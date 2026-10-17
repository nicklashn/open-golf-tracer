"""Settings → Performance: hardware parsing, what each profile sets, the automatic step down
after an out-of-memory error, and the endpoints."""
import pytest

from golf_api import performance
from golf_api.performance import Perf

SMI = """name, memory.total [MiB], memory.used [MiB]
NVIDIA GeForce RTX 5070, 12227 MiB, 1034 MiB
"""
SMI_NOUNITS = "NVIDIA GeForce RTX 5070, 12227, 812\nNVIDIA RTX A2000, 6138, 0\n"
MEMINFO = """MemTotal:       16479800 kB
MemFree:         1024000 kB
MemAvailable:   12288000 kB
Cached:          4000000 kB
"""

GPU_PC = {"cpuCores": 16, "ram": {"totalMb": 32000, "availableMb": 20000}, "inference": "DirectML",
          "gpus": [{"name": "NVIDIA GeForce RTX 5070", "vramMb": 12227, "usedMb": 900}], "providers": ["DmlExecutionProvider"]}
CPU_PC = {"cpuCores": 4, "ram": {"totalMb": 16000, "availableMb": 12000}, "inference": "CPU", "gpus": [], "providers": ["CPUExecutionProvider"]}


def test_nvidia_smi_output():
    assert performance.parse_nvidia_smi(SMI) == [{"name": "NVIDIA GeForce RTX 5070", "vramMb": 12227, "usedMb": 1034}]
    assert [g["vramMb"] for g in performance.parse_nvidia_smi(SMI_NOUNITS)] == [12227, 6138]
    assert performance.parse_nvidia_smi("") == []
    assert performance.parse_nvidia_smi("NVIDIA-SMI has failed because it couldn't communicate with the NVIDIA driver.") == []
    # A comma in the name stays in the name.
    assert performance.parse_nvidia_smi("Tesla T4, rev 2, 15360, 3\n")[0]["name"] == "Tesla T4, rev 2"


def test_meminfo():
    assert performance.parse_meminfo(MEMINFO) == {"totalMb": 16093, "availableMb": 12000}
    # Old kernels without MemAvailable: free + cached.
    assert performance.parse_meminfo("MemTotal: 2048000 kB\nMemFree: 1024 kB\nCached: 1024 kB\n")["availableMb"] == 2


def test_hardware_is_plain_data():
    hw = performance.hardware(refresh=True)
    assert hw["cpuCores"] >= 1 and hw["ram"]["totalMb"] > 0 and hw["inference"] in ("DirectML", "CUDA", "CPU")


def test_profiles_on_a_gpu_pc():
    gentle = performance.for_profile("gentle", GPU_PC)
    assert gentle == Perf(analyses=1, ingests=1, sessions=1, batch=1, threads=8)
    assert performance.for_profile("balanced", GPU_PC) == Perf(analyses=1, ingests=2, sessions=1, batch=1, threads=0)
    mx = performance.for_profile("max", GPU_PC)
    assert mx.analyses == 3 and mx.sessions == 3 and mx.ingests == 4 and mx.threads == 0
    small = {**GPU_PC, "gpus": [{"name": "GTX 1650", "vramMb": 4096, "usedMb": 0}]}
    assert performance.for_profile("max", small).analyses == 1
    # Little RAM caps the analyses too (each holds seconds of full-HD frames).
    assert performance.for_profile("max", {**GPU_PC, "ram": {"totalMb": 6000}}).analyses == 2


def test_profiles_on_a_cpu_pc():
    assert performance.for_profile("gentle", CPU_PC).threads == 2
    assert performance.for_profile("balanced", CPU_PC).ingests == 1
    mx = performance.for_profile("max", CPU_PC)
    assert mx.analyses == 1 and mx.sessions == 1 and mx.ingests == 2
    tuned = performance.for_profile("tuned", CPU_PC, {"analyses": 9, "ingests": 2, "sessions": 1, "batch": "x", "threads": -3})
    assert tuned == Perf(analyses=performance.MAX_ANALYSES, ingests=2, sessions=1, batch=1, threads=0)
    assert performance.for_profile("tuned", CPU_PC, None) == performance.for_profile("balanced", CPU_PC)


