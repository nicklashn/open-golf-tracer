"""Video decoding on the CPU or a GPU decoder (shottracer.hwdecode, video.decode): the ffmpeg
commands per method, and the fallback to the CPU when a GPU decoder fails, checked with a fake
ffmpeg that breaks on purpose (the real GPU decoders need the user's PC)."""
import os
import shutil
import subprocess
import sys
from pathlib import Path

import numpy as np
import pytest

from shottracer import hwdecode, runtime
from shottracer import video as V
from shottracer.video import VideoInfo, decode, decode_cmd, probe

REAL = shutil.which("ffmpeg")
needs_ffmpeg = pytest.mark.skipif(not REAL or sys.platform == "win32", reason="needs ffmpeg (and a POSIX shell for the fake)")


@pytest.fixture(autouse=True)
def _clean():
    hwdecode.reset()
    hwdecode._listeners.clear()   # e.g. the worker's, which saves to performance.json
    yield
    hwdecode.reset()
    hwdecode._listeners.clear()
    runtime.configure(runtime.Runtime())


def _info(**kw) -> VideoInfo:
    d = {"path": Path("clip.mp4"), "width": 1920, "height": 1080, "fps": 60.0, "frame_count": 600, "codec": "h264"}
    return VideoInfo(**{**d, **kw})


# --- commands ---------------------------------------------------------------------------------


def _before_input(cmd: list[str]) -> list[str]:
    return cmd[: cmd.index("-i")]


@pytest.mark.parametrize("method,args", [("sw", []), ("auto", ["-hwaccel", "auto"]), ("d3d11va", ["-hwaccel", "d3d11va"]),
                                         ("cuda", ["-hwaccel", "cuda"]), ("dxva2", ["-hwaccel", "dxva2"]),
                                         ("qsv", ["-hwaccel", "qsv"]), ("vaapi", ["-hwaccel", "vaapi"]), ("bogus", [])])
def test_each_method_only_changes_the_decoder(method, args):
    cmd, shape = decode_cmd(_info(), method, start=120, stop=360, exe="ffmpeg")
    sw, _ = decode_cmd(_info(), "sw", start=120, stop=360, exe="ffmpeg")
    assert _before_input(cmd) == ["ffmpeg", "-v", "error", *args, "-ss", f"{119.5 / 60:.6f}"]
    # After the input everything is the same: frames come back to memory and are cropped, scaled,
    # converted and auto-rotated by the same software filters (no -hwaccel_output_format, no
    # -noautorotate), so their size and orientation never depend on the decoder.
    assert cmd[cmd.index("-i"):] == sw[sw.index("-i"):]
    assert "-hwaccel_output_format" not in cmd and "-noautorotate" not in cmd
    assert shape == (1080, 1920, 3) and cmd[cmd.index("-frames:v") + 1] == "240"


def test_filters_threads_rate_and_gray():
    info = _info()
    cmd, shape = decode_cmd(info, "cuda", start=0, stop=600, crop=(10, 20, 640, 360), scale=0.5, gray=True, threads=6)
    assert cmd[cmd.index("-threads") + 1] == "6" and "-ss" not in cmd
    assert cmd[cmd.index("-vf") + 1] == "crop=640:360:10:20,scale=320:180:flags=area,format=gray"
    assert shape == (180, 320) and cmd[-3:] == ["-pix_fmt", "gray", "-"]
    cmd, shape = decode_cmd(info, "d3d11va", start=60, stop=120, scale=0.1, gray=True, rate=10.0)
    assert cmd[cmd.index("-vf") + 1] == "fps=10,scale=192:108:flags=area,format=gray"
    assert cmd[cmd.index("-t") + 1] == "1.000000" and "-frames:v" not in cmd and shape == (108, 192)


