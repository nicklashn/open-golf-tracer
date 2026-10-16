"""Putting: strokes on the green, found from the ball rolling (never traced).

Sound is unreliable on the green (a soft tick, wind), so the ball itself is followed from where it
rests at address: every run of motion between two rests is one putt, and a ball that vanishes
where it slows down went in. Positions are in the followed frames' pixels; speeds and distances
are in ball radii, so the thresholds hold at any zoom.
"""
from __future__ import annotations

import math
from collections import deque
from collections.abc import Iterable
from dataclasses import dataclass

import cv2
import numpy as np

FOLLOW_FPS = 30.0
MAX_FOLLOW_S = 180.0
MATCH_MIN = 0.55        # template score of a sighting ...
REFIND_MIN = 0.7        # ... and of finding it again after losing it
REST_SPEED = 3.0        # r/s: the follower treats the ball as lying still below this
MAX_PUTT_SPEED = 200.0  # r/s in the image: ~4 m/s across the view; a chip leaves 2-4x faster
MOVE_R = 1.5            # off its rest spot by this much: rolling
STILL_R = 0.6           # staying within this much for REST_S: at rest
REST_S = 0.5
GONE_S = 1.0            # unseen this long after rolling: gone (in the hole, out of view or hidden)
LOST_MOVING_S = 2.5     # the follower gives up this long after losing a rolling ball ...
LOST_RESTING_S = 30.0   # ... or a lying one (a player standing over it, marking it)
MIN_ROLL_R = 3.0        # shorter is a nudge or noise, not a putt
MIN_ROLL_S = 0.25
RISE_R = 2.5            # the ball climbs this far above both ends of its path: it flew (a chip)
HOLE_SPEED = 60.0       # r/s: vanishing slower than this means it dropped
EDGE_R = 3.0
STILL_LYING = "the ball still lies on the green when the clip ends"


@dataclass
class Sightings:
    t: np.ndarray       # every followed frame (s)
    u: np.ndarray       # nan where the ball was not seen
    v: np.ndarray
    r: float            # ball radius at address (px)
    size: tuple[int, int]


@dataclass
class Roll:
    start: float
    end: float
    ended: str          # rest | hidden (seen again later) | gone | edge | clip
    t: np.ndarray       # sightings from the rest spot to the end
    u: np.ndarray
    v: np.ndarray
    peak: float         # r/s
    rise: float         # r
    length: float       # r
    seen: float         # share of frames with a sighting
    end_speed: float    # r/s over the last sightings
    holed: bool | None = None
    unsure: str = ""

    @property
    def ground(self) -> bool:
        return self.rise <= RISE_R and self.peak <= MAX_PUTT_SPEED

    @property
    def is_putt(self) -> bool:
        return self.ground and self.length >= MIN_ROLL_R and self.end - self.start >= MIN_ROLL_S and len(self.t) >= 5


# --- following the ball ------------------------------------------------------------------------

def _patch(g: np.ndarray, x: float, y: float, half: int) -> np.ndarray | None:
    cx, cy = int(round(x)), int(round(y))
    if cx - half < 0 or cy - half < 0 or cx + half + 1 > g.shape[1] or cy + half + 1 > g.shape[0]:
        return None
    return g[cy - half:cy + half + 1, cx - half:cx + half + 1].astype(np.float32)


def _sub(a: float, b: float, c: float) -> float:
    d = a - 2 * b + c
    return 0.0 if abs(d) < 1e-6 else float(np.clip(0.5 * (a - c) / d, -0.5, 0.5))


def _search(g: np.ndarray, tpl: np.ndarray, cx: float, cy: float, rad: float,
            min_score: float = MATCH_MIN) -> tuple[float, float, float] | None:
    """Best template match within `rad` of (cx, cy), nearer ones preferred."""
    half = tpl.shape[0] // 2
    x1, y1 = max(0, int(cx - rad) - half), max(0, int(cy - rad) - half)
    x2, y2 = min(g.shape[1], int(cx + rad) + half + 2), min(g.shape[0], int(cy + rad) + half + 2)
    win = g[y1:y2, x1:x2]
    if win.shape[0] < tpl.shape[0] or win.shape[1] < tpl.shape[1]:
        return None
    res = np.nan_to_num(cv2.matchTemplate(win.astype(np.float32), tpl, cv2.TM_CCOEFF_NORMED))
    yy, xx = np.mgrid[0:res.shape[0], 0:res.shape[1]]
    d = np.hypot(x1 + xx + half - cx, y1 + yy + half - cy) / max(rad, 1.0)
    j, i = np.unravel_index(int(np.argmax(res - 0.15 * d)), res.shape)
    score = float(res[j, i])
    found = win[j:j + tpl.shape[0], i:i + tpl.shape[1]]
    if score < min_score or found.std() < 0.5 * tpl.std():   # same shape but faint: grass, not the ball
        return None
    dx = _sub(res[j, i - 1], res[j, i], res[j, i + 1]) if 0 < i < res.shape[1] - 1 else 0.0
    dy = _sub(res[j - 1, i], res[j, i], res[j + 1, i]) if 0 < j < res.shape[0] - 1 else 0.0
    return x1 + i + half + dx, y1 + j + half + dy, score


