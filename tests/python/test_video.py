"""Frame timing (shottracer.video): frame i is the picture shown i / fps seconds after the file's
start, in decode() and read_frame() alike, also on variable-rate clips (a phone filming slower in
low light) and on files whose timestamps do not start at zero."""
import shutil
import subprocess
from fractions import Fraction
from pathlib import Path

import numpy as np
import pytest

from shottracer import runtime
from shottracer import video as V

FFMPEG = shutil.which("ffmpeg")
pytestmark = pytest.mark.skipif(not (FFMPEG and shutil.which("ffprobe")), reason="needs ffmpeg")

# Each frame shows its own number on the 60 fps clock: a white square in the top row at
# (number % 40) and one in the bottom row at (number // 40), 16 px apart.
MARK = "geq=lum='255*if(lt(Y,32),eq(floor(X/16),mod(S,40)),eq(floor(X/16),floor(S/40)))':cb=128:cr=128"


def _number(img: np.ndarray) -> int:
    g = img[..., 1] if img.ndim == 3 else img
    return int(g[32:].mean(0).argmax() // 16 * 40 + g[:32].mean(0).argmax() // 16)


@pytest.fixture(scope="module")
def vfr(tmp_path_factory) -> Path:
    """2 s at 60 fps, then 2 s at 30 fps, in one file (ffprobe: r 60, avg 45)."""
    p = tmp_path_factory.mktemp("vfr") / "vfr.mp4"
    fast = MARK.replace("S", "round(T*60)")
    slow = MARK.replace("S", "round((T+2)*60)")
    subprocess.run([FFMPEG, "-v", "error", "-y", "-f", "lavfi", "-i", "color=black:s=640x64:r=60:d=2,format=yuv420p",
                    "-f", "lavfi", "-i", "color=black:s=640x64:r=30:d=2,format=yuv420p",
                    "-filter_complex", f"[0:v]{fast}[a];[1:v]{slow}[b];[a][b]concat=n=2:v=1[v]", "-map", "[v]",
                    "-c:v", "libx264", "-qp", "0", "-g", "30", "-fps_mode", "vfr", str(p)], check=True)
    return p


@pytest.fixture(autouse=True)
def _cpu():
    runtime.configure(runtime.Runtime(decoder="sw"))
    yield
    runtime.configure(runtime.Runtime())


def _times(path: Path) -> list[Fraction]:
    out = subprocess.run(["ffprobe", "-v", "error", "-select_streams", "v:0", "-show_entries", "frame=pts_time", "-of", "csv=p=0",
                          str(path)], capture_output=True, text=True, check=True).stdout
    return [Fraction(line.strip().strip(",")) for line in out.split()]


def test_a_variable_rate_clip_is_read_on_one_constant_grid(vfr):
    info = V.probe(vfr)
    assert info.fps == 45 and info.frame_count == 180
    times = _times(vfr)
    numbers = [round(t * 60) for t in times]

    def shown(i: int) -> int:   # the last frame whose time rounds to slot i, else the one before it
        before = [n for t, n in zip(times, numbers) if t * info.rate < i + Fraction(1, 2)]
        return before[-1] if before else numbers[0]

    full = [(i, _number(f)) for i, f in V.decode(info, gray=True)]
    assert [i for i, _ in full] == list(range(180))
    assert [n for _, n in full] == [shown(i) for i in range(180)]
    # A 60 fps stretch drops frames to the grid, a 30 fps one repeats them; the time is always right.
    assert all(abs(n / 60 - i / 45) <= 1 / 30 + 1e-9 for i, n in full)
    seq = [n for _, n in full]
    for start in (0, 1, 3, 50, 91, 100, 170):   # seeking lands on the same frames
        assert [_number(f) for _, f in V.decode(info, start=start, stop=start + 8)] == seq[start:start + 8]
        assert [_number(V.read_frame(info, i)) for i in range(start, min(180, start + 8))] == seq[start:start + 8]
        picked = [(i, _number(f)) for i, f in V.decode(info, start=start, stop=start + 20, gray=True, every=3, phase=1)]
        assert [i for i, _ in picked] == list(V.picked(start, min(start + 20, 180), 3, 1))
        assert all(n == seq[i] for i, n in picked)
    for i in (120, 7, 121, 64, 65, 66, 150, 2, 179):   # out of order (seeks) and close together (decoded on)
        assert _number(V.read_frame(info, i)) == seq[i]


def test_a_file_that_does_not_start_at_zero(vfr, tmp_path):
    """Times count from the file's start (here 0.7 s), for the seeking reader too."""
    late = tmp_path / "late.mkv"
    subprocess.run([FFMPEG, "-v", "error", "-y", "-i", str(vfr), "-c", "copy", "-output_ts_offset", "0.7", str(late)], check=True)
    ref = [_number(f) for _, f in V.decode(V.probe(vfr), gray=True)]
    info = V.probe(late)
    assert [_number(f) for _, f in V.decode(info, start=100, stop=110)] == ref[100:110]
    assert [_number(V.read_frame(info, i)) for i in (100, 101, 102, 40, 160)] == [ref[i] for i in (100, 101, 102, 40, 160)]


def test_a_constant_rate_clip_is_unchanged(tmp_path):
    """On an ordinary clip frame i is simply the i-th frame, whichever way it is read."""
    p = tmp_path / "cfr.mp4"
    subprocess.run([FFMPEG, "-v", "error", "-y", "-f", "lavfi", "-i", f"color=black:s=640x64:r=30000/1001:d=3,format=yuv420p,{MARK.replace('S', 'N')}",
                    "-c:v", "libx264", "-qp", "0", "-g", "12", str(p)], check=True)
    info = V.probe(p)
    assert [_number(f) for _, f in V.decode(info, gray=True)] == list(range(info.frame_count))
    assert [_number(f) for _, f in V.decode(info, start=40, stop=50, every=4, phase=2)] == [42, 46]
    assert [_number(V.read_frame(info, i)) for i in (5, 6, 7, 30, 31, 80, 3)] == [5, 6, 7, 30, 31, 80, 3]
