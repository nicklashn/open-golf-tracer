"""Video/audio I/O: frame iteration, audio extraction and an ffmpeg-backed writer."""
from __future__ import annotations

import functools
import json
import os
import shutil
import subprocess
import threading
from dataclasses import dataclass
from pathlib import Path

import cv2
import numpy as np

from . import runtime


def ffmpeg_bin() -> str:
    exe = shutil.which("ffmpeg")
    if not exe:
        raise RuntimeError("ffmpeg was not found on PATH")
    return exe


@dataclass
class VideoInfo:
    path: Path
    width: int
    height: int
    fps: float
    frame_count: int
    pix_fmt: str = "yuv420p"
    color: dict | None = None        # primaries/transfer/space tags to carry over

    @property
    def duration(self) -> float:
        return self.frame_count / self.fps

    @property
    def hdr(self) -> bool:
        return bool(self.color) and self.color.get("color_trc") in ("arib-std-b67", "smpte2084")

    @property
    def long_side(self) -> int:
        return max(self.width, self.height)

    @property
    def diag(self) -> float:
        return float(np.hypot(self.width, self.height))


def _open(path: Path) -> cv2.VideoCapture:
    cap = cv2.VideoCapture(str(path))
    if not cap.isOpened():
        raise RuntimeError(f"Cannot open video: {path}")
    return cap


def probe(path: Path) -> VideoInfo:
    cap = _open(path)
    ok, frame = cap.read()
    if not ok:
        raise RuntimeError(f"Cannot read frames from: {path}")
    fps = cap.get(cv2.CAP_PROP_FPS) or 30.0
    n = int(cap.get(cv2.CAP_PROP_FRAME_COUNT) or 0)
    cap.release()
    h, w = frame.shape[:2]  # frame shape reflects auto-rotation, unlike CAP_PROP_FRAME_WIDTH
    info = VideoInfo(Path(path), w, h, float(fps), n)
    ffprobe = shutil.which("ffprobe")
    if ffprobe:
        out = subprocess.run([ffprobe, "-v", "error", "-select_streams", "v:0", "-show_entries",
                              "stream=pix_fmt,color_primaries,color_transfer,color_space", "-of", "json", str(path)],
                             capture_output=True, text=True).stdout
        try:
            st = json.loads(out)["streams"][0]
            info.pix_fmt = st.get("pix_fmt", info.pix_fmt)
            tags = {"color_primaries": st.get("color_primaries"), "color_trc": st.get("color_transfer"),
                    "colorspace": st.get("color_space")}
            info.color = {k: v for k, v in tags.items() if v and v != "unknown"}
        except (ValueError, KeyError, IndexError):
            pass
    return info


def read_frame(info: VideoInfo, index: int) -> np.ndarray | None:
    """One display-oriented BGR frame. In-process (PyAV) when possible: starting an ffmpeg
    process per frame cost ~1 s each on Windows, ~15x slower than seeking in an open file."""
    if not (info.hdr and sdr_for_analysis()):
        try:
            return _reader(str(info.path)).frame(index, info.fps)
        except Exception:  # noqa: BLE001 - PyAV missing or the file confuses it: use ffmpeg
            pass
    for _, f in decode(info, start=index, stop=index + 1):
        return f.copy()
    return None


class _FrameReader:
    """An open container for random frame access (seek to the keyframe, decode forward)."""

    _ROTATE = {90: cv2.ROTATE_90_COUNTERCLOCKWISE, -90: cv2.ROTATE_90_CLOCKWISE, 270: cv2.ROTATE_90_CLOCKWISE,
               -270: cv2.ROTATE_90_COUNTERCLOCKWISE, 180: cv2.ROTATE_180, -180: cv2.ROTATE_180}

    def __init__(self, path: str):
        import av

        self.container = av.open(path)
        self.stream = self.container.streams.video[0]
        self.stream.thread_type = "AUTO"
        self.lock = threading.Lock()

    def frame(self, index: int, fps: float) -> np.ndarray | None:
        t = index / fps
        half = 0.5 / fps
        s = self.stream
        with self.lock:
            self.container.seek(max(0, int((t - half) / float(s.time_base))), stream=s, backward=True)
            for f in self.container.decode(s):
                if f.time is not None and f.time >= t - half:
                    img = f.to_ndarray(format="bgr24")
                    rot = self._ROTATE.get(int(round(getattr(f, "rotation", 0) or 0)))
                    return cv2.rotate(img, rot) if rot is not None else img
        return None

    def close(self) -> None:
        self.container.close()