def follow(frames: Iterable[tuple[float, np.ndarray]], start: tuple[float, float], r: float) -> Sightings:
    """Follow the ball lying at `start` through gray `frames` ((time, image) in order) until it
    has been out of sight too long. A lying ball is searched for around its spot; a rolling one
    ahead of its motion, in a window that grows while it is not seen."""
    r = max(1.0, r)
    half = max(3, int(round(1.6 * r)))
    ts: list[float] = []
    us: list[float] = []
    vs: list[float] = []
    tpl: np.ndarray | None = None
    hist: deque[tuple[float, float, float]] = deque(maxlen=64)
    size = (0, 0)
    for t, g in frames:
        if tpl is None:
            size = (g.shape[1], g.shape[0])
            p0 = _patch(g, *start, half)
            if p0 is None:
                break
            hit = _search(g, p0, start[0], start[1], 2 * r)
            x, y = (hit[0], hit[1]) if hit else start
            tpl = _patch(g, x, y, half)
            if tpl is None:
                break
            hist.append((t, x, y))
            ts.append(t)
            us.append(x)
            vs.append(y)
            continue
        lt, lx, ly = hist[-1]
        old = next((h for h in hist if h[0] >= lt - 0.25), hist[-1])
        dt = lt - old[0]
        vx, vy = ((lx - old[1]) / dt, (ly - old[2]) / dt) if dt > 0.05 else (0.0, 0.0)
        resting = math.hypot(vx, vy) < REST_SPEED * r
        gap = t - lt
        if gap > (LOST_RESTING_S if resting else LOST_MOVING_S):
            break
        px, py = (lx, ly) if resting else (lx + vx * gap, ly + vy * gap)
        rad = min(2 * r + MAX_PUTT_SPEED * r * gap, (12 if resting else 40) * r)
        hit = _search(g, tpl, px, py, rad, MATCH_MIN if gap < 0.15 else REFIND_MIN)
        ts.append(t)
        if hit is None:
            us.append(math.nan)
            vs.append(math.nan)
            continue
        x, y, score = hit
        us.append(x)
        vs.append(y)
        hist.append((t, x, y))
        if score > 0.8:
            p = _patch(g, x, y, half)
            if p is not None:
                tpl = 0.7 * tpl + 0.3 * p
    return Sightings(np.array(ts), np.array(us), np.array(vs), r, size)


# --- strokes -----------------------------------------------------------------------------------

def _speeds(t: np.ndarray, u: np.ndarray, v: np.ndarray, r: float, lag: int = 3) -> np.ndarray:
    if len(t) <= lag:
        lag = max(1, len(t) - 1)
    if len(t) < 2:
        return np.zeros(1)
    dt = np.maximum(t[lag:] - t[:-lag], 1e-3)
    return np.hypot(u[lag:] - u[:-lag], v[lag:] - v[:-lag]) / dt / r


def _roll(s: Sightings, t, u, v, i0: int, i1: int, ended: str, rest: np.ndarray) -> Roll:
    r = s.r
    pt, pu, pv = t[i0:i1 + 1], u[i0:i1 + 1], v[i0:i1 + 1]
    # The ball left between the last still sighting and the first moving one: extrapolate the
    # first moving ones back to the rest spot.
    start = float(t[i0])
    if i1 >= i0 + 2:
        d1, d2 = (math.hypot(u[i0 + k] - rest[0], v[i0 + k] - rest[1]) for k in (1, 2))
        speed = (d2 - d1) / max(t[i0 + 2] - t[i0 + 1], 1e-3)
        if speed > 0:
            start = float(np.clip(t[i0 + 1] - d1 / speed, t[i0], t[i0 + 1]))
    end = float(t[i1])
    sp = _speeds(pt, pu, pv, r)
    tail = pt >= end - 0.3
    in_roll = (s.t >= start) & (s.t <= end)
    return Roll(
        start=start, end=end, ended=ended, t=pt, u=pu, v=pv,
        peak=float(np.percentile(sp, 90)),
        rise=float(max(0.0, min(pv[0], pv[-1]) - pv.min()) / r),
        length=float(np.hypot(pu - rest[0], pv - rest[1]).max() / r),
        seen=float(np.isfinite(s.u[in_roll]).mean()) if in_roll.any() else 0.0,
        end_speed=float(_speeds(pt[tail], pu[tail], pv[tail], r, 1).mean()) if tail.sum() >= 2 else float(sp[-1]),
    )


