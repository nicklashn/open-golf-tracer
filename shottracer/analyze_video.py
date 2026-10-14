"""Analysis only (no rendering): python -m shottracer.analyze_video VIDEO [--out shots.json]

Prints/writes the project fragment the editor consumes (see pipeline.analyze)."""
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

from .pipeline import Options, analyze


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(prog="shottracer.analyze_video")
    ap.add_argument("video")
    ap.add_argument("--out")
    ap.add_argument("--slowmo", type=float, default=1.0)
    ap.add_argument("--model")
    a = ap.parse_args(argv)
    res = analyze(Path(a.video), Options(slowmo=a.slowmo, model=a.model),
                  progress=lambda f, m: print(f"  {f * 100:5.1f}% {m}", file=sys.stderr, flush=True))
    text = json.dumps(res, indent=2, ensure_ascii=False)
    if a.out:
        Path(a.out).write_text(text, encoding="utf-8")
    else:
        print(text)
    return 0 if res["shots"] else 2


if __name__ == "__main__":
    sys.exit(main())
