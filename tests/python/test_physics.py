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


# --- sanity rule: flights the editor cannot show ------------------------------------------

def test_normal_flight_is_in_frame():
    from shottracer.physics import off_frame_reason
    assert off_frame_reason(_flight(), 1920, 1080) is None


def test_flight_far_outside_the_picture_is_caught_and_pulled_in():
    from shottracer.physics import flight_handles, into_frame, off_frame_reason
    fl = _flight()
    # A wild fit: apex three frame heights above the picture, landing five widths to the right.
    wild = fit_constrained(fl.params, fl.cx, fl.cy, fl.anchor, 1920, 30.0, 3.0,
                           Constraints(apex=(1100, -3 * 1080), landing=(5 * 1920, 400)))
    assert off_frame_reason(wild, 1920, 1080) in {"apex off frame", "landing off frame", "flight too long", "carry too long"}
    fixed = into_frame(wild, 1920, 1080, 1920, 30.0)
    assert off_frame_reason(fixed, 1920, 1080) is None
    start, apex, land, _ = flight_handles(fixed)
    assert start == fl.anchor
    for x, y in (apex, land):
        assert 0 <= x <= 1920 and 0 <= y <= 1080
    assert apex[1] < land[1] < start[1]   # rises to the apex, lands lower down


def test_in_frame_handles_are_kept_when_pulling_in():
    from shottracer.physics import flight_handles, into_frame
    fl = _flight()
    _, apex0, land0, _ = flight_handles(fl)
    fixed = into_frame(fl, 1920, 1080, 1920, 30.0)
    _, apex, land, _ = flight_handles(fixed)
    assert math.hypot(apex[0] - apex0[0], apex[1] - apex0[1]) < 6
    assert math.hypot(land[0] - land0[0], land[1] - land0[1]) < 6


def test_invalid_flight_is_caught():
    from shottracer.physics import off_frame_reason
    fl = _flight()
    p = fl.params.copy()
    p[5] = math.radians(-25)   # camera pitched up: the address ball is above the horizon
    bad = Flight(p, fl.cx, fl.cy, (998.4, 100.0))
    assert off_frame_reason(bad, 1920, 1080) is not None
