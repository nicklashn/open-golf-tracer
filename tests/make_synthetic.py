"""Renders a synthetic down-the-line golf shot with a known ground-truth flight.

Usage: python tests/make_synthetic.py OUT.mp4 [--phi DEG] [--fps 30] [--shots N] [--no-audio] [--portrait]
Writes OUT.mp4 and OUT.truth.json (impact times, ball start, flight stats).
"""
from __future__ import annotations

import argparse
import json
import math
import subprocess
import sys
import wave
from pathlib import Path

import cv2
import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from shottracer.physics import Flight  # noqa: E402
from shottracer.video import ffmpeg_bin  # noqa: E402


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("out")
    ap.add_argument("--phi", type=float, default=4.0)
    ap.add_argument("--fps", type=float, default=30.0)
    ap.add_argument("--speed", type=float, default=62.0)
    ap.add_argument("--theta", type=float, default=15.0)
    ap.add_argument("--ks", type=float, default=0.0008)
    ap.add_argument("--shots", type=int, default=1)
    ap.add_argument("--no-audio", action="store_true")
    ap.add_argument("--portrait", action="store_true")
    a = ap.parse_args()

    W, H = (1080, 1920) if a.portrait else (1920, 1080)
    fps, gap = a.fps, 9.0
    impacts = [2.0 + gap * i for i in range(a.shots)]
    dur = impacts[-1] + 5.0
    out = Path(a.out)
    rng = np.random.default_rng(1)

    # Background: sky gradient, tree line, fairway.
    bg = np.zeros((H, W, 3), np.uint8)
    horizon = int(H * 0.45)
    for y in range(horizon):
        k = y / horizon
        bg[y] = (235 - 40 * k, 200 - 30 * k, 150 - 20 * k)
    bg[horizon:] = (60, 140, 70)
    bg[horizon:] = (bg[horizon:].astype(np.int16) + rng.integers(-12, 12, (H - horizon, W, 1))).clip(0, 255).astype(np.uint8)
    for x in range(0, W, 23):
        cv2.circle(bg, (x, horizon - rng.integers(5, 40)), int(rng.integers(20, 45)), (40, 80, 45), -1)
    bg = cv2.GaussianBlur(bg, (3, 3), 0)

    cx, cy = W / 2, H / 2
    anchor = (W * 0.52, H * 0.86)
    params = np.array([a.speed, math.radians(a.theta), math.radians(a.phi), 0.0038, a.ks,
                       math.radians(4), math.log(1.3), math.log(0.75 * W), 0.0])
    fl = Flight(params, cx, cy, anchor)
    t_f, u_f, v_f, z_f = fl.project(True)

    def shot_at(t):
        """Index of the shot whose swing/flight is current at time t."""
        return min(range(len(impacts)), key=lambda j: abs(t - impacts[j]) if t <= impacts[j] + gap / 2 else 1e9)

    tmp = out.with_suffix(".silent.mp4")
    proc = subprocess.Popen([ffmpeg_bin(), "-y", "-v", "error", "-f", "rawvideo", "-pix_fmt", "bgr24",
                             "-s", f"{W}x{H}", "-r", str(fps), "-i", "-", "-c:v", "libx264", "-crf", "20",
                             "-pix_fmt", "yuv420p", str(tmp)], stdin=subprocess.PIPE)
    n = int(dur * fps)
    golfer_x = int(anchor[0] - 190)
    for i in range(n):
        t = i / fps
        t_imp = impacts[shot_at(t)]
        f = bg.copy()
        # Crude golfer: body + swinging club, fastest around impact.
        phase = np.clip((t - (t_imp - 1.2)) / 1.6, 0, 1)
        ang = math.pi * (0.5 + 1.6 * math.sin(phase * math.pi) * (1 if phase < 0.75 else 1))
        cv2.rectangle(f, (golfer_x - 45, int(H * 0.45)), (golfer_x + 45, int(H * 0.92)), (60, 50, 140), -1)
        cv2.circle(f, (golfer_x, int(H * 0.41)), 32, (140, 170, 210), -1)
        hand = (golfer_x + 40, int(H * 0.62))
        club = (int(hand[0] + 260 * math.cos(ang)), int(hand[1] + 260 * math.sin(ang)))
        cv2.line(f, hand, club, (30, 30, 30), 6, cv2.LINE_AA)
        s = t - t_imp
        if s < -gap / 2:
            pass
        elif s < 0:
            cv2.circle(f, (int(anchor[0]), int(anchor[1])), 6, (250, 250, 250), -1, cv2.LINE_AA)
        elif s <= t_f[-1]:
            j = int(np.searchsorted(t_f, s))
            r = max(1.0, 6 * z_f[0] / z_f[j])
            cv2.circle(f, (int(u_f[j] * 16), int(v_f[j] * 16)), int(r * 16), (245, 245, 245), -1, cv2.LINE_AA, shift=4)
        noise = rng.normal(0, 2.5, f.shape).astype(np.int16)
        proc.stdin.write((f.astype(np.int16) + noise).clip(0, 255).astype(np.uint8).tobytes())
    proc.stdin.close()
    proc.wait()

    if a.no_audio:
        tmp.replace(out)
    else:
        sr = 22050
        audio = rng.normal(0, 0.003, int(dur * sr))
        for t_imp in impacts:
            k = int(t_imp * sr)
            audio[k:k + 200] += np.exp(-np.arange(200) / 40) * rng.normal(0, 0.6, 200)
        wav = out.with_suffix(".wav")
        with wave.open(str(wav), "wb") as w:
            w.setnchannels(1); w.setsampwidth(2); w.setframerate(sr)
            w.writeframes((audio.clip(-1, 1) * 32767).astype(np.int16).tobytes())
        subprocess.run([ffmpeg_bin(), "-y", "-v", "error", "-i", str(tmp), "-i", str(wav), "-c:v", "copy",
                        "-c:a", "aac", "-shortest", str(out)], check=True)
        tmp.unlink(); wav.unlink()
    truth = {"impact": impacts[0], "impacts": impacts, "anchor": anchor, "stats": fl.stats(),
             "params": params.tolist(), "size": [W, H], "fps": fps}
    out.with_suffix(".truth.json").write_text(json.dumps(truth, indent=2))
    print(json.dumps(truth, indent=2))


if __name__ == "__main__":
    main()
