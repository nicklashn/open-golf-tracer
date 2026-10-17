"""Video/audio I/O: frame iteration, audio extraction and an ffmpeg-backed writer."""
from __future__ import annotations

import collections
import fractions
import functools
import json
import math
import os
import shutil
import subprocess
import tempfile
import threading
from dataclasses import dataclass
from pathlib import Path

import cv2
import numpy as np

from . import hwdecode, runtime


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
    codec: str = ""                  # e.g. h264, hevc (which GPU decoders work depends on it)
    rotation: int = 0                # display rotation in the file (width/height are already rotated)

    @property
    def duration(self) -> float:
        return self.frame_count / self.fps

    @property
    def rate(self) -> fractions.Fraction:
        """The frame rate as the exact fraction ffmpeg is given (30000/1001, not 29.97...)."""
        return frame_rate(self.fps)

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
                              "stream=codec_name,pix_fmt,color_primaries,color_transfer,color_space:stream_side_data=rotation",
                              "-of", "json", str(path)],
                             capture_output=True, text=True).stdout
        try:
            st = json.loads(out)["streams"][0]
            info.pix_fmt = st.get("pix_fmt", info.pix_fmt)
            info.codec = str(st.get("codec_name") or "")
            info.rotation = parse_rotation(st)
            tags = {"color_primaries": st.get("color_primaries"), "color_trc": st.get("color_transfer"),
                    "colorspace": st.get("color_space")}
            info.color = {k: v for k, v in tags.items() if v and v != "unknown"}
        except (ValueError, KeyError, IndexError):
            pass
    return info


def parse_rotation(stream: dict) -> int:
    """Display rotation (degrees) from an ffprobe stream: side data (new) or the rotate tag (old)."""
    for sd in stream.get("side_data_list") or []:
        if "rotation" in sd:
            try:
                return int(round(float(sd["rotation"])))
            except (TypeError, ValueError):
                return 0
    try:
        return int((stream.get("tags") or {}).get("rotate", 0))
    except (TypeError, ValueError):
        return 0


def frame_rate(fps: float) -> fractions.Fraction:
    return fractions.Fraction(fps).limit_denominator(100_000)


# Frame i of a video is the picture shown at i / fps seconds after the file's start, on a
# constant-rate grid at the probed fps, both in decode() and in read_frame(): of the frames whose
# time rounds to slot i, the last one; with none (a variable-rate phone clip filming slower in low
# light), the one before it, shown again. ffmpeg's fps filter does exactly this, and read_frame
# picks the same frame, so the times of strikes, tracks and putts line up on any clip.


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


FORWARD_S = 2.0   # a frame at most this far ahead is decoded on to, not sought (unless a keyframe comes sooner)
SEEK_PAD = 2      # slots sought before the one wanted, so a gap in a variable-rate clip finds the frame before it