def test_stored_profile_and_env_override(env, monkeypatch):
    monkeypatch.delenv("INGEST_PARALLEL", raising=False)
    perf, data = performance.effective(GPU_PC)
    assert data["profile"] == "balanced" and perf.analyses == 1
    performance.set_profile("max")
    perf, data = performance.effective(GPU_PC)
    assert data["profile"] == "max" and perf.analyses == 3
    monkeypatch.setenv("INGEST_PARALLEL", "1")
    assert performance.effective(GPU_PC)[0].ingests == 1
    with pytest.raises(LookupError):
        performance.set_profile("tuned")
    (env / "data" / "performance.json").write_text("{broken")
    assert performance.load()["profile"] == "balanced"


def test_step_down_after_out_of_memory(env):
    performance.set_profile("max")
    rev = performance.load()["rev"]
    change = performance.step_down(rev, "D3D12 out of memory")
    assert change and change["from"] == "max" and change["to"] == "balanced"
    # A second job that failed with the same, older settings does not lower it again.
    assert performance.step_down(rev, "again") is None
    assert performance.load()["profile"] == "balanced"
    performance.step_down(performance.load()["rev"], "oom")
    assert performance.load()["profile"] == "gentle"
    performance.step_down(performance.load()["rev"], "oom")
    perf, data = performance.effective(GPU_PC)
    assert data["cpuOnly"] and not perf.gpu and perf.sessions == 1
    # Choosing a profile again turns the GPU back on.
    performance.set_profile("balanced")
    assert performance.effective(GPU_PC)[0].gpu and "fallback" not in performance.load()


@pytest.mark.parametrize("exc,expected", [
    (RuntimeError("[ONNXRuntimeError] : 6 : RUNTIME_EXCEPTION : Non-zero status code returned while running Conv node. "
                  "Status Message: D:\\a\\_work\\1\\s\\onnxruntime\\core\\providers\\dml\\DmlExecutionProvider\\src\\"
                  "DmlCommandRecorder.cpp(371)\\onnxruntime_pybind11_state.pyd!00007FF8: (caller: 00007FF8) Exception(3) "
                  "tid(2f0c) 887A0005 The GPU device instance has been suspended."), True),
    (RuntimeError("CUDA error: out of memory"), True),
    (RuntimeError("Failed to allocate memory for requested buffer of size 123456"), True),
    (MemoryError(), True),
    (RuntimeError("Too few frames after the impact at 3.0 s."), False),
    (ValueError("Cannot open video: x.mp4"), False),
])
def test_device_errors(exc, expected):
    assert performance.is_device_error(exc) is expected


def test_endpoints(client):
    r = client.get("/api/performance")
    assert r.status_code == 200, r.text
    s = r.json()
    assert s["profile"] == "balanced" and set(s["profiles"]) == {"gentle", "balanced", "max"}
    assert s["hardware"]["cpuCores"] >= 1 and s["tuned"] is None and s["fallback"] is None
    s = client.put("/api/performance", json={"profile": "gentle"}).json()
    assert s["profile"] == "gentle" and s["effective"]["analyses"] == 1
    assert client.put("/api/performance", json={"profile": "turbo"}).status_code == 422
    r = client.put("/api/performance", json={"profile": "tuned"})
    assert r.status_code == 422 and r.json()["error"]["code"] == "not_tuned"

    job = client.post("/api/performance/optimize").json()
    assert job["kind"] == "tune" and job["status"] == "queued"
    assert client.post("/api/performance/optimize").json()["id"] == job["id"]   # one at a time

    performance.save_tuned(Perf(analyses=2, ingests=2, sessions=2), {"speedup": 2.4, "gpu": "RTX 5070", "inference": "DirectML", "stop": "vram"})
    s = client.get("/api/performance").json()
    assert s["profile"] == "tuned" and s["profiles"]["tuned"]["analyses"] == 2 and s["tuned"]["summary"]["speedup"] == 2.4
