"""Finds the moment of impact.

Primary cue: the address ball disappears from its spot and does not come back.
Secondary cue: club speed (pixel motion) around the ball peaks right at impact.
Audio, when present, refines the time to sub-frame precision.
"""
from __future__ import annotations

from dataclasses import dataclass

import cv2
import numpy as np
from scipy.ndimage import median_filter

from .audio import StrikePeak
from .detect import Ball


@dataclass
class Impact:
    time: float          # seconds into the video
    frame: int           # first frame where the ball is gone
    method: str
    confidence: float


class PresenceProbe:
    """Per-frame template match of the address ball plus local motion energy."""

    def __init__(self, ball: Ball, ref_frame: np.ndarray):
        gray = cv2.cvtColor(ref_frame, cv2.COLOR_BGR2GRAY)
        self.h, self.w = gray.shape
        r = ball.r
        half = int(np.ceil(max(1.3 * r, 4)))  # tight: a tee or divot left behind must not match
        self.pad = int(np.ceil(max(2, 0.6 * r)))
        cx, cy = int(round(ball.x)), int(round(ball.y))
        self.t_box = self._clip(cx - half, cy - half, cx + half + 1, cy + half + 1)
        self.s_box = self._clip(cx - half - self.pad, cy - half - self.pad, cx + half + self.pad + 1, cy + half + self.pad + 1)
        e = int(max(8 * r, 24))
        self.e_box = self._clip(cx - e, cy - e, cx + e, cy + e)
        x1, y1, x2, y2 = self.t_box
        self.template = gray[y1:y2, x1:x2].copy()
        self.prev_e = None
        # Region to decode per frame: union of search and energy boxes (x, y, w, h).
        rx1, ry1 = min(self.s_box[0], self.e_box[0]), min(self.s_box[1], self.e_box[1])
        rx2, ry2 = max(self.s_box[2], self.e_box[2]), max(self.s_box[3], self.e_box[3])
        self.region = (rx1, ry1, rx2 - rx1, ry2 - ry1)

    def _clip(self, x1, y1, x2, y2):
        return max(0, x1), max(0, y1), min(self.w, x2), min(self.h, y2)

    def _local(self, box):
        ox, oy = self.region[:2]
        return box[0] - ox, box[1] - oy, box[2] - ox, box[3] - oy

    def __call__(self, crop: np.ndarray) -> tuple[float, float]:
        """`crop` is the gray frame cropped to `self.region`."""
        x1, y1, x2, y2 = self._local(self.s_box)
        search = crop[y1:y2, x1:x2]
        if search.shape[0] < self.template.shape[0] or search.shape[1] < self.template.shape[1]:
            presence = 0.0
        else:
            m = cv2.matchTemplate(search, self.template, cv2.TM_CCOEFF_NORMED)
            presence = float(np.nan_to_num(m).max())
        x1, y1, x2, y2 = self._local(self.e_box)
        cur = crop[y1:y2, x1:x2]
        energy = 0.0 if self.prev_e is None else float(cv2.absdiff(cur, self.prev_e).mean())
        self.prev_e = cur
        return presence, energy


def ball_left(ball: Ball, before: np.ndarray, after: np.ndarray) -> bool:
    """True if the ball seen in `before` is no longer at its spot in `after`."""
    probe = PresenceProbe(ball, before)
    x, y, w, h = probe.region
    crop = lambda f: cv2.cvtColor(f[y:y + h, x:x + w], cv2.COLOR_BGR2GRAY)  # noqa: E731
    p_before, _ = probe(crop(before))
    p_after, _ = probe(crop(after))
    return p_before > 0.6 and p_after < 0.5 * p_before


def _runs(mask: np.ndarray) -> list[tuple[int, int]]:
    """[start, end) index pairs of True runs."""
    d = np.diff(np.r_[0, mask.astype(np.int8), 0])
    return list(zip(np.flatnonzero(d == 1), np.flatnonzero(d == -1)))


def _audio_near(peaks: list[StrikePeak], t: float, window: float) -> StrikePeak | None:
    near = [p for p in peaks if abs(p.time - t) <= window]
    return max(near, key=lambda p: p.ratio) if near else None


def choose_impact(times: np.ndarray, presence: np.ndarray | None, energy: np.ndarray,
                  fps: float, audio: list[StrikePeak]) -> Impact | None:
    dt = 1.0 / fps
    if presence is not None and len(presence) > 5:
        p = median_filter(presence, size=3, mode="nearest")
        ref = float(np.percentile(p, 90))
        if ref > 0.5:
            gone = p < 0.55 * ref
            min_len = max(3, int(round(0.15 * fps)))
            e_norm = energy / (np.median(energy) + 1e-3)
            best, best_score = None, -1.0
            for s, e in _runs(gone):
                long_enough = (e - s) >= min_len
                permanent = e == len(p) or (times[e - 1] - times[s]) >= 1.5
                was_there = s >= int(0.3 * fps) and not gone[max(0, s - int(0.3 * fps)):s].any()
                if not (long_enough and permanent and was_there):
                    continue
                score = float(e_norm[max(0, s - 3):s + 2].max())
                a = _audio_near(audio, times[s], 0.15)
                if a:
                    score += 5 + a.ratio
                if score > best_score:
                    best, best_score = s, score
            if best is not None:
                t_vis = 0.5 * (times[best - 1] + times[best])
                a = _audio_near(audio, t_vis, 1.5 * dt)
                if a:
                    return Impact(a.time, int(round(times[best] * fps)), "ball gone + sound", 0.95)
                return Impact(t_vis, int(round(times[best] * fps)), "ball gone", 0.8)
    if audio and audio[0].ratio >= 10:
        t = audio[0].time
        return Impact(t, int(round(t * fps)), "sound", 0.6)
    if len(energy) > 5 and energy.max() > 4 * (np.median(energy) + 1e-3):
        i = int(np.argmax(energy))
        return Impact(float(times[i]), int(round(times[i] * fps)), "motion stop", 0.3)
    return None
