"""Writes packages/physics/test/fixtures/parity.json: Python projections (and constrained
fits) for random shots. The TypeScript port must reproduce them (vitest)."""
from __future__ import annotations

import json
import math
import sys
from pathlib import Path

import numpy as np

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT))
from shottracer.physics import CLUBS, Constraints, Flight, fit_constrained, launch_prior  # noqa: E402

OUT = ROOT / "packages/physics/test/fixtures/parity.json"


def main() -> None:
    rng = np.random.default_rng(7)
    cases = []
    for i in range(24):
        W, H = (1920, 1080) if i % 3 else (1080, 1920)
        long_side = max(W, H)
        params = [
            float(rng.uniform(25, 80)), math.radians(rng.uniform(5, 35)), math.radians(rng.uniform(-30, 30)),
            float(rng.uniform(0.001, 0.006)), float(rng.uniform(-0.002, 0.002)), math.radians(rng.uniform(-5, 15)),
            math.log(rng.uniform(0.6, 2.0)), math.log(0.75 * long_side * rng.uniform(0.6, 1.6)), float(rng.uniform(-0.01, 0.01)),
        ]
        cam = {"cx": W / 2, "cy": H / 2}
        anchor = {"x": float(W * rng.uniform(0.3, 0.7)), "y": float(H * rng.uniform(0.7, 0.92))}
        fl = Flight(np.array(params), cam["cx"], cam["cy"], (anchor["x"], anchor["y"]))
        proj = fl.project(True)
        case = {"params": params, "camera": cam, "anchor": anchor, "size": [W, H]}
        case["launch_prior"] = {c: launch_prior(params, None if c == "auto" else c) for c in ["auto", *CLUBS]}
        if proj is None:
            case["projection"] = None
        else:
            t, u, v, z = proj
            idx = sorted(set(list(range(0, len(t), 12)) + [len(t) - 1]))
            case["projection"] = {"n": len(t), "idx": idx, "u": [float(u[j]) for j in idx], "v": [float(v[j]) for j in idx],
                                  "z": [float(z[j]) for j in idx]}
            st = fl.stats()
            case["stats"] = {"carry_m": st["carry_m"], "apex_m": st["apex_m"], "flight_time_s": st["flight_time_s"]}
            if i < 6:
                # A constrained refit: move the landing 4 % of the width to the right.
                land = (float(u[-1]) + 0.04 * W, float(v[-1]))
                con = Constraints(landing=land, carry_m=None)
                fit = fit_constrained(np.array(params), cam["cx"], cam["cy"], (anchor["x"], anchor["y"]), long_side,
                                      30.0, 3.0, con)
                p2 = fit.project(True)
                case["fit"] = {"landing": list(land), "fps": 30.0,
                               "result_landing": [float(p2[1][-1]), float(p2[2][-1])] if p2 is not None else None}
        cases.append(case)
    OUT.write_text(json.dumps({"cases": cases}, indent=1))
    print(f"wrote {len(cases)} cases to {OUT}")


if __name__ == "__main__":
    main()
