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
