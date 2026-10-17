"""Optimise (Settings → Performance): a short benchmark of the ball detector on this PC.

It runs the detector on a few frames with more and more frames per call (when the model allows)
and, on a GPU, sessions side by side, watching frames per second and GPU memory, and stops at the first of:
an error (e.g. out of memory), GPU memory above VRAM_LIMIT, no real gain, or the time budget.
The best safe step is saved as the "Tuned for this PC" profile.
"""
from __future__ import annotations

import gc
import logging
import time
from collections.abc import Callable
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
SESSIONS = (2, 3, 4)
MIN_TRIAL_S = 2.0        # each trial runs at least this long (steadier numbers)


@dataclass
class Trial:
    sessions: int
    batch: int
    threads: int = 0
    fps: float | None = None       # frames per second through the detector
    vram_mb: int | None = None     # GPU memory in use while the sessions were loaded
    error: str | None = None
    seconds: float = 0.0
    dynamic: bool = False          # the model takes more than one frame per call


Measure = Callable[[int, int, int], Trial]


def search(measure: Measure, hw: dict[str, Any], dynamic_batch: bool | None = None, budget_s: float = BUDGET_S,
           clock: Callable[[], float] = time.monotonic, idle_vram_mb: int | None = None) -> tuple[Trial, Trial, list[Trial], str]:
    """(baseline, best, every trial, why it stopped). The baseline is Balanced: 1 session, 1 frame."""
    t0 = clock()
    gpu = hw.get("inference") in ("DirectML", "CUDA")
    total = max((g["vramMb"] for g in hw.get("gpus") or []), default=0)
    limit = performance.VRAM_LIMIT * total if gpu and total else None
    base = measure(1, 1, 0)
    trials = [base]
    if base.error or not base.fps:
        raise RuntimeError(f"The detector does not run: {base.error}")
    if dynamic_batch is None:
        dynamic_batch = base.dynamic
    if limit and base.vram_mb and base.vram_mb > limit:
        return base, base, trials, "vram"
    best = base
    # GPU memory one more session (or a bigger batch) is likely to cost.
    step_mb = (base.vram_mb - idle_vram_mb) if base.vram_mb is not None and idle_vram_mb is not None else None

    def attempt(sessions: int, batch: int, threads: int) -> str | None:
        nonlocal best
        last = trials[-1]
        if clock() - t0 + 1.5 * last.seconds > budget_s:
            return "time"
        if limit and last.vram_mb is not None and step_mb is not None and last.vram_mb + step_mb > limit:
            return "vram"            # stop before trying a step that would not fit
        tr = measure(sessions, batch, threads)
        trials.append(tr)
        if tr.error:
            return "error"
        if limit and tr.vram_mb is not None and tr.vram_mb > limit:
            return "vram"
        if not tr.fps or tr.fps < best.fps * MIN_GAIN:  # type: ignore[operator]
            return "no_gain"
        best = tr
        return None

    stop = "done"
    if dynamic_batch:
        for b in BATCHES:
            if (stop := attempt(1, b, 0)) is not None:
                break
        if stop in ("time", "error", "vram"):
            return base, best, trials, stop
        stop = "done"
    if not gpu:
        # On the CPU, sessions side by side only split the same cores: in a real analysis (decoding,
        # tracking) two sessions of 2 threads were slower than one of 4 (60 -> 75 s on 4 cores).
        return base, best, trials, "cpu"
    for s in SESSIONS:
        if (stop := attempt(s, best.batch, 0)) is not None:
            break
    return base, best, trials, stop or "done"


def recommend(best: Trial, hw: dict[str, Any]) -> Perf:
    """Settings from the best trial. With a GPU, two analyses can share one session: the CPU
    steps of one overlap the other's detector calls."""
    gpu = hw.get("inference") in ("DirectML", "CUDA")
    cores = int(hw.get("cpuCores") or 1)
    ram_cap = performance._ram_cap(hw, performance.RAM_PER_ANALYSIS_MB)
    if gpu:
        analyses = max(best.sessions, 2 if cores >= 4 else 1)
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
    def measure(sessions: int, batch: int, threads: int) -> Trial:
        from shottracer.detect import OnnxRfDetrBallDetector
        from shottracer.runtime import Runtime

        t0 = time.perf_counter()
        tr = Trial(sessions, batch, threads)
        det = None
        try:
            det = OnnxRfDetrBallDetector(rt=Runtime(sessions=sessions, batch=batch, threads=threads, gpu=gpu))
            if det.sessions < sessions:
                raise RuntimeError(f"only {det.sessions} of {sessions} detector sessions could be created (out of memory)")
            if batch > 1 and det.batch < batch:
                raise RuntimeError("the model takes one frame per call")
            det.CACHE = 0
            tr.dynamic = det.fixed_batch is None
            n = max(4, 2 * det.sessions * det.batch)
            imgs = [frames[i % len(frames)] for i in range(n)]
            det._raw_many(imgs[: det.sessions * det.batch])   # first runs allocate and compile
            t, done = time.perf_counter(), 0
            while done < n or time.perf_counter() - t < MIN_TRIAL_S:
                det._raw_many(imgs)
                done += len(imgs)
            tr.fps = done / (time.perf_counter() - t)
            tr.vram_mb = _gpu_used() if gpu else None
        except Exception as exc:  # noqa: BLE001 - out of memory is an answer, not a crash
            tr.error = f"{type(exc).__name__}: {exc}"[:300]
        finally:
            del det
            gc.collect()
        tr.seconds = time.perf_counter() - t0
        log.info("tuner: %d session(s) x batch %d, %d threads: %s", sessions, batch, threads,
                 f"{tr.fps:.2f} frames/s, GPU memory {tr.vram_mb} MB" if tr.fps else tr.error)
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

    def measure(s: int, b: int, t: int) -> Trial:
        if not report(min(0.95, 0.1 + 0.12 * done[0]), f"Testing {s} session(s), {b} frame(s) per call"):
            raise Canceled()
        done[0] += 1
        return base_measure(s, b, t)

    base, best, trials, stop = search(measure, hw, idle_vram_mb=idle)
    perf = recommend(best, hw)
    gpu_info = (hw.get("gpus") or [None])[0]
    summary = {
        "speedup": round(best.fps / base.fps, 2) if base.fps and best.fps else 1.0,
        "baseFps": round(base.fps or 0, 2), "bestFps": round(best.fps or 0, 2),
        "inference": hw.get("inference"), "gpu": gpu_info["name"] if gpu_info else None,
        "vramMb": gpu_info["vramMb"] if gpu_info else None, "peakVramMb": max((t.vram_mb or 0 for t in trials), default=0) or None,
        "cpuCores": hw.get("cpuCores"), "ramMb": (hw.get("ram") or {}).get("totalMb"),
        "dynamicBatch": base.dynamic, "stop": stop, "seconds": round(time.monotonic() - t_start, 1),
        "trials": [asdict(t) for t in trials],
    }
    performance.save_tuned(perf, summary)
    log.info("tuner: %s -> %s (%.2fx, stopped: %s)", hw.get("inference"), perf, summary["speedup"], stop)
    return {"settings": asdict(perf), "summary": summary}

