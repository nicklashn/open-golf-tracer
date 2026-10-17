"""Optimise (Settings → Performance): a short benchmark of the ball detector on this PC.

It runs the detector on a few frames with more and more frames per call (when the model allows),
on CUDA sessions side by side, and on a GPU more callers sharing them (as analyses at once do),
watching frames per second and GPU memory. Each of these stops at an error (e.g. out of memory),
GPU memory above VRAM_LIMIT or no real gain, and the next one is still tried; the time budget ends
it all. On a GPU it then measures video decoding side by side, which is most of an analysis once
the detector is fast (a 3-minute 1080p60 clip with 18 shots: ~100 detector calls, ~10,000
decoded frames), and picks the number of analyses at once from that.
The best safe step is saved as the "Tuned for this PC" profile.
"""
from __future__ import annotations

import gc
import logging
import time
from collections.abc import Callable
from concurrent.futures import ThreadPoolExecutor
from dataclasses import asdict, dataclass
from pathlib import Path
from typing import Any

import numpy as np

from golf_api import performance
from golf_api.performance import Perf

from .ffmpeg import Canceled

log = logging.getLogger("golf.worker")

ROOT = Path(__file__).resolve().parents[3]
BUDGET_S = 45.0
MIN_GAIN = 1.05          # a step must be at least this much faster to count
BATCHES = (2, 4, 8)
SESSIONS = (2, 3, 4)      # CUDA only: with DirectML one Run call runs at a time (shottracer.detect)
CALLERS = (2, 3)
ERROR_CHARS = 1000
MIN_TRIAL_S = 2.0        # each trial runs at least this long (steadier numbers)


@dataclass
class Trial:
    sessions: int
    batch: int
    callers: int = 1               # threads using the detector at once (analyses side by side)
    threads: int = 0
    fps: float | None = None       # frames per second through the detector
    vram_mb: int | None = None     # GPU memory in use while the sessions were loaded
    error: str | None = None
    seconds: float = 0.0
    dynamic: bool = False          # the model takes more than one frame per call
    provider: str | None = None    # where the model really ran (a broken GPU driver falls back to the CPU)
    kind: str = "detector"         # or "decode": `callers` videos decoded side by side


Measure = Callable[[int, int, int], Trial]   # (sessions, batch, callers)


def search(measure: Measure, hw: dict[str, Any], dynamic_batch: bool | None = None, budget_s: float = BUDGET_S,
           clock: Callable[[], float] = time.monotonic, idle_vram_mb: int | None = None) -> tuple[Trial, Trial, list[Trial], str]:
    """(baseline, best, every trial, why it stopped). The baseline is Balanced: 1 session, 1 frame."""
    t0 = clock()
    gpu = hw.get("inference") in ("DirectML", "CUDA")
    total = max((g["vramMb"] for g in hw.get("gpus") or []), default=0)
    limit = performance.VRAM_LIMIT * total if gpu and total else None
    base = measure(1, 1, 1)
    trials = [base]
    if base.error or not base.fps:
        raise RuntimeError(f"The detector does not run: {base.error}")
    if gpu and base.provider == "CPUExecutionProvider":
        gpu = False                  # the GPU did not take the model: what is measured is the CPU
    if dynamic_batch is None:
        dynamic_batch = base.dynamic
    if limit and base.vram_mb and base.vram_mb > limit:
        return base, base, trials, "vram"
    best = base
    # GPU memory one more session (or a bigger batch) is likely to cost.
    step_mb = (base.vram_mb - idle_vram_mb) if base.vram_mb is not None and idle_vram_mb is not None else None

    def attempt(sessions: int, batch: int, callers: int = 1) -> str | None:
        nonlocal best
        last = trials[-1]
        if clock() - t0 + 1.5 * last.seconds > budget_s:
            return "time"
        if limit and callers == 1 and last.vram_mb is not None and step_mb is not None and last.vram_mb + step_mb > limit:
            return "vram"            # stop before trying a step that would not fit (more callers cost no memory)
        tr = measure(sessions, batch, callers)
        trials.append(tr)
        if tr.error:
            return "error"
        if limit and tr.vram_mb is not None and tr.vram_mb > limit:
            return "vram"
        if not tr.fps or tr.fps < best.fps * MIN_GAIN:  # type: ignore[operator]
            return "no_gain"
        best = tr
        return None

    stops: list[str] = []

    def walk(steps) -> bool:
        """Tries the steps in order until one stops; False when the time is up."""
        for sessions, batch, callers in steps:
            if (stop := attempt(sessions, batch, callers)) is not None:
                stops.append(stop)
                break
        return "time" not in stops

    def why(default: str) -> str:
        return next((s for s in ("time", "error", "vram") if s in stops), stops[-1] if stops else default)

    if dynamic_batch and not walk((1, b, 1) for b in BATCHES):
        return base, best, trials, why("done")
    if not gpu:
        # On the CPU, sessions side by side only split the same cores: in a real analysis (decoding,
        # tracking) two sessions of 2 threads were slower than one of 4 (60 -> 75 s on 4 cores).
        return base, best, trials, "error" if "error" in stops else "cpu"
    if hw.get("inference") == "CUDA" and not walk((s, best.batch, 1) for s in SESSIONS):
        return base, best, trials, why("done")
    walk((best.sessions, best.batch, c) for c in CALLERS)
    return base, best, trials, why("done")


