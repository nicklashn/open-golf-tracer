"""ffmpeg helpers: GPU decode/encode with CPU fallback, HDR tone mapping, progress parsing."""
from __future__ import annotations

import functools
import re
import shutil
import subprocess
from collections.abc import Callable
from pathlib import Path


class Canceled(Exception):
    pass


def ffmpeg() -> str:
    exe = shutil.which("ffmpeg")
    if not exe:
        raise RuntimeError("ffmpeg was not found on PATH")
    return exe


@functools.cache
def has_filter(name: str) -> bool:
    out = subprocess.run([ffmpeg(), "-hide_banner", "-filters"], capture_output=True, text=True).stdout
    return re.search(rf"^\s*\S+\s+{re.escape(name)}\s", out, re.M) is not None


@functools.cache
def encoder_ok(codec: str) -> bool:
    cmd = [ffmpeg(), "-v", "error", "-f", "lavfi", "-i", "color=c=black:s=256x256:d=0.1", "-c:v", codec, "-f", "null", "-"]
    return subprocess.run(cmd, capture_output=True).returncode == 0


@functools.cache
def cuda_ok() -> bool:
    """CUDA frames -> scale_cuda -> NVENC works, so a proxy can be made without leaving the GPU."""
    if not (encoder_ok("h264_nvenc") and has_filter("scale_cuda") and has_filter("hwupload_cuda")):
        return False
    cmd = [ffmpeg(), "-v", "error", "-f", "lavfi", "-i", "color=c=black:s=320x240:d=0.1", "-vf", "format=nv12,hwupload_cuda,scale_cuda=256:192",
           "-c:v", "h264_nvenc", "-f", "null", "-"]
    return subprocess.run(cmd, capture_output=True).returncode == 0


def tonemap_filter() -> str:
    """HLG/PQ -> SDR BT.709 for previews and SDR exports."""
    if has_filter("zscale") and has_filter("tonemap"):
        return ("zscale=t=linear:npl=100,format=gbrpf32le,zscale=p=bt709,tonemap=tonemap=hable:desat=0,"
                "zscale=t=bt709:m=bt709:r=tv")
    if has_filter("colorspace"):
        return "colorspace=all=bt709:iall=bt2020:fast=1"
    return "null"


def h264_args(crf: int = 23, keyint: int | None = None, fast_decode: bool = False, preview: bool = False,
              cuda_frames: bool = False) -> list[str]:
    """preview: fastest x264 preset (a higher crf keeps the size of veryfast); cuda_frames: input is already on the GPU."""
    if cuda_frames or encoder_ok("h264_nvenc"):
        args = ["-c:v", "h264_nvenc", "-preset", "p4", "-rc", "vbr", "-cq", str(crf), "-b:v", "0", "-bf", "0"]
    elif preview:
        args = ["-c:v", "libx264", "-preset", "ultrafast", "-crf", str(crf + 7), "-bf", "0"]
    else:
        args = ["-c:v", "libx264", "-preset", "veryfast", "-crf", str(crf), "-bf", "0"]
    if fast_decode and "libx264" in args:
        args += ["-tune", "fastdecode"]
    if keyint:
        args += ["-g", str(keyint), "-keyint_min", str(keyint)]
        if "libx264" in args:
            args += ["-sc_threshold", "0"]
    return args if cuda_frames else [*args, "-pix_fmt", "yuv420p"]


def run(cmd: list[str], duration: float = 0.0, on_progress: Callable[[float], bool] | None = None) -> None:
    """Runs ffmpeg with -progress; on_progress(fraction) returning False cancels."""
    full = [cmd[0], "-hide_banner", "-nostdin", "-progress", "pipe:1", "-nostats", *cmd[1:]]
    proc = subprocess.Popen(full, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, encoding="utf-8", errors="replace")
    assert proc.stdout is not None
    try:
        for line in proc.stdout:
            if on_progress and duration > 0 and line.startswith("out_time_us="):
                try:
                    us = int(line.split("=", 1)[1])
                except ValueError:
                    continue
                if not on_progress(min(1.0, us / 1e6 / duration)):
                    proc.kill()
                    raise Canceled()
        err = proc.stderr.read() if proc.stderr else ""
        if proc.wait() != 0:
            raise RuntimeError(f"ffmpeg fejlede: {err.strip()[-1500:]}")
    finally:
        if proc.poll() is None:
            proc.kill()


def hwaccel_args() -> list[str]:
    return ["-hwaccel", "auto"]


def file_size(p: Path) -> int:
    return p.stat().st_size if p.exists() else 0
