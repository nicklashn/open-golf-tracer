"""Putting: following a rolling ball and cutting it into strokes (synthetic frames, no detector)."""
import subprocess
import sys
from pathlib import Path

import cv2
import numpy as np
import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "apps" / "api"))

from shottracer import putt  # noqa: E402

W, H, R, FPS = 640, 360, 4.0, 30.0


def _green(seed=0):
    rng = np.random.default_rng(seed)
    return cv2.GaussianBlur(np.clip(110 + rng.normal(0, 6, (H, W)), 0, 255).astype(np.uint8), (3, 3), 0)


def _pos(t, legs):
    """legs: (t0, t1, from, to) rolls that slow down like a putt; the ball lies still in between."""
    p = legs[0][2]
    for t0, t1, a, b in legs:
        if t < t0:
            return p
        if t <= t1:
            e = 1 - (1 - (t - t0) / (t1 - t0)) ** 2
            return a[0] + (b[0] - a[0]) * e, a[1] + (b[1] - a[1]) * e
        p = b
    return p


def _frames(legs, dur, gone=None, lift=None, jitter=0.0, seed=0):
    rng = np.random.default_rng(seed + 1)
    bg = _green(seed)
    for i in range(int(dur * FPS)):
        t = i / FPS
        g = np.clip(bg.astype(np.int16) + rng.integers(-3, 4, bg.shape), 0, 255).astype(np.uint8)   # sensor noise
        if gone is None or t < gone:
            x, y = _pos(t, legs)
            y -= lift(t) if lift else 0.0
            x, y = x + rng.normal(0, jitter), y + rng.normal(0, jitter)
            cv2.circle(g, (int(round(x * 8)), int(round(y * 8))), int(R * 8), 235, -1, cv2.LINE_AA, 3)
        yield t, g


def _putts(legs, dur, **kw):
    seen = putt.follow(_frames(legs, dur, **kw), legs[0][2], R)
    return [ro for ro in putt.segment(seen) if ro.is_putt]


def test_a_roll_that_stops_is_one_putt_not_holed():
    rolls = _putts([(1.0, 3.0, (320, 300), (320, 150))], 6.0)
    assert len(rolls) == 1
    ro = rolls[0]
    assert abs(ro.start - 1.0) < 0.05 and 2.5 < ro.end < 3.1
    assert ro.ended == "rest" and ro.holed is False and ro.unsure == putt.STILL_LYING


def test_two_rolls_then_the_ball_drops_is_two_putts_the_last_holed():
    legs = [(1.0, 3.0, (320, 300), (320, 150)), (5.0, 6.2, (320, 150), (335, 100))]
    rolls = _putts(legs, 9.5, gone=6.25)
    assert [ro.ended for ro in rolls] == ["rest", "gone"]
    assert abs(rolls[0].start - 1.0) < 0.05 and abs(rolls[1].start - 5.0) < 0.05
    assert abs(rolls[1].end - 6.25) < 0.1
    assert rolls[0].holed is False and rolls[1].holed is True and not rolls[1].unsure


def test_a_chip_that_rises_is_not_a_putt():
    lift = lambda t: 0 if t < 1 or t > 1.6 else 60 * (t - 1) * (1.6 - t) / 0.09  # noqa: E731
    seen = putt.follow(_frames([(1.0, 1.8, (320, 300), (300, 220))], 4.0, lift=lift), (320, 300), R)
    rolls = putt.segment(seen)
    assert rolls and not any(ro.is_putt for ro in rolls)
    assert max(ro.rise for ro in rolls) > putt.RISE_R


def test_a_lying_ball_with_noise_is_no_putt():
    assert _putts([(99, 100, (320, 300), (320, 300))], 4.0, jitter=0.4, seed=3) == []


def test_a_ball_rolling_out_of_view_is_unsure():
    t = np.arange(0, 5, 1 / FPS)
    u = np.where(t < 1, 320.0, 320 + (t - 1) * 200)
    u[u > W - 2] = np.nan
    s = putt.Sightings(t, u, np.full_like(t, 200.0), R, (W, H))
    rolls = [ro for ro in putt.segment(s) if ro.is_putt]
    assert len(rolls) == 1 and rolls[0].ended == "edge" and rolls[0].holed is None and rolls[0].unsure


