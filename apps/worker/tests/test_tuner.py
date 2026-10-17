"""Optimise: the benchmark's stop rules (simulated timings, GPU memory and errors), what it
recommends, the out-of-memory fallback of an analysis, and how many lane threads claim jobs."""
import pytest

from golf_api import performance
from golf_api.performance import Perf
from golf_worker.tuner import Trial, recommend, search

GPU_PC = {"cpuCores": 16, "ram": {"totalMb": 32000}, "inference": "DirectML",
          "gpus": [{"name": "NVIDIA GeForce RTX 5070", "vramMb": 12000, "usedMb": 500}]}
CPU_PC = {"cpuCores": 4, "ram": {"totalMb": 16000}, "inference": "CPU", "gpus": []}


def sim(fps: dict, vram: dict | None = None, errors: tuple = (), seconds: float = 2.0, dynamic: bool = False):
    """A measure() that answers from tables keyed by (sessions, batch), recording what was tried."""
    tried = []

    def measure(s: int, b: int, t: int) -> Trial:
        tried.append((s, b))
        if (s, b) in errors:
            return Trial(s, b, t, error="RuntimeError: D3D12 out of memory", seconds=seconds)
        return Trial(s, b, t, fps=fps.get((s, b), 0.0), vram_mb=(vram or {}).get((s, b)), seconds=seconds, dynamic=dynamic)

    return measure, tried


def test_gpu_more_sessions_until_no_gain():
    measure, tried = sim({(1, 1): 20, (2, 1): 34, (3, 1): 35, (4, 1): 60}, {(1, 1): 2500, (2, 1): 4000, (3, 1): 5500})
    base, best, trials, stop = search(measure, GPU_PC, idle_vram_mb=1000)
    assert (best.sessions, stop) == (2, "no_gain") and tried == [(1, 1), (2, 1), (3, 1)]
    assert base.fps == 20


def test_gpu_stops_before_80_percent_of_vram():
    # Each session costs ~3 GB: the third would pass 80 % of 12 GB, so it is never created.
    measure, tried = sim({(1, 1): 20, (2, 1): 34, (3, 1): 45}, {(1, 1): 3500, (2, 1): 7000})
    _, best, _, stop = search(measure, GPU_PC, idle_vram_mb=500)
    assert (best.sessions, stop) == (2, "vram") and (3, 1) not in tried


def test_gpu_measured_over_the_limit_is_not_used():
    measure, _ = sim({(1, 1): 20, (2, 1): 40}, {(1, 1): 4000, (2, 1): 9900})
    _, best, _, stop = search(measure, GPU_PC)            # unknown idle memory: no projection, but the check after
    assert (best.sessions, stop) == (1, "vram")


def test_gpu_error_keeps_the_last_safe_step():
    measure, _ = sim({(1, 1): 20, (2, 1): 34}, {(1, 1): 2000, (2, 1): 3000}, errors=((3, 1),))
    _, best, trials, stop = search(measure, GPU_PC, idle_vram_mb=1000)
    assert (best.sessions, stop) == (2, "error") and trials[-1].error


def test_time_budget():
    now = [0.0]

    def clock():
        return now[0]

    def measure(s, b, t):
        now[0] += 20
        return Trial(s, b, t, fps=10.0 * s, seconds=20)

    _, best, trials, stop = search(measure, GPU_PC, budget_s=60, clock=clock)
    assert stop == "time" and len(trials) == 2 and best.sessions == 2


def test_dynamic_batch_first_then_sessions():
    fps = {(1, 1): 20, (1, 2): 30, (1, 4): 36, (1, 8): 36.5, (2, 4): 50, (3, 4): 51}
    measure, tried = sim(fps, dynamic=True)
    _, best, _, stop = search(measure, GPU_PC)
    assert (best.sessions, best.batch, stop) == (2, 4, "no_gain")
    assert tried == [(1, 1), (1, 2), (1, 4), (1, 8), (2, 4), (3, 4)]


