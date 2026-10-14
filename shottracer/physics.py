"""Ballistic golf-ball flight model fitted to 2D observations.

The ball starts on the ground where the address ball was seen. Its flight is
simulated in 3D (gravity, drag, backspin lift, sidespin curve) and projected
through a pinhole camera of unknown pitch, height and focal length. Gravity
sets the metric scale, so the fit also yields rough carry/apex/speed numbers.

Camera coordinates follow OpenCV: x right, y down, z forward.
"""
from __future__ import annotations

import math
from dataclasses import dataclass, field

import numpy as np
from numba import njit
from scipy.optimize import least_squares

G = 9.81
KD = 0.0047          # 0.5*rho*Cd*A/m for a golf ball (1/m)
DT = 1.0 / 240.0
MAX_FLIGHT = 12.0

NAMES = ("V", "theta", "phi", "kl", "ks", "pitch", "log_h", "log_f", "dt0")


@dataclass
class Flight:
    params: np.ndarray
    cx: float
    cy: float
    anchor: tuple[float, float]
    rms_px: float = float("nan")
    n_obs: int = 0
    fitted: bool = True

    def p(self, name: str) -> float:
        return float(self.params[NAMES.index(name)])

    @property
    def t_offset(self) -> float:
        return self.p("dt0")

    def simulate(self, to_ground: bool = True, t_end: float = MAX_FLIGHT):
        return simulate(self.params, self.cx, self.cy, self.anchor, t_end, to_ground)

    def project(self, to_ground: bool = True):
        """Returns (t, u, v, z) of the full flight in analysis-image coordinates."""
        sim = self.simulate(to_ground)
        if sim is None:
            return None
        t, P = sim
        f = math.exp(self.p("log_f"))
        z = np.maximum(P[:, 2], 1e-3)
        return t, self.cx + f * P[:, 0] / z, self.cy + f * P[:, 1] / z, z

    def stats(self) -> dict:
        sim = self.simulate(True)
        if sim is None:
            return {}
        t, P = sim
        pitch = self.p("pitch")
        sp, cp = math.sin(pitch), math.cos(pitch)
        F = np.array([0, -sp, cp]); R = np.array([1.0, 0, 0]); U = np.array([0, -cp, -sp])
        D = P - P[0]
        fwd, right, up = D @ F, D @ R, D @ U
        # Lateral relative to the initial horizontal launch direction.
        phi = self.p("phi")
        along = fwd * math.cos(phi) + right * math.sin(phi)
        lateral = -fwd * math.sin(phi) + right * math.cos(phi)
        carry = float(math.hypot(fwd[-1], right[-1]))
        return {
            "carry_m": round(carry, 1),
            "carry_yd": round(carry * 1.0936, 1),
            "apex_m": round(float(up.max()), 1),
            "flight_time_s": round(float(t[-1]), 2),
            "ball_speed_mph": round(self.p("V") * 2.23694, 1),
            "launch_angle_deg": round(math.degrees(self.p("theta")), 1),
            "curve_m": round(float(lateral[-1]), 1),
            "along_m": round(float(along[-1]), 1),
            "camera_height_m": round(math.exp(self.p("log_h")), 2),
            "camera_pitch_deg": round(math.degrees(pitch), 1),
        }


def simulate(params, cx, cy, anchor, t_end, to_ground=False):
    V, th, ph, kl, ks, pitch, log_h, log_f, _ = (float(x) for x in params)
    h, f = math.exp(log_h), math.exp(log_f)
    sp, cp = math.sin(pitch), math.cos(pitch)
    rx, ry = (anchor[0] - cx) / f, (anchor[1] - cy) / f
    den = cp * ry + sp
    if den < 1e-3:
        return None  # the address ball would be above the horizon
    z0 = h / den
    x, y, z = z0 * rx, z0 * ry, z0
    Fx, Fy, Fz = 0.0, -sp, cp
    Ux, Uy, Uz = 0.0, -cp, -sp
    c_th, s_th, c_ph, s_ph = math.cos(th), math.sin(th), math.cos(ph), math.sin(ph)
    hx, hy, hz = c_ph * Fx + s_ph, c_ph * Fy, c_ph * Fz
    vx = V * (c_th * hx + s_th * Ux)
    vy = V * (c_th * hy + s_th * Uy)
    vz = V * (c_th * hz + s_th * Uz)
    gx, gy, gz = 0.0, G * cp, G * sp
    n = int(t_end / DT) + 2
    out = _integrate(x, y, z, vx, vy, vz, gx, gy, gz, Ux, Uy, Uz, kl, ks, cp, sp, h, n, to_ground)
    return np.arange(len(out)) * DT, out


