"""Clean cut windows: the stretch around a shot where nothing spoils the picture.

A phone on a tripod films the golfer from behind. Before the swing the golfer often walks from
the camera to the ball, and after the landing walks back to stop the recording (or someone walks
in from the side, or the phone is picked up). An automatic cut with fixed pads shows that. Here
each shot gets a window, in source seconds, that the generated videos stay inside:

- `from`: after the last time someone came close to the camera, walked in away from the golfer
  or the camera moved, and after the golfer last walked about (set up still at address);
- `to`: before someone walks toward the camera, walks into the picture, moves big near the lens
  or the camera is picked up (large global shift, sudden blur) after the strike.

Cheap signals only: an ffmpeg decode at ~10 samples/s and ~192 px (gray) – for a full shot the
part up to the end of the track comes from the track's own decode (pipeline) – frame
differences, connected moving regions measured against the golfer's box (found at address
anyway), phase correlation for global shift and the Laplacian for blur.
"""
from __future__ import annotations

from collections.abc import Callable, Iterable
from dataclasses import dataclass

import cv2
import numpy as np

from .detect import Box
from .video import VideoInfo, decode

RATE = 10.0           # samples per video second
LONG_SIDE = 192       # long side of the sampled frames (px)
DIFF = 14             # grey levels a pixel must change between samples to count as moving
DIFF_BG = 24          # ... or differ from the stretch's background to count as foreground
MIN_REGION = 0.004    # moving regions smaller than this share of the frame are ignored
PRE_S = 3.5           # scanned before the strike (real seconds; slow motion scales them): the cuts keep at most 3 s
POST_S = 3.5          # ... and after the landing (the cuts keep at most 3.2 s)
MAX_FLIGHT_S = 8.0    # the landing is not known when the scan starts: cover the longest flight
FOLLOW_S = 0.5        # the follow-through after the strike is never an intrusion
LEAD_S = 1.4          # the window always keeps this much before a full swing (the takeaway) ...
PUTT_LEAD_S = 0.8     # ... and before a putt
BACKTRACK_S = 1.5     # an approach is followed back this far to where it began
DEFAULT_GOLFER_H = 0.4   # golfer height / frame height when no golfer was detected
DEFAULT_GOLFER_A = 0.06  # golfer box area / frame area when none was detected


@dataclass
class Motion:
    """Per-sample measurements of a stretch of video."""
    t: np.ndarray        # source seconds
    frac: np.ndarray     # share of pixels that changed since the previous sample
    shift: np.ndarray    # global image shift since the previous sample (share of the long side)
    sharp: np.ndarray    # Laplacian variance (drops when the camera blurs)
    tall: np.ndarray     # height of the tallest foreground region (share of the frame height)
    near: np.ndarray     # a foreground region far bigger than the golfer: someone close to the camera
    away: np.ndarray     # a person-sized foreground region away from the golfer: someone walked in
    big: np.ndarray      # whole-body movement (walking about), anywhere
    golfer_h: float      # golfer height used for the thresholds (share of the frame height)


def _zone(golfer: Box | None, size: tuple[int, int] | None, w: int, h: int):
    """Golfer height and box area as shares of the frame, and the box the swing reaches (frame px)."""
    if golfer is None or size is None or golfer.h <= 0 or golfer.w <= 0:
        return DEFAULT_GOLFER_H, DEFAULT_GOLFER_A, None
    sx, sy = w / size[0], h / size[1]
    gh = float(np.clip(golfer.h / size[1], 0.08, 0.9))
    ga = float(np.clip(golfer.w * golfer.h / (size[0] * size[1]), 0.004, 0.5))
    # The swing reaches beyond the body: club above the head, arms and club to the sides.
    zone = ((golfer.x1 - 0.6 * golfer.w) * sx, (golfer.y1 - 0.35 * golfer.h) * sy,
            (golfer.x2 + 0.6 * golfer.w) * sx, (golfer.y2 + 0.1 * golfer.h) * sy)
    return gh, ga, zone


def _stacked(regions: list[tuple], h: int) -> list[tuple]:
    """Regions one above the other joined into one: a person in front of something of their own
    colour (the golfer's spot in the background) splits into a top and a bottom part."""
    out = [list(r) for r in regions]
    merged = True
    while merged:
        merged = False
        for i in range(len(out)):
            for j in range(i + 1, len(out)):
                a, b = out[i], out[j]
                overlap = min(a[0] + a[2], b[0] + b[2]) - max(a[0], b[0])
                gap = max(a[1], b[1]) - min(a[1] + a[3], b[1] + b[3])
                if overlap >= 0.5 * min(a[2], b[2]) and gap < 0.25 * h:
                    x0, y0 = min(a[0], b[0]), min(a[1], b[1])
                    x1, y1 = max(a[0] + a[2], b[0] + b[2]), max(a[1] + a[3], b[1] + b[3])
                    out[i] = [x0, y0, x1 - x0, y1 - y0, a[4] + b[4]]
                    del out[j]
                    merged = True
                    break
            if merged:
                break
    return [tuple(r) for r in out]