_local = threading.local()


def _reader(path: str) -> _FrameReader:
    """An open file per thread: analyses running side by side never share (or close) one."""
    readers: dict[str, _FrameReader] = _local.__dict__.setdefault("readers", {})
    r = readers.get(path)
    if r is None:
        while len(readers) >= 2:                      # a thread sees one video at a time
            readers.pop(next(iter(readers))).close()
        r = readers[path] = _FrameReader(path)
    return r


# HDR (iPhone HLG, PQ) is analysed as the raw signal by default, like the original engine:
# tone-mapping made a real iPhone HLG clip lose the ball (YOLO found nothing, the blob fallback
# locked onto a 1.5 px speck). GOLF_HDR_TONEMAP=1 tone-maps to SDR before analysis instead.
SDR_TONEMAP = ("zscale=t=linear:npl=100,format=gbrpf32le,zscale=p=bt709,tonemap=tonemap=hable:desat=0,"
               "zscale=t=bt709:m=bt709:r=tv")


@functools.cache
def sdr_for_analysis() -> bool:
    if os.environ.get("GOLF_HDR_TONEMAP", "0") != "1":
        return False
    out = subprocess.run([ffmpeg_bin(), "-hide_banner", "-filters"], capture_output=True, text=True).stdout
    return " zscale " in out and " tonemap " in out


def decode(info: VideoInfo, start: int = 0, stop: int | None = None,
           crop: tuple[int, int, int, int] | None = None, scale: float = 1.0, gray: bool = False,
           rate: float | None = None):
    """Yield (index, frame) via an ffmpeg pipe – GPU decoding, crop and resize happen in ffmpeg.

    crop = (x, y, w, h) in display (rotated) pixels; scale applies after the crop. With `rate`
    the frames are resampled to that many per second (the index then counts samples from
    `start`, `rate` per second) and `stop` limits the duration.
    """
    w, h = (crop[2], crop[3]) if crop else (info.width, info.height)
    filters = [f"fps={rate:g}"] if rate else []
    if crop:
        filters.append(f"crop={crop[2]}:{crop[3]}:{crop[0]}:{crop[1]}")
    if scale != 1.0:
        w, h = max(2, int(round(w * scale / 2)) * 2), max(2, int(round(h * scale / 2)) * 2)
        filters.append(f"scale={w}:{h}:flags=area")
    if info.hdr and sdr_for_analysis():
        filters.append(SDR_TONEMAP)
    pix = "gray" if gray else "bgr24"
    filters.append(f"format={pix}")
    cmd = [ffmpeg_bin(), "-v", "error", "-hwaccel", "auto"]
    if runtime.current().threads:
        cmd += ["-threads", str(runtime.current().threads)]
    if start > 0:
        cmd += ["-ss", f"{(start - 0.5) / info.fps:.6f}"]
    cmd += ["-i", str(info.path)]
    if stop is not None:
        cmd += ["-t", f"{(stop - start) / info.fps:.6f}"] if rate else ["-frames:v", str(stop - start)]
    cmd += ["-an", "-sn", "-dn", "-fps_mode", "passthrough", "-vf", ",".join(filters),
            "-f", "rawvideo", "-pix_fmt", pix, "-"]
    ch = 1 if gray else 3
    size = w * h * ch
    proc = subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, bufsize=size * 4)
    try:
        i = start
        while True:
            buf = proc.stdout.read(size)
            if len(buf) < size:
                break
            frame = np.frombuffer(buf, np.uint8).reshape((h, w) if gray else (h, w, 3))
            yield i, frame
            i += 1
    finally:
        proc.stdout.close()
        proc.kill()
        proc.wait()


def load_audio(path: Path, sr: int = 22050) -> tuple[np.ndarray, int] | None:
    cmd = [ffmpeg_bin(), "-v", "error", "-i", str(path), "-vn", "-ac", "1",
           "-ar", str(sr), "-f", "s16le", "-"]
    out = subprocess.run(cmd, capture_output=True).stdout
    if len(out) < sr // 10:
        return None
    return np.frombuffer(out, np.int16).astype(np.float32) / 32768.0, sr