@njit(cache=True, fastmath=True)
def _integrate(x, y, z, vx, vy, vz, gx, gy, gz, Ux, Uy, Uz, kl, ks, cp, sp, h, n, to_ground):
    out = np.empty((n, 3))
    out[0, 0], out[0, 1], out[0, 2] = x, y, z
    k = 1
    t = 0.0
    while k < n:
        s = math.sqrt(vx * vx + vy * vy + vz * vz) + 1e-9
        ex, ey, ez = vx / s, vy / s, vz / s
        ud = Ux * ex + Uy * ey + Uz * ez
        nx, ny, nz = Ux - ud * ex, Uy - ud * ey, Uz - ud * ez
        nn = math.sqrt(nx * nx + ny * ny + nz * nz) + 1e-9
        sx, sy, sz = ey * Uz - ez * Uy, ez * Ux - ex * Uz, ex * Uy - ey * Ux
        sn = math.sqrt(sx * sx + sy * sy + sz * sz) + 1e-9
        s2 = s * s
        lk, sk = kl * s2 / nn, ks * s2 / sn
        vx += (gx - KD * s * vx + lk * nx + sk * sx) * DT
        vy += (gy - KD * s * vy + lk * ny + sk * sy) * DT
        vz += (gz - KD * s * vz + lk * nz + sk * sz) * DT
        x += vx * DT
        y += vy * DT
        z += vz * DT
        t += DT
        out[k, 0], out[k, 1], out[k, 2] = x, y, z
        k += 1
        if to_ground and t > 0.1 and -(cp * y + sp * z) < -h:
            break
    return out[:k]


# Typical launch per club in this model's terms: ball speed (m/s), launch angle (deg), lift kl.
# Calibrated 2026-10-14 so the simulated carry/apex match good-amateur averages (driver
# 215/28 m, wood 185/26, long iron 165/25, mid iron 140/24, short iron 110/22, wedge ~80/18).
# Same table in packages/physics/src/model.ts.
CLUBS: dict[str, tuple[float, float, float]] = {
    "driver": (67.0, 12.0, 0.00375),
    "wood": (55.0, 13.0, 0.00525),
    "longIron": (48.5, 15.0, 0.00625),
    "midIron": (41.5, 18.0, 0.0075),
    "shortIron": (36.5, 24.0, 0.0075),
    "wedge": (30.5, 30.0, 0.0075),
}
_BY_SPEED = sorted(CLUBS.values())
_V_TAB = [c[0] for c in _BY_SPEED]
_TH_TAB = [math.radians(c[1]) for c in _BY_SPEED]
_KL_TAB = [c[2] for c in _BY_SPEED]


def launch_prior(p, club: str | None) -> list[float]:
    """Prior residuals on ball speed, launch angle and lift. With a club: that club's typical
    launch. Without ("auto"): speed is free-ish, but the launch angle and lift must fit the
    speed the way real clubs do, so a short track can't turn a 90 m wedge into a 140 m
    7-iron or a towering 48° lob."""
    V, th, kl = float(p[0]), float(p[1]), float(p[3])
    if club in CLUBS:
        v0, th0, kl0 = CLUBS[club]
        return [(V - v0) / (0.15 * v0), (th - math.radians(th0)) / math.radians(5), (kl - kl0) / 0.0015]
    th0 = float(np.interp(V, _V_TAB, _TH_TAB))
    kl0 = float(np.interp(V, _V_TAB, _KL_TAB))
    return [(V - 60.0) / 30.0, (th - th0) / math.radians(8), (kl - kl0) / 0.002]


def _starts(club: str | None, carry_m: float | None) -> list[tuple[float, float, float]]:
    """(V, theta rad, kl) starting points; the cost surface has one basin per kind of shot."""
    if carry_m is not None:
        return [(V, math.radians(th), 0.0035) for V in (30.0 + 0.2 * carry_m, 40.0 + 0.25 * carry_m)
                for th in (9, 17, 26)]
    if club in CLUBS:
        v0, th0, kl0 = CLUBS[club]
        return [(v0, math.radians(th0), kl0), (0.9 * v0, math.radians(th0 + 4), kl0), (1.1 * v0, math.radians(th0 - 3), kl0)]
    return [(v, math.radians(th), kl) for v, th, kl in _BY_SPEED[::-1]]


