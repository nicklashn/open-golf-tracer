"""Finds the ball in flight.

1. Candidates: three-frame differencing (an object present in frame i but not at
   the same spot in i-k and i+k) -> small connected components. Pixels that flicker
   all the time (trees, flags, water) and the golfer's body are down-weighted.
2. Chain search: dynamic programming finds the longest smooth chain of candidates,
   optionally starting at the address ball (see track_ball).
"""
from __future__ import annotations

import math
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass, field

import cv2
import numpy as np
from numba import njit

from .detect import Box
from .runtime import cpu_workers

MAX_PER_FRAME = 25      # kept per frame after weighting
RAW_PER_FRAME = 200     # considered per frame before weighting


@dataclass
class Candidates:
    fi: np.ndarray   # analysis frame index
    t: np.ndarray    # seconds relative to impact
    u: np.ndarray
    v: np.ndarray
    w: np.ndarray    # reliability weight 0..1

    def __len__(self) -> int:
        return len(self.t)

    def without(self, idx: np.ndarray) -> Candidates:
        keep = np.ones(len(self.t), bool)
        keep[idx] = False
        return Candidates(self.fi[keep], self.t[keep], self.u[keep], self.v[keep], self.w[keep])


@dataclass
class Track:
    t: np.ndarray
    u: np.ndarray
    v: np.ndarray
    anchored: bool
    seed_score: float
    idx: np.ndarray = field(default_factory=lambda: np.zeros(0, int))  # indices into the Candidates

    def __len__(self) -> int:
        return len(self.t)


def _align(src: np.ndarray, ref: np.ndarray, small: float = 0.25) -> np.ndarray:
    """Undo a global translation between two frames (handheld shake)."""
    a = cv2.resize(src, None, fx=small, fy=small, interpolation=cv2.INTER_AREA).astype(np.float32)
    b = cv2.resize(ref, None, fx=small, fy=small, interpolation=cv2.INTER_AREA).astype(np.float32)
    (dx, dy), resp = cv2.phaseCorrelate(b, a)
    dx, dy = dx / small, dy / small
    if resp < 0.1 or np.hypot(dx, dy) < 0.3:
        return src
    m = np.float32([[1, 0, -dx], [0, 1, -dy]])
    return cv2.warpAffine(src, m, (src.shape[1], src.shape[0]), borderMode=cv2.BORDER_REPLICATE)


