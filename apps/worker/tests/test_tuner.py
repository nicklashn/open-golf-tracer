"""Optimise: the benchmark's stop rules (simulated timings, GPU memory and errors), what it
recommends, the out-of-memory fallback of an analysis, and how many lane threads claim jobs."""
import pytest

from golf_api import performance
from golf_api.performance import Perf
from golf_worker.tuner import Trial, recommend, search

GPU_PC = {"cpuCores": 16, "ram": {"totalMb": 32000}, "inference": "DirectML",
          "gpus": [{"name": "NVIDIA GeForce RTX 5070", "vramMb": 12000, "usedMb": 500}]}
CPU_PC = {"cpuCores": 4, "ram": {"totalMb": 16000}, "inference": "CPU", "gpus": []}
CUDA_PC = {**GPU_PC, "inference": "CUDA"}


def sim(fps: dict, vram: dict | None = None, errors: tuple = (), seconds: float = 2.0, dynamic: bool = False,
        provider: str = "DmlExecutionProvider"):
    """A measure() that answers from tables keyed by (sessions, batch) or (sessions, batch, callers),
    recording what was tried."""
    tried = []

    def measure(s: int, b: int, c: int) -> Trial:
        key = (s, b) if c == 1 else (s, b, c)
        tried.append(key)
        if key in errors:
            return Trial(s, b, c, error="RuntimeError: D3D12 out of memory", seconds=seconds)
        return Trial(s, b, c, fps=fps.get(key, 0.0), vram_mb=(vram or {}).get((s, b)), seconds=seconds, dynamic=dynamic,
                     provider=provider)

    return measure, tried


def test_cuda_more_sessions_until_no_gain():
    measure, tried = sim({(1, 1): 20, (2, 1): 34, (3, 1): 35, (4, 1): 60}, {(1, 1): 2500, (2, 1): 4000, (3, 1): 5500})
    base, best, trials, stop = search(measure, CUDA_PC, idle_vram_mb=1000)
    assert (best.sessions, stop) == (2, "no_gain") and tried[:3] == [(1, 1), (2, 1), (3, 1)]
    assert tried[3:] == [(2, 1, 2)]       # then callers on the best sessions
    assert base.fps == 20


def test_gpu_stops_before_80_percent_of_vram():
    # Each session costs ~3 GB: the third would pass 80 % of 12 GB, so it is never created.
    measure, tried = sim({(1, 1): 20, (2, 1): 34, (3, 1): 45}, {(1, 1): 3500, (2, 1): 7000})
    _, best, _, stop = search(measure, CUDA_PC, idle_vram_mb=500)
    assert (best.sessions, stop) == (2, "vram") and (3, 1) not in tried


def test_gpu_measured_over_the_limit_is_not_used():
    measure, _ = sim({(1, 1): 20, (2, 1): 40}, {(1, 1): 4000, (2, 1): 9900})
    _, best, _, stop = search(measure, CUDA_PC)            # unknown idle memory: no projection, but the check after
    assert (best.sessions, stop) == (1, "vram")


def test_gpu_error_keeps_the_last_safe_step():
    measure, _ = sim({(1, 1): 20, (2, 1): 34}, {(1, 1): 2000, (2, 1): 3000}, errors=((3, 1),))
    _, best, trials, stop = search(measure, CUDA_PC, idle_vram_mb=1000)
    assert (best.sessions, stop) == (2, "error") and any(t.error for t in trials)


def test_directml_tries_callers_not_sessions():
    """The RTX 5070 report: sessions=2 failed at once in DmlFusedNode, which ended Optimise at
    1.0x. DirectML runs one call at a time, so it measures analyses sharing one session instead."""
    measure, tried = sim({(1, 1): 24, (1, 1, 2): 40, (1, 1, 3): 41})
    _, best, _, stop = search(measure, GPU_PC)
    assert tried == [(1, 1), (1, 1, 2), (1, 1, 3)] and (best.sessions, best.callers, stop) == (1, 2, "no_gain")
    assert recommend(best, GPU_PC).analyses == 2 and recommend(best, GPU_PC).sessions == 1


def test_an_error_in_one_dimension_still_tries_the_next():
    measure, tried = sim({(1, 1): 20, (1, 2): 30, (1, 2, 2): 45}, errors=((1, 4),), dynamic=True)
    _, best, trials, stop = search(measure, GPU_PC)
    assert tried == [(1, 1), (1, 2), (1, 4), (1, 2, 2), (1, 2, 3)]
    assert (best.batch, best.callers, stop) == (2, 2, "error")


def test_gpu_installed_but_the_model_ran_on_the_cpu():
    measure, tried = sim({(1, 1): 2.0}, provider="CPUExecutionProvider")
    _, best, _, stop = search(measure, GPU_PC)
    assert tried == [(1, 1)] and stop == "cpu"


def test_time_budget():
    now = [0.0]

    def clock():
        return now[0]

    def measure(s, b, c):
        now[0] += 20
        return Trial(s, b, c, fps=10.0 * s, seconds=20)

    _, best, trials, stop = search(measure, CUDA_PC, budget_s=60, clock=clock)
    assert stop == "time" and len(trials) == 2 and best.sessions == 2


def test_dynamic_batch_first_then_sessions():
    fps = {(1, 1): 20, (1, 2): 30, (1, 4): 36, (1, 8): 36.5, (2, 4): 50, (3, 4): 51}
    measure, tried = sim(fps, dynamic=True)
    _, best, _, stop = search(measure, CUDA_PC)
    assert (best.sessions, best.batch, stop) == (2, 4, "no_gain")
    assert tried == [(1, 1), (1, 2), (1, 4), (1, 8), (2, 4), (3, 4), (2, 4, 2)]


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
    assert runtime.current().sessions == 1 and runtime.current().batch == 4
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