def test_a_portrait_phone_clip_keeps_its_display_size():
    """A phone stores portrait video as landscape plus a rotation; probe reports the display size."""
    info = _info(width=1080, height=1920, rotation=-90)
    for m in ("sw", "cuda", "d3d11va"):
        cmd, shape = decode_cmd(info, m, scale=0.5)
        assert shape == (960, 540, 3) and "scale=540:960:flags=area" in cmd[cmd.index("-vf") + 1]


def test_rotation_from_ffprobe():
    assert V.parse_rotation({"side_data_list": [{"side_data_type": "Display Matrix", "rotation": -90}]}) == -90
    assert V.parse_rotation({"tags": {"rotate": "180"}}) == 180
    assert V.parse_rotation({"side_data_list": [{"side_data_type": "other"}]}) == 0
    assert V.parse_rotation({"side_data_list": [{"rotation": "x"}]}) == 0


def test_the_hwaccel_list():
    text = "Hardware acceleration methods:\ncuda\ndxva2\nqsv\nd3d11va\nopencl\nvulkan\nd3d12va\n\n"
    assert hwdecode.parse_hwaccels(text) == ["cuda", "dxva2", "qsv", "d3d11va", "opencl", "vulkan", "d3d12va"]
    hwdecode.compiled.cache_clear()
    try:
        fake = {"ffmpeg": tuple(hwdecode.parse_hwaccels(text))}
        orig = hwdecode.compiled
        hwdecode.compiled = lambda exe: fake[exe]   # type: ignore[assignment]
        assert hwdecode.candidates("ffmpeg", "win32") == ["d3d11va", "cuda", "dxva2", "qsv"]
        assert hwdecode.candidates("ffmpeg", "linux") == ["cuda", "qsv"]
        assert hwdecode.candidates("ffmpeg", "darwin") == []
    finally:
        hwdecode.compiled = orig


def test_a_failed_decoder_is_not_used_again_for_that_codec():
    seen = []
    hwdecode.on_failure(lambda key, why: seen.append(key))
    assert hwdecode.choose("cuda", "hevc", "yuv420p10le") == "cuda"
    hwdecode.record_failure("cuda", "hevc", "yuv420p10le", "10-bit not supported")
    hwdecode.record_failure("cuda", "hevc", "yuv420p10le", "again")
    assert seen == ["cuda:hevc:yuv420p10le"]
    assert hwdecode.choose("cuda", "hevc", "yuv420p10le") == "sw"
    assert hwdecode.choose("cuda", "h264", "yuv420p") == "cuda"          # other codecs still use it
    assert hwdecode.choose("d3d11va", "h264", "yuv420p", known_bad=["d3d11va:h264:yuv420p"]) == "sw"   # saved earlier
    with hwdecode.muted():
        hwdecode.record_failure("qsv", "h264", "yuv420p", "tried on purpose")
    assert seen == ["cuda:hevc:yuv420p10le"] and hwdecode.choose("qsv", "h264", "yuv420p") == "sw"
    assert hwdecode.choose("auto", "hevc", "x") == "auto" and hwdecode.choose("nonsense", "h264", "x") == "auto"


# --- decoding with a fake GPU decoder ---------------------------------------------------------


@pytest.fixture(scope="module")
def clip(tmp_path_factory) -> Path:
    if not REAL:
        pytest.skip("needs ffmpeg")
    p = tmp_path_factory.mktemp("hw") / "clip.mp4"
    subprocess.run([REAL, "-v", "error", "-f", "lavfi", "-i", "testsrc2=s=160x96:r=30:d=3", "-c:v", "libx264", "-g", "15",
                    "-pix_fmt", "yuv420p", str(p)], check=True)
    return p


@pytest.fixture(scope="module")
def rotated(clip, tmp_path_factory) -> Path:
    p = tmp_path_factory.mktemp("hw") / "rotated.mp4"
    subprocess.run([REAL, "-v", "error", "-display_rotation:v:0", "-90", "-i", str(clip), "-c", "copy", str(p)], check=True)
    return p