class _FrameReader:
    """An open container for random frame access (seek to the keyframe, decode forward; a frame
    shortly after the last one read is decoded on to without seeking)."""

    _ROTATE = {90: cv2.ROTATE_90_COUNTERCLOCKWISE, -90: cv2.ROTATE_90_CLOCKWISE, 270: cv2.ROTATE_90_CLOCKWISE,
               -270: cv2.ROTATE_90_COUNTERCLOCKWISE, 180: cv2.ROTATE_180, -180: cv2.ROTATE_180}

    def __init__(self, path: str):
        import av

        self.container = av.open(path)
        self.stream = self.container.streams.video[0]
        self.stream.thread_type = "AUTO"
        self.lock = threading.Lock()
        self.tb = fractions.Fraction(self.stream.time_base)
        # Times count from the file's start, as ffmpeg's (-start_at_zero) do: an MPEG-TS clip
        # or a trimmed phone video may start at 1.4 s.
        start = self.container.start_time or 0
        self.origin = _round_near(fractions.Fraction(start, 1_000_000) / self.tb)
        self._frames = None            # the decoder after the last seek
        self._cur = None               # the last frame read from it that was before the slot asked for
        self._next = None              # the frame after that, already decoded
        self._last_key: int | None = None
        self._gop: float | None = None  # longest keyframe distance seen (seconds)

    def _slot_below(self, pts: int, rate: fractions.Fraction, bound: fractions.Fraction) -> bool:
        """True when a frame at `pts` falls in a slot before `bound` (slot + 1/2)."""
        return (pts - self.origin) * self.tb * rate < bound

    def _pull(self):
        assert self._frames is not None
        for f in self._frames:
            if f.pts is None:
                continue
            if f.key_frame:
                if self._last_key is not None and f.pts > self._last_key:
                    self._gop = max(self._gop or 0.0, float((f.pts - self._last_key) * self.tb))
                self._last_key = f.pts
            return f
        return None

    def frame(self, index: int, fps: float) -> np.ndarray | None:
        rate = frame_rate(fps)
        bound = fractions.Fraction(2 * index + 1, 2)
        with self.lock:
            pts = self._cur.pts if self._cur is not None else None
            ahead = (index - float((pts - self.origin) * self.tb * rate)) / float(rate) if pts is not None else math.inf
            if not (pts is not None and self._slot_below(pts, rate, bound) and ahead <= min(FORWARD_S, self._gop or FORWARD_S)):
                t = fractions.Fraction(index - SEEK_PAD, 1) / rate - fractions.Fraction(1, 2) / rate
                target = self.origin + math.floor(max(fractions.Fraction(0), t) / self.tb)
                self.container.seek(int(target), stream=self.stream, backward=True)
                self._frames = self.container.decode(self.stream)
                self._cur = self._next = None
                self._last_key = None
            try:
                while True:
                    f = self._next if self._next is not None else self._pull()
                    self._next = None
                    if f is None:
                        break
                    if self._slot_below(f.pts, rate, bound):
                        self._cur = f
                        continue
                    self._next = f
                    break
            except Exception:
                self._cur = self._next = None   # seek again next time
                raise
            f = self._cur if self._cur is not None else self._next   # before the first frame: the first one
            if f is None:
                return None
            img = f.to_ndarray(format="bgr24")
            rot = self._ROTATE.get(int(round(getattr(f, "rotation", 0) or 0)))
            return cv2.rotate(img, rot) if rot is not None else img

    def close(self) -> None:
        self.container.close()


def _round_near(x: fractions.Fraction) -> int:
    """Rounds half away from zero, as ffmpeg does (AV_ROUND_NEAR_INF)."""
    return int(math.floor(x + fractions.Fraction(1, 2))) if x >= 0 else -int(math.floor(-x + fractions.Fraction(1, 2)))


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


class DecodeError(RuntimeError):
    """ffmpeg ended with an error while decoding (used to fall back from GPU decoding)."""


def decode_plan(info: VideoInfo, crop: tuple[int, int, int, int] | None = None, scale: float = 1.0, gray: bool = False,
                start: int = 0, every: int = 1, phase: int = 0) -> tuple[list[str], tuple[int, ...], str]:
    """(filters, frame shape, pixel format) for decode()."""
    w, h = (crop[2], crop[3]) if crop else (info.width, info.height)
    # The constant-rate grid (see read_frame), counted from the file's start (-copyts
    # -start_at_zero, start_time=0); trim drops the slots before `start` and select keeps every
    # `every`-th slot counted from `phase`. Both run before the pixels are touched.
    filters = [f"fps={info.rate}:start_time=0:round=near"]
    if start > 0:
        filters.append(f"trim=start_pts={start}")
    if every > 1:
        filters.append(f"select='not(mod(n+{(start - phase) % every},{every}))'")
    if crop:
        filters.append(f"crop={crop[2]}:{crop[3]}:{crop[0]}:{crop[1]}")
    if scale != 1.0:
        w, h = max(2, int(round(w * scale / 2)) * 2), max(2, int(round(h * scale / 2)) * 2)
        filters.append(f"scale={w}:{h}:flags=area")
    if info.hdr and sdr_for_analysis():
        filters.append(SDR_TONEMAP)
    pix = "gray" if gray else "bgr24"
    filters.append(f"format={pix}")
    return filters, ((h, w) if gray else (h, w, 3)), pix


def picked(start: int, stop: int | None, every: int = 1, phase: int = 0) -> range | None:
    """The frame indices decode() yields for these arguments (None: to the end of the file)."""
    first = start + (phase - start) % every
    return range(first, stop, every) if stop is not None else None


