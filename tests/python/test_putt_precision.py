"""Putting precision: ground motion that is not a putt must not become one (synthetic tracks).

Each case is a track of ball sightings (30 fps, ball radius 4 px, a little tracker jitter) as
`putt.follow` would give it; `None` is a frame where the ball was not seen.
"""
import math

import numpy as np

from shottracer import pipeline, putt

R, FPS, W, H = 4.0, 30.0, 1280, 720


def _sight(pos, dur, jitter=0.12, seed=0):
    rng = np.random.default_rng(seed)
    t = np.arange(0, dur, 1 / FPS)
    u, v = np.full_like(t, math.nan), np.full_like(t, math.nan)
    for i, x in enumerate(t):
        p = pos(float(x))
        if p is not None:
            u[i], v[i] = p[0] + rng.normal(0, jitter), p[1] + rng.normal(0, jitter)
    return putt.Sightings(t, u, v, R, (W, H))


def _putts(pos, dur, **kw):
    return [ro for ro in putt.segment(_sight(pos, dur, **kw)) if ro.is_putt]


def _ease_out(t, t0, t1, a, b):
    """A struck ball: fastest at once, slowing evenly to a stop."""
    x = min(1.0, max(0.0, (t - t0) / (t1 - t0)))
    e = 1 - (1 - x) ** 2
    return a[0] + (b[0] - a[0]) * e, a[1] + (b[1] - a[1]) * e


def _ease_in(t, t0, t1, a, b):
    """Speeding up from rest: lifted by a hand, falling, a camera starting to pan."""
    x = min(1.0, max(0.0, (t - t0) / (t1 - t0)))
    return a[0] + (b[0] - a[0]) * x * x, a[1] + (b[1] - a[1]) * x * x


A = (600.0, 600.0)


def test_a_real_putt_still_counts():
    rolls = _putts(lambda t: _ease_out(t, 1.0, 3.0, A, (600, 400)), 6.0)
    assert len(rolls) == 1 and rolls[0].ended == "rest"


def test_a_micro_roll_is_no_putt():
    # Nudged 5 radii (~10 cm) in 0.4 s: a marker, a foot, the putter grounded behind it.
    assert _putts(lambda t: _ease_out(t, 1.0, 1.4, A, (620, 600)), 4.0) == []


def test_a_ball_picked_up_is_no_putt():
    # Lifted: speeding up as it rises in the frame, then gone in the hand.
    pos = lambda t: None if t > 1.6 else _ease_in(t, 1.0, 1.6, A, (600, 520))  # noqa: E731
    seen = putt.segment(_sight(pos, 5.0))
    assert seen and not any(ro.is_putt for ro in seen)


def test_a_ball_marked_and_replaced_then_putted_is_one_putt():
    def pos(t):
        if t < 1.0:
            return A
        if t < 1.5:
            return _ease_in(t, 1.0, 1.5, A, (600, 540))      # picked up
        if t < 6.0:
            return None                                       # in the pocket, a coin on the green
        return _ease_out(t, 9.0, 11.0, A, (600, 380))         # put back, then putted
    rolls = _putts(pos, 14.0)
    assert len(rolls) == 1 and abs(rolls[0].start - 9.0) < 0.1


def test_a_dropped_ball_is_no_putt():
    # Seen again in the hand above the green, then falling (speeding up) onto it.
    def pos(t):
        if t < 1.0:
            return A
        if t < 3.0:
            return None
        return _ease_in(t, 4.0, 4.35, (700, 500), (700, 560))
    seen = putt.segment(_sight(pos, 7.0))
    assert not any(ro.is_putt for ro in seen)


def test_a_putter_head_over_the_ball_is_no_putt():
    # The follower slips onto the putter for a practice stroke and back: out and back, no roll.
    def pos(t):
        if 1.0 <= t < 1.6:
            return A[0] + 14 * math.sin(math.pi * (t - 1.0) / 0.6), A[1]
        return A
    assert _putts(pos, 4.0) == []