FAKE = r"""#!/bin/sh
# A fake ffmpeg: with -hwaccel it misbehaves as FAKE_MODE says, otherwise it is the real one.
echo "$*" >> "$FAKE_LOG"
case " $* " in
  *" -hwaccel "*) ;;
  *) exec "$REAL_FFMPEG" "$@" ;;
esac
if [ "$FAKE_MODE" = fail ]; then echo "Device creation failed: -542398533." >&2; exit 187; fi
# The real ffmpeg without "-hwaccel X", its output cut after FAKE_BYTES bytes.
set -- $(printf '%s\n' "$@" | awk '{ if (s) { s = 0; next } if ($0 == "-hwaccel") { s = 1; next } print }')
"$REAL_FFMPEG" "$@" | head -c "$FAKE_BYTES"
if [ "$FAKE_MODE" = partial ]; then echo "hwaccel: decode error" >&2; exit 1; fi
exit 0
"""


@pytest.fixture
def fake(tmp_path, monkeypatch):
    bin_dir = tmp_path / "bin"
    bin_dir.mkdir()
    exe = bin_dir / "ffmpeg"
    exe.write_text(FAKE)
    exe.chmod(0o755)
    log = tmp_path / "calls.log"
    log.write_text("")
    monkeypatch.setenv("FAKE_LOG", str(log))
    monkeypatch.setenv("REAL_FFMPEG", REAL or "ffmpeg")
    monkeypatch.setattr(V, "ffmpeg_bin", lambda: str(exe))

    def set_mode(mode: str, frames: int = 0, shape=(96, 160, 3)):
        monkeypatch.setenv("FAKE_MODE", mode)
        monkeypatch.setenv("FAKE_BYTES", str(frames * int(np.prod(shape))))
        log.write_text("")

    set_mode.calls = lambda: [line for line in log.read_text().splitlines() if line]   # type: ignore[attr-defined]
    return set_mode


def _frames(info, **kw):
    return [(i, f.copy()) for i, f in decode(info, **kw)]


def _same(a, b):
    assert [i for i, _ in a] == [i for i, _ in b]
    assert all(x.shape == y.shape and np.array_equal(x, y) for (_, x), (_, y) in zip(a, b))


@needs_ffmpeg
@pytest.mark.parametrize("mode,frames", [("fail", 0), ("partial", 7), ("short", 7)])
def test_a_failing_gpu_decoder_hands_over_to_the_cpu(clip, fake, mode, frames):
    info = probe(clip)
    assert info.codec == "h264" and info.rotation == 0
    runtime.configure(runtime.Runtime(decoder="sw"))
    ref = _frames(info, start=10, stop=40)
    saved = []
    hwdecode.on_failure(lambda key, why: saved.append((key, why)))
    runtime.configure(runtime.Runtime(decoder="d3d11va"))
    fake(mode, frames)
    got = _frames(info, start=10, stop=40)
    _same(got, ref)                                   # one unbroken run, the same frames
    assert [k for k, _ in saved] == ["d3d11va:h264:yuv420p"]
    if mode == "fail":
        assert "Device creation failed" in saved[0][1]
    calls = fake.calls()
    assert "-hwaccel d3d11va" in calls[0] and "-hwaccel" not in calls[1]
    if mode != "fail":                                # the CPU took over where the GPU stopped
        assert f"-frames:v {30 - frames}" in calls[1]
    fake(mode, frames)
    _same(_frames(info, start=10, stop=40), ref)      # the next segment goes straight to the CPU
    assert len(fake.calls()) == 1 and "-hwaccel" not in fake.calls()[0]


@needs_ffmpeg
def test_a_working_gpu_decoder_is_used_and_nothing_is_recorded(clip, fake):
    info = probe(clip)
    runtime.configure(runtime.Runtime(decoder="sw"))
    ref = _frames(info, start=5, stop=25, scale=0.5, gray=True)
    runtime.configure(runtime.Runtime(decoder="cuda"))
    fake("ok", 10_000, (48, 80))
    _same(_frames(info, start=5, stop=25, scale=0.5, gray=True), ref)
    assert hwdecode.failed() == {} and len(fake.calls()) == 1 and "-hwaccel cuda" in fake.calls()[0]


