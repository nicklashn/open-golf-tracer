"""Broadcast-style tracer: glowing line that thins with distance, drawn in sync with time.

Everything here produces RGBA overlays (straight alpha) that ffmpeg composites onto
the untouched source video.
"""
from __future__ import annotations

from dataclasses import dataclass

import cv2
import numpy as np


def hex_to_bgr(h: str) -> tuple[int, int, int]:
    h = h.lstrip("#")
    r, g, b = (int(h[i:i + 2], 16) for i in (0, 2, 4))
    return b, g, r


# Default look (same as TRACER_PRESETS.classic in packages/schema): the line rises softly out
# of the ball, runs orange-red into gold over the top, soft glow, no hard white core.
DEFAULT_COLOR = "#ff4520"
DEFAULT_COLOR2 = "#ffd23f"
BASE_WIDTH = 0.0022 * 4.5        # of the frame diagonal at the ball
FADE_IN = 0.3                    # fraction of the drawn line over which it fades in
CORE = 0.3                       # how white-hot the centre is
GLOW = 0.3


@dataclass
class TracerPath:
    t: np.ndarray       # flight time (s) per point
    x: np.ndarray       # output-image pixels
    y: np.ndarray
    width: np.ndarray   # line width in px
    alpha: np.ndarray   # opacity 0..1
    d: np.ndarray       # drawn length from the ball (px)

    @property
    def length(self) -> float:
        return float(self.d[-1]) if len(self.d) else 0.0

    @classmethod
    def build(cls, t, u, v, z, scale_to_output: float, out_diag: float, base_width: float = BASE_WIDTH,
              fade_in: float = FADE_IN):
        """Perspective styling: the line thins and fades with distance (aerial perspective) and
        rises softly out of the ball (fade_in) instead of starting as a blunt stub."""
        x, y = u * scale_to_output, v * scale_to_output
        near = np.clip(z[0] / z, 0.0, 1.0)
        w = base_width * out_diag * np.maximum(near ** 0.75, 0.09)
        a = 0.35 + 0.65 * near ** 0.4
        if fade_in <= 0:
            ease = np.clip(t / 0.06, 0, 1)
            w = w * (0.35 + 0.65 * ease * ease * (3 - 2 * ease))
        # Drop points closer than ~2.5 px to the previous kept point.
        keep = [0]
        for i in range(1, len(t)):
            if np.hypot(x[i] - x[keep[-1]], y[i] - y[keep[-1]]) >= 2.5:
                keep.append(i)
        if keep[-1] != len(t) - 1:
            keep.append(len(t) - 1)
        k = np.array(keep)
        xs, ys = x[k], y[k]
        steps = np.hypot(np.diff(xs), np.diff(ys))
        d = np.concatenate([[0.0], np.cumsum(np.nan_to_num(steps))])
        a = a[k]
        if fade_in > 0 and d[-1] > 0:
            c = np.clip(d / (fade_in * d[-1]), 0, 1)
            a = a * c * c * (3 - 2 * c)
        return cls(t[k], xs, ys, np.maximum(w[k], 1.0), a, d)

    def until(self, s: float) -> int:
        return int(np.searchsorted(self.t, s, side="right"))


