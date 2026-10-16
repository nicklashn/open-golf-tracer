"""Strike sound signatures: the same strike heard by two microphones matches, two strikes don't."""
import time

import numpy as np

from shottracer.audio import find_strikes, signature, signature_similarity

SR = 22050


def _scene(seed: int) -> np.ndarray:
    """A strike at 1.0 s and what follows it: a click of its own colour and a few later sounds."""
    rng = np.random.default_rng(seed)
    x = np.zeros(int(3 * SR), np.float32)
    n = int(0.03 * SR)
    click = rng.normal(0, 1, n) * np.exp(-np.arange(n) / (SR * rng.uniform(0.002, 0.01)))
    click = np.convolve(click, rng.normal(0, 1, 8), "same")
    x[SR: SR + n] += click.astype(np.float32)
    for _ in range(4):
        at, dur = rng.uniform(1.1, 2.4), rng.uniform(0.05, 0.3)
        f = rng.uniform(150, 6000)
        t = np.arange(int(dur * SR)) / SR
        i = int(at * SR)
        x[i: i + len(t)] += (rng.uniform(0.05, 0.2) * np.sin(2 * np.pi * f * t) * np.hanning(len(t))).astype(np.float32)
    return x


def _recording(scene: np.ndarray, seed: int, gain: float, delay_s: float) -> np.ndarray:
    rng = np.random.default_rng(seed)
    y = np.roll(scene, int(delay_s * SR)) * gain
    return (y + rng.normal(0, 0.003 * gain, len(y))).astype(np.float32)


def test_same_strike_on_two_microphones_matches():
    scene = _scene(1)
    a = _recording(scene, 10, 1.0, 0.0)
    b = _recording(scene, 11, 0.2, 0.4)  # quieter, starts 0.4 s later
    # Each camera found the impact a frame or so off.
    sa, sb = signature(a, SR, 1.0 + 0.01), signature(b, SR, 1.4 - 0.03)
    assert sa and sb
    assert len(sa["bands"]) == 3 and len(sa["bands"][0]) == 80
    assert signature_similarity(sa, sb) > 0.85
    # More hiss on one phone.
    c = b + np.random.default_rng(12).normal(0, 0.02, len(b)).astype(np.float32)
    assert signature_similarity(sa, signature(c, SR, 1.4)) > 0.75


def test_two_strikes_do_not_match():
    # A partner hitting from the same tee: a click just as loud, but other sounds around it.
    for x, y in ((1, 2), (3, 4), (5, 6)):
        a, b = _recording(_scene(x), 10, 1.0, 0.0), _recording(_scene(y), 11, 0.5, 0.0)
        sa, sb = signature(a, SR, 1.0), signature(b, SR, 1.0)
        assert sa and sb
        assert signature_similarity(sa, sb) < 0.5


def test_found_strike_and_edges():
    a = _recording(_scene(3), 10, 1.0, 0.0)
    assert abs(find_strikes(a, SR)[0].time - 1.0) < 0.01
    assert signature(a, SR, 0.1) is not None  # padded before the start
    assert signature(a[:500], SR, 0.0) is None
    assert signature(np.zeros(SR * 3, np.float32), SR, 1.0) is None
    t0 = time.perf_counter()
    for _ in range(20):
        signature(a, SR, 1.0)
    assert (time.perf_counter() - t0) / 20 < 0.05