@needs_ffmpeg
def test_the_end_of_the_file_is_not_a_failure(clip, fake):
    """The frame count from the container can be a little high: a GPU run that ends with the file
    is fine (the CPU finds nothing more), and it is not marked broken."""
    info = probe(clip)
    info.frame_count += 5
    runtime.configure(runtime.Runtime(decoder="sw"))
    ref = _frames(info, start=60)
    runtime.configure(runtime.Runtime(decoder="d3d11va"))
    fake("ok", 10_000)
    _same(_frames(info, start=60), ref)
    assert hwdecode.failed() == {}


@needs_ffmpeg
def test_with_a_rate_the_cpu_starts_over_and_skips_what_was_delivered(clip, fake):
    info = probe(clip)
    kw = {"start": 3, "stop": 80, "scale": 0.5, "gray": True, "rate": 10.0}
    runtime.configure(runtime.Runtime(decoder="sw"))
    ref = _frames(info, **kw)
    runtime.configure(runtime.Runtime(decoder="qsv"))
    fake("partial", 9, (48, 80))
    _same(_frames(info, **kw), ref)
    assert list(hwdecode.failed()) == ["qsv:h264:yuv420p"]


@needs_ffmpeg
def test_stopping_early_is_not_a_failure(clip, fake):
    info = probe(clip)
    runtime.configure(runtime.Runtime(decoder="cuda"))
    fake("ok", 10_000)
    frames = decode(info, start=0, stop=80)
    for k, _ in enumerate(frames):
        if k == 3:
            break
    frames.close()   # the caller had enough: ffmpeg is killed, which is not an error
    assert hwdecode.failed() == {}


@needs_ffmpeg
def test_a_rotated_phone_clip_comes_out_the_same_way_up(clip, rotated, fake):
    info = probe(rotated)
    assert (info.width, info.height, info.rotation) == (96, 160, -90)
    runtime.configure(runtime.Runtime(decoder="sw"))
    ref = _frames(info, start=4, stop=12, scale=0.5)
    assert ref[0][1].shape == (80, 48, 3)
    stored = _frames(probe(clip), start=4, stop=5)[0][1]          # the same picture before the rotation
    turned = _frames(info, start=4, stop=5)[0][1]
    assert np.array_equal(np.rot90(stored, -1), turned)            # turned a quarter clockwise
    for mode in ("ok", "fail"):
        hwdecode.reset()
        runtime.configure(runtime.Runtime(decoder="d3d11va"))
        fake(mode, 10_000, (80, 48, 3))
        _same(_frames(info, start=4, stop=12, scale=0.5), ref)


@needs_ffmpeg
def test_the_real_gpu_decoders_here_fail_safely(clip):
    """This machine's ffmpeg may list GPU decoders without the hardware: each one either works
    or falls back, and the frames are the CPU's either way."""
    info = probe(clip)
    runtime.configure(runtime.Runtime(decoder="sw"))
    ref = _frames(info, start=10, stop=20)
    for m in hwdecode.candidates(REAL or "ffmpeg"):
        runtime.configure(runtime.Runtime(decoder=m))
        got = _frames(info, start=10, stop=20)
        assert [i for i, _ in got] == [i for i, _ in ref]
        assert all(np.abs(a.astype(int) - b).mean() < 1.5 for (_, a), (_, b) in zip(got, ref))


def test_os_error_from_a_missing_binary_is_still_raised(monkeypatch):
    monkeypatch.setattr(V, "ffmpeg_bin", lambda: os.path.join("/nonexistent", "ffmpeg"))
    runtime.configure(runtime.Runtime(decoder="sw"))
    with pytest.raises(OSError):
        list(decode(_info()))
