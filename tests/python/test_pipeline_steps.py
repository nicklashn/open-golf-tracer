"""The analysis loop around the steps (shottracer.pipeline): one bad shot does not cost the
others, a cancel is noticed inside long decodes, a slow-motion track fits in memory, and the
track's decode feeds the motion scan without changing it. No detector weights needed."""
import shutil
import subprocess
from pathlib import Path

import numpy as np
import pytest

from shottracer import clean, pipeline, runtime
from shottracer import video as V
from shottracer.detect import Ball
from shottracer.impact import Impact

FFMPEG = shutil.which("ffmpeg")
needs_ffmpeg = pytest.mark.skipif(not FFMPEG, reason="needs ffmpeg")


class Stop(Exception):
    """What the worker's progress callback raises when the job is cancelled."""


@pytest.fixture(scope="module")
def clip(tmp_path_factory) -> Path:
    if not FFMPEG:
        pytest.skip("needs ffmpeg")
    p = tmp_path_factory.mktemp("steps") / "clip.mp4"
    subprocess.run([FFMPEG, "-v", "error", "-f", "lavfi", "-i", "testsrc2=s=320x180:r=30:d=12", "-c:v", "libx264", "-g", "30",
                    "-pix_fmt", "yuv420p", str(p)], check=True)
    return p


@pytest.fixture(autouse=True)
def _blob(monkeypatch):
    from shottracer.detect import get_detector

    monkeypatch.setenv("GOLF_DETECTOR", "blob")
    runtime.configure(runtime.Runtime(decoder="sw"))
    get_detector.cache_clear()
    yield
    get_detector.cache_clear()
    runtime.configure(runtime.Runtime())


def _two_shots(monkeypatch, info, fail):
    """Two strikes at 3 s and 8 s; `fail(t)` is what tracking the one at t does."""
    addrs = [pipeline.Address(Ball(100, 150, 3, 0.9, "test"), int((t - 0.6) * info.fps), None, None, t) for t in (3.0, 8.0)]
    monkeypatch.setattr(pipeline, "_verified_addresses", lambda *a, **k: addrs)
    monkeypatch.setattr(pipeline, "_find_impact", lambda info, addr, *a, **k: Impact(addr.verified, int(addr.verified * info.fps), "sound + ball", 0.9))
    monkeypatch.setattr(pipeline, "_track_and_fit", lambda info, det, impact, *a, **k: fail(impact.time))


@needs_ffmpeg
def test_one_bad_shot_does_not_fail_the_clip(clip, monkeypatch):
    """A shot whose fit breaks (here: singular matrix, then a bad value) is skipped with a warning;
    the analysis goes on with the next one instead of failing the whole clip."""
    info = V.probe(clip)

    def fail(t):
        if t < 5:
            raise np.linalg.LinAlgError("Singular matrix")
        raise ValueError("math domain error")

    _two_shots(monkeypatch, info, fail)
    res = pipeline.analyze(clip)
    assert res["shots"] == [] and len(res["warnings"]) == 2
    assert "3.0 s" in res["warnings"][0] and "LinAlgError" in res["warnings"][0] and "ValueError" in res["warnings"][1]


@needs_ffmpeg
@pytest.mark.parametrize("exc", [MemoryError("Unable to allocate 7.9 GiB"), Stop()])
def test_out_of_memory_and_cancel_still_end_the_analysis(clip, monkeypatch, exc):
    """Not one shot's fault: the worker must see them (retry gentler / mark the job cancelled)."""
    info = V.probe(clip)

    def fail(t):
        raise exc

    _two_shots(monkeypatch, info, fail)
    calls = []

    def progress(f, msg):
        calls.append(msg)
        if isinstance(exc, Stop) and msg.startswith("shot"):
            raise exc

    if isinstance(exc, Stop):   # the cancel comes from a check inside the step
        monkeypatch.setattr(pipeline, "_track_and_fit", lambda *a, check=None, **k: check() if check else None)
    with pytest.raises(type(exc)):
        pipeline.analyze(clip, progress=progress)


@needs_ffmpeg
def test_a_cancel_is_noticed_inside_a_putt_follow(clip):
    """Following a putt decodes up to 180 s of video: the cancel must not wait for its end."""
    info = V.probe(clip)
    addr = pipeline.Address(Ball(100, 150, 3, 0.9, "test"), 0, None, None, None)
    seen = []

    def check():
        seen.append(1)
        if len(seen) >= 2:
            raise Stop()

    with pytest.raises(Stop):
        pipeline._putts(info, pipeline.get_detector(), addr, pipeline.Options(), [], 0, check)
    assert len(seen) == 2


@needs_ffmpeg
def test_a_cancel_is_noticed_inside_the_track_decode(clip):
    info = V.probe(clip)
    seen = []

    def check():
        seen.append(1)
        raise Stop()

    impact = Impact(3.0, 90, "sound", 0.9)
    with pytest.raises(Stop):
        pipeline._track_and_fit(info, pipeline.get_detector(), impact, None, pipeline.Options(), None, check)
    assert seen == [1]


@needs_ffmpeg
def test_a_stopped_motion_scan_ends_early(clip):
    info = V.probe(clip)
    full = clean.measure_span(info, 0.0, 12.0, None)
    n = [0]

    def stopped():
        n[0] += 1
        return n[0] > 5

    short = clean.measure_span(info, 0.0, 12.0, None, stopped=stopped)
    assert len(full.t) > 100 and len(short.t) == 5


def test_a_slow_motion_track_fits_in_memory():
    """4 s of flight at 16x slow motion are 64 s of video: every frame of it at full size was ~8 GB."""
    assert pipeline._track_window(60.0, 10.0) == (596, 843, 1, 2)            # real time: as before
    assert pipeline._track_window(30.0, 10.0) == (297, 422, 1, 1)
    assert pipeline._track_window(240.0, 10.0) == (2388, 3370, 2, 4)
    for fps, slowmo in ((30.0, 16.0), (60.0, 8.0), (240.0, 8.0), (30.0, 40.0)):
        i0, i1, step, k = pipeline._track_window(fps, 10.0, slowmo)
        assert (i1 - i0) / step <= pipeline.MAX_TRACK_FRAMES and i1 >= (10.0 + 4 * slowmo) * fps and k >= 1


@needs_ffmpeg
def test_the_track_decode_feeds_the_motion_scan_unchanged(clip):
    """The motion scan's samples up to the end of the track come from the track's own decode;
    they are the frames, and the measurements, a separate scan gets."""
    info = V.probe(clip)
    sp = clean.span(info, 1.0, 12.0)
    head: list = []
    impact = Impact(4.0, 120, "sound", 0.9)
    try:
        pipeline._track_and_fit(info, pipeline.get_detector(), impact, None, pipeline.Options(), (sp, head))
    except RuntimeError:
        pass   # no ball in a test pattern: the track is not the point here
    i0, i1, step, _ = pipeline._track_window(info.fps, 4.0)
    assert [i for i, _ in head] == list(range(sp.start, i1, sp.every))
    alone = list(V.decode(info, **sp.decode_args(stop=i1)))
    assert all(np.array_equal(a, b) for (_, a), (_, b) in zip(head, alone))
    a = clean.measure_span(info, 1.0, 12.0, None, head)
    b = clean.measure_span(info, 1.0, 12.0, None)
    assert np.array_equal(a.t, b.t) and np.array_equal(a.frac, b.frac) and np.array_equal(a.sharp, b.sharp)
