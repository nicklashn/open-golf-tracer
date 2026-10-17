"""How ffmpeg decodes the video frames the engine reads (video.decode): on the CPU or on the GPU.

Methods:
- "sw": software decoding on the CPU (no -hwaccel);
- "auto": ffmpeg picks a GPU decoder itself and silently uses the CPU when none works (the
  behaviour before Optimise measured anything, kept as the default);
- "d3d11va", "dxva2" (Windows, any GPU vendor), "cuda" (NVIDIA NVDEC), "qsv" (Intel), "vaapi"
  (Linux): that GPU decoder, frames copied back to memory, then crop, scale, colour conversion
  and rotation in software exactly as with "sw", so the frames have the same size and
  orientation and practically the same pixels.

A GPU decoder is used only when Optimise measured it faster (performance.json "decoder"). If it
fails on a video (ffmpeg exits with an error, no frames, fewer frames than expected) the decode
carries on in software from where it stopped, and the method is remembered as broken for that
codec and pixel format for the rest of the process (and reported to listeners, which the worker
uses to save it), so it is not tried again on every segment.

Not used: GPU scaling (scale_cuda/scale_d3d11). The analysis size of a 1080p clip is its own
size, so there is nothing to scale on the main path, and those filters' kernels do not average
for the big reductions the cheap scans use (1920 -> 192 px), which would change their numbers.
"""
from __future__ import annotations

import contextlib
import functools
import logging
import subprocess
import sys
import threading
from collections.abc import Callable, Iterable

log = logging.getLogger("shottracer.decode")

SW, AUTO = "sw", "auto"
HW_METHODS = ("d3d11va", "cuda", "dxva2", "qsv", "vaapi")
METHODS = (SW, AUTO, *HW_METHODS)
PLATFORM_METHODS = {"win32": ("d3d11va", "cuda", "dxva2", "qsv"), "linux": ("cuda", "vaapi", "qsv")}
LABELS = {SW: "CPU", AUTO: "auto"}   # the others are shown by name


def input_args(method: str) -> list[str]:
    """ffmpeg arguments before -i for a method."""
    if method == SW or method not in METHODS:
        return []
    return ["-hwaccel", method]


def failure_key(method: str, codec: str, pix_fmt: str) -> str:
    return f"{method}:{codec or '?'}:{pix_fmt or '?'}"


_lock = threading.Lock()
_failed: dict[str, str] = {}
_listeners: list[Callable[[str, str], None]] = []
_muted = 0


def on_failure(fn: Callable[[str, str], None]) -> None:
    """fn(key, reason) is called once per newly broken method/codec (e.g. to save it)."""
    with _lock:
        if fn not in _listeners:
            _listeners.append(fn)


def record_failure(method: str, codec: str, pix_fmt: str, reason: str) -> None:
    key = failure_key(method, codec, pix_fmt)
    with _lock:
        if key in _failed:
            return
        _failed[key] = reason
        listeners = [] if _muted else list(_listeners)
    log.warning("GPU decoding (%s) failed for %s, using the CPU from now on: %s", method, key, reason.splitlines()[0][:300] if reason else "")
    for fn in listeners:
        try:
            fn(key, reason)
        except Exception:  # noqa: BLE001 - saving the note must never break the decode
            log.exception("decode failure listener")


@contextlib.contextmanager
def muted():
    """Failures inside are remembered but not reported (Optimise trying decoders on purpose)."""
    global _muted
    with _lock:
        _muted += 1
    try:
        yield
    finally:
        with _lock:
            _muted -= 1


def failed() -> dict[str, str]:
    with _lock:
        return dict(_failed)


def reset() -> None:
    """Forget the failures of this process (tests, a new Optimise)."""
    with _lock:
        _failed.clear()


def choose(preferred: str, codec: str, pix_fmt: str, known_bad: Iterable[str] = ()) -> str:
    """The method to use for a video: the preferred one unless it failed for this codec before."""
    if preferred not in METHODS:
        return AUTO
    if preferred in HW_METHODS:
        key = failure_key(preferred, codec, pix_fmt)
        with _lock:
            bad = key in _failed
        if bad or key in set(known_bad):
            return SW
    return preferred


def parse_hwaccels(text: str) -> list[str]:
    """`ffmpeg -hide_banner -hwaccels` -> the method names listed."""
    out = []
    for line in text.splitlines():
        name = line.strip()
        if name and " " not in name and not name.endswith(":"):
            out.append(name)
    return out


@functools.cache
def compiled(ffmpeg: str) -> tuple[str, ...]:
    """GPU decoders this ffmpeg was built with (whether the PC has the hardware is another matter)."""
    try:
        text = subprocess.run([ffmpeg, "-hide_banner", "-hwaccels"], capture_output=True, text=True, timeout=20).stdout
    except (OSError, subprocess.SubprocessError):
        return ()
    return tuple(parse_hwaccels(text))


def candidates(ffmpeg: str, platform: str | None = None) -> list[str]:
    """GPU decoders worth measuring on this platform, best first."""
    have = set(compiled(ffmpeg))
    return [m for m in PLATFORM_METHODS.get(platform or sys.platform, ()) if m in have]


@functools.cache
def device_ok(ffmpeg: str, method: str) -> bool:
    """This PC has the device for a GPU decoder (ffmpeg can open it): qsv needs an Intel GPU,
    cuda an NVIDIA one, vaapi a render node. Cheap: no video is decoded."""
    cmd = [ffmpeg, "-v", "error", "-init_hw_device", method, "-f", "lavfi", "-i", "nullsrc=s=64x64:d=0.04", "-frames:v", "1", "-f", "null", "-"]
    try:
        return subprocess.run(cmd, capture_output=True, timeout=20).returncode == 0
    except (OSError, subprocess.SubprocessError):
        return False


def usable(ffmpeg: str, platform: str | None = None) -> list[str]:
    """candidates() whose device this PC has: the others would only fail (e.g. qsv without an
    Intel GPU), so they are not measured."""
    out = []
    for m in candidates(ffmpeg, platform):
        if device_ok(ffmpeg, m):
            out.append(m)
        else:
            log.info("GPU decoder %s skipped: no such device on this PC", m)
    return out