class TracerRenderer:
    def __init__(self, path: TracerPath, frame_shape: tuple[int, int], color: str = DEFAULT_COLOR,
                 color2: str | None = DEFAULT_COLOR2, glow: float = GLOW, core: float = CORE):
        self.path = path
        fh, fw = frame_shape
        self.c1 = np.array(hex_to_bgr(color)[::-1], np.float32)            # RGB
        self.c2 = np.array(hex_to_bgr(color2)[::-1], np.float32) if color2 else self.c1
        self.core_k = core
        self.glow = glow
        self.gs = 0.25
        self.blur = max(3, int(path.width[0] * 2.5) | 1)
        # Fixed overlay box: whole visible path plus room for glow, clipped to the frame.
        m = int(path.width.max() * 3 + self.blur)
        on = (path.x > -m) & (path.x < fw + m) & (path.y > -m) & (path.y < fh + m)
        xs, ys = (path.x[on], path.y[on]) if on.any() else (path.x[:1], path.y[:1])
        x1, x2 = max(0, int(xs.min()) - m), min(fw, int(xs.max()) + m + 1)
        y1, y2 = max(0, int(ys.min()) - m), min(fh, int(ys.max()) + m + 1)
        x1, y1 = x1 & ~1, y1 & ~1                       # even offsets for chroma-subsampled video
        w, h = max(2, (x2 - x1 + 1) & ~1), max(2, (y2 - y1 + 1) & ~1)
        w, h = min(w, fw - x1), min(h, fh - y1)
        self.box = (x1, y1, w, h)

    def _color(self, i: int) -> np.ndarray:
        """Colour of segment i: color -> color2 along the drawn line."""
        f = min(1.0, self.path.d[i] / max(1e-6, self.path.length))
        return self.c1 + (self.c2 - self.c1) * f

    def _lines(self, alpha: np.ndarray, rgb: np.ndarray | None, n: int, s: float, width_mul: float,
               alpha_mul: float = 1.0) -> None:
        """Draws segments into an alpha mask and a premultiplied colour image."""
        p = self.path
        x0, y0 = self.box[:2]
        ok = np.isfinite(p.x[:n]) & np.isfinite(p.y[:n])   # a degenerate fit can project to NaN
        xs = (np.nan_to_num(p.x[:n] - x0) * s * 16).astype(np.int32)
        ys = (np.nan_to_num(p.y[:n] - y0) * s * 16).astype(np.int32)
        for i in range(1, n):
            if not (ok[i - 1] and ok[i]):
                continue
            w = max(1, int(round(p.width[i] * width_mul * s)))
            a = min(1.0, float(p.alpha[i]) * alpha_mul)
            if a <= 0.004:
                continue
            a0, a1 = (int(xs[i - 1]), int(ys[i - 1])), (int(xs[i]), int(ys[i]))
            cv2.line(alpha, a0, a1, a, w, cv2.LINE_AA, shift=4)
            if rgb is not None:
                cv2.line(rgb, a0, a1, tuple(float(c) * a for c in self._color(i)), w, cv2.LINE_AA, shift=4)

    def empty(self) -> np.ndarray:
        return np.zeros((self.box[3], self.box[2], 4), np.uint8)

    def overlay(self, s: float, landed: bool) -> np.ndarray:
        n = self.path.until(s)
        if n < 2:
            return self.empty()
        w, h = self.box[2], self.box[3]
        gw, gh = max(1, int(w * self.gs)), max(1, int(h * self.gs))
        ga, gc = np.zeros((gh, gw), np.float32), np.zeros((gh, gw, 3), np.float32)
        self._lines(ga, gc, n, self.gs, 2.2)
        k = max(3, int(self.blur * self.gs) | 1)
        ga = cv2.resize(cv2.GaussianBlur(ga, (k, k), 0), (w, h), interpolation=cv2.INTER_LINEAR)
        gc = cv2.resize(cv2.GaussianBlur(gc, (k, k), 0), (w, h), interpolation=cv2.INTER_LINEAR)
        ba, bc = np.zeros((h, w), np.float32), np.zeros((h, w, 3), np.float32)
        self._lines(ba, bc, n, 1.0, 1.0, 0.9)
        ca = np.zeros((h, w), np.float32)
        self._lines(ca, None, n, 1.0, 0.3)
        if not landed and np.isfinite(self.path.x[n - 1]) and np.isfinite(self.path.y[n - 1]):
            i = n - 1
            r = max(2.0, float(self.path.width[i]) * 0.7)
            c = (int((self.path.x[i] - self.box[0]) * 16), int((self.path.y[i] - self.box[1]) * 16))
            cv2.circle(ca, c, int(r * 16), 1.0, -1, cv2.LINE_AA, shift=4)
            cv2.circle(ba, c, int(r * 16), 1.0, -1, cv2.LINE_AA, shift=4)
            cv2.circle(bc, c, int(r * 16), tuple(float(v) for v in self._color(i)), -1, cv2.LINE_AA, shift=4)

        # Straight colour of each layer, then glow -> body -> core "over" compositing.
        glow_rgb = gc / np.maximum(ga, 1e-6)[..., None]
        body_rgb = bc / np.maximum(ba, 1e-6)[..., None]
        core_rgb = body_rgb + (255 - body_rgb) * self.core_k
        ag = np.clip(ga, 0, 1) * self.glow
        ab = np.clip(ba, 0, 1)
        ac = np.clip(ca, 0, 1)
        cp = ag[..., None] * glow_rgb
        cp = cp * (1 - ab[..., None]) + ab[..., None] * body_rgb
        a = ag * (1 - ab) + ab
        cp = cp * (1 - ac[..., None]) + ac[..., None] * core_rgb
        a = a * (1 - ac) + ac
        rgb = cp / np.maximum(a, 1e-6)[..., None]
        out = np.empty((h, w, 4), np.uint8)
        out[..., :3] = np.clip(rgb, 0, 255)
        out[..., 3] = np.clip(a * 255, 0, 255)
        return out


def stats_card(stats: dict, frame_w: int, frame_h: int, estimated: bool = True) -> tuple[np.ndarray, tuple[int, int]]:
    """RGBA card with the estimated numbers and its top-left position in the frame."""
    lines = [
        ("CARRY", f"{stats['carry_m']:.0f} m"),
        ("APEX", f"{stats['apex_m']:.0f} m"),
        ("BALL SPEED", f"{stats['ball_speed_mph']:.0f} mph"),
        ("LAUNCH", f"{stats['launch_angle_deg']:.1f} deg"),  # Hershey fonts have no degree sign
    ]
    sc = max(0.5, min(frame_w, frame_h) / 1080 * 0.9)
    pad, lh = int(18 * sc), int(40 * sc)
    bw, bh = int(330 * sc), pad * 2 + lh * len(lines) + int(8 * sc)
    rgb = np.zeros((bh, bw, 3), np.uint8)
    rgb[:] = (20, 20, 20)
    for i, (k, v) in enumerate(lines):
        y = pad + lh * (i + 1) - int(10 * sc)
        cv2.putText(rgb, k, (pad, y), cv2.FONT_HERSHEY_SIMPLEX, 0.55 * sc, (170, 170, 170), max(1, int(1.2 * sc)), cv2.LINE_AA)
        cv2.putText(rgb, v, (int(170 * sc), y), cv2.FONT_HERSHEY_SIMPLEX, 0.85 * sc, (255, 255, 255), max(1, int(2 * sc)), cv2.LINE_AA)
    cv2.putText(rgb, "estimated" if estimated else "from the given carry", (pad, bh - int(10 * sc)), cv2.FONT_HERSHEY_SIMPLEX, 0.4 * sc, (130, 130, 130), 1, cv2.LINE_AA)
    rgba = np.dstack([rgb, np.full((bh, bw), 215, np.uint8)])
    return rgba, (pad * 2, pad * 2)
