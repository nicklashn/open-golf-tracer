"""How hard the engine may push the machine: detector sessions, frames per inference call and
CPU threads. The worker sets it from the performance profile before each job (configure)."""
from __future__ import annotations

import os
import threading
from dataclasses import dataclass


@dataclass(frozen=True)
class Runtime:
    sessions: int = 1     # detector sessions: inference calls that may run at the same time
    batch: int = 1        # frames per inference call (only for a model with a dynamic batch dimension)
    threads: int = 0      # CPU threads for inference, OpenCV and frame decoding; 0 = all cores
    gpu: bool = True      # False: the detector stays on the CPU (after GPU errors)
    decoder: str = "auto"  # how ffmpeg decodes video (hwdecode.METHODS); "auto": ffmpeg's own pick
    decode_failed: tuple[str, ...] = ()   # GPU decoder/codec pairs that failed before (hwdecode.failure_key)


_lock = threading.Lock()
_current = Runtime()


def configure(rt: Runtime) -> None:
    global _current
    with _lock:
        if rt == _current:
            return
        _current = rt
    import cv2

    cv2.setNumThreads(rt.threads or -1)   # -1: OpenCV's default (all cores)


def current() -> Runtime:
    return _current


def cpu_workers(cap: int = 16) -> int:
    n = os.cpu_count() or 4
    return max(1, min(cap, _current.threads or n))