def measure(frames: Iterable[tuple[float, np.ndarray]], golfer: Box | None = None, size: tuple[int, int] | None = None) -> Motion:
    """Measure (time, gray frame) samples. `golfer` is in the coordinates of `size` (w, h) –
    the source video; the frames may be any (smaller) size.

    Two kinds of change: from one sample to the next (camera movement, walking about) and from
    the stretch's background, its per-pixel median (whole silhouettes: a person of one colour
    walking toward the lens only changes at their outline from frame to frame)."""
    ts: list[float] = []
    imgs: list[np.ndarray] = []
    for t, gray in frames:
        if imgs and gray.shape != imgs[0].shape:
            continue
        ts.append(float(t))
        imgs.append(cv2.GaussianBlur(gray, (3, 3), 0).astype(np.float32))
    n = len(imgs)
    t_arr = np.array(ts)
    zeros = np.zeros(n)
    if not n:
        return Motion(t_arr, zeros, zeros, zeros, zeros, zeros.astype(bool), zeros.astype(bool), zeros.astype(bool), DEFAULT_GOLFER_H)
    h, w = imgs[0].shape
    gh, ga, zone = _zone(golfer, size, w, h)
    area = float(w * h)
    win = cv2.createHanningWindow((w, h), cv2.CV_32F)
    kernel = np.ones((3, 3), np.uint8)
    frac, shift, sharp, tall = zeros.copy(), zeros.copy(), zeros.copy(), zeros.copy()
    near, away, big = zeros.astype(bool), zeros.astype(bool), zeros.astype(bool)

    def regions(mask: np.ndarray):
        k, _, stats, _ = cv2.connectedComponentsWithStats(cv2.dilate(mask, kernel), connectivity=8)
        return [(x, y, bw, bh, a / area) for x, y, bw, bh, a in stats[1:k] if a / area >= MIN_REGION]

    for i, g in enumerate(imgs):
        sharp[i] = float(cv2.Laplacian(g, cv2.CV_32F).var())
        if i == 0:
            continue
        prev = imgs[i - 1]
        moving = (cv2.absdiff(g, prev) > DIFF).astype(np.uint8)
        frac[i] = float(moving.mean())
        (dx, dy), resp = cv2.phaseCorrelate(prev.copy(), g.copy(), win)   # it may window its inputs in place
        shift[i] = float(np.hypot(dx, dy)) / max(w, h) if resp > 0.05 else 0.0
        big[i] = any(af > max(0.006, 0.3 * ga) and bh / h > 0.8 * gh for _, _, _, bh, af in regions(moving))

    # A camera that moves all the time (hand-held) has no steady background to compare with.
    if n >= 3 and float(np.median(shift)) < 0.004 and float(np.median(frac)) < 0.08:
        bg = np.median(np.stack(imgs), axis=0).astype(np.float32)
        for i, g in enumerate(imgs):
            d = cv2.absdiff(g, bg)
            d = d - float(np.median(d))              # an exposure change lifts every pixel alike
            fg = cv2.morphologyEx((d > DIFF_BG).astype(np.uint8), cv2.MORPH_OPEN, kernel)
            for x, y, bw, bh, af in _stacked(regions(fg), h):
                hf = bh / h
                tall[i] = max(tall[i], hf)
                near[i] |= hf > min(0.95, 1.45 * gh) or af > max(0.10, 2.0 * ga)
                if af > max(0.015, 0.5 * ga):
                    inside = 0.0
                    if zone is not None:
                        ix = max(0.0, min(x + bw, zone[2]) - max(x, zone[0]))
                        iy = max(0.0, min(y + bh, zone[3]) - max(y, zone[1]))
                        inside = ix * iy / max(1.0, bw * bh)
                    away[i] |= inside < 0.3
    return Motion(t_arr, frac, shift, sharp, tall, near, away, big, gh)


def _camera(m: Motion) -> np.ndarray:
    """The camera moved (picked up, knocked, panned) or blurred, against the stretch's own
    calm level – a hand-held clip that shakes throughout is not cut everywhere."""
    if not len(m.t):
        return np.zeros(0, bool)
    shift0 = float(np.median(m.shift))
    sharp0 = float(np.median(m.sharp))
    blur = (m.sharp < 0.4 * sharp0) & (m.frac > 0.08) if sharp0 > 1.0 else np.zeros(len(m.t), bool)
    return (m.frac > 0.45) | ((m.shift > max(0.015, 4 * shift0)) & (m.frac > 0.1)) | blur


