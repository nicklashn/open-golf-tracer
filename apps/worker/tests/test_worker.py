import base64
import json
import os
from pathlib import Path

import pytest
from testkit import upload

ROOT = Path(__file__).resolve().parents[3]


def _drain(kinds):
    from golf_api import jobs
    from golf_api.db import session_scope
    from golf_worker.main import run_job

    while True:
        with session_scope() as db:
            j = jobs.claim(db, kinds, "test")
            jid = j.id if j else None
        if not jid:
            return
        run_job(jid)


def test_ingest_makes_proxy_thumbs_waveform(client, tiny_video):
    res = upload(client, tiny_video)
    _drain(["ingest"])
    m = client.get(f"/api/media/{res['media']['id']}").json()
    assert m["status"] == "ready"
    assert {"original", "proxy", "poster", "thumbs", "waveform"} <= set(m["urls"])
    assert m["thumbs"]["count"] >= 2
    proxy = client.get(m["urls"]["proxy"])
    assert proxy.status_code == 200 and proxy.content[4:8] == b"ftyp"
    wf = client.get(m["urls"]["waveform"]).json()
    peaks = base64.b64decode(wf["peaks"])
    assert wf["rate"] == 100 and abs(len(peaks) - 200) <= 2 and max(peaks) > 50


PROBE = {"duration": 194.0, "width": 1920, "height": 1080, "fps": 59.94, "codec": "h264", "pix_fmt": "yuv420p", "rotation": 0,
         "hdr": False, "hasAudio": True}


def test_proxy_cmds_make_thumbs_in_the_same_pass(monkeypatch):
    from golf_worker import tasks

    monkeypatch.setattr(tasks, "cuda_ok", lambda: False)
    (cmd,) = tasks.proxy_cmds(Path("in.mp4"), Path("proxy.mp4"), Path("thumbs.jpg"), PROBE)
    graph = cmd[cmd.index("-filter_complex") + 1]
    assert cmd.count("-i") == 1 and "split=2[pv][tv]" in graph and "tile=10x15" in graph and "scale=160:90" in graph
    assert cmd[-1] == "thumbs.jpg" and "proxy.mp4" in cmd


def test_proxy_cmds_gpu_first_with_cpu_fallback(monkeypatch):
    from golf_worker import ffmpeg, tasks

    monkeypatch.setattr(tasks, "cuda_ok", lambda: True)
    monkeypatch.setattr(ffmpeg, "encoder_ok", lambda codec: codec == "h264_nvenc")
    gpu, cpu = tasks.proxy_cmds(Path("in.mp4"), Path("proxy.mp4"), Path("thumbs.jpg"), PROBE)
    g = gpu[gpu.index("-filter_complex") + 1]
    assert gpu[gpu.index("-hwaccel") + 1] == "cuda" and "-hwaccel_output_format" in gpu
    assert "scale_cuda=1280:720" in g and "fps=1/1.29333,hwdownload,format=nv12" in g and "-pix_fmt" not in gpu
    assert "scale_cuda" not in cpu[cpu.index("-filter_complex") + 1] and "-pix_fmt" in cpu
    for probe in ({**PROBE, "hdr": True}, {**PROBE, "rotation": 90}, {**PROBE, "pix_fmt": "yuv420p10le"}):
        assert len(tasks.proxy_cmds(Path("in.mp4"), Path("proxy.mp4"), None, probe)) == 1
    assert len(tasks.proxy_cmds(Path("in.mp4"), Path("proxy.webm"), None, PROBE, vp9=True)) == 1


