import math

import numpy as np

from shottracer.physics import Constraints, Flight, fit_constrained, landing, simulate


def _flight():
    p = np.array([62, math.radians(15), math.radians(4), 0.0038, 0.0008, math.radians(4), math.log(1.3),
                  math.log(0.75 * 1920), 0.0])
    return Flight(p, 960, 540, (998.4, 928.8))


def test_landing_is_on_the_ground():
    fl = _flight()
    ts, P = simulate(fl.params, fl.cx, fl.cy, fl.anchor, 12, True)
    t, u, v, carry = landing(P, ts, fl.params, fl.cx, fl.cy)
    assert abs(carry - fl.stats()["carry_m"]) < 1.0
    assert ts[-2] <= t <= ts[-1]


def test_constrained_fit_follows_landing_handle():
    fl = _flight()
    _, u, v, _ = fl.project(True)
    target = (u[-1] + 60, v[-1] + 10)
    out = fit_constrained(fl.params, fl.cx, fl.cy, fl.anchor, 1920, 30.0, 3.0, Constraints(landing=target))
    _, u2, v2, _ = out.project(True)
    assert math.hypot(u2[-1] - target[0], v2[-1] - target[1]) < 4


def test_constrained_fit_scales_to_carry():
    fl = _flight()
    out = fit_constrained(fl.params, fl.cx, fl.cy, fl.anchor, 1920, 30.0, 3.0, Constraints(carry_m=150))
    assert abs(out.stats()["carry_m"] - 150) < 4


def test_curve_sets_sidespin_sign():
    fl = _flight()
    fade = fit_constrained(fl.params, fl.cx, fl.cy, fl.anchor, 1920, 30.0, 3.0, Constraints(curve=1.0))
    draw = fit_constrained(fl.params, fl.cx, fl.cy, fl.anchor, 1920, 30.0, 3.0, Constraints(curve=-1.0))
    assert fade.p("ks") > 0 > draw.p("ks")
    assert fade.stats()["curve_m"] > draw.stats()["curve_m"]