def _bounds(f0: float, fps: float):
    lo = [15, math.radians(1), math.radians(-100), 0.0, -0.005, math.radians(-25), math.log(0.2), math.log(0.3 * f0 / 0.75), -1.5 / fps]
    hi = [90, math.radians(60), math.radians(100), 0.008, 0.005, math.radians(40), math.log(3.0), math.log(2.5 * f0 / 0.75), 1.5 / fps]
    return np.array(lo), np.array(hi)


def fit_flight(t_obs, u_obs, v_obs, anchor, cx, cy, long_side, fps, sigma_px, carry_m: float | None = None,
               club: str | None = None) -> Flight:
    """Fit the flight to 2D observations. A known carry (metres) pins down the scale,
    which a single camera otherwise only weakly constrains; a known club narrows it."""
    t_obs, u_obs, v_obs = map(np.asarray, (t_obs, u_obs, v_obs))
    f0 = 0.75 * long_side
    lo, hi = _bounds(f0, fps)
    t_end = float(t_obs.max()) + 0.1
    n = len(t_obs)

    def residuals(p):
        sim = simulate(p, cx, cy, anchor, t_end + 2 / fps)
        prior = np.array([
            *launch_prior(p, club),
            p[4] / 0.0015, (p[5] - math.radians(3)) / math.radians(12), (p[6] - math.log(1.2)) / 0.4,
            (p[7] - math.log(f0)) / 0.35, p[8] / (0.5 / fps)])
        if sim is None:
            # Same layout as a valid evaluation: data, ground, prior (+ carry) terms.
            bad = np.r_[np.full(3 * n, 50.0), prior]
            return bad if carry_m is None else np.r_[bad, 50.0]
        ts, P = sim
        tq = np.clip(t_obs - p[8], 0, ts[-1])
        x = np.interp(tq, ts, P[:, 0]); y = np.interp(tq, ts, P[:, 1]); z = np.maximum(np.interp(tq, ts, P[:, 2]), 1e-3)
        f = math.exp(p[7])
        ru = (cx + f * x / z - u_obs) / sigma_px
        rv = (cy + f * y / z - v_obs) / sigma_px
        # The ball cannot be below the ground while we still see it flying.
        sp_, cp_ = math.sin(p[5]), math.cos(p[5])
        height = -(cp_ * y + sp_ * z) + math.exp(p[6])
        under = np.minimum(height, 0.0) * 20.0
        if carry_m is None:
            return np.r_[ru, rv, under, prior]
        full = simulate(p, cx, cy, anchor, MAX_FLIGHT, to_ground=True)
        c = carry_of(full[1], p[5]) if full is not None else 0.0
        return np.r_[ru, rv, under, prior, (c - carry_m) / (0.02 * carry_m)]

    # Initial lateral direction from the first observed motion.
    early = t_obs <= t_obs.min() + 0.25
    du = np.mean(u_obs[early]) - anchor[0]
    dv = anchor[1] - np.mean(v_obs[early])
    if abs(du) > 1.5 * max(dv, 1e-6):
        phi0 = [math.copysign(math.radians(70), du), math.copysign(math.radians(85), du)]
    else:
        base = math.atan2(du, max(dv, 1e-6)) * 0.5
        phi0 = [base, base - math.radians(15), base + math.radians(15)]

    # Distance and speed trade off against each other in a single view, so the cost
    # surface has several basins: start from a grid of plausible shots.
    best = None
    for ph in phi0:
        for V, th, kl in _starts(club, carry_m):
            x0 = np.array([V, th, ph, kl, 0.0, math.radians(3), math.log(1.2), math.log(f0), 0.0])
            x0 = np.clip(x0, lo + 1e-9, hi - 1e-9)
            r = least_squares(residuals, x0, bounds=(lo, hi), loss="soft_l1", f_scale=1.5,
                              x_scale="jac", max_nfev=150, diff_step=1e-3)
            if best is None or r.cost < best.cost:
                best = r
    data = residuals(best.x)[: 2 * n] * sigma_px
    rms = float(np.sqrt(np.mean(data[:n] ** 2 + data[n:] ** 2)))
    return Flight(best.x, cx, cy, anchor, rms, n)