def decode_cmd(info: VideoInfo, method: str = hwdecode.AUTO, start: int = 0, stop: int | None = None,
               crop: tuple[int, int, int, int] | None = None, scale: float = 1.0, gray: bool = False,
               every: int = 1, phase: int = 0, threads: int = 0, exe: str = "ffmpeg") -> tuple[list[str], tuple[int, ...]]:
    """The ffmpeg command decode() runs, and the shape of each frame it writes.

    Every method decodes to frames in memory and then crops, scales, converts and rotates them
    in software (ffmpeg's autorotation), so the frames are the same size and orientation
    whichever decoder made them."""
    filters, shape, pix = decode_plan(info, crop, scale, gray, start, every, phase)
    cmd = [exe, "-v", "error", *hwdecode.input_args(method)]
    if threads:
        cmd += ["-threads", str(threads)]
    if start > SEEK_PAD:   # a little early: the frames before `start` only pass the grid, which trim drops
        cmd += ["-ss", f"{(start - SEEK_PAD - 0.5) / info.fps:.6f}"]
    cmd += ["-copyts", "-start_at_zero", "-i", str(info.path)]
    if stop is not None:
        cmd += ["-frames:v", str(len(picked(start, stop, every, phase) or ()))]
    cmd += ["-an", "-sn", "-dn", "-fps_mode", "passthrough", "-vf", ",".join(filters),
            "-f", "rawvideo", "-pix_fmt", pix, "-"]
    return cmd, shape


def _read_into(stream, out: np.ndarray) -> bool:
    """Fills `out` from the pipe; False at the end of the stream (a partial frame is dropped)."""
    view = memoryview(out.reshape(-1))
    got, size = 0, out.nbytes
    while got < size:
        n = stream.readinto(view[got:])
        if not n:
            return False
        got += n
    return True


def _pipe(cmd: list[str], shape: tuple[int, ...], start: int, check: bool = False, step: int = 1, finish: bool = False):
    """Yield (index, frame) from an ffmpeg rawvideo pipe (indices start, start + step, ...). With
    `check` a failed ffmpeg (non-zero exit at the end of the stream) raises DecodeError with the
    end of its error output; with `finish` ffmpeg may finish its other outputs after the pipe ends."""
    proc = subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE if check else subprocess.DEVNULL, bufsize=0)
    assert proc.stdout is not None
    err: collections.deque[bytes] = collections.deque(maxlen=20)
    drain = None
    if check:   # read stderr beside the frames, so a chatty ffmpeg never blocks on it
        stderr = proc.stderr
        assert stderr is not None
        drain = threading.Thread(target=lambda: err.extend(stderr), daemon=True)
        drain.start()
    try:
        i = start
        while True:
            frame = np.empty(shape, np.uint8)   # a new array each time: callers keep frames
            if not _read_into(proc.stdout, frame):
                break
            yield i, frame
            i += step
        if finish:
            proc.wait()
        if check:
            rc = proc.wait()
            if drain is not None:
                drain.join(2)
            if rc != 0:
                tail = b"".join(err).decode(errors="replace").strip()[-600:]
                raise DecodeError(f"ffmpeg exited with {rc}" + (f": {tail}" if tail else ""))
    finally:
        proc.stdout.close()
        if proc.poll() is None:
            proc.kill()
        proc.wait()
        if proc.stderr is not None:
            if drain is not None:
                drain.join(2)
            proc.stderr.close()


def _expected(info: VideoInfo, start: int, stop: int | None, every: int, phase: int) -> int | None:
    """Frames a decode should give when the file has them (None: not known well enough)."""
    end = min(stop, info.frame_count) if stop is not None and info.frame_count else stop or info.frame_count
    return len(picked(start, end, every, phase) or ()) if end else None


def decode(info: VideoInfo, start: int = 0, stop: int | None = None,
           crop: tuple[int, int, int, int] | None = None, scale: float = 1.0, gray: bool = False,
           every: int = 1, phase: int = 0):
    """Yield (index, frame) via an ffmpeg pipe – decoding, crop and resize happen in ffmpeg.

    crop = (x, y, w, h) in display (rotated) pixels; scale applies after the crop. With `every`
    only the frames whose index is `phase` plus a multiple of `every` are yielded (dropped in
    ffmpeg, before they are scaled or sent).

    The decoder is the one in the runtime settings (hwdecode); a GPU decoder that fails hands
    over to the CPU where it stopped, so the caller sees one unbroken run of frames.
    """
    rt = runtime.current()
    method = hwdecode.choose(rt.decoder, info.codec, info.pix_fmt, rt.decode_failed)
    exe = ffmpeg_bin()
    every = max(1, int(every))

    def run(m: str, s: int, check: bool = False):
        cmd, shape = decode_cmd(info, m, s, stop, crop, scale, gray, every, phase, rt.threads, exe)
        return _pipe(cmd, shape, s + (phase - s) % every, check, every)

    if method not in hwdecode.HW_METHODS:
        yield from run(method, start)
        return
    n, last, reason = 0, None, None
    frames = run(method, start, check=True)
    try:
        for item in frames:
            yield item
            n += 1
            last = item[0]
    except DecodeError as exc:
        reason = str(exc)
    finally:
        frames.close()
    expected = _expected(info, start, stop, every, phase)
    short = expected is not None and n < expected
    if reason is None and not short:
        return
    if reason is not None:
        hwdecode.record_failure(method, info.codec, info.pix_fmt, reason)
    # Carry on in software from the first frame the GPU did not deliver.
    s = start if last is None else last + 1
    if stop is not None and s >= stop:
        return
    rest = run(hwdecode.SW, s)
    try:
        for i, f in rest:
            if reason is None:   # the GPU stopped early, the CPU found more: it dropped frames
                hwdecode.record_failure(method, info.codec, info.pix_fmt, f"{n} of {expected or 'the'} frames, then nothing")
                reason = "short"
            yield i, f
    finally:
        rest.close()