def search_parallel(measure: Callable[[int], Trial], hw: dict[str, Any], budget_s: float,
                    clock: Callable[[], float] = time.monotonic) -> tuple[int | None, list[Trial]]:
    """How many videos decode side by side before it gets no faster (None: not measured)."""
    t0 = clock()
    cap = min(performance.MAX_ANALYSES, performance._ram_cap(hw, performance.RAM_PER_ANALYSIS_MB))
    trials: list[Trial] = []
    best: Trial | None = None
    for k in range(1, cap + 1):
        if trials and clock() - t0 + 1.5 * trials[-1].seconds > budget_s:
            break
        tr = measure(k)
        trials.append(tr)
        if tr.error or not tr.fps or (best and tr.fps < best.fps * MIN_GAIN):  # type: ignore[operator]
            break
        best = tr
    return (best.callers if best else None), trials


def recommend(best: Trial, hw: dict[str, Any], parallel: int | None = None) -> Perf:
    """Settings from the best trial. With a GPU, analyses share the detector: the CPU steps of one
    (decoding, tracking) overlap the other's detector calls; `parallel` is how many videos decoded
    side by side still got faster (default 2)."""
    gpu = hw.get("inference") in ("DirectML", "CUDA")
    cores = int(hw.get("cpuCores") or 1)
    ram_cap = performance._ram_cap(hw, performance.RAM_PER_ANALYSIS_MB)
    if gpu:
        analyses = max(best.sessions, best.callers, parallel or (2 if cores >= 4 else 1))
    else:
        analyses = 1   # the detector already uses every core
    analyses = max(1, min(performance.MAX_ANALYSES, analyses, ram_cap))
    ingests = performance.for_profile("max", hw).ingests
    return Perf(analyses=analyses, ingests=ingests, sessions=best.sessions, batch=best.batch, threads=best.threads)


def _frames(n: int = 3) -> list[np.ndarray]:
    demo = ROOT / "assets" / "demo" / "demo.mp4"
    try:
        from shottracer.video import decode, probe

        info = probe(demo)
        out = []
        for i, f in decode(info, start=int(info.fps * 2), stop=int(info.fps * 2) + n * 10):
            if i % 10 == 0:
                out.append(f.copy())
        if out:
            return out
    except Exception as exc:  # noqa: BLE001 - any picture will do
        log.info("tuner: demo frames unavailable (%s), using noise", exc)
    rng = np.random.default_rng(0)
    return [rng.integers(0, 255, (1080, 1920, 3), np.uint8) for _ in range(n)]


def _gpu_used() -> int | None:
    g = performance.gpus()
    return max(x["usedMb"] for x in g) if g else None


def measure_detector(frames: list[np.ndarray], gpu: bool = True) -> Measure:
    def measure(sessions: int, batch: int, callers: int) -> Trial:
        from shottracer.detect import OnnxRfDetrBallDetector
        from shottracer.runtime import Runtime

        t0 = time.perf_counter()
        tr = Trial(sessions, batch, callers)
        det = None
        try:
            det = OnnxRfDetrBallDetector(rt=Runtime(sessions=sessions, batch=batch, gpu=gpu))
            tr.provider = det.provider
            if det.sessions < sessions:
                raise RuntimeError(f"only {det.sessions} of {sessions} detector sessions could be created"
                                   + (f": {det.session_error}" if det.session_error else " (DirectML runs one)"))
            if batch > 1 and det.batch < batch:
                raise RuntimeError("the model takes one frame per call")
            det.CACHE = 0
            tr.dynamic = det.fixed_batch is None
            n = max(4, 2 * det.sessions * det.batch)
            imgs = [frames[i % len(frames)] for i in range(n)]
            det._raw_many(imgs[: det.sessions * det.batch])   # first runs allocate and compile

            def work(d: OnnxRfDetrBallDetector) -> int:
                done = 0
                while done < n or time.perf_counter() - t < MIN_TRIAL_S:
                    d._raw_many(imgs)
                    done += len(imgs)
                return done

            t = time.perf_counter()
            with ThreadPoolExecutor(max_workers=callers) as ex:
                done = sum(ex.map(work, [det] * callers))
            tr.fps = done / (time.perf_counter() - t)
            tr.vram_mb = _gpu_used() if gpu else None
        except Exception as exc:  # noqa: BLE001 - out of memory is an answer, not a crash
            tr.error = f"{type(exc).__name__}: {exc}"[:ERROR_CHARS]
        finally:
            del det
            gc.collect()
        tr.seconds = time.perf_counter() - t0
        if tr.error:
            log.warning("tuner: %d session(s) x batch %d, %d caller(s) failed: %s", sessions, batch, callers, tr.error)
        else:
            log.info("tuner: %d session(s) x batch %d, %d caller(s) on %s: %.2f frames/s, GPU memory %s MB", sessions, batch,
                     callers, tr.provider, tr.fps, tr.vram_mb)
        return tr

    return measure