def test_cpu_tries_no_extra_sessions():
    measure, tried = sim({(1, 1): 2.6})
    _, best, _, stop = search(measure, CPU_PC)
    assert (best.sessions, stop) == (1, "cpu") and tried == [(1, 1)]


def test_detector_that_does_not_run():
    measure, _ = sim({}, errors=((1, 1),))
    with pytest.raises(RuntimeError):
        search(measure, GPU_PC)


def test_recommendation():
    gpu = recommend(Trial(3, 1, 0, fps=50), GPU_PC)
    assert (gpu.analyses, gpu.sessions, gpu.ingests) == (3, 3, 4)
    # One session is still shared by two analyses on a GPU: the CPU steps overlap.
    assert recommend(Trial(1, 1, 0, fps=50), GPU_PC).analyses == 2
    cpu = recommend(Trial(1, 1, 0, fps=2.6), CPU_PC)
    assert (cpu.analyses, cpu.sessions, cpu.threads) == (1, 1, 0)
    assert recommend(Trial(4, 1, 0, fps=50), {**GPU_PC, "ram": {"totalMb": 6500}}).analyses == 2


# --- the out-of-memory fallback ----------------------------------------------------------------


def test_analysis_retries_once_with_a_lower_profile(env):
    from golf_worker import tasks

    performance.set_profile("max")
    calls, messages = [], []

    def run():
        calls.append(performance.load()["profile"])
        if len(calls) == 1:
            raise RuntimeError("[ONNXRuntimeError] DmlExecutionProvider: 887A0005 The GPU device instance has been suspended")
        return {"shots": []}

    res = tasks._with_fallback(run, lambda p, m: messages.append(m) or True)
    assert calls == ["max", "balanced"] and res["perfFallback"]["to"] == "balanced"
    assert any("memory" in m for m in messages)
    assert performance.load()["fallback"]["from"] == "max"


def test_other_errors_are_not_retried(env):
    from golf_worker import tasks

    calls = []

    def run():
        calls.append(1)
        raise RuntimeError("Too few frames after the impact at 3.0 s.")

    with pytest.raises(RuntimeError):
        tasks._with_fallback(run, lambda p, m: True)
    assert calls == [1] and performance.load()["profile"] == "balanced"


def test_a_second_device_error_fails_the_job(env):
    from golf_worker import tasks

    def run():
        raise MemoryError()

    with pytest.raises(MemoryError):
        tasks._with_fallback(run, lambda p, m: True)
    assert performance.load()["profile"] == "gentle"


def test_runtime_follows_the_profile(env, monkeypatch):
    from golf_worker import tasks
    from shottracer import runtime

    monkeypatch.setattr(performance, "hardware", lambda refresh=False: GPU_PC)
    performance.set_profile("gentle")
    tasks.apply_performance()
    assert runtime.current() == runtime.Runtime(sessions=1, batch=1, threads=8, gpu=True)
    performance.set_profile("max")
    tasks.apply_performance()
    assert runtime.current().sessions == 3
    runtime.configure(runtime.Runtime())


# --- lane threads ------------------------------------------------------------------------------


def test_lane_threads_follow_the_profile(env, monkeypatch):
    from golf_worker import main

    monkeypatch.delenv("INGEST_PARALLEL", raising=False)
    monkeypatch.setattr(performance, "hardware", lambda refresh=False: GPU_PC)
    assert (main.lane_threads("media"), main.lane_threads("analysis")) == (2, 1)
    performance.set_profile("max")
    assert (main.lane_threads("media"), main.lane_threads("analysis")) == (4, 3)
    performance.save_tuned(Perf(analyses=9, ingests=1), {})
    assert (main.lane_threads("media"), main.lane_threads("analysis")) == (1, main.LANE_MAX["analysis"])
    performance.set_profile("gentle")
    assert (main.lane_threads("media"), main.lane_threads("analysis")) == (1, 1)
    monkeypatch.setattr(performance, "hardware", lambda refresh=False: CPU_PC)
    performance.set_profile("max")
    assert (main.lane_threads("media"), main.lane_threads("analysis")) == (2, 1)