def decode_pair(info: VideoInfo, main: dict, side: dict, out: list[tuple[int, np.ndarray]]):
    """decode(**main), and decode(**side) of the same video from the same ffmpeg run: each frame
    is decoded once and goes both ways (e.g. the track's full-size frames and the motion scan's
    small samples around them). Yields main's (index, frame); `out` gets side's at the end.

    The frames are those the two decodes would give on their own. A GPU decoder (which may hand
    over to the CPU half way) or nothing to share: the two decodes, one after the other."""
    rt = runtime.current()
    method = hwdecode.choose(rt.decoder, info.codec, info.pix_fmt, rt.decode_failed)
    s0, s1 = int(main.get("start", 0)), main.get("stop")
    t0, t1 = int(side.get("start", 0)), side.get("stop")
    if method in hwdecode.HW_METHODS or s1 is None or t1 is None or t1 <= t0 or s1 <= s0:
        yield from decode(info, **main)
        out.extend(decode(info, **side))
        return

    def branch(kw: dict) -> tuple[str, tuple[int, ...], str, range, int]:
        every = max(1, int(kw.get("every", 1)))
        phase = int(kw.get("phase", 0))
        filters, shape, pix = decode_plan(info, kw.get("crop"), kw.get("scale", 1.0), kw.get("gray", False), kw["start"], every, phase)
        return ",".join(filters[1:]), shape, pix, picked(kw["start"], kw["stop"], every, phase) or range(0), every

    mf, mshape, mpix, mpick, mevery = branch(main)
    sf, sshape, spix, spick, _ = branch(side)
    first = min(s0, t0)
    cmd = [ffmpeg_bin(), "-v", "error", "-y", *hwdecode.input_args(method)]
    if rt.threads:
        cmd += ["-threads", str(rt.threads)]
    if first > SEEK_PAD:
        cmd += ["-ss", f"{(first - SEEK_PAD - 0.5) / info.fps:.6f}"]
    # The decoder's own pixel format up to the split, so each branch converts from it as its own
    # decode would (else ffmpeg may convert once, before the split, for both).
    grid = decode_plan(info)[0][0] + (f",format={info.pix_fmt}" if info.pix_fmt else "")
    fd, tmp = tempfile.mkstemp(suffix=".raw", prefix="shottracer-")
    os.close(fd)
    cmd += ["-copyts", "-start_at_zero", "-i", str(info.path), "-an", "-sn", "-dn",
            "-filter_complex", f"[0:v]{grid},split=2[a][b];[a]{mf}[m];[b]{sf}[s]",
            "-map", "[m]", "-frames:v", str(len(mpick)), "-fps_mode", "passthrough", "-f", "rawvideo", "-pix_fmt", mpix, "-",
            "-map", "[s]", "-frames:v", str(len(spick)), "-fps_mode", "passthrough", "-f", "rawvideo", "-pix_fmt", spix, tmp]
    try:
        yield from _pipe(cmd, mshape, mpick.start if len(mpick) else s0, step=mevery, finish=True)
        size = int(np.prod(sshape))
        data = np.fromfile(tmp, np.uint8)
        n = min(len(spick), data.size // size)
        frames = data[: n * size].reshape(n, *sshape)
        out.extend((spick[k], frames[k]) for k in range(n))
    finally:
        try:
            os.unlink(tmp)
        except OSError:
            pass


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