def test_a_shaking_camera_is_no_putt():
    def pos(t):
        if 1.0 <= t < 3.0:
            return A[0] + 12 * math.sin(2 * math.pi * 1.5 * (t - 1.0)), A[1] + 4 * math.sin(2 * math.pi * 2.0 * (t - 1.0))
        return A
    assert _putts(pos, 5.0) == []


def test_a_camera_pan_is_no_putt():
    # The whole view slides: smooth start, smooth stop (speed peaks in the middle).
    def pos(t):
        if t < 1.0:
            return A
        if t < 2.5:
            x = (t - 1.0) / 1.5
            e = 3 * x * x - 2 * x ** 3
            return A[0] + 160 * e, A[1]
        return A[0] + 160, A[1]
    assert _putts(pos, 5.0) == []


def test_a_roll_that_hangs_for_a_moment_is_one_putt():
    # Slows almost to a stop at the lip, sits for 0.7 s, then topples on: one stroke.
    def pos(t):
        if t < 3.0:
            return _ease_out(t, 1.0, 3.0, A, (600, 400))
        if t < 3.7:
            return 600, 400
        return _ease_out(t, 3.7, 4.5, (600, 400), (600, 360))
    rolls = _putts(pos, 7.0)
    assert len(rolls) == 1 and rolls[0].end > 4.2


def test_a_roll_hidden_by_a_player_is_one_putt():
    # Someone walks in front of the rolling ball for 1.2 s: still one stroke.
    def pos(t):
        if 2.0 < t < 3.2:
            return None
        return _ease_out(t, 1.0, 4.5, A, (600, 300))
    rolls = _putts(pos, 7.0)
    assert len(rolls) == 1 and rolls[0].end > 4.0


def test_two_real_putts_stay_two():
    def pos(t):
        if t < 4.0:
            return _ease_out(t, 1.0, 3.0, A, (600, 400))
        return _ease_out(t, 6.0, 7.2, (600, 400), (620, 330))
    assert len(_putts(pos, 9.0)) == 2


def test_a_chip_running_out_is_no_putt():
    # Seen from behind: a flash of fast flight (no visible rise), then the roll out.
    def pos(t):
        if t < 1.0:
            return A
        if t < 1.25:
            return A[0], A[1] - 300 * 4 * (t - 1.0)             # 300 r/s for a quarter second
        return _ease_out(t, 1.25, 3.5, (A[0], A[1] - 300), (A[0], A[1] - 400))
    assert _putts(pos, 6.0) == []


def test_confidence_drops_for_a_short_roll():
    long = _putts(lambda t: _ease_out(t, 1.0, 3.0, A, (600, 400)), 6.0)[0]
    short = _putts(lambda t: _ease_out(t, 1.0, 1.8, A, (600, 560)), 4.0)[0]
    on = putt.green_prior(0.0, None)
    assert putt.confidence(short, on) < putt.confidence(long, on)
    # No GPS: a short roll is not shown on its own (the pipeline hides putts below 0.6).
    assert putt.confidence(short, putt.green_prior(None, None)) < pipeline.PUTT_SHOW_CONF


def test_another_players_ball_after_a_holed_putt_is_hidden():
    def shot(t, end, holed, x):
        return {"kind": "putt", "impactTime": t, "putt": {"end": end, "holed": holed}, "anchor": {"x": x, "y": 100},
                "track": {"t": [0.5], "u": [x + 50], "v": [100]}, "warnings": [], "visible": True}

    ours, other, other2 = shot(1.0, 3.0, True, 100), shot(20.0, 22.0, False, 600), shot(30.0, 31.0, True, 700)
    pipeline._settle_putts([ours, other, other2], 1000.0)
    assert ours["putt"]["holed"] is True and ours["visible"]
    assert not other["visible"] and not other2["visible"]
    assert all(w["code"] == "putt_count_unsure" for w in other["warnings"] + other2["warnings"])
