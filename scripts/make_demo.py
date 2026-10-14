"""Renders the bundled demo clip: an illustrated driving range with two drives and a known flight.

Usage: python scripts/make_demo.py [--out assets/demo/demo.mp4] [--analyze]

The scene is drawn (no stock footage), so it can ship with the app without licensing
questions. With --analyze the clip is run through the real analysis and
the result is written next to it as demo.analysis.json, which the demo project loads instantly.
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

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))
from shottracer.physics import Flight  # noqa: E402
from shottracer.video import ffmpeg_bin  # noqa: E402

W, H, FPS = 1920, 1080, 30.0
HORIZON = int(H * 0.422)  # matches the flight camera's horizon (pitch 3.5°, f = 0.75 W)
VP = (W * 0.5, HORIZON)


def lerp(a, b, k):
    return tuple(float(x) + (float(y) - float(x)) * k for x, y in zip(a, b))


def background(rng: np.random.Generator) -> np.ndarray:
    """Static scene in BGR: evening sky, hills, tree line, striped fairway, markers and a green."""
    img = np.zeros((H, W, 3), np.float32)
    # Sky: deep blue at the top to warm haze at the horizon, plus a soft sun glow.
    top, mid, low = (196, 140, 72), (226, 196, 150), (200, 222, 246)
    for y in range(HORIZON):
        k = y / HORIZON
        img[y] = lerp(top, mid, k / 0.7) if k < 0.7 else lerp(mid, low, (k - 0.7) / 0.3)
    yy, xx = np.mgrid[0:H, 0:W].astype(np.float32)
    sun = np.exp(-(((xx - W * 0.78) / 420) ** 2 + ((yy - HORIZON * 0.78) / 300) ** 2))
    img += sun[..., None] * np.array([40, 80, 110], np.float32)
    # Clouds: blurred, flattened blobs.
    clouds = np.zeros((H, W), np.float32)
    for _ in range(22):
        cx, cy = rng.uniform(0, W), rng.uniform(60, HORIZON * 0.6)
        for _ in range(6):
            cv2.ellipse(clouds, (int(cx + rng.normal(0, 90)), int(cy + rng.normal(0, 10))),
                        (int(rng.uniform(60, 160)), int(rng.uniform(14, 30))), 0, 0, 360, 1.0, -1)
    clouds = cv2.GaussianBlur(clouds, (0, 0), 18) * 0.55
    img = img * (1 - clouds[..., None]) + clouds[..., None] * np.array([245, 242, 240], np.float32)

    # Distant hills (two hazy layers).
    for base, amp, col, seed in ((HORIZON - 70, 50, (176, 168, 150), 1.3), (HORIZON - 34, 34, (140, 146, 124), 2.1)):
        xs = np.arange(W)
        ridge = base - amp * (0.6 * np.sin(xs / 310 + seed) + 0.4 * np.sin(xs / 127 + seed * 3)) * 0.5 - amp * 0.5
        for x in range(W):
            img[int(ridge[x]):HORIZON, x] = col
    # Tree line: overlapping crowns with a darker base.
    trees = np.zeros((H, W, 3), np.float32)
    mask = np.zeros((H, W), np.float32)
    for x in range(-30, W + 30, 14):
        r = int(rng.uniform(16, 34))
        y = HORIZON - int(rng.uniform(4, 26))
        g = rng.uniform(0.8, 1.15)
        col = (52 * g, 92 * g, 60 * g)
        cv2.circle(trees, (x, y), r, col, -1, cv2.LINE_AA)
        cv2.circle(mask, (x, y), r, 1.0, -1, cv2.LINE_AA)
        cv2.circle(trees, (x - r // 3, y - r // 3), r // 2, (70 * g, 122 * g, 82 * g), -1, cv2.LINE_AA)
    mask = cv2.GaussianBlur(mask, (0, 0), 1.2)
    img = img * (1 - mask[..., None]) + trees * mask[..., None]

    # Ground: rough at the sides, mown fairway in the middle with perspective stripes.
    g0 = HORIZON
    for y in range(g0, H):
        k = (y - g0) / (H - g0)
        img[y] = lerp((62, 132, 78), (52, 150, 76), k)
    for i in range(-12, 13):
        x0, x1 = VP[0] + i * 70, W / 2 + i * 380
        x2, x3 = VP[0] + (i + 1) * 70, W / 2 + (i + 1) * 380
        poly = np.array([[x0, g0], [x2, g0], [x3, H], [x1, H]], np.int32)
        shade = 1.07 if i % 2 == 0 else 0.95
        sub = np.zeros((H, W), np.uint8)
        cv2.fillPoly(sub, [poly], 1)
        img[sub == 1] *= shade
    # Fairway edges darken to rough.
    edge = np.clip((np.abs(xx - VP[0]) - (yy - g0).clip(0) * 1.9 - 140) / 260, 0, 1) * (yy > g0)
    img = img * (1 - 0.28 * edge[..., None])
    # Haze near the horizon.
    haze = np.exp(-np.clip(yy - g0, 0, None) / 60) * (yy >= g0)
    img = img * (1 - 0.45 * haze[..., None]) + haze[..., None] * 0.45 * np.array([170, 190, 200], np.float32)

    # Distance markers (perspective scaled) and a target green with a flag.
    for d, side in ((0.08, -1), (0.16, 1), (0.30, -1), (0.55, 1)):
        y = g0 + (H - g0) * d * 0.35
        x = VP[0] + side * (40 + 900 * d)
        s = 0.25 + 2.2 * d
        cv2.line(img, (int(x), int(y)), (int(x), int(y - 26 * s)), (235, 235, 235), max(1, int(2 * s)), cv2.LINE_AA)
        cv2.rectangle(img, (int(x), int(y - 26 * s)), (int(x + 12 * s), int(y - 18 * s)), (40, 40, 210), -1, cv2.LINE_AA)
    gx, gy = int(W * 0.56), g0 + 16
    cv2.ellipse(img, (gx, gy), (70, 7), 0, 0, 360, (90, 182, 112), -1, cv2.LINE_AA)
    cv2.line(img, (gx + 6, gy), (gx + 6, gy - 30), (240, 240, 240), 2, cv2.LINE_AA)
    cv2.fillConvexPoly(img, np.array([[gx + 7, gy - 30], [gx + 21, gy - 26], [gx + 7, gy - 22]], np.int32), (40, 50, 225), cv2.LINE_AA)

    # Hitting mat under the ball.
    mat = np.array([[W * 0.40, H * 0.80], [W * 0.62, H * 0.80], [W * 0.66, H * 0.96], [W * 0.37, H * 0.96]], np.int32)
    cv2.fillPoly(img, [mat], (52, 98, 48), cv2.LINE_AA)
    cv2.polylines(img, [mat], True, (70, 120, 64), 2, cv2.LINE_AA)
    # Vignette.
    vig = 1 - 0.22 * (((xx - W / 2) / (W / 2)) ** 2 + ((yy - H / 2) / (H / 2)) ** 2) / 2
    img *= vig[..., None]
    return img.clip(0, 255).astype(np.uint8)


def ease(k: float) -> float:
    k = min(1.0, max(0.0, k))
    return k * k * (3 - 2 * k)


def swing_angle(s: float, address: float) -> float:
    """Club angle (image radians) at time s relative to impact; sweeps back over the shoulder and through."""
    back = address - math.radians(215)
    finish = address + math.radians(225)
    if s < -1.4:
        return address
    if s < -0.32:  # backswing
        return address + (back - address) * ease((s + 1.4) / 1.08)
    if s < 0:  # downswing, accelerating
        k = (s + 0.32) / 0.32
        return back + (address - back) * k ** 2.2
    if s < 0.55:  # follow-through
        k = s / 0.55
        return address + (finish - address) * (1 - (1 - k) ** 2.4)
    if s < 7.0:  # hold the finish while the ball is in the air
        return finish
    if s < 8.2:  # back to address for the next ball
        return finish + (address + 2 * math.pi - finish) * ease((s - 7.0) / 1.2)
    return address


def draw_golfer(f: np.ndarray, gx: float, ball: tuple[float, float], s: float) -> None:
    """Silhouette from behind (down the line), right-handed, standing left of the ball."""
    navy, skin, dark = (70, 44, 30), (120, 150, 196), (30, 32, 36)
    hip = (gx, H * 0.70)
    # Legs.
    for dx in (-34, 30):
        cv2.fillConvexPoly(f, np.array([[hip[0] + dx - 22, hip[1]], [hip[0] + dx + 22, hip[1]],
                                        [hip[0] + dx * 1.5 + 18, H * 0.93], [hip[0] + dx * 1.5 - 16, H * 0.93]], np.int32), (60, 56, 52), cv2.LINE_AA)
        cv2.ellipse(f, (int(hip[0] + dx * 1.5), int(H * 0.935)), (28, 10), 0, 0, 360, (235, 235, 235), -1, cv2.LINE_AA)
    # Torso leans towards the ball; it turns a little with the swing.
    turn = math.sin(min(max(s + 1.4, 0), 1.95) / 1.95 * math.pi) * 10 if s < 0.6 else 6
    shoulder = (gx + 46 + turn, H * 0.47)
    torso = np.array([[hip[0] - 52, hip[1]], [hip[0] + 52, hip[1]], [shoulder[0] + 60, shoulder[1]], [shoulder[0] - 66, shoulder[1] - 8]], np.int32)
    cv2.fillConvexPoly(f, torso, navy, cv2.LINE_AA)
    cv2.ellipse(f, (int(shoulder[0]), int(shoulder[1] + 4)), (66, 22), 0, 180, 360, navy, -1, cv2.LINE_AA)
    head = (int(shoulder[0] + 22), int(shoulder[1] - 46))
    cv2.circle(f, head, 34, skin, -1, cv2.LINE_AA)
    cv2.ellipse(f, (head[0] - 2, head[1] - 12), (38, 24), 0, 180, 360, (245, 245, 245), -1, cv2.LINE_AA)  # cap
    cv2.ellipse(f, (head[0] + 26, head[1] - 10), (22, 6), 0, 0, 360, (225, 225, 225), -1, cv2.LINE_AA)
    # Arms and club as one lever around the lead shoulder.
    pivot = (shoulder[0] + 30, shoulder[1] + 10)
    reach = math.hypot(ball[0] - pivot[0], ball[1] - pivot[1])
    address = math.atan2(ball[1] - pivot[1], ball[0] - pivot[0])
    a = swing_angle(s, address)
    arm = reach * 0.40
    hands = (pivot[0] + arm * math.cos(a), pivot[1] + arm * math.sin(a))
    cv2.line(f, (int(pivot[0]), int(pivot[1])), (int(hands[0]), int(hands[1])), navy, 26, cv2.LINE_AA)
    cv2.circle(f, (int(hands[0]), int(hands[1])), 13, (235, 235, 235), -1, cv2.LINE_AA)  # glove
    # The shaft lags behind the arms in the downswing and releases through impact.
    lag = math.radians(28) * math.sin(min(max((s + 0.32) / 0.32, 0), 1) * math.pi) if -0.32 <= s < 0 else 0
    ca = a - lag
    head_pt = (hands[0] + (reach - arm) * math.cos(ca), hands[1] + (reach - arm) * math.sin(ca))
    cv2.line(f, (int(hands[0]), int(hands[1])), (int(head_pt[0]), int(head_pt[1])), (40, 40, 44), 5, cv2.LINE_AA)
    cv2.ellipse(f, (int(head_pt[0]), int(head_pt[1])), (16, 9), math.degrees(ca), 0, 360, dark, -1, cv2.LINE_AA)


def draw_ball(f: np.ndarray, x: float, y: float, r: float) -> None:
    """A shaded golf ball: lit from the upper right, darker rim, small specular highlight."""
    if r < 2.5:
        cv2.circle(f, (int(x * 16), int(y * 16)), int(r * 16), (248, 248, 248), -1, cv2.LINE_AA, shift=4)
        return
    x0, y0, x1, y1 = int(x - r - 2), int(y - r - 2), int(x + r + 3), int(y + r + 3)
    if x0 < 0 or y0 < 0 or x1 > W or y1 > H:
        return
    yy, xx = np.mgrid[y0:y1, x0:x1].astype(np.float32)
    d = np.hypot(xx - x, yy - y) / r
    alpha = np.clip((1 - d) * r, 0, 1)[..., None]
    light = np.clip(1 - 0.35 * np.hypot(xx - (x + r * 0.35), yy - (y - r * 0.35)) / r, 0.55, 1)
    spec = np.exp(-(np.hypot(xx - (x + r * 0.3), yy - (y - r * 0.4)) / (r * 0.25)) ** 2) * 20
    col = (np.stack([light * 238, light * 242, light * 246], -1) + spec[..., None]).clip(0, 255)
    roi = f[y0:y1, x0:x1].astype(np.float32)
    f[y0:y1, x0:x1] = (roi * (1 - alpha) + col * alpha).astype(np.uint8)


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", default=str(ROOT / "assets/demo/demo.mp4"))
    ap.add_argument("--analyze", action="store_true", help="also write demo.analysis.json with the real analysis")
    a = ap.parse_args()
    out = Path(a.out)
    out.parent.mkdir(parents=True, exist_ok=True)
    rng = np.random.default_rng(7)
    bg = background(rng)

    impacts = [2.4, 12.6]
    dur = 20.0
    anchor = (W * 0.52, H * 0.865)
    flights = []
    for speed, theta, phi, ks in ((66.0, 14.0, 3.0, 0.0012), (63.0, 16.0, 6.0, -0.0006)):
        params = np.array([speed, math.radians(theta), math.radians(phi), 0.0038, ks, math.radians(3.5),
                           math.log(1.3), math.log(0.75 * W), 0.0])
        flights.append(Flight(params, W / 2, H / 2, anchor).project(True))

    noise = [rng.normal(0, 2.0, (H, W, 1)).astype(np.int16) for _ in range(6)]
    silent = out.with_suffix(".silent.mp4")
    proc = subprocess.Popen([ffmpeg_bin(), "-y", "-v", "error", "-f", "rawvideo", "-pix_fmt", "bgr24", "-s", f"{W}x{H}", "-r", str(FPS),
                             "-i", "-", "-c:v", "libx264", "-preset", "slow", "-crf", "21", "-pix_fmt", "yuv420p", str(silent)],
                            stdin=subprocess.PIPE)
    assert proc.stdin is not None
    golfer_x = anchor[0] - 250
    for i in range(int(dur * FPS)):
        t = i / FPS
        j = 0 if t < impacts[1] - 1.6 else 1
        s = t - impacts[j]
        f = bg.copy()
        tf, uf, vf, zf = flights[j]
        ball_visible_at_address = s < 0 or (j == 0 and s > 8.2)
        draw_golfer(f, golfer_x, anchor, s if not (j == 0 and s > 8.2) else -9)
        if ball_visible_at_address:  # a fresh ball is teed up after the first shot
            cv2.ellipse(f, (int(anchor[0] + 3), int(anchor[1] + 7)), (11, 4), 0, 0, 360, (36, 72, 36), -1, cv2.LINE_AA)
            draw_ball(f, anchor[0], anchor[1], 10)
        if 0 <= s <= tf[-1]:
            k = int(np.searchsorted(tf, s))
            draw_ball(f, uf[k], vf[k], max(1.2, 10 * zf[0] / zf[k]))
        proc.stdin.write((f.astype(np.int16) + noise[i % len(noise)]).clip(0, 255).astype(np.uint8).tobytes())
    proc.stdin.close()
    proc.wait()

    # Sound: soft wind, birds, and a crisp strike at each impact.
    sr = 44100
    n = int(dur * sr)
    wind = np.convolve(rng.normal(0, 1, n), np.ones(400) / 400, mode="same") * 0.05
    audio = wind + rng.normal(0, 0.002, n)
    tt = np.arange(n) / sr
    for start in (1.1, 6.3, 9.7, 15.9):
        k = (tt >= start) & (tt < start + 0.35)
        ph = (tt[k] - start)
        audio[k] += 0.04 * np.sin(2 * math.pi * (3800 + 900 * np.sin(ph * 40)) * ph) * np.exp(-((ph - 0.12) / 0.08) ** 2)
    for t_imp in impacts:
        k = int(t_imp * sr)
        m = int(0.12 * sr)
        env = np.exp(-np.arange(m) / (0.008 * sr))
        audio[k:k + m] += env * (0.7 * rng.normal(0, 1, m) + 0.5 * np.sin(2 * math.pi * 2600 * np.arange(m) / sr))
    wav = out.with_suffix(".wav")
    with wave.open(str(wav), "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(sr)
        w.writeframes((audio.clip(-1, 1) * 32767 * 0.8).astype(np.int16).tobytes())
    subprocess.run([ffmpeg_bin(), "-y", "-v", "error", "-i", str(silent), "-i", str(wav), "-c:v", "copy", "-c:a", "aac", "-b:a", "128k",
                    "-shortest", "-movflags", "+faststart", str(out)], check=True)
    silent.unlink()
    wav.unlink()
    print(f"wrote {out}")

    if a.analyze:
        from shottracer.pipeline import Options, analyze

        res = analyze(out, Options(), progress=lambda p, msg: print(f"  {p * 100:5.1f}% {msg}", file=sys.stderr, flush=True))
        dest = out.with_suffix(".analysis.json")
        dest.write_text(json.dumps(res, indent=2, ensure_ascii=False), encoding="utf-8")
        print(f"wrote {dest} ({len(res['shots'])} shots)")
        if len(res["shots"]) != len(impacts):
            print("warning: analysis did not find every shot", file=sys.stderr)
            return 2
    return 0


if __name__ == "__main__":
    sys.exit(main())