def segment(s: Sightings) -> list[Roll]:
    """Runs of motion between rests, with how each ended and whether it was holed."""
    r = s.r
    ok = np.isfinite(s.u)
    t, u, v = s.t[ok], s.u[ok], s.v[ok]
    n = len(t)
    if n < 3:
        return []
    dist = lambda i, p: math.hypot(u[i] - p[0], v[i] - p[1])  # noqa: E731
    first = t <= t[0] + 0.2
    rest = np.array([np.median(u[first]), np.median(v[first])])
    rolls: list[Roll] = []
    moving, i0, i = False, 0, 1
    while i < n:
        p = (u[i], v[i])
        if not moving:
            if t[i] - t[i - 1] > GONE_S and dist(i, rest) > MOVE_R * r:
                rest = np.array(p)          # hidden, then seen elsewhere: the ball was moved
            elif dist(i, rest) > MOVE_R * r and i + 1 < n and dist(i + 1, rest) > MOVE_R * r:
                j = i - 1
                while j > 0 and dist(j, rest) > STILL_R * r:
                    j -= 1
                i0, moving = j, True
            elif dist(i, rest) <= STILL_R * r:
                rest = 0.9 * rest + 0.1 * np.array(p)
            i += 1
            continue
        if t[i] - t[i - 1] > GONE_S:
            rolls.append(_roll(s, t, u, v, i0, i - 1, "hidden", rest))
            moving, rest = False, np.array(p)
            i += 1
            continue
        k = int(np.searchsorted(t, t[i] - REST_S))
        if k > i0 and i - k >= 2 and t[i] - t[k] >= 0.8 * REST_S and all(dist(m, p) <= STILL_R * r for m in range(k, i + 1)):
            while k - 1 > i0 and dist(k - 1, p) <= STILL_R * r:
                k -= 1
            rolls.append(_roll(s, t, u, v, i0, k, "rest", rest))
            moving, rest = False, np.array([u[k:i + 1].mean(), v[k:i + 1].mean()])
        i += 1
    if moving:
        ended = "gone" if s.t[-1] - t[-1] >= GONE_S else "clip"
        w, h = s.size
        x, y = u[-1], v[-1]
        if ended == "gone" and min(x, y, w - x, h - y) < EDGE_R * r:
            ended = "edge"
        rolls.append(_roll(s, t, u, v, i0, n - 1, ended, rest))
    _holed(rolls)
    return rolls


def _holed(rolls: list[Roll]) -> None:
    putts = [ro for ro in rolls if ro.is_putt]
    for k, ro in enumerate(putts):
        last = k == len(putts) - 1
        if ro.ended == "rest":
            ro.holed = False
            if last:
                ro.unsure = STILL_LYING
        elif ro.ended == "hidden":
            ro.holed = False
            ro.unsure = "the ball was out of sight as it stopped"
        elif ro.ended == "gone" and last and ro.end_speed <= HOLE_SPEED:
            ro.holed = True
        elif ro.ended == "gone":
            ro.unsure = "the ball vanished while rolling fast"
        elif ro.ended == "edge":
            ro.unsure = "the ball rolled out of view"
        else:
            ro.unsure = "the clip ends while the ball rolls"


# --- confidence --------------------------------------------------------------------------------

def green_prior(green_m: float | None, to_green: float | None) -> float:
    """How much the GPS says "on the green": metres to the mapped green, else to the hole's end."""
    if green_m is not None:
        return 1.0 if green_m <= 1 else 0.85 if green_m <= 8 else 0.4 if green_m <= 30 else 0.15
    if to_green is not None:
        return 0.8 if to_green <= 15 else 0.5 if to_green <= 40 else 0.15
    return 0.4


def confidence(ro: Roll, green: float, heard: bool = False) -> float:
    m = ro.seen ** 0.5
    if ro.ended not in ("rest", "gone"):
        m *= 0.8
    m *= 1 - 0.5 * min(1.0, ro.rise / RISE_R)
    m *= 1.0 if ro.peak <= 0.6 * MAX_PUTT_SPEED else 0.7
    c = 0.5 * green + 0.5 * m + (0.1 if heard else 0.0)
    return round(float(min(1.0, c)), 3)