def _lasting(flag: np.ndarray) -> np.ndarray:
    """True where the flag holds for at least two samples in a row (one odd frame is noise)."""
    prev = np.r_[False, flag[:-1]]
    nxt = np.r_[flag[1:], False]
    return flag & (prev | nxt)


def window(m: Motion, impact: float, land: float, slowmo: float = 1.0, putt: bool = False) -> dict | None:
    """The clean window {from, to} (source seconds) around a shot struck at `impact` whose ball
    is down at `land`, from the motion measured around it."""
    if len(m.t) < 3:
        return None
    dt = 1.0 / RATE
    cam = _camera(m)
    event = _lasting(m.near | m.away | cam) | (m.frac > 0.6)
    lead = (PUTT_LEAD_S if putt else LEAD_S) * slowmo

    # End: the first intrusion after the follow-through, followed back to where it began.
    after = impact + FOLLOW_S * slowmo
    to = float(m.t[-1])
    hits = np.flatnonzero(event & (m.t >= after))
    if len(hits):
        i = j = int(hits[0])
        while (j > 0 and m.t[j - 1] >= after and m.t[i] - m.t[j - 1] <= BACKTRACK_S * slowmo
               and (m.tall[j - 1] > 1.1 * m.golfer_h or event[j - 1])):
            j -= 1
        # Sample j is the first that differs from the one before: the movement began after j-1.
        to = max(impact + 0.3 * slowmo, float(m.t[j]) - dt - 0.1)

    # Start: after the last intrusion before the swing, and after the golfer last walked about.
    latest = impact - lead
    frm = max(0.0, float(m.t[0]))
    before = np.flatnonzero(event & (m.t <= latest))
    if len(before):
        frm = max(frm, float(m.t[before[-1]]) + 0.25)
    walk = np.flatnonzero(_lasting(m.big) & (m.t <= latest) & (m.t >= frm))
    if len(walk):
        frm = max(frm, float(m.t[walk[-1]]) + 0.2)
    frm = min(frm, latest)
    return {"from": round(max(0.0, frm), 3), "to": round(max(to, frm + 0.1), 3)}


@dataclass(frozen=True)
class Span:
    """The frames a scan of [t0, t1] measures: every `every`-th from `start` (exclusive `stop`)."""
    start: int
    stop: int
    every: int
    scale: float

    def decode_args(self, start: int | None = None, stop: int | None = None) -> dict:
        """decode() arguments for these samples, or for those of them in [start, stop)."""
        return {"start": max(self.start, start or 0), "stop": self.stop if stop is None else min(self.stop, stop),
                "scale": self.scale, "gray": True, "every": self.every, "phase": self.start}


def span(info: VideoInfo, t0: float, t1: float) -> Span:
    """The samples of [t0, t1] (source seconds): ~RATE per second (a whole number of frames
    apart, so the samples are the same frames however the decode is split) at LONG_SIDE px."""
    t0 = max(0.0, t0)
    t1 = min(info.duration, t1)
    start = int(t0 * info.fps)
    stop = max(start + 1, int(np.ceil(t1 * info.fps)))
    return Span(start, stop, max(1, round(info.fps / RATE)), min(1.0, LONG_SIDE / max(1, info.long_side)))


def measure_span(info: VideoInfo, t0: float, t1: float, golfer: Box | None, head: list[tuple[int, np.ndarray]] | None = None,
                 stopped: Callable[[], bool] = lambda: False) -> Motion:
    """Decode [t0, t1] (source seconds) at ~RATE samples/s and LONG_SIDE px and measure it.
    `head`: (index, frame) samples of this span decoded already (its start, in order), e.g. by
    the track; `stopped` ends the decode early (a cancelled analysis)."""
    sp = span(info, t0, t1)
    got = [(i, g) for i, g in head or [] if sp.start <= i < sp.stop]
    if [i for i, _ in got] != list(range(sp.start, sp.stop, sp.every))[: len(got)]:
        got = []   # not this span's samples from its start: decode it all
    samples = [(i / info.fps, g) for i, g in got]
    nxt = got[-1][0] + sp.every if got else sp.start
    if nxt < sp.stop:
        frames = decode(info, **sp.decode_args(start=nxt))
        try:
            for i, g in frames:
                if stopped():
                    break
                samples.append((i / info.fps, g))
        finally:
            frames.close()
    return measure(samples, golfer, (info.width, info.height))


def scan_range(impact: float, slowmo: float = 1.0, land: float | None = None) -> tuple[float, float]:
    """Source seconds to measure around a strike; without a landing, the longest flight."""
    end = land if land is not None else impact + MAX_FLIGHT_S * slowmo
    return impact - PRE_S * slowmo, end + POST_S * slowmo