def carry_of(P: np.ndarray, pitch: float) -> float:
    """Horizontal distance from start to the last simulated point (metres)."""
    sp, cp = math.sin(pitch), math.cos(pitch)
    d = P[-1] - P[0]
    fwd = -sp * d[1] + cp * d[2]
    return float(math.hypot(fwd, d[0]))


def default_flight(anchor, cx, cy, long_side, fps, direction: float = 0.0, club: str | None = None) -> Flight:
    """A plausible shot straight away from the camera when nothing was tracked (mid iron, or
    the typical launch of the given club)."""
    V, th, kl = CLUBS.get(club or "", (55.0, 16.0, 0.0035))
    p = np.array([V, math.radians(th), direction, kl, 0.0, math.radians(3), math.log(1.2),
                  math.log(0.75 * long_side), 0.0])
    return Flight(p, cx, cy, anchor, fitted=False)


# --- user constraints ----------------------------------------------------------------------
# Same residual layout as packages/physics (TypeScript), which runs this live in the editor.

@dataclass
class Constraints:
    apex: tuple[float, float] | None = None        # image point the 3D apex must project to
    landing: tuple[float, float] | None = None     # image point of the landing spot
    points: list[tuple[float, float, float]] = field(default_factory=list)  # (flight t, u, v)
    carry_m: float | None = None
    curve: float | None = None                     # -1 draw .. +1 fade
    flight_time: float | None = None

    @property
    def empty(self) -> bool:
        return (self.apex is None and self.landing is None and not self.points and self.carry_m is None
                and self.curve is None and self.flight_time is None)


CONSTRAINT_PX = 0.5
CURVE_KS = 0.003


def _project_points(P: np.ndarray, cx: float, cy: float, f: float):
    z = np.maximum(P[:, 2], 1e-3)
    return cx + f * P[:, 0] / z, cy + f * P[:, 1] / z


def apex_index(P: np.ndarray, pitch: float) -> int:
    sp, cp = math.sin(pitch), math.cos(pitch)
    return int(np.argmax(-(cp * P[:, 1] + sp * P[:, 2])))


def landing(P: np.ndarray, ts: np.ndarray, params, cx: float, cy: float):
    """Exact ground crossing between the last two steps: (t, u, v, carry). Moves smoothly
    with the parameters, unlike the last step itself (same as packages/physics)."""
    sp, cp = math.sin(params[5]), math.cos(params[5])
    h, f = math.exp(params[6]), math.exp(params[7])
    n = len(P)
    a = 1.0
    if n >= 2:
        h0 = -(cp * P[-2, 1] + sp * P[-2, 2]) + h
        h1 = -(cp * P[-1, 1] + sp * P[-1, 2]) + h
        if h0 > 0 >= h1 and h0 != h1:
            a = h0 / (h0 - h1)
    q = P[-2] + (P[-1] - P[-2]) * a if n >= 2 else P[-1]
    z = max(q[2], 1e-3)
    fwd = -sp * (q[1] - P[0, 1]) + cp * (q[2] - P[0, 2])
    t = ts[-2] + (ts[-1] - ts[-2]) * a if n >= 2 else ts[-1]
    return float(t), cx + f * q[0] / z, cy + f * q[1] / z, float(math.hypot(fwd, q[0] - P[0, 0]))


def constraint_residuals(p, cx, cy, anchor, con: Constraints) -> np.ndarray:
    """Residuals for the user's handles; empty if there are none."""
    out: list[float] = []
    if con.curve is not None:
        out.append((p[4] - con.curve * CURVE_KS) / 0.0002)
    needs_full = con.apex or con.landing or con.points or con.carry_m or con.flight_time
    if not needs_full:
        return np.asarray(out)
    full = simulate(p, cx, cy, anchor, MAX_FLIGHT, to_ground=True)
    n_terms = (2 if con.apex else 0) + (2 if con.landing else 0) + 2 * len(con.points) \
        + (1 if con.carry_m else 0) + (1 if con.flight_time else 0)
    if full is None:
        return np.r_[out, np.full(n_terms, 50.0)]
    ts, P = full
    f = math.exp(p[7])
    pu, pv = _project_points(P, cx, cy, f)
    if con.apex:
        k = apex_index(P, p[5])
        out += [(pu[k] - con.apex[0]) / CONSTRAINT_PX, (pv[k] - con.apex[1]) / CONSTRAINT_PX]
    land = landing(P, ts, p, cx, cy) if (con.landing or con.carry_m or con.flight_time) else None
    if con.landing:
        out += [(land[1] - con.landing[0]) / CONSTRAINT_PX, (land[2] - con.landing[1]) / CONSTRAINT_PX]
    for t, u, v in con.points:
        tq = min(max(t, 0.0), ts[-1])
        out += [(np.interp(tq, ts, pu) - u) / CONSTRAINT_PX, (np.interp(tq, ts, pv) - v) / CONSTRAINT_PX]
    if con.carry_m:
        out.append((land[3] - con.carry_m) / (0.01 * con.carry_m))
    if con.flight_time:
        out.append((land[0] - con.flight_time) / 0.03)
    return np.asarray(out, dtype=float)


