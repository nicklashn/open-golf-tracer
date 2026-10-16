"""Finds club-ball strike transients in the soundtrack.

A strike is a very short, broadband click that towers over the local background,
so we look for peaks in high-passed short-time energy relative to a running median.
"""
from __future__ import annotations

from dataclasses import dataclass

import numpy as np
from scipy.ndimage import median_filter
from scipy.signal import find_peaks

HOP_S = 0.002


@dataclass
class StrikePeak:
    time: float      # onset time in seconds
    ratio: float     # peak energy / local background
    energy: float


def find_strikes(samples: np.ndarray, sr: int, min_ratio: float = 6.0) -> list[StrikePeak]:
    hp = np.diff(samples)  # crude high-pass: strikes are rich in high frequencies
    hop = max(1, int(sr * HOP_S))
    n = len(hp) // hop
    if n < 50:
        return []
    e = np.sqrt((hp[: n * hop].reshape(n, hop) ** 2).mean(1)) + 1e-7
    bg = median_filter(e, size=int(0.3 / HOP_S), mode="nearest") + 1e-6
    ratio = e / bg
    idx, _ = find_peaks(ratio, height=min_ratio, distance=int(0.5 / HOP_S))
    peaks = []
    for i in idx:
        # onset = first hop of the burst that reaches half the peak energy
        j = i
        while j > 0 and e[j - 1] > 0.5 * e[i] and i - j < 10:
            j -= 1
        peaks.append(StrikePeak(time=j * hop / sr, ratio=float(ratio[i]), energy=float(e[i])))
    peaks.sort(key=lambda p: p.ratio * np.sqrt(p.energy), reverse=True)
    return peaks


# Sound signature: what the microphone heard around a strike, small enough to keep on the shot.
# Log band energies at SIG_RATE frames/s from SIG_START to SIG_START + SIG_SPAN seconds around
# the impact, each band moved to zero mean and all scaled to unit spread (so gain and microphone
# tilt drop out). The click itself (SIG_CLICK frames) sounds alike for every strike and is left at 0;
# what identifies a strike is what is heard around it. packages/compose/src/match.ts compares
# signatures the same way as `signature_similarity`.
SIG_RATE = 40
SIG_START = -0.5
SIG_SPAN = 2.0
SIG_BANDS = (0.0, 1000.0, 4000.0, 1e9)  # Hz: low, mid, high
SIG_CLICK = (0, 2)  # frames from the impact frame on
SIG_WIN = 1024
SIG_FLOOR = 1e-3  # energy floor relative to the loudest frame: hiss below it is ignored


def _click(start: float, rate: float, n: int) -> np.ndarray:
    i = int(round(-start * rate))
    m = np.zeros(n, bool)
    m[max(0, i + SIG_CLICK[0]): max(0, i + SIG_CLICK[1])] = True
    return m


def signature(samples: np.ndarray, sr: int, t: float) -> dict | None:
    hop = sr / SIG_RATE
    n = int(round(SIG_SPAN * SIG_RATE))
    start = int(round((t + SIG_START) * sr)) - SIG_WIN // 2
    lo, hi = max(0, start), min(len(samples), start + int(n * hop) + SIG_WIN)
    if hi - lo < SIG_WIN:
        return None
    seg = np.zeros(int(n * hop) + SIG_WIN, np.float32)
    seg[lo - start: hi - start] = samples[lo:hi]
    idx = (np.arange(n) * hop).astype(int)[:, None] + np.arange(SIG_WIN)[None, :]
    spec = np.abs(np.fft.rfft(seg[idx] * np.hanning(SIG_WIN), axis=1)) ** 2
    freq = np.fft.rfftfreq(SIG_WIN, 1 / sr)
    keep = ~_click(SIG_START, SIG_RATE, n)
    e = np.stack([spec[:, (freq >= f0) & (freq < f1)].sum(1) for f0, f1 in zip(SIG_BANDS[:-1], SIG_BANDS[1:])])
    e = np.log10(e + SIG_FLOOR * e[:, keep].max(1, keepdims=True) + 1e-20)
    # One spread for all bands: a band with nothing but hiss stays small instead of being blown up.
    e = e - e[:, keep].mean(1, keepdims=True)
    sd = e[:, keep].std()
    if sd < 1e-6:
        return None  # silence
    z = np.where(keep, e / sd, 0.0)
    bands = [[round(float(v), 1) + 0.0 for v in row] for row in z]
    return {"rate": SIG_RATE, "start": SIG_START, "bands": bands}


def signature_similarity(a: dict, b: dict, max_lag_s: float = 0.15) -> float:
    """Best correlation (0…1) of two signatures over small time shifts (the impact times of two
    cameras differ by a frame or two), leaving out both clicks."""
    xa, xb = np.asarray(a["bands"], float), np.asarray(b["bands"], float)
    if xa.shape[0] != xb.shape[0] or a["rate"] != b["rate"]:
        return 0.0
    m = min(xa.shape[1], xb.shape[1])
    ka, kb = ~_click(a["start"], a["rate"], m), ~_click(b["start"], b["rate"], m)
    best = 0.0
    lag_n = int(round(max_lag_s * a["rate"]))
    for lag in range(-lag_n, lag_n + 1):
        sa, sb = slice(max(0, lag), m + min(0, lag)), slice(max(0, -lag), m - max(0, lag))
        k = ka[sa] & kb[sb]
        u, v = xa[:, sa][:, k].ravel(), xb[:, sb][:, k].ravel()
        if u.size < 10:
            continue
        u, v = u - u.mean(), v - v.mean()
        d = np.sqrt((u * u).sum() * (v * v).sum())
        if d > 0:
            best = max(best, float((u * v).sum() / d))
    return best