# --- Optimise has the analysis lane to itself ------------------------------------------------


def test_optimise_waits_for_running_analyses_and_holds_new_ones(client, monkeypatch):
    """With two analyses at once, Optimise used to start beside a running analysis: the
    numbers were wrong and its test sessions could fill the GPU under the analysis."""
    from golf_api import jobs
    from golf_api.db import session_scope
    from golf_worker import main

    monkeypatch.setattr(main, "_busy", {})
    kinds = main.LANES["analysis"]
    with session_scope() as db:
        jobs.enqueue(db, "analyze", {"media_id": "a"})
        jobs.enqueue(db, "analyze", {"media_id": "b"})
        db.commit()

    def claim(slot: str) -> str | None:
        with session_scope() as db, main._busy_lock:
            j = jobs.claim(db, main.claimable(db, "analysis", kinds) or ["-"], slot)
            if j:
                main._busy.setdefault("analysis", []).append(j.kind)
            return j.kind if j else None

    assert claim("w1") == "analyze"
    with session_scope() as db:
        jobs.enqueue(db, "tune", {}, max_attempts=1)
        db.commit()
    assert claim("w2") is None                    # analysis b waits behind the queued Optimise
    main._busy["analysis"].remove("analyze")      # the running analysis finished
    assert claim("w1") == "tune"
    assert claim("w2") is None                    # nothing beside Optimise
    main._busy["analysis"].remove("tune")
    assert claim("w1") == "analyze"
    assert main.claimable(None, "media", main.LANES["media"]) == ["ingest"]   # the media lane is not held up


# --- the whole Optimise job, on a simulated DirectML PC --------------------------------------


def _fake_tuner(monkeypatch, decode_fps: dict, detector: dict, errors: tuple = ()):
    from golf_worker import tuner

    monkeypatch.delenv("GOLF_DETECTOR", raising=False)
    monkeypatch.setattr(performance, "hardware", lambda refresh=False: GPU_PC)
    monkeypatch.setattr(tuner, "_frames", lambda n=3: [])
    monkeypatch.setattr(tuner, "_gpu_used", lambda: None)
    monkeypatch.setattr(tuner, "measure_detector", lambda frames, gpu=True: sim(detector, errors=errors)[0])
    monkeypatch.setattr(tuner, "measure_decoding", lambda: lambda k: Trial(0, 0, k, fps=decode_fps.get(k, 0.0), kind="decode"))
    return tuner


def test_optimise_on_directml_saves_what_decoding_side_by_side_allows(env, monkeypatch):
    tuner = _fake_tuner(monkeypatch, {1: 300, 2: 520, 3: 700, 4: 710}, {(1, 1): 24, (1, 1, 2): 40})
    messages = []
    res = tuner.run_tuner(lambda p, m: messages.append(m) or True)
    data = performance.load()
    assert data["profile"] == "tuned" and res["settings"]["analyses"] == 3 and res["settings"]["sessions"] == 1
    assert data["tuned"]["summary"]["parallel"] == 3 and data["tuned"]["summary"]["speedup"] == round(40 / 24, 2)
    kinds = [t["kind"] for t in data["tuned"]["summary"]["trials"]]
    assert kinds == ["detector"] * 3 + ["decode"] * 4
    assert any("decoded" in m for m in messages)


def test_a_failed_step_keeps_enough_of_the_error_to_tell_why(monkeypatch):
    """The RTX 5070's error was cut at 300 characters, before the part that says what failed."""
    import numpy as np

    from golf_worker import tuner
    from shottracer import detect

    long_error = "[ONNXRuntimeError] : 6 : RUNTIME_EXCEPTION : Non-zero status code returned while running DmlFusedNode_7_11 node. " \
                 + "x" * 400 + " 887A0005 The GPU device instance has been suspended."

    class Det:
        sessions, batch, fixed_batch, provider, session_error = 1, 1, 1, "DmlExecutionProvider", None

        def __init__(self, rt=None):
            pass

        def _raw_many(self, imgs):
            raise RuntimeError(long_error)

    monkeypatch.setattr(detect, "OnnxRfDetrBallDetector", Det)
    tr = tuner.measure_detector([np.zeros((8, 8, 3), np.uint8)], gpu=False)(1, 1, 1)
    assert tr.error and tr.error.endswith("suspended.") and tr.provider == "DmlExecutionProvider"


def test_optimise_can_be_stopped_and_then_saves_nothing(env, monkeypatch):
    from golf_worker.ffmpeg import Canceled

    tuner = _fake_tuner(monkeypatch, {1: 300}, {(1, 1): 24})
    calls = []
    with pytest.raises(Canceled):
        tuner.run_tuner(lambda p, m: calls.append(m) or len(calls) < 3)
    assert "tuned" not in performance.load()


def test_decoding_side_by_side_for_real(monkeypatch):
    from golf_worker import tuner

    monkeypatch.setattr(tuner, "MIN_TRIAL_S", 0.3)
    one, two = (tuner.measure_decoding()(k) for k in (1, 2))
    assert one.fps and two.fps and not one.error and two.kind == "decode" and two.callers == 2


def test_search_parallel():
    from golf_worker.tuner import search_parallel

    tried = []

    def measure(k):
        tried.append(k)
        return Trial(0, 0, k, fps={1: 300, 2: 520, 3: 530}.get(k, 0.0), kind="decode")

    assert search_parallel(measure, GPU_PC, 60) == (2, search_parallel(measure, GPU_PC, 60)[1]) and tried[:3] == [1, 2, 3]
    assert search_parallel(lambda k: Trial(0, 0, k, error="no ffmpeg"), GPU_PC, 60)[0] is None