def test_an_hdr_proxy_is_tone_mapped_after_it_is_made_small(monkeypatch):
    """Tone mapping is float maths per pixel: on the 1280 px frames at most 60 per second, not
    the full-size ones (2x faster on a 1080p60 iPhone HLG clip; 4K or 120 fps gain more)."""
    from golf_worker import tasks

    monkeypatch.setattr(tasks, "cuda_ok", lambda: False)
    monkeypatch.setattr(tasks, "tonemap_filter", lambda: "TONEMAP")
    hdr = {**PROBE, "hdr": True, "codec": "hevc", "pix_fmt": "yuv420p10le", "fps": 119.88, "width": 3840, "height": 2160}
    (cmd,) = tasks.proxy_cmds(Path("in.mov"), Path("proxy.mp4"), Path("thumbs.jpg"), hdr)
    chain = cmd[cmd.index("-filter_complex") + 1].split(",split=")[0].removeprefix("[0:v:0]").split(",")
    assert chain == ["fps=60", "scale=1280:-2:flags=area", "TONEMAP", "format=yuv420p"]
    (cmd,) = tasks.proxy_cmds(Path("in.mp4"), Path("proxy.mp4"), None, PROBE)
    assert "TONEMAP" not in cmd[cmd.index("-filter_complex") + 1]


def test_ingest_falls_back_when_the_gpu_fails(client, tiny_video, monkeypatch, caplog):
    from golf_worker import tasks

    # The GPU command fails here (no CUDA); the CPU command must still make everything.
    monkeypatch.setattr(tasks, "_gpu_proxy_ok", lambda probe: True)
    res = upload(client, tiny_video)
    _drain(["ingest"])
    m = client.get(f"/api/media/{res['media']['id']}").json()
    assert m["status"] == "ready" and {"proxy", "poster", "thumbs", "waveform"} <= set(m["urls"])
    assert "GPU preview failed" in caplog.text


def test_parallel_lanes_claim_each_job_once(client):
    import threading

    from golf_api import jobs
    from golf_api.db import session_scope

    with session_scope() as db:
        ids = {jobs.enqueue(db, "ingest", {"i": i}).id for i in range(12)}
    got: list[str] = []
    lock = threading.Lock()

    def lane(name):
        while True:
            with session_scope() as db:
                j = jobs.claim(db, ["ingest"], name)
                if j is None:
                    return
                with lock:
                    got.append(j.id)

    threads = [threading.Thread(target=lane, args=(f"w{i}",)) for i in range(4)]
    for t in threads:
        t.start()
    for t in threads:
        t.join()
    assert sorted(got) == sorted(ids)


def test_ingest_parallel_setting(env, monkeypatch):
    from golf_api import performance
    from golf_worker import main

    monkeypatch.setenv("INGEST_PARALLEL", "3")
    assert main.lane_threads("media") == 3 and main.lane_threads("analysis") == 1
    monkeypatch.delenv("INGEST_PARALLEL")
    hw = performance.hardware()
    monkeypatch.setattr(performance, "hardware", lambda refresh=False: {**hw, "cpuCores": 4})
    assert main.lane_threads("media") == 1
    monkeypatch.setattr(performance, "hardware", lambda refresh=False: {**hw, "cpuCores": 16})
    assert main.lane_threads("media") == 2


@pytest.mark.slow
@pytest.mark.skipif(not (ROOT / "models" / "yolo26x.pt").exists(), reason="YOLO weights missing")
def test_analysis_job_finds_shots(client):
    import subprocess
    import sys

    vid = ROOT / "tests" / "out" / "multi.mp4"
    if not vid.exists():
        subprocess.run([sys.executable, str(ROOT / "tests" / "make_synthetic.py"), str(vid), "--shots", "3"], check=True)
    res = upload(client, vid)
    _drain(["analyze"])
    doc = client.get(f"/api/projects/{res['projectId']}").json()["document"]
    assert len(doc["shots"]) == 3
    assert all(s["mediaId"] == res["media"]["id"] for s in doc["shots"])
    # The retrack job tracks one shot again from a known strike time.
    r = client.post(f"/api/projects/{res['projectId']}/retrack", json={"mediaId": res["media"]["id"], "impactTime": 11.0})
    assert r.status_code == 200
    _drain(["retrack"])
    jobs = client.get("/api/jobs", params={"project_id": res["projectId"]}).json()["jobs"]
    rt = next(j for j in jobs if j["kind"] == "retrack")
    assert rt["status"] == "succeeded", rt
    assert abs(rt["result"]["shot"]["impactTime"] - 11.0) < 0.05
    os.environ.pop("X", None)
    json.dumps(doc)