def test_confidence_leans_on_the_green():
    ro = _putts([(1.0, 3.0, (320, 300), (320, 150))], 6.0)[0]
    on, off = putt.confidence(ro, putt.green_prior(0.0, None)), putt.confidence(ro, putt.green_prior(None, 120.0))
    assert on > 0.9 and off < on and 0 <= off <= 1


def test_green_distance():
    from golf_api.routes.geo import green_distance

    course = {"features": [{"k": "green", "ring": [[56.2, 11.7], [56.2, 11.7003], [56.2002, 11.7003], [56.2002, 11.7]]}]}
    assert green_distance(56.2001, 11.70015, course) == 0
    assert 20 < green_distance(56.2001, 11.7007, course) < 30   # ~25 m east of the green's edge
    assert green_distance(56.2, 11.7, {"features": []}) is None


class _NoPeople:
    def people(self, img):
        return []


def _video(path: Path, legs, dur, gone):
    proc = subprocess.Popen(["ffmpeg", "-y", "-v", "error", "-f", "rawvideo", "-pix_fmt", "gray", "-s", f"{W}x{H}", "-r", str(FPS),
                             "-i", "-", "-c:v", "libx264", "-preset", "ultrafast", "-crf", "18", "-pix_fmt", "yuv420p", str(path)], stdin=subprocess.PIPE)
    assert proc.stdin is not None
    for _, g in _frames(legs, dur, gone=gone):
        proc.stdin.write(g.tobytes())
    proc.stdin.close()
    proc.wait()


def test_putts_become_putt_shots(tmp_path):
    """Through the pipeline: decoded frames, putt shots in the editor's shape, valid by the schema."""
    from golf_api.documents import _validator, clean_shot, new_document
    from shottracer import pipeline
    from shottracer.detect import Ball
    from shottracer.video import probe

    path = tmp_path / "putts.mp4"
    legs = [(1.0, 3.0, (320, 300), (320, 150)), (5.0, 6.2, (320, 150), (335, 100))]
    try:
        _video(path, legs, 7.5, gone=6.25)
    except FileNotFoundError:
        pytest.skip("ffmpeg missing")
    info = probe(path)
    addr = pipeline.Address(Ball(320, 300, R, 0.5, "test"), int(0.4 * FPS), None, None, None)
    opt = pipeline.Options(green_m=0.0)
    docs, span = pipeline._putts(info, _NoPeople(), addr, opt, [], 0)   # type: ignore[arg-type]
    assert [d["kind"] for d in docs] == ["putt", "putt"]
    assert [d["putt"]["holed"] for d in docs] == [False, True]
    assert abs(docs[0]["impactTime"] - 1.0) < 0.06 and abs(docs[1]["impactTime"] - 5.0) < 0.06
    assert all(d["visible"] and d["confidence"] > 0.6 for d in docs)
    assert span[0] < 1.0 and span[1] > 6.0
    doc = new_document("t")
    doc["shots"] = [clean_shot(d, "m1") for d in docs]
    assert not list(_validator().iter_errors(doc))


def test_a_putt_followed_by_another_was_not_holed():
    from shottracer import pipeline

    def shot(t, end, holed, x):
        return {"kind": "putt", "impactTime": t, "putt": {"end": end, "holed": holed}, "anchor": {"x": x, "y": 100},
                "track": {"t": [0.5], "u": [x + 50], "v": [100]}, "warnings": []}

    a, b = shot(1.0, 3.0, True, 100), shot(20.0, 22.0, True, 150)
    pipeline._settle_putts([a, b], 1000.0)
    assert a["putt"]["holed"] is False and b["putt"]["holed"] is True
    assert [w["code"] for w in a["warnings"]] == ["putt_count_unsure"]


def test_putting_is_only_looked_for_near_the_green():
    from shottracer import pipeline

    assert pipeline._by_green(pipeline.Options(green_m=3.0)) and not pipeline._by_green(pipeline.Options(green_m=20.0))
    assert pipeline._by_green(pipeline.Options(to_green=10.0)) and not pipeline._by_green(pipeline.Options())
    assert not pipeline._maybe_putt(pipeline.Options(to_green=150.0), None)
    assert pipeline._maybe_putt(pipeline.Options(), None)