def find_candidates(frames: list[np.ndarray], times: np.ndarray, t_impact: float, k: int,
                    people: list[Box], diag: float, align: bool = True) -> tuple[Candidates, np.ndarray]:
    h, w = frames[0].shape
    blurred = [cv2.GaussianBlur(f, (3, 3), 0) for f in frames]
    if align:
        # Only pay for per-frame alignment when the camera actually moves (handheld).
        probes = [i for i in (k, len(frames) // 2, len(frames) - 1 - k) if k <= i < len(frames) - k]
        align = any(_align(blurred[i - k], blurred[i]) is not blurred[i - k] for i in probes)
    max_area = (0.03 * diag) ** 2
    def per_frame(i: int):
        a, b, c = blurred[i - k], blurred[i], blurred[i + k]
        if align:
            a, c = _align(a, b), _align(c, b)
        m = cv2.min(cv2.absdiff(b, a), cv2.absdiff(c, b))
        hist = cv2.calcHist([m], [0], None, [256], [0, 256]).ravel().cumsum()
        p50 = float(np.searchsorted(hist, hist[-1] * 0.5))
        bw = (m > max(8.0, 6.0 * p50 + 4.0)).astype(np.uint8)
        n, _, stats, cent = cv2.connectedComponentsWithStats(bw, connectivity=8)
        out = []
        if n > 1:
            area = stats[1:, cv2.CC_STAT_AREA].astype(np.float32)
            cx, cy = cent[1:, 0], cent[1:, 1]
            ok = area <= max_area
            area, cx, cy = area[ok], cx[ok], cy[ok]
            peak = m[np.clip(cy.round().astype(int), 0, h - 1), np.clip(cx.round().astype(int), 0, w - 1)].astype(np.float32)
            strength = peak + 2 * np.sqrt(area)
            for j in np.argsort(-strength)[:RAW_PER_FRAME]:
                out.append((i, times[i] - t_impact, cx[j], cy[j], strength[j]))
        return bw, out

    idx = [i for i in range(k, len(frames) - k) if times[i] >= t_impact]
    freq = np.zeros((h, w), np.float32)
    rows = []
    # OpenCV releases the GIL, so threads give a near-linear speed-up here.
    with ThreadPoolExecutor(max_workers=cpu_workers()) as ex:
        for bw, out in ex.map(per_frame, idx):
            freq += bw
            rows += out
    if not rows:
        empty = np.zeros(0)
        return Candidates(empty.astype(int), empty, empty, empty, empty), freq
    arr = np.array(rows, dtype=np.float64)
    fi, t, u, v, strength = arr[:, 0].astype(int), arr[:, 1], arr[:, 2], arr[:, 3], arr[:, 4]

    # Flicker weight: a ball crosses a pixel once; foliage lights it up again and again.
    fb = cv2.blur(freq, (5, 5))
    f_at = fb[np.clip(v.round().astype(int), 0, h - 1), np.clip(u.round().astype(int), 0, w - 1)]
    wgt = np.clip(1.0 - (f_at - 2.0) / 6.0, 0.1, 1.0)
    for b in people:
        inside = (u >= b.x1) & (u <= b.x2) & (v >= b.y1) & (v <= b.y2)
        wgt[inside] *= 0.35

    # Keep the strongest reliable candidates per frame.
    rank = wgt * strength
    keep = np.zeros(len(fi), bool)
    for f in np.unique(fi):
        idx = np.flatnonzero(fi == f)
        keep[idx[np.argsort(-rank[idx])[:MAX_PER_FRAME]]] = True
    return Candidates(fi[keep], t[keep], u[keep], v[keep], wgt[keep]), freq




# --- chain tracker -----------------------------------------------------------------
# Every candidate is a node; edges join candidates up to MAX_GAP_FRAMES apart.
# Dynamic programming over edges finds the highest-scoring chain whose velocity
# changes smoothly from step to step. Speed may shrink a lot between steps
# (perspective makes a receding ball decelerate in the image), but direction must
# turn gently. The address ball is an optional extra start node with a bonus.

MAX_GAP_FRAMES = 3
ANCHOR_BONUS = 2.5
MIN_POINTS = 4


@njit(cache=True, fastmath=True)
def _turn_cost(px, py, qx, qy, from_anchor):
    """Cost of turning from velocity p to q (px/frame); inf if implausible.

    Tolerances widen for slow motion, where ~1 px of centroid noise dominates the
    direction (e.g. around the apex of a shot flying away from the camera).
    """
    s1 = math.sqrt(px * px + py * py) + 1e-9
    s2 = math.sqrt(qx * qx + qy * qy) + 1e-9
    c = (px * qx + py * qy) / (s1 * s2)
    ang = math.acos(min(1.0, max(-1.0, c)))
    ratio = s2 / s1
    if from_anchor:
        if ang > 0.9 or ratio <= 0.05 or ratio >= 1.6:
            return math.inf
        return (ang / 0.45) ** 2
    slow = 1.0 / min(s1, s2)
    a_sig, r_sig = 0.2 + 1.2 * slow, 0.35 + 0.8 * slow
    lr = math.log(ratio)
    if ang > 3 * a_sig or abs(lr) > 3 * r_sig:
        return math.inf
    return (ang / a_sig) ** 2 + (lr / r_sig) ** 2


@njit(cache=True)
def _dp(fi, u, v, w, frame_start, frame_end, f_min, anchor, f0, anchor_window, max_step, anchored_only, max_gap):
    """Edges are created per destination node in time order, so each node's incoming
    edges are contiguous: [in_lo[j], in_hi[j])."""
    n = len(fi) - 1                       # last node is the anchor
    cap = 64 * (n + 1) + 16
    e_src = np.empty(cap, np.int64); e_dst = np.empty(cap, np.int64)
    e_vx = np.empty(cap); e_vy = np.empty(cap); e_score = np.empty(cap); e_prev = np.empty(cap, np.int64)
    in_lo = np.zeros(n + 1, np.int64); in_hi = np.zeros(n + 1, np.int64)
    m = 0
    for j in range(n):
        in_lo[j] = m
        f = fi[j]
        for g in range(1, max_gap + 2):
            if g <= max_gap:
                fp = f - g
                if fp < f_min or fp - f_min >= len(frame_start):
                    continue
                lo, hi = frame_start[fp - f_min], frame_end[fp - f_min]
            else:                          # pseudo-gap: the anchor node
                if not anchor or not (0 < f - f0 <= anchor_window) or not (v[j] < v[n] - 2):
                    continue
                lo, hi = n, n + 1
            for i in range(lo, hi):
                gg = g if i != n else f - f0
                dx, dy = u[j] - u[i], v[j] - v[i]
                d = math.sqrt(dx * dx + dy * dy)
                if i != n and (d < gg or d > gg * max_step):
                    continue
                qx, qy = dx / gg, dy / gg
                if i == n or not anchored_only:
                    best, prev = w[i] + w[j], -1
                else:
                    best, prev = -math.inf, -1
                for k in range(in_lo[i], in_hi[i]):
                    c = _turn_cost(e_vx[k], e_vy[k], qx, qy, e_src[k] == n)
                    if c == math.inf:
                        continue
                    sc = e_score[k] + w[j] - 0.15 * c
                    if sc > best:
                        best, prev = sc, k
                if best == -math.inf:
                    continue
                if m >= cap:
                    break
                e_src[m] = i; e_dst[m] = j; e_vx[m] = qx; e_vy[m] = qy; e_score[m] = best; e_prev[m] = prev
                m += 1
        in_hi[j] = m
    return e_src[:m], e_dst[:m], e_score[:m], e_prev[:m]


def track_ball(C: Candidates, anchor: tuple[float, float] | None, frame_dt: float, diag: float) -> Track | None:
    """Prefer chains that start at the address ball; birds and planes make long smooth chains too."""
    if anchor:
        tr = _chain(C, anchor, frame_dt, diag, anchored_only=True)
        if tr is not None and len(tr) >= MIN_POINTS + 2:
            return tr
    return _chain(C, anchor, frame_dt, diag, anchored_only=False)


def _chain(C: Candidates, anchor, frame_dt: float, diag: float, anchored_only: bool) -> Track | None:
    if len(C) == 0:
        return None
    order = np.argsort(C.fi, kind="stable")
    fi_s = C.fi[order]
    f0 = int(round(C.fi[0] - C.t[0] / frame_dt))
    f_min = int(fi_s[0])
    span = int(fi_s[-1]) - f_min + 1
    frame_start = np.searchsorted(fi_s, np.arange(f_min, f_min + span), "left")
    frame_end = np.searchsorted(fi_s, np.arange(f_min, f_min + span), "right")
    fi = np.r_[fi_s, f0].astype(np.int64)
    u = np.r_[C.u[order], anchor[0] if anchor else 0.0]
    v = np.r_[C.v[order], anchor[1] if anchor else 0.0]
    w = np.r_[C.w[order], ANCHOR_BONUS]
    e_src, e_dst, e_score, e_prev = _dp(fi, u, v, w, frame_start, frame_end, f_min, anchor is not None, f0,
                                        int(round(0.25 / frame_dt)), 0.15 * diag, anchored_only, MAX_GAP_FRAMES)
    if len(e_src) == 0:
        return None
    n = len(fi) - 1
    k = int(np.argmax(e_score))
    top = k
    chain = []
    while True:
        chain.append(int(e_dst[k]))
        if e_prev[k] == -1:
            chain.append(int(e_src[k]))
            break
        k = int(e_prev[k])
    starts_at_anchor = chain[-1] == n
    chain = [c for c in reversed(chain) if c != n]
    if len(chain) < MIN_POINTS:
        return None
    idx = order[np.array(chain)]
    return Track(C.t[idx], C.u[idx], C.v[idx], anchored=starts_at_anchor, seed_score=float(e_score[top]), idx=idx)