def fit_constrained(params0, cx, cy, anchor, long_side, fps, sigma_px, con: Constraints,
                    t_obs=None, u_obs=None, v_obs=None, club: str | None = None) -> Flight:
    """Refit a flight from a starting guess so it honours the user's constraints while
    staying close to the tracked points (if any) and to plausible golf physics."""
    f0 = 0.75 * long_side
    lo, hi = _bounds(f0, fps)
    has_obs = t_obs is not None and len(t_obs) > 0
    if has_obs:
        t_obs, u_obs, v_obs = map(np.asarray, (t_obs, u_obs, v_obs))
        t_end = float(t_obs.max()) + 0.1
    p_ref = np.asarray(params0, float)

    def residuals(p):
        prior = np.array([
            *launch_prior(p, club),
            p[4] / 0.0015 if con.curve is None else 0.0, (p[5] - math.radians(3)) / math.radians(12),
            (p[6] - math.log(1.2)) / 0.4, (p[7] - math.log(f0)) / 0.35, p[8] / (0.5 / fps)])
        # Stay near the current solution so a small drag gives a small change.
        stay = (p - p_ref) / np.array([20, 0.3, 0.3, 0.003, 0.002, 0.3, 0.5, 0.5, 1.0])
        parts = [prior, 0.3 * stay, constraint_residuals(p, cx, cy, anchor, con)]
        if has_obs:
            sim = simulate(p, cx, cy, anchor, t_end + 2 / fps)
            if sim is None:
                parts.insert(0, np.full(3 * len(t_obs), 50.0))
            else:
                ts, P = sim
                tq = np.clip(t_obs - p[8], 0, ts[-1])
                x = np.interp(tq, ts, P[:, 0]); y = np.interp(tq, ts, P[:, 1]); z = np.maximum(np.interp(tq, ts, P[:, 2]), 1e-3)
                f = math.exp(p[7])
                sp_, cp_ = math.sin(p[5]), math.cos(p[5])
                height = -(cp_ * y + sp_ * z) + math.exp(p[6])
                # Robust loss on the tracked points only, so the user's handles always win.
                parts.insert(0, np.r_[_soft_l1((cx + f * x / z - u_obs) / sigma_px), _soft_l1((cy + f * y / z - v_obs) / sigma_px),
                                      np.minimum(height, 0.0) * 20.0])
        return np.concatenate(parts)

    x0 = np.clip(p_ref, lo + 1e-9, hi - 1e-9)
    r = least_squares(residuals, x0, bounds=(lo, hi), x_scale="jac", max_nfev=200, diff_step=1e-3)
    fl = Flight(r.x, cx, cy, anchor)
    if has_obs:
        assert t_obs is not None and u_obs is not None and v_obs is not None
        sim = fl.project(to_ground=False)
        if sim is not None:
            ts, pu, pv, _ = sim
            tq = np.clip(t_obs - fl.t_offset, 0, ts[-1])
            err = np.hypot(np.interp(tq, ts, pu) - u_obs, np.interp(tq, ts, pv) - v_obs)
            fl.rms_px = float(np.sqrt(np.mean(err ** 2)))
        fl.n_obs = len(t_obs)
    return fl


def _soft_l1(r: np.ndarray, c: float = 1.5) -> np.ndarray:
    """scipy's soft_l1 loss as a residual transform (same as packages/physics)."""
    z = (r / c) ** 2
    return np.sign(r) * c * np.sqrt(2 * (np.sqrt(1 + z) - 1))
