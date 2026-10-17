"""The roll line: the path a putt rolled, smoothed, and the gate that keeps only reliable ones."""
import math

import cv2
import numpy as np

from shottracer import putt

W, H, R, FPS = 640, 360, 4.0, 30.0


def _green(seed=0):
    rng = np.random.default_rng(seed)
    return cv2.GaussianBlur(np.clip(110 + rng.normal(0, 6, (H, W)), 0, 255).astype(np.uint8), (3, 3), 0)


def _roll(t0, t1, a, b, bend=0.0):
    """A struck ball slowing to a stop; `bend` px of break that grows as it slows (one way)."""
    dx, dy = b[0] - a[0], b[1] - a[1]
    n = math.hypot(dx, dy)
    nx, ny = -dy / n, dx / n

    def pos(t):
        x = min(1.0, max(0.0, (t - t0) / (t1 - t0)))
        e = 1 - (1 - x) ** 2
        k = bend * e ** 3
        return a[0] + dx * e + nx * k, a[1] + dy * e + ny * k
    return pos


def _follow(pos, dur, shake=0.0, seed=0):
    rng = np.random.default_rng(seed + 1)
    bg = _green(seed)
    off = np.zeros(2)

    def frames():
        nonlocal off
        for i in range(int(dur * FPS)):
            t = i / FPS
            g = np.clip(bg.astype(np.int16) + rng.integers(-3, 4, bg.shape), 0, 255).astype(np.uint8)
            x, y = pos(t)
            cv2.circle(g, (int(round(x * 8)), int(round(y * 8))), int(R * 8), 235, -1, cv2.LINE_AA, 3)
            if shake:
                off = 0.85 * off + rng.normal(0, shake, 2)
                g = cv2.warpAffine(g, np.float32([[1, 0, off[0]], [0, 1, off[1]]]), (W, H), borderMode=cv2.BORDER_REFLECT)
            yield t, g
    s = putt.follow(frames(), pos(0.0), R)
    rolls = [ro for ro in putt.segment(s) if ro.is_putt]
    assert len(rolls) == 1
    return s, rolls[0]


def _off_path(p, pos, t0, t1):
    """Distance (ball radii) of each path point from the true path."""
    dense = np.array([pos(float(x)) for x in np.linspace(t0 - 0.05, t1, 600)])
    return np.array([np.min(np.hypot(dense[:, 0] - x, dense[:, 1] - y)) for x, y in zip(p.u, p.v)]) / R


def test_a_straight_roll_gives_a_line_on_its_path():
    pos = _roll(1.0, 3.0, (320, 300), (330, 120))
    s, ro = _follow(pos, 5.0)
    p = putt.roll_path(s, ro)
    assert p.ok, p.why
    assert np.max(_off_path(p, pos, 1.0, 3.0)) < 0.5
    # About PATH_FPS points a second, from the stroke to where the ball lies.
    assert abs(len(p.t) - (ro.end - ro.start) * putt.PATH_FPS) <= 2
    assert np.all(np.diff(p.t) > 0) and abs(p.t[0] - ro.start) < 1e-9 and abs(p.t[-1] - ro.end) < 1e-9
    assert math.hypot(p.u[0] - 320, p.v[0] - 300) < 0.5 * R
    assert math.hypot(p.u[-1] - 330, p.v[-1] - 120) < 1.0 * R


def test_a_breaking_roll_keeps_its_curve():
    pos = _roll(1.0, 3.2, (300, 320), (360, 110), bend=50)
    s, ro = _follow(pos, 5.2)
    p = putt.roll_path(s, ro)
    assert p.ok, p.why
    assert np.max(_off_path(p, pos, 1.0, 3.2)) < 0.5
    # The middle bows out like the truth (a straight chord would be ~6 radii off).
    mid = len(p.t) * 2 // 3
    tx, ty = pos(float(p.t[mid]))
    assert math.hypot(p.u[mid] - tx, p.v[mid] - ty) < 1.0 * R


def test_a_shaking_camera_gets_no_line():
    pos = _roll(1.0, 3.0, (320, 300), (360, 120), bend=40)
    s, ro = _follow(pos, 5.0, shake=1.0)
    p = putt.roll_path(s, ro)
    assert not p.ok and p.why in ("the camera moves", "the path zig-zags", "the sightings jitter")


def _sightings(pos, dur, jitter=0.0, seed=0, drop=None, slip=None):
    rng = np.random.default_rng(seed)
    t = np.arange(0, dur, 1 / FPS)
    uv = np.array([pos(float(x)) for x in t])
    u, v = uv[:, 0] + rng.normal(0, jitter * R, len(t)), uv[:, 1] + rng.normal(0, jitter * R, len(t))
    if drop:
        u[(t > drop[0]) & (t < drop[1])] = np.nan
        v[(t > drop[0]) & (t < drop[1])] = np.nan
    for i in slip or []:
        u[i] += 3 * R
    return putt.Sightings(t, u, v, R, (W, H))


def _path(s):
    rolls = [ro for ro in putt.segment(s) if ro.is_putt]
    assert len(rolls) == 1
    return putt.roll_path(s, rolls[0])


POS = _roll(1.0, 3.5, (480, 470), (560, 200), bend=60)


def test_a_steady_track_passes_the_gate():
    p = _path(_sightings(POS, 5.5, jitter=0.08))
    assert p.ok and p.rms < 0.15 and p.wiggle < 15 and p.still < 0.15


def test_a_noisy_track_is_rejected():
    p = _path(_sightings(POS, 5.5, jitter=0.4, seed=2))
    assert not p.ok and p.why == "the sightings jitter"


def test_a_lone_slip_is_forgiven_but_a_run_of_them_is_not():
    one = _path(_sightings(POS, 5.5, jitter=0.05, slip=[60]))
    assert one.ok and one.slips == 1
    # And it does not pull the line off the path.
    assert np.max(_off_path(one, POS, 1.0, 3.5)) < 0.4
    run = _path(_sightings(POS, 5.5, jitter=0.05, slip=[60, 61, 62]))
    assert not run.ok and run.why == "sightings far off the path"


def test_a_ball_hidden_long_while_rolling_is_rejected():
    short = _path(_sightings(POS, 5.5, jitter=0.05, drop=(1.6, 1.85)))
    assert short.ok and np.max(_off_path(short, POS, 1.0, 3.5)) < 0.5
    long = _path(_sightings(POS, 5.5, jitter=0.05, drop=(1.6, 2.2)))
    assert not long.ok and long.why == "the ball was out of sight too long"


def test_a_zig_zag_is_rejected():
    base = _roll(1.0, 3.5, (480, 470), (500, 200))

    def pos(t):
        x, y = base(t)
        return x + (6 * math.sin(2 * math.pi * 2.0 * (t - 1.0)) if 1.0 < t < 3.5 else 0.0), y
    p = _path(_sightings(pos, 5.5, jitter=0.05))
    assert not p.ok and p.why == "the path zig-zags"