def measure_decoding() -> Callable[[int], Trial]:
    """`k` decoders side by side on the demo clip at analysis size, as `k` analyses tracking shots."""
    def measure(k: int) -> Trial:
        from shottracer import runtime
        from shottracer.pipeline import ANALYSIS_LONG_SIDE
        from shottracer.video import decode, probe

        t0 = time.perf_counter()
        tr = Trial(0, 0, k, kind="decode")
        try:
            runtime.configure(runtime.Runtime())   # all threads, as the tuned profile (the next job sets its own)
            info = probe(ROOT / "assets" / "demo" / "demo.mp4")
            scale = min(1.0, ANALYSIS_LONG_SIDE / info.long_side)
            n = max(10, int(info.fps * 2))

            def work(i: int) -> int:
                done, start = 0, (i * n) % max(1, info.frame_count - n)
                while time.perf_counter() - t < MIN_TRIAL_S:
                    done += sum(1 for _ in decode(info, start=start, stop=start + n, scale=scale))
                    start = (start + n) % max(1, info.frame_count - n)
                return done

            t = time.perf_counter()
            with ThreadPoolExecutor(max_workers=k) as ex:
                done = sum(ex.map(work, range(k)))
            tr.fps = done / (time.perf_counter() - t)
        except Exception as exc:  # noqa: BLE001 - no ffmpeg or no demo clip: the default is used
            tr.error = f"{type(exc).__name__}: {exc}"[:ERROR_CHARS]
        tr.seconds = time.perf_counter() - t0
        log.info("tuner: %d video(s) decoded side by side: %s", k, f"{tr.fps:.1f} frames/s" if tr.fps else tr.error)
        return tr

    return measure


def run_tuner(report: Callable[[float, str], bool]) -> dict[str, Any]:
    import os

    if os.environ.get("GOLF_DETECTOR", "").strip().lower() not in ("", "rfdetr", "rf-detr", "rfdetr-onnx", "onnx"):
        raise ValueError("Optimise needs the default RF-DETR detector (ONNX).")
    from shottracer.detect import get_detector

    t_start = time.monotonic()
    if not report(0.02, "Looking at the hardware"):
        raise Canceled()
    hw = performance.hardware(refresh=True)
    _, data = performance.effective(hw)
    gpu = not data.get("cpuOnly")
    if not gpu:
        hw = {**hw, "inference": "CPU"}
    get_detector.cache_clear()   # measure from an empty GPU
    gc.collect()
    idle = _gpu_used() if gpu else None
    frames = _frames()
    base_measure = measure_detector(frames, gpu)
    done = [0]

    def measure(s: int, b: int, c: int) -> Trial:
        if not report(min(0.95, 0.1 + 0.12 * done[0]), f"Testing {s} session(s), {b} frame(s) per call, {c} at once"):
            raise Canceled()
        done[0] += 1
        return base_measure(s, b, c)

    base, best, trials, stop = search(measure, hw, idle_vram_mb=idle)
    if base.provider == "CPUExecutionProvider":
        hw = {**hw, "inference": "CPU"}   # DirectML/CUDA is installed but did not take the model
    parallel, decoding = None, []
    if hw.get("inference") in ("DirectML", "CUDA") and stop != "time":
        base_decode = measure_decoding()

        def decode_k(k: int) -> Trial:
            if not report(min(0.95, 0.1 + 0.12 * done[0]), f"Testing {k} video(s) decoded at once"):
                raise Canceled()
            done[0] += 1
            return base_decode(k)

        parallel, decoding = search_parallel(decode_k, hw, max(10.0, BUDGET_S - (time.monotonic() - t_start)))
        trials += decoding
    perf = recommend(best, hw, parallel)
    gpu_info = (hw.get("gpus") or [None])[0]
    summary = {
        "speedup": round(best.fps / base.fps, 2) if base.fps and best.fps else 1.0,
        "baseFps": round(base.fps or 0, 2), "bestFps": round(best.fps or 0, 2),
        "inference": hw.get("inference"), "gpu": gpu_info["name"] if gpu_info else None,
        "vramMb": gpu_info["vramMb"] if gpu_info else None, "peakVramMb": max((t.vram_mb or 0 for t in trials), default=0) or None,
        "cpuCores": hw.get("cpuCores"), "ramMb": (hw.get("ram") or {}).get("totalMb"),
        "dynamicBatch": base.dynamic, "stop": stop, "parallel": parallel, "seconds": round(time.monotonic() - t_start, 1),
        "trials": [asdict(t) for t in trials],
    }
    performance.save_tuned(perf, summary)
    log.info("tuner: %s -> %s (%.2fx, stopped: %s)", hw.get("inference"), perf, summary["speedup"], stop)
    return {"settings": asdict(perf), "summary": summary}

