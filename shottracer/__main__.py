"""Command line: python -m shottracer VIDEO [VIDEO ...] [options]"""
from __future__ import annotations

import argparse
import datetime
import subprocess
import sys
import traceback
from pathlib import Path

from .pipeline import Options, process

VIDEO_EXT = {".mp4", ".mov", ".m4v", ".avi", ".mkv"}
LOG = Path(__file__).resolve().parent.parent / "tracer_log.txt"


class _Tee:
    """Mirror console output into the log file so failed runs can be diagnosed afterwards."""

    def __init__(self, stream, log):
        self.stream, self.log = stream, log

    def write(self, text):
        self.stream.write(text)
        self.log.write(text)
        self.log.flush()

    def flush(self):
        self.stream.flush()


def _inputs(paths: list[str]) -> list[Path]:
    out = []
    for p in map(Path, paths):
        if p.is_dir():
            out += sorted(f for f in p.iterdir() if f.suffix.lower() in VIDEO_EXT and "_traced" not in f.stem)
        else:
            out.append(p)
    return out


def _place(path: Path) -> dict | None:
    """Course, hole and distance to the green from the video's GPS, via the app's OpenStreetMap
    lookup (apps/api). Optional: no GPS, no network or no API package just means no place."""
    api = Path(__file__).resolve().parent.parent / "apps" / "api"
    if str(api) not in sys.path:
        sys.path.insert(0, str(api))
    try:
        from golf_api.probe import probe_file
        from golf_api.routes.geo import place_at

        geo = probe_file(path).get("geo")
        return place_at(float(geo["lat"]), float(geo["lon"])) if geo else None
    except Exception:  # noqa: BLE001
        return None


def main(argv: list[str] | None = None) -> int:
    for stream in (sys.stdout, sys.stderr):
        stream.reconfigure(encoding="utf-8", errors="replace")
    log = LOG.open("a", encoding="utf-8")
    sys.stdout, sys.stderr = _Tee(sys.stdout, log), _Tee(sys.stderr, log)
    print(f"\n=== {datetime.datetime.now():%Y-%m-%d %H:%M:%S}  arguments: {sys.argv[1:] if argv is None else argv}")
    ap = argparse.ArgumentParser(prog="shottracer", description="Draws a shot tracer on golf videos.")
    ap.add_argument("inputs", nargs="+", help="video files or folders")
    ap.add_argument("-o", "--out", help="output file (one input) or output folder")
    ap.add_argument("--ball", help="the ball's position at address in pixels, e.g. 960,880")
    ap.add_argument("--impact", type=float, help="impact time in seconds")
    ap.add_argument("--slowmo", type=float, default=1.0, help="how many times slower the video plays than real time")
    ap.add_argument("--color", default="#ff4520", help="tracer colour as hex")
    ap.add_argument("--color2", default="#ffd23f", help="the colour over the top (none = one colour)")
    ap.add_argument("--stats", action="store_true", help="show estimated carry/apex/ball speed after landing")
    ap.add_argument("--no-hold", action="store_true", help="do not hold the last frame until the ball lands")
    ap.add_argument("--debug", action="store_true", help="save a debug image and JSON next to the output")
    ap.add_argument("--model", help="use YOLO with these weights instead of RF-DETR (e.g. yolo26x.pt)")
    ap.add_argument("--carry", type=float, help="known carry in metres - gives real numbers for apex/ball speed")
    ap.add_argument("--club", choices=["driver", "wood", "longIron", "midIron", "shortIron", "wedge"],
                    help="the club - gives a realistic estimate of speed/angle/carry (default: auto)")
    ap.add_argument("--open", action="store_true", help="show the finished video in Explorer")
    ap.add_argument("--no-map", action="store_true", help="turn off looking up the hole/course (OpenStreetMap) from the video's GPS")
    a = ap.parse_args(argv)

    files = _inputs(a.inputs)
    missing = [f for f in files if not f.is_file()]
    for f in missing:
        print(f"  ✗ not found: {f}")
    files = [f for f in files if f.is_file()]
    if not files:
        print("No videos to process.")
        return 1
    ball = tuple(float(x) for x in a.ball.split(",")) if a.ball else None
    opt = Options(ball=ball, impact=a.impact, slowmo=a.slowmo, color=a.color,
                  color2=None if (a.color2 or "").lower() in ("", "none") else a.color2, stats=a.stats,
                  debug=a.debug, hold=not a.no_hold, model=a.model, carry=a.carry, club=a.club)

    failures, last_ok = 0, None
    for f in files:
        if a.out and len(files) == 1 and not Path(a.out).is_dir():
            dst = Path(a.out)
        else:
            out_dir = Path(a.out) if a.out else f.parent
            out_dir.mkdir(parents=True, exist_ok=True)
            dst = out_dir / f"{f.stem}_traced.mp4"
        print(f"\n▶ {f.name}", flush=True)
        place = None if a.no_map else _place(f)
        if place and place.get("hole"):
            print(f"  ⛳ {place.get('course', '')} · hole {place['hole']}" + (f" · par {place['par']}" if place.get("par") else "")
                  + (f" · {place['toGreen']:.0f} m to the green" if place.get("toGreen") is not None else ""), flush=True)
        # The distance to the green caps what the estimate may claim (like in the web app).
        to_green = (place or {}).get("toGreen")
        opt.to_green = float(to_green) if to_green is not None else None
        try:
            r = process(f, dst, opt)
        except Exception as exc:  # keep going through a batch
            failures += 1
            print(f"  ✗ {exc}", flush=True)
            LOG.open("a", encoding="utf-8").write(traceback.format_exc())
            continue
        for w in r.warnings:
            print(f"  ! {w}")
        print(f"  ✓ Done: {dst}  ({r.seconds:.1f} s)", flush=True)
        last_ok = dst
    if a.open and failures < len(files):
        subprocess.Popen(["explorer", "/select,", str(last_ok.resolve())])
    return 1 if failures or missing else 0


if __name__ == "__main__":
    sys.exit(main())
