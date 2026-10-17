"""Clean cut windows (shottracer/clean.py) on synthetic clips: someone walking up to the camera,
camera shake, a person entering from the edge, the golfer walking to the ball. No detector."""
import subprocess
from pathlib import Path

import cv2
import numpy as np
import pytest

from shottracer import clean
from shottracer.detect import Box
from shottracer.video import ffmpeg_bin, probe

W, H, FPS = 640, 360, 30.0
GOLFER = Box(270, 140, 330, 300)          # the golfer at address (as the detector would give it)
BALL = (372, 296)


def _background(seed=0):
    rng = np.random.default_rng(seed)
    bg = np.zeros((H, W, 3), np.uint8)
    bg[: H // 2] = (220, 190, 150)
    bg[H // 2:] = (60, 140, 70)
    for _ in range(140):
        x, y = int(rng.integers(0, W)), int(rng.integers(H // 2, H))
        cv2.circle(bg, (x, y), int(rng.integers(3, 12)), tuple(int(c) for c in rng.integers(40, 120, 3)), -1)
    for x in range(0, W, 19):
        cv2.circle(bg, (x, H // 2 - int(rng.integers(4, 20))), int(rng.integers(10, 22)), (40, 80, 45), -1)
    return cv2.GaussianBlur(bg, (3, 3), 0)


def _person(f, cx, bottom, height, color=(70, 44, 30)):
    """A standing person seen from behind: body and head, `height` px tall, feet at `bottom`."""
    w = height * 0.38
    cv2.rectangle(f, (int(cx - w / 2), int(bottom - height * 0.82)), (int(cx + w / 2), int(bottom)), color, -1)
    cv2.circle(f, (int(cx), int(bottom - height * 0.9)), int(height * 0.1), (120, 150, 196), -1)


def _golfer(f, s):
    """The golfer at address; s = seconds from the strike (the club swings from -1.0 to +0.8)."""
    _person(f, 300, 300, 160)
    a = np.pi * 0.35
    if -1.0 <= s <= 0.8:
        a += 2.6 * np.sin(np.pi * (s + 1.0) / 1.8)
    hand = (320, 220)
    cv2.line(f, hand, (int(hand[0] + 95 * np.cos(a)), int(hand[1] + 95 * np.sin(a))), (30, 30, 30), 3)


def _clip(path: Path, dur: float, draw) -> Path:
    bg = _background()
    rng = np.random.default_rng(1)
    proc = subprocess.Popen([ffmpeg_bin(), "-y", "-v", "error", "-f", "rawvideo", "-pix_fmt", "bgr24", "-s", f"{W}x{H}", "-r", str(FPS),
                             "-i", "-", "-c:v", "libx264", "-preset", "veryfast", "-crf", "20", "-pix_fmt", "yuv420p", str(path)],
                            stdin=subprocess.PIPE)
    assert proc.stdin is not None
    for i in range(int(dur * FPS)):
        f = bg.copy()
        f = draw(f, i / FPS) if draw else f
        f = (f.astype(np.int16) + rng.integers(-3, 4, f.shape)).clip(0, 255).astype(np.uint8)
        proc.stdin.write(f.tobytes())
    proc.stdin.close()
    assert proc.wait() == 0
    return path


def _window(path: Path, impact: float, land: float, putt: bool = False):
    info = probe(path)
    m = clean.measure_span(info, *clean.scan_range(impact, 1.0, land), GOLFER)
    return clean.window(m, impact, land, 1.0, putt), info


def _swing_scene(impact, after=None):
    def draw(f, t):
        if after is not None and after(f, t):
            return f
        _golfer(f, t - impact)
        if t < impact:
            cv2.circle(f, BALL, 3, (250, 250, 250), -1)
        return f
    return draw


def test_quiet_clip_keeps_the_whole_scan(tmp_path):
    impact, land = 3.0, 6.0
    w, info = _window(_clip(tmp_path / "quiet.mp4", 12.0, _swing_scene(impact)), impact, land)
    assert w is not None
    assert w["from"] == pytest.approx(0.0, abs=0.15)
    assert w["to"] >= min(info.duration, land + clean.POST_S) - 0.25


def test_walking_toward_the_camera_after_the_strike_ends_the_window(tmp_path):
    impact, land, walk = 3.0, 5.5, 6.5

    def toward(f, t):
        if t < walk:
            return False
        k = (t - walk) / 2.5           # from the address spot to right in front of the lens
        _person(f, 300 + 40 * k, 300 + 160 * k, 160 + 380 * k)
        return True

    w, _ = _window(_clip(tmp_path / "walk.mp4", 11.0, _swing_scene(impact, toward)), impact, land)
    assert w is not None
    assert land <= w["to"] <= walk + 0.2, w   # before they get big in the picture
    assert w["from"] == pytest.approx(0.0, abs=0.15)


def test_camera_shake_at_the_end_ends_the_window(tmp_path):
    impact, land, pickup = 3.0, 5.5, 8.0
    rng = np.random.default_rng(3)

    def shake(f, t):
        if t < pickup:
            return False
        _golfer(f, 9)
        dx, dy = rng.integers(-24, 25, 2)
        f[:] = cv2.GaussianBlur(cv2.warpAffine(f, np.float32([[1, 0, dx], [0, 1, dy]]), (W, H), borderMode=cv2.BORDER_REFLECT), (9, 9), 0)
        return True

    w, _ = _window(_clip(tmp_path / "shake.mp4", 10.5, _swing_scene(impact, shake)), impact, land)
    assert w is not None
    assert pickup - 0.6 <= w["to"] <= pickup + 0.05, w


def test_person_entering_from_the_edge_ends_the_window(tmp_path):
    impact, land, enter = 3.0, 5.5, 7.0

    def walker(f, t):
        if t >= enter:
            _person(f, W + 20 - 260 * (t - enter), 320, 130, (40, 40, 160))
        return False

    w, _ = _window(_clip(tmp_path / "edge.mp4", 10.0, _swing_scene(impact, walker)), impact, land)
    assert w is not None
    assert land <= w["to"] <= enter + 0.25, w


def test_window_starts_once_the_golfer_has_walked_to_the_ball(tmp_path):
    impact, land, arrive = 7.0, 9.5, 3.5

    def walk_in(f, t):
        if t >= arrive:
            return False
        k = max(0.0, (t - 0.3) / (arrive - 0.3))   # from in front of the lens to the address spot
        _person(f, 340 - 40 * k, 460 - 160 * k, 540 - 380 * k)
        return True

    w, _ = _window(_clip(tmp_path / "walkin.mp4", 14.0, _swing_scene(impact, walk_in)), impact, land)
    assert w is not None
    assert arrive - 0.4 <= w["from"] <= impact - clean.LEAD_S, w
    assert w["to"] >= land + 3


def test_window_never_starts_inside_the_swing():
    """However late the last disturbance, the takeaway stays in the window."""
    t = np.arange(0, 10, 0.1)
    n = len(t)
    m = clean.Motion(t, np.full(n, 0.01), np.zeros(n), np.full(n, 50.0), np.full(n, 0.3), (t > 2.0) & (t < 3.55), np.zeros(n, bool), np.zeros(n, bool), 0.4)
    w = clean.window(m, 5.0, 8.0)
    assert w is not None and w["from"] <= 5.0 - clean.LEAD_S + 1e-6
    # A putt keeps less before the stroke.
    assert clean.window(m, 5.0, 8.0, putt=True)["from"] <= 5.0 - clean.PUTT_LEAD_S + 1e-6