@functools.cache
def _nvenc_ok(codec: str) -> bool:
    cmd = [ffmpeg_bin(), "-v", "error", "-f", "lavfi", "-i", "color=c=black:s=256x256:d=0.1",
           "-c:v", codec, "-f", "null", "-"]
    return subprocess.run(cmd, capture_output=True).returncode == 0


def _encoder_args(info: VideoInfo) -> list[str]:
    if info.hdr:
        # Keep 10-bit HDR (e.g. iPhone HLG) instead of flattening it to SDR.
        args = (["-c:v", "hevc_nvenc", "-preset", "p5", "-rc", "vbr", "-cq", "20", "-b:v", "0", "-profile:v", "main10"]
                if _nvenc_ok("hevc_nvenc") else ["-c:v", "libx265", "-preset", "fast", "-crf", "20"])
        args += ["-pix_fmt", "p010le", "-tag:v", "hvc1"]
        for k, v in (info.color or {}).items():
            args += [f"-{k}", v]
        return args
    args = (["-c:v", "h264_nvenc", "-preset", "p5", "-rc", "vbr", "-cq", "19", "-b:v", "0"]
            if _nvenc_ok("h264_nvenc") else ["-c:v", "libx264", "-preset", "veryfast", "-crf", "18"])
    return args + ["-pix_fmt", "yuv420p"]


class OverlayCompositor:
    """ffmpeg decodes/encodes the full video; we only stream a small RGBA overlay.

    The overlay covers a fixed box (x, y, w, h) and starts at `start_time`. After the
    last overlay frame ffmpeg keeps showing it (eof_action=repeat). An optional still
    image (stats card) fades in at `still_at`. The source is extended by `hold`
    seconds of its last frame so the flight can finish.
    """

    def __init__(self, info: VideoInfo, out: Path, box: tuple[int, int, int, int], start_time: float,
                 hold: float = 0.0, still: Path | None = None, still_at: float = 0.0,
                 still_pos: tuple[int, int] = (0, 0)):
        x, y, w, h = box
        fps = info.fps
        cmd = [ffmpeg_bin(), "-y", "-v", "error", "-i", str(info.path),
               "-f", "rawvideo", "-pix_fmt", "rgba", "-s", f"{w}x{h}", "-r", f"{fps:.6f}", "-i", "-"]
        base = "[0:v]setpts=PTS-STARTPTS"
        if hold > 0:
            base += f",tpad=stop_mode=clone:stop_duration={hold:.3f}"
        graph = [f"{base}[base]",
                 f"[1:v]setpts=PTS-STARTPTS+{start_time:.6f}/TB[ov]",
                 f"[base][ov]overlay=x={x}:y={y}:eof_action=repeat:format=auto[v1]"]
        last = "v1"
        if still is not None:
            cmd += ["-loop", "1", "-framerate", f"{fps:.6f}", "-t", f"{info.duration + hold + 1:.3f}", "-i", str(still)]
            graph += [f"[2:v]format=rgba,fade=t=in:st={still_at:.3f}:d=0.5:alpha=1[st]",
                      f"[v1][st]overlay=x={still_pos[0]}:y={still_pos[1]}:enable='gte(t,{still_at:.3f})':format=auto[v2]"]
            last = "v2"
        cmd += ["-filter_complex", ";".join(graph), "-map", f"[{last}]", "-map", "0:a?",
                "-c:a", "aac", "-b:a", "192k"] + _encoder_args(info) + ["-movflags", "+faststart", str(out)]
        self.size = w * h * 4
        self.proc = subprocess.Popen(cmd, stdin=subprocess.PIPE, stderr=subprocess.PIPE)

    def write(self, rgba: np.ndarray) -> None:
        self.proc.stdin.write(np.ascontiguousarray(rgba).tobytes())

    def close(self) -> None:
        self.proc.stdin.close()
        err = self.proc.stderr.read().decode(errors="replace")
        if self.proc.wait() != 0:
            raise RuntimeError(f"ffmpeg failed: {err.strip()}")
