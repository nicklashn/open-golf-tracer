"""End-to-end analysis and rendering.

`process()` is the CLI path: video in -> traced video out (best shot only).
`analyze()` is the editor path: video in -> project fragment (JSON) with every verified
shot, no rendering. Both share the same steps below.
"""
from __future__ import annotations

import json
import math
import threading
import time
from collections import deque
from collections.abc import Callable
from concurrent.futures import Future, ThreadPoolExecutor
from concurrent.futures import TimeoutError as FutureTimeout
from dataclasses import dataclass, field
from pathlib import Path

import cv2
import numpy as np

from . import audio as audio_mod
from . import clean as clean_mod
from . import putt as putt_mod
from .detect import Ball, BallDetector, feet_roi, get_detector, pick_golfer
from .impact import Impact, PresenceProbe, ball_left, choose_impact
from .physics import Flight, default_flight, fit_flight, into_frame, off_frame_reason
from .render import TracerPath, TracerRenderer, stats_card
from .track import Candidates, Track, find_candidates, track_ball
from .video import OverlayCompositor, VideoInfo, decode, decode_pair, load_audio, probe, read_frame

ANALYSIS_LONG_SIDE = 1920
TRACK_SECONDS = 4.0
MAX_TRACK_FRAMES = 640   # analysis frames per track at most (~1.3 GB of grey full-HD): slow motion samples sparser
CHECK_EVERY = 30         # frames between looks at whether the analysis was cancelled
ADDRESS_LEAD = 0.6   # seconds before impact where the golfer stands still over the ball
MIN_SHOT_GAP = 2.0   # two strikes closer than this are the same shot
GREEN_SLACK_M = 25.0  # a ball may carry this far past the green before the hole says no
WEAK_SHOT_CONF = 0.3  # below this, a shot with no sound or ball evidence is hidden
SHORT_GAME_M = 40.0  # this close to the green: chip, pitch or putt, not traced
GREEN_NEAR_M = 8.0   # the camera this close to a mapped green (or ...
PUTT_TO_GREEN_M = 15.0  # ... this close to the hole's end): look for putts first
PUTT_LONG_SIDE = 960  # putts are followed in frames this size, or larger for a tiny ball
PUTT_BALL_PX = 3.0

Progress = Callable[[float, str], None]


@dataclass
class Options:
    ball: tuple[float, float] | None = None      # manual address-ball position (output pixels)
    impact: float | None = None                  # manual impact time (s)
    slowmo: float = 1.0                          # video plays this many times slower than real time
    color: str = "#ff4520"
    color2: str | None = "#ffd23f"               # the line runs from color into color2
    stats: bool = False
    debug: bool = False
    hold: bool = True                            # freeze the last frame until the ball lands
    model: str | None = None
    carry: float | None = None                   # known carry in metres (scales the 3D fit)
    club: str | None = None                      # driver/wood/longIron/midIron/shortIron/wedge; None = auto
    to_green: float | None = None                # metres from the player to the green (hole from GPS)
    green_m: float | None = None                 # metres from the player to the nearest mapped green (0 = on it)
    ref_time: float | None = None                # manual ball: time the ball was clicked (strike follows)


@dataclass
class Result:
    output: Path
    impact: Impact | None
    ball: Ball | None
    track_points: int
    flight: Flight
    stats: dict
    warnings: list[str] = field(default_factory=list)
    seconds: float = 0.0


@dataclass
class Address:
    """The golfer standing over the ball, before a (possibly verified) strike."""
    ball: Ball | None
    ref_idx: int
    ref: np.ndarray | None
    golfer: object | None
    verified: float | None          # audio strike time confirmed by the ball leaving


@dataclass
class ShotAnalysis:
    impact: Impact
    ball: Ball | None
    track: Track | None
    flight: Flight
    anchor: tuple[float, float]     # analysis pixels
    sa: float                       # analysis scale (analysis px / source px)
    size_a: tuple[int, int]         # analysis frame (w, h)
    fps_a: float
    tol: float
    cands: Candidates
    color_at_impact: np.ndarray | None
    warnings: list[str] = field(default_factory=list)
    codes: list[tuple[str, str]] = field(default_factory=list)   # (code, detail) for the editor
    verdict: str | None = None

    @property
    def stats(self) -> dict:
        return self.flight.stats()


_T0 = [0.0]


def _log(msg: str) -> None:
    print(f"  [{time.perf_counter() - _T0[0]:5.1f}s] {msg}", flush=True)


# =============================================================================================
# CLI: one shot, rendered


def process(src: Path, dst: Path, opt: Options) -> Result:
    t_start = _T0[0] = time.perf_counter()
    info = probe(src)
    fps = info.fps
    _log(f"{info.width}x{info.height} @ {fps:.2f} fps, ~{info.frame_count / fps:.1f} s")

    det = get_detector(opt.model)
    aud = load_audio(src)
    strikes = audio_mod.find_strikes(*aud) if aud else []
    addr = _find_address(info, det, strikes, opt)
    ball = addr.ball
    _log(f"golfer: {'found' if addr.golfer else 'not found'}; ball: "
         + (f"({ball.x:.0f},{ball.y:.0f}) r={ball.r:.1f} via {ball.source} ({ball.conf:.2f})" if ball else "not found")
         + (f"; strike sound verified at {addr.verified:.2f} s" if addr.verified is not None else ""))

    impact = _find_impact(info, addr, strikes, opt)
    if impact is None:
        raise RuntimeError("Could not find the moment of impact. Give it with --impact SECONDS.")
    _log(f"impact: {impact.time:.3f} s (frame {impact.frame}) via {impact.method}")

    sh = _track_and_fit(info, det, impact, ball, opt)
    flight, stats, warnings = sh.flight, sh.stats, sh.warnings
    _log("estimate: " + ", ".join(f"{k}={v}" for k, v in stats.items()))

    # Render ---------------------------------------------------------------------------------
    sa = sh.sa
    proj = flight.project(to_ground=True)
    if proj is None:
        raise RuntimeError("The flight could not be computed")
    t_f, u_f, v_f, z_f = proj
    path = TracerPath.build(t_f, u_f, v_f, z_f, 1 / sa, info.diag)
    renderer = TracerRenderer(path, (info.height, info.width), opt.color, opt.color2)
    t_land = float(t_f[-1])
    flight_time = lambda tv: (tv - impact.time) / opt.slowmo - flight.t_offset  # noqa: E731

    # Overlay frame k belongs to video frame i_first + k; after landing ffmpeg repeats the last one.
    t_imp_video = impact.time + flight.t_offset * opt.slowmo
    i_first = max(0, int(np.floor(t_imp_video * fps)))
    t_land_video = t_imp_video + t_land * opt.slowmo
    i_last = int(np.ceil(t_land_video * fps)) + 1
    hold = max(0.0, t_land_video + 1.0 - info.duration) if opt.hold else 0.0
    hold = min(hold, 15.0)
    i_last = min(i_last, int((info.duration + hold) * fps) - 1)  # ffmpeg stops reading at the end
    still, still_pos = None, (0, 0)
    if opt.stats and stats:
        card, still_pos = stats_card(stats, info.width, info.height, estimated=opt.carry is None)
        still = dst.with_name(dst.stem + "_stats.png")
        cv2.imwrite(str(still), card)

    _log(f"rendering overlay {renderer.box[2]}x{renderer.box[3]} for {i_last - i_first} frames ...")
    comp = OverlayCompositor(info, dst, renderer.box, i_first / fps, hold, still, t_land_video, still_pos)
    t_render = time.perf_counter()
    try:
        # Overlay frames are independent; OpenCV/numpy release the GIL, so render in parallel.
        def frame_at(i: int):
            s = flight_time(i / fps)
            return renderer.overlay(s, s >= t_land)

        with ThreadPoolExecutor(max_workers=8) as ex:
            for ov in ex.map(frame_at, range(i_first, i_last + 1)):
                comp.write(ov)
        _log(f"overlay ready ({time.perf_counter() - t_render:.1f} s), encoder ...")
    finally:
        comp.close()
        if still is not None:
            still.unlink(missing_ok=True)

    if opt.debug:
        _write_debug(dst, sh.color_at_impact, sh.cands, sh.track, sh.anchor, flight, impact, ball, stats, warnings, sh.tol)

    n_pts = len(sh.track) if sh.track is not None else 0
    return Result(dst, impact, ball, n_pts, flight, stats, warnings, time.perf_counter() - t_start)


# =============================================================================================
# Editor: every shot, as data


def analyze(src: Path, opt: Options | None = None, progress: Progress | None = None,
            on_shot: Callable[[dict], None] | None = None) -> dict:
    """Find and analyse every verified shot in a video. Returns a project fragment:

    {"media": {...}, "shots": [shot, ...], "warnings": [...], "seconds": float}

    Shot fields follow packages/schema (`Shot`); positions are source-video pixels.
    """
    opt = opt or Options()
    t_start = _T0[0] = time.perf_counter()
    report = _Report(progress)
    stopped = threading.Event()   # tells the background motion scans to stop (cancelled or failed)
    # The motion around each strike (clean.py) is measured in the background, beside the detector.
    motion_pool = ThreadPoolExecutor(max_workers=1)
    try:
        return _analyze(src, opt, report, on_shot, t_start, motion_pool, stopped)
    finally:
        stopped.set()
        motion_pool.shutdown(wait=False, cancel_futures=True)


def _analyze(src: Path, opt: Options, report: _Report, on_shot, t_start: float, motion_pool: ThreadPoolExecutor,
             stopped: threading.Event) -> dict:
    info = probe(src)
    report(0.02, "probe")
    det = get_detector(opt.model)
    aud = load_audio(src)
    strikes = audio_mod.find_strikes(*aud) if aud else []
    report(0.08, "audio")

    addresses: list[Address] = []
    if opt.impact is not None or opt.ball is not None:
        addresses = [_find_address(info, det, strikes, opt)]
    else:
        addresses = _verified_addresses(info, det, strikes, lambda f: report(0.08 + 0.22 * f, "strikes"))
        if not addresses:
            addresses = _scan_addresses(info, det, lambda f: report(0.08 + 0.22 * f, "scan"))
        if not addresses:
            addresses = [_find_address(info, det, [], opt)]
    _log(f"{len(addresses)} candidate shot(s)")

    shots: list[dict] = []
    warnings: list[str] = []
    used: list[float] = []
    auto = opt.impact is None and opt.ball is None
    green = auto and _by_green(opt)
    spans: list[tuple[float, float]] = []   # followed for putts
    ticks: list | None = None

    def motion(t0: float, t1: float, golfer, head=None) -> Future:
        return motion_pool.submit(clean_mod.measure_span, info, t0, t1, golfer, head, stopped.is_set)

    # A shot is handed on once its motion scan is done: the scan runs beside the next shot's
    # steps, not in front of them.
    pending: list[tuple[dict, float, Future | None, float | None]] = []

    def emit(doc: dict, t: float, moved: Future | None = None, land: float | None = None) -> None:
        pending.append((doc, t, moved, land))

    def flush(wait: bool) -> None:
        while pending and (wait or pending[0][2] is None or pending[0][2].done()):
            _emit(*pending.pop(0))

    def _emit(doc: dict, t: float, moved: Future | None = None, land: float | None = None) -> None:
        sound = audio_mod.signature(*aud, t) if aud else None
        if sound:
            doc["sound"] = sound
        if moved is not None:
            try:
                while True:   # still measuring: wait, but notice a cancel
                    try:
                        m = moved.result(timeout=0.5)
                        break
                    except FutureTimeout:
                        report.check()
                clean = clean_mod.window(m, t, land if land is not None else t, opt.slowmo, doc["kind"] == "putt")
            except Exception as exc:  # noqa: BLE001 - the window is a nicety: the shot stands without it
                if exc is report.raised:
                    raise
                _log(f"clean window failed: {exc}")
                clean = None
            if clean:
                doc["clean"] = clean
                _log(f"clean {clean['from']:.1f}-{clean['to']:.1f} s around {t:.1f} s")
        shots.append(doc)
        if on_shot:
            on_shot(doc)

    def shot(addr: Address) -> None:
        nonlocal ticks
        stop = None
        if opt.ref_time is not None and opt.impact is None:
            stop = min(info.frame_count, addr.ref_idx + int(8.0 * info.fps))
        elif addr.verified is not None:
            stop = int((addr.verified + 2.0) * info.fps)
        elif len(addresses) > 1:
            stop = min(info.frame_count, addr.ref_idx + int(6.0 * info.fps))
        impact = _find_impact(info, addr, strikes, opt, stop=stop, check=report.check)
        if impact is not None and any(abs(impact.time - t) < MIN_SHOT_GAP for t in used):
            return
        # The motion scan before the strike and through the track comes from the track's decode;
        # the rest is decoded once the landing is known.
        t_scan = clean_mod.scan_range(impact.time, opt.slowmo)[0] if impact is not None else 0.0
        head: list = []
        sh, err = None, None
        if impact is not None and not green:
            try:
                sh = _track_and_fit(info, det, impact, addr.ball, opt, (clean_mod.span(info, t_scan, info.duration), head), report.check)
            except RuntimeError as exc:
                if exc is report.raised:
                    raise
                err = str(exc)
        if auto and addr.ball is not None and (green or (impact is not None and _maybe_putt(opt, sh))):
            # On the green, or a stroke that did not fly: follow the ball through the putts.
            if ticks is None:
                ticks = audio_mod.find_strikes(*aud, min_ratio=PUTT_TICK) if aud else []
            putts, span = _putts(info, det, addr, opt, ticks, len(shots) + len(pending), report.check)
            if putts:
                spans.append(span)
                moves = [motion(*clean_mod.scan_range(d["impactTime"], opt.slowmo, d["putt"]["end"]), addr.golfer) for d in putts]
                for doc, mv in zip(putts, moves):
                    used.append(doc["impactTime"])
                    emit(doc, doc["impactTime"], mv, doc["putt"]["end"])
                if impact is None or any(abs(d["impactTime"] - impact.time) < 1.0 for d in putts):
                    return
        if impact is None:
            return
        if sh is None and err is None:
            try:
                sh = _track_and_fit(info, det, impact, addr.ball, opt, (clean_mod.span(info, t_scan, info.duration), head), report.check)
            except RuntimeError as exc:
                if exc is report.raised:
                    raise
                err = str(exc)
        if sh is None:
            warnings.append(err or "")
            return
        used.append(impact.time)
        flight_s = float(sh.stats.get("flight_time_s") or 4.0) if sh.stats else 4.0
        land = impact.time + (sh.flight.t_offset + flight_s) * opt.slowmo
        moved = motion(*clean_mod.scan_range(impact.time, opt.slowmo, land), addr.golfer, head)
        emit(_shot_doc(info, sh, len(shots) + len(pending), opt), impact.time, moved, land)

    for k, addr in enumerate(addresses):
        base = 0.3 + 0.68 * k / max(1, len(addresses))
        report(base, f"shot {k + 1}/{len(addresses)}")
        flush(False)
        if any(a <= addr.ref_idx / info.fps <= b for a, b in spans):
            continue
        try:
            shot(addr)
        except Exception as exc:
            # One shot that breaks the analysis (a bad fit, an odd frame) must not cost the others.
            if exc is report.raised or _fatal(exc):
                raise
            at = addr.verified if addr.verified is not None else addr.ref_idx / info.fps
            _log(f"shot at {at:.1f} s failed: {type(exc).__name__}: {exc}")
            warnings.append(f"The shot at {at:.1f} s could not be analysed ({type(exc).__name__}: {exc})"[:300])
    flush(True)
    _settle_putts(shots, info.diag)
    shots.sort(key=lambda s: s["impactTime"])
    report(1.0, "done")
    return {
        "media": {"width": info.width, "height": info.height, "fps": info.fps, "duration": info.duration,
                  "hdr": info.hdr, "hasAudio": aud is not None},
        "shots": shots,
        "warnings": warnings,
        "seconds": round(time.perf_counter() - t_start, 2),
    }


class _Report:
    """The caller's progress callback, which may raise to cancel the analysis (the worker's
    does); `check()` asks again with the last values, from inside long loops, and `raised` is
    what it raised, so no step mistakes a cancel for its own failure."""

    def __init__(self, fn: Progress | None):
        self.fn = fn
        self.last: tuple[float, str] = (0.0, "")
        self.raised: BaseException | None = None

    def __call__(self, f: float, msg: str) -> None:
        self.last = (f, msg)
        self._call(f, msg)

    def check(self) -> None:
        self._call(*self.last)

    def _call(self, f: float, msg: str) -> None:
        if self.fn is None:
            return
        try:
            self.fn(f, msg)
        except BaseException as exc:
            self.raised = exc
            raise


def _fatal(exc: BaseException) -> bool:
    """Errors that are not one shot's: out of memory, or the detector (the GPU) failing – the
    worker retries the whole analysis with gentler settings."""
    return isinstance(exc, MemoryError) or type(exc).__module__.split(".")[0] in ("onnxruntime", "torch")


def _checked(frames, check: Callable[[], None] | None, every: int = CHECK_EVERY):
    """The frames, with a look at whether the analysis was cancelled every so often."""
    for k, item in enumerate(frames):
        if check is not None and k % every == every - 1:
            check()
        yield item


def _confidence(sh: ShotAnalysis) -> float:
    c = sh.impact.confidence
    if sh.track is None:
        return round(c * 0.3, 3)
    c *= min(1.0, len(sh.track) / 15) ** 0.5
    c *= 1.0 if sh.track.anchored else 0.75
    if sh.flight.rms_px > sh.tol:
        c *= 0.75
    if sh.verdict:
        c *= 0.4
    if any(code == "off_frame" for code, _ in sh.codes):
        c *= 0.5
    return round(float(min(1.0, c)), 3)


def _shot_doc(info: VideoInfo, sh: ShotAnalysis, n: int, opt: Options) -> dict:
    """Convert an analysis-space result to the editor's source-pixel shot document."""
    wa, ha = sh.size_a
    sx, sy = wa / info.width, ha / info.height
    s = 0.5 * (sx + sy)
    params = sh.flight.params.astype(float).copy()
    params[7] = params[7] - math.log(s)          # focal length in source pixels
    anchor = {"x": round(sh.anchor[0] / sx, 2), "y": round(sh.anchor[1] / sy, 2)}
    track = {"t": [], "u": [], "v": []}
    if sh.track is not None:
        track = {"t": [round(float(t), 4) for t in sh.track.t],
                 "u": [round(float(u) / sx, 2) for u in sh.track.u],
                 "v": [round(float(v) / sy, 2) for v in sh.track.v]}
    kind = "full"
    visible = True
    codes = list(sh.codes)
    if sh.verdict and sh.track is not None and ("slow" in sh.verdict or "flight time" in sh.verdict):
        kind, visible = "short", False
        codes.append(("short_shot", sh.verdict))
    elif opt.to_green is not None and (opt.to_green < SHORT_GAME_M or (sh.verdict and opt.to_green < 2 * SHORT_GAME_M)):
        # Filmed right by the green, or near it with no believable flight: a chip, pitch or
        # putt, not a full shot to trace.
        kind, visible = "short", False
        codes.append(("short_shot", f"{opt.to_green:.0f} m to the green"))
    elif sh.verdict and ("sound" not in sh.impact.method or "ball" not in sh.impact.method):
        # No believable flight, and the strike is only heard or only seen (a practice swing,
        # someone else's shot, a ball picked up). Keep it, hidden, so it can be switched on.
        visible = False
    conf = _confidence(sh)
    if visible and conf < WEAK_SHOT_CONF and not ("sound" in sh.impact.method or "ball" in sh.impact.method):
        # Found only because the golfer stopped moving – no strike heard, no ball seen leaving –
        # and the flight is doubtful too: usually putts or practice strokes. Hidden.
        visible = False
    if conf < 0.6 and not any(c == "low_confidence" for c, _ in codes):
        codes.insert(0, ("low_confidence", ""))
    plist = [round(float(x), 6) for x in params]
    return {
        "id": f"shot{n + 1}_{int(sh.impact.time * 1000)}",
        "source": "auto",
        "kind": kind,
        "impactTime": round(float(sh.impact.time), 4),
        "confidence": conf,
        "warnings": [{"code": c, "detail": d[:300]} if d else {"code": c} for c, d in codes],
        "camera": {"cx": info.width / 2, "cy": info.height / 2},
        "anchor": anchor,
        "track": track,
        "params": plist,
        "rmsPx": None if not math.isfinite(sh.flight.rms_px) else round(sh.flight.rms_px / s, 3),
        "auto": {"params": plist, "anchor": anchor, "impactTime": round(float(sh.impact.time), 4)},
        "slowmo": opt.slowmo,
        "club": opt.club or "auto",
        "visible": visible,
        "label": "",
        "stats": sh.stats,
        "impactMethod": sh.impact.method,
    }


# =============================================================================================
# Putts


PUTT_TICK = 3.0   # a putt's tick is far softer than a full strike (find_strikes ratio)
PUTT_SHOW_CONF = 0.6   # putts less sure than this are kept hidden (they still count, and are asked about)
OTHER_BALL_S = 240.0   # after a holed putt, putts this soon that start elsewhere are another player's


def _by_green(opt: Options) -> bool:
    if opt.green_m is not None:
        return opt.green_m <= GREEN_NEAR_M
    return opt.to_green is not None and opt.to_green <= PUTT_TO_GREEN_M


def _maybe_putt(opt: Options, sh: ShotAnalysis | None) -> bool:
    """A stroke worth following on the ground: no believable flight, and not far from a green."""
    if (opt.to_green is not None and opt.to_green >= 2 * SHORT_GAME_M) or (opt.green_m is not None and opt.green_m >= 2 * SHORT_GAME_M):
        return False
    return sh is None or sh.track is None or bool(sh.verdict and ("slow" in sh.verdict or "flight time" in sh.verdict))


def _putts(info: VideoInfo, det: BallDetector, addr: Address, opt: Options, ticks, n0: int,
           check: Callable[[], None] | None = None) -> tuple[list[dict], tuple[float, float]]:
    """Follow the ball lying at this address through the putts that follow (putt.py)."""
    ball = addr.ball
    assert ball is not None
    sp = min(1.0, max(PUTT_LONG_SIDE / info.long_side, PUTT_BALL_PX / max(ball.r, 0.5)))
    w, h = info.width, info.height
    if sp != 1.0:   # as decode() sizes it
        w, h = max(2, int(round(w * sp / 2)) * 2), max(2, int(round(h * sp / 2)) * 2)
    sx, sy = w / info.width, h / info.height
    step = max(1, round(info.fps / putt_mod.FOLLOW_FPS))
    t_ref = addr.ref_idx / info.fps
    stop = min(info.frame_count, addr.ref_idx + int(putt_mod.MAX_FOLLOW_S * info.fps))
    # Only every step-th frame is followed: the others are dropped in ffmpeg, before scaling.
    frames = decode(info, start=addr.ref_idx, stop=stop, scale=sp, gray=True, every=step, phase=addr.ref_idx)
    try:
        seen = putt_mod.follow(((i / info.fps, g) for i, g in _checked(frames, check, max(1, CHECK_EVERY // step))),
                               (ball.x * sx, ball.y * sy), ball.r * 0.5 * (sx + sy))
    finally:
        frames.close()
    rolls = [ro for ro in putt_mod.segment(seen) if ro.is_putt]
    _log(f"putts from {t_ref:.1f} s: {len(rolls)} ({', '.join(f'{ro.start:.1f}-{ro.end:.1f} {ro.ended}' for ro in rolls)})")
    prior = putt_mod.green_prior(opt.green_m, opt.to_green)
    docs = []
    for ro in rolls:
        tick = min((p for p in ticks if -0.12 <= p.time - ro.start <= 0.08), key=lambda p: abs(p.time - ro.start), default=None)
        t0 = float(tick.time) if tick else ro.start
        if ro.holed and _hidden_by_player(info, det, ro, sx, sy):
            ro.holed, ro.unsure = None, "a player stood where the ball vanished"
        codes: list[tuple[str, str]] = []
        if ro.unsure:
            codes.append(("putt_count_unsure", ro.unsure))
        if len(ro.t) < 8:
            codes.append(("few_points", str(len(ro.t))))
        conf = putt_mod.confidence(ro, prior, tick is not None)
        if conf < PUTT_SHOW_CONF:
            codes.insert(0, ("low_confidence", ""))
        doc = _putt_doc(info, ro, t0, conf, codes, n0 + len(docs), opt, sx, sy, "roll + sound" if tick else "roll")
        path = putt_mod.roll_path(seen, ro)
        _log(f"  roll line {ro.start:.1f} s: {'ok' if path.ok else path.why} (rms {path.rms:.2f} r, slips {path.slips}, gap {path.gap:.2f} s, "
             f"wiggle {path.wiggle:.0f} deg, back {path.back:.2f} r, still {path.still:.2f} r)")
        if path.ok:
            doc["putt"]["path"] = _path_doc(path, info.width * sx, info.height * sy)
        docs.append(doc)
    return docs, (t_ref, float(seen.t[-1]) if len(seen.t) else t_ref)


def _path_doc(path: putt_mod.RollPath, w: float, h: float) -> list[dict]:
    """The roll line's points: source-video seconds and fractions of the frame (any size, any crop)."""
    return [{"t": round(float(t), 4), "x": round(float(u) / w, 5), "y": round(float(v) / h, 5)} for t, u, v in zip(path.t, path.u, path.v)]


def _hidden_by_player(info: VideoInfo, det: BallDetector, ro: putt_mod.Roll, sx: float, sy: float) -> bool:
    """Someone standing where the ball vanished hides it; it need not have dropped."""
    _, frame = _at(info, ro.end + 0.5)
    if frame is None:
        return False
    x, y = float(ro.u[-1]) / sx, float(ro.v[-1]) / sy
    return any(b.x1 <= x <= b.x2 and b.y1 <= y <= b.y2 for b in det.people(frame))


def _putt_doc(info: VideoInfo, ro: putt_mod.Roll, t0: float, conf: float, codes: list[tuple[str, str]], n: int, opt: Options,
              sx: float, sy: float, method: str) -> dict:
    """A putt as an editor shot: never traced, so the flight is a neutral default and the track
    is the ball's path on the ground."""
    anchor = {"x": round(float(ro.u[0]) / sx, 2), "y": round(float(ro.v[0]) / sy, 2)}
    k = max(1, (len(ro.t) - 1) // 120 + 1)
    track = {"t": [round(float(t) - t0, 4) for t in ro.t[1::k]],
             "u": [round(float(u) / sx, 2) for u in ro.u[1::k]],
             "v": [round(float(v) / sy, 2) for v in ro.v[1::k]]}
    fl = default_flight((anchor["x"], anchor["y"]), info.width / 2, info.height / 2, info.long_side, info.fps, club="wedge")
    plist = [round(float(x), 6) for x in fl.params]
    return {
        "id": f"shot{n + 1}_{int(t0 * 1000)}",
        "source": "auto",
        "kind": "putt",
        "impactTime": round(t0, 4),
        "putt": {"end": round(max(ro.end, t0), 4), "holed": ro.holed},
        "confidence": conf,
        "warnings": [{"code": c, "detail": d[:300]} if d else {"code": c} for c, d in codes],
        "camera": {"cx": info.width / 2, "cy": info.height / 2},
        "anchor": anchor,
        "track": track,
        "params": plist,
        "rmsPx": None,
        "auto": {"params": plist, "anchor": anchor, "impactTime": round(t0, 4)},
        "slowmo": opt.slowmo,
        "club": "auto",
        "visible": conf >= PUTT_SHOW_CONF,
        "label": "",
        "stats": {},
        "impactMethod": method,
    }


def _settle_putts(shots: list[dict], diag: float) -> None:
    """Putts followed separately (the ball was lost between them): a putt followed by another
    from where it stopped was not the last one, so it was not holed. Putts soon after a holed one
    that start elsewhere are another player's ball: hidden, and the count is unsure."""
    putts = sorted((s for s in shots if s["kind"] == "putt"), key=lambda s: s["impactTime"])
    unsure = {"code": "putt_count_unsure", "detail": "another putt follows the one that seemed to drop"}
    other = {"code": "putt_count_unsure", "detail": "starts away from where the holed putt dropped: maybe another player's ball"}
    dropped: dict | None = None
    for a, b in zip(putts, putts[1:]):
        a["warnings"] = [w for w in a["warnings"] if w.get("detail") != putt_mod.STILL_LYING]
        if dropped is None and a["putt"]["holed"] is True:
            tr = a["track"]
            end = (tr["u"][-1], tr["v"][-1]) if tr["u"] else (a["anchor"]["x"], a["anchor"]["y"])
            a["warnings"].append(unsure)
            if math.hypot(b["anchor"]["x"] - end[0], b["anchor"]["y"] - end[1]) < 0.03 * diag:
                a["putt"]["holed"] = False
                continue
            dropped = a
        if dropped is not None:
            if b["impactTime"] - dropped["putt"]["end"] <= OTHER_BALL_S:
                b["visible"] = False
                b["warnings"].append(dict(other))
                continue
            dropped = None


# =============================================================================================
# Shared steps


def _at(info: VideoInfo, sec: float):
    idx = max(0, min(int(sec * info.fps), max(0, info.frame_count - 1)))
    return idx, read_frame(info, idx)


def _verify_strike(info: VideoInfo, det: BallDetector, t: float) -> Address | None:
    """A loud click is a real strike only if a ball sits there before and is gone after."""
    if t < ADDRESS_LEAD + 0.2 or t > info.duration - 0.3:
        return None
    idx, pre = _at(info, t - ADDRESS_LEAD)
    if pre is None:
        return None
    golfer = pick_golfer(det.people(pre), info.width, info.height)
    ball = det.ball(pre, golfer, allow_blob=False)
    if not ball or ball.conf < 0.2:
        return None
    _, post = _at(info, t + 0.5)
    if post is not None and ball_left(ball, pre, post):
        return Address(ball, idx, pre, golfer, t)
    return None


QUIET_STRIKE = 0.08  # a click this much quieter than the loudest strike is a waggle or practice swing


def _verified_addresses(info: VideoInfo, det: BallDetector, strikes, report=lambda f: None) -> list[Address]:
    """Every audio strike confirmed by vision, in time order. Loudest first, so a real strike is
    never pushed aside by a faint waggle a second earlier (the club hides the ball then, so it
    can look "gone"); clicks far quieter than the loudest confirmed strike are dropped."""
    cands = sorted(strikes, key=lambda p: -p.energy)
    out: list[tuple[Address, float]] = []
    for i, p in enumerate(cands):
        report(i / max(1, len(cands)))
        if out and p.energy < QUIET_STRIKE * out[0][1]:
            break
        if any(abs(p.time - a.verified) < MIN_SHOT_GAP for a, _ in out):
            continue
        a = _verify_strike(info, det, p.time)
        if a:
            out.append((a, float(p.energy)))
    return sorted((a for a, _ in out), key=lambda a: a.verified)


def _prefetch(info: VideoInfo, times, ahead: int = 2):
    """(sec, idx, frame) for each time, in order, read a few frames ahead in a background
    thread so seeking overlaps with the detector."""
    pool = ThreadPoolExecutor(max_workers=1)
    pending: deque = deque()
    it = iter(times)
    try:
        for sec in it:
            pending.append((float(sec), pool.submit(_at, info, float(sec))))
            if len(pending) > ahead:
                break
        while pending:
            sec, fut = pending.popleft()
            nxt = next(it, None)
            if nxt is not None:
                pending.append((float(nxt), pool.submit(_at, info, float(nxt))))
            yield (sec, *fut.result())
    finally:
        pool.shutdown(wait=True, cancel_futures=True)


def _scan_addresses(info: VideoInfo, det: BallDetector, report=lambda f: None, step: float = 1.0) -> list[Address]:
    """No usable audio: sample the video for a ball at address. Each run of detections at
    the same spot is one address; the strike is searched for right after it."""
    found: list[tuple[float, Ball, int, np.ndarray, object]] = []
    times = np.arange(0.0, max(0.0, info.duration - 0.5), step)
    group: list[tuple[float, int, np.ndarray]] = []
    n = max(getattr(det, "batch", 1), det.parallel)
    pool = ThreadPoolExecutor(max_workers=det.parallel) if det.parallel > 1 else None

    def look(group: list[tuple[float, int, np.ndarray]]) -> None:
        # The samples are independent: people in one (batched) call, the ball searches side by side.
        golfers = [pick_golfer(p, info.width, info.height) for p in det.people_many([f for _, _, f in group])]
        search = lambda fg: det.ball(fg[0], fg[1], allow_blob=False)  # noqa: E731
        pairs = [(f, g) for (_, _, f), g in zip(group, golfers)]
        balls = list(pool.map(search, pairs)) if pool else [search(fg) for fg in pairs]
        for (sec, idx, frame), golfer, ball in zip(group, golfers, balls):
            if ball and ball.conf >= 0.25:
                found.append((sec, ball, idx, frame, golfer))
        group.clear()

    try:
        for i, (sec, idx, frame) in enumerate(_prefetch(info, times, ahead=n + 1)):
            report(i / max(1, len(times)))
            if frame is not None:
                group.append((sec, idx, frame))
            if len(group) >= n:
                look(group)
        if group:
            look(group)
    finally:
        if pool:
            pool.shutdown(cancel_futures=True)

    episodes: list[list] = []
    for f in found:
        last = episodes[-1][-1] if episodes else None
        if last and f[0] - last[0] <= 2.5 * step and math.hypot(f[1].x - last[1].x, f[1].y - last[1].y) < max(3 * f[1].r, 12):
            episodes[-1].append(f)
        else:
            episodes.append([f])
    out = []
    for ep in episodes:
        # The strike follows the last sighting, which may already be the moment of impact,
        # so the reference frame is taken from a little earlier.
        if len(ep) >= 2:
            sec, ball, idx, frame, golfer = ep[-2]
        else:
            sec, ball, _, _, golfer = ep[-1]
            idx, frame = _at(info, max(0.0, sec - ADDRESS_LEAD))
        out.append(Address(ball, idx, frame, golfer, None))
    return out


def _find_address(info: VideoInfo, det: BallDetector, strikes, opt: Options) -> Address:
    """Smart path: for each loud click, look for a ball just before it and check that
    the ball is gone just after. Fallback: sample frames and keep the most confident ball."""
    if opt.ball:
        idx, frame = _at(info, opt.impact - ADDRESS_LEAD if opt.impact else (opt.ref_time or 0.0))
        golfer = pick_golfer(det.people(frame), info.width, info.height)
        return Address(Ball(opt.ball[0], opt.ball[1], max(2.0, info.diag * 0.003), 1.0, "manual"), idx, frame, golfer, opt.impact)

    # A clean strike is usually the loudest click, so check by energy first.
    loud = sorted(strikes[:8], key=lambda p: p.energy, reverse=True)
    times = [opt.impact] if opt.impact is not None else [p.time for p in loud]
    for t in times:
        a = _verify_strike(info, det, t)
        if a:
            return a

    best = (None, 0, None, None)
    for sec in sorted({0.0, 0.5, 1.0, info.duration * 0.25, info.duration * 0.5}):
        idx, frame = _at(info, sec)
        if frame is None:
            continue
        golfer = pick_golfer(det.people(frame), info.width, info.height)
        ball = det.ball(frame, golfer)
        if ball and (best[0] is None or ball.conf > best[0].conf):
            best = (ball, idx, frame, golfer)
        if ball and ball.conf > 0.5:
            break
    if best[2] is None:
        idx, frame = _at(info, 0.0)
        golfer = pick_golfer(det.people(frame), info.width, info.height) if frame is not None else None
        return Address(None, idx, frame, golfer, None)
    return Address(*best, None)


def _find_impact(info: VideoInfo, addr: Address, strikes, opt: Options, stop: int | None = None,
                 check: Callable[[], None] | None = None) -> Impact | None:
    fps = info.fps
    if opt.impact is not None:
        return Impact(opt.impact, int(opt.impact * fps), "manual", 1.0)
    ball, ref = addr.ball, addr.ref
    if ref is None:
        return None
    presence_probe = PresenceProbe(ball, ref) if ball else None
    if presence_probe is None and addr.golfer is not None:
        # No ball: watch motion in the feet region instead.
        roi = feet_roi(addr.golfer, info.width, info.height)
        presence_probe = PresenceProbe(Ball(*roi.center, max(roi.w, roi.h) / 8, 0, "roi"), ref)
    if stop is None and addr.verified is not None:
        stop = int((addr.verified + 2.0) * fps)
    pres, energy = [], []
    if presence_probe:
        for _, crop in _checked(decode(info, start=addr.ref_idx, stop=stop, crop=presence_probe.region, gray=True), check):
            p, e = presence_probe(crop)
            pres.append(p)
            energy.append(e)
    times = (addr.ref_idx + np.arange(len(pres))) / fps
    t_lo, t_hi = (times[0], times[-1]) if len(times) else (0.0, info.duration)
    local = [s for s in strikes if t_lo - 0.2 <= s.time <= t_hi + 0.2] if stop is not None else strikes
    return choose_impact(times, np.array(pres) if ball else None, np.array(energy), fps, local)


def _track_window(fps: float, t_impact: float, slowmo: float = 1.0) -> tuple[int, int, int, int]:
    """(first frame, end frame, frame step, difference lag in analysis frames) of a track."""
    step = max(1, round(fps / 120))
    while True:
        k = max(1, round(fps / step / 30))
        i0 = max(0, int(t_impact * fps) - (k + 2) * step)
        i1 = int((t_impact + TRACK_SECONDS * slowmo) * fps) + (k + 1) * step
        if (i1 - i0) / step <= MAX_TRACK_FRAMES:
            return i0, i1, step, k
        # Slow motion: 4 s of flight are 4 x slowmo seconds of video. Every frame of them at full
        # size ran out of memory (x16: ~8 GB); the ball moves little between them anyway.
        step = max(step + 1, math.ceil((i1 - i0) / MAX_TRACK_FRAMES))


def _track_and_fit(info: VideoInfo, det: BallDetector, impact: Impact, ball: Ball | None, opt: Options,
                   motion: tuple[clean_mod.Span, list] | None = None, check: Callable[[], None] | None = None) -> ShotAnalysis:
    """`motion`: a motion scan's samples and a list that gets those of them up to the end of the
    track, from the same decode."""
    fps = info.fps
    warnings: list[str] = []
    codes: list[tuple[str, str]] = []
    sa = min(1.0, ANALYSIS_LONG_SIDE / info.long_side)
    i0, i1, step, k = _track_window(fps, impact.time, opt.slowmo)
    fps_a = fps / step
    people_at = {int((impact.time + dt * opt.slowmo) * fps) for dt in (0.0, 0.3, 0.6)}
    frames, times, color_at_impact, people = [], [], None, []
    # People are looked for beside the decode, not in its way.
    pool = ThreadPoolExecutor(max_workers=det.parallel)
    found_people = []
    main = {"start": i0, "stop": i1, "scale": sa, "every": step, "phase": i0}
    head: list = []
    try:
        decoded = decode_pair(info, main, motion[0].decode_args(stop=i1), head) if motion else decode(info, **main)
        for i, small in _checked(decoded, check):
            if color_at_impact is None and i >= impact.frame:
                color_at_impact = small.copy()
            if any(i <= p < i + step for p in people_at):
                found_people.append(pool.submit(det.people, small))
            frames.append(cv2.cvtColor(small, cv2.COLOR_BGR2GRAY))
            times.append(i / fps)
        for fut in found_people:
            people += [b for b in fut.result() if b.h > 0.2 * frames[0].shape[0]]
    finally:
        pool.shutdown(cancel_futures=True)
    if motion:
        motion[1][:] = head
    if len(frames) < 2 * k + 3:
        raise RuntimeError(f"Too few frames after the impact at {impact.time:.1f} s.")
    times = np.array(times)
    t_rel = (times - impact.time) / opt.slowmo  # real flight seconds

    ha, wa = frames[0].shape
    diag_a = float(np.hypot(wa, ha))
    tol = max(3.0, 0.0035 * diag_a)
    cands, _ = find_candidates(frames, t_rel, 0.0, k, people, diag_a)
    _log(f"{len(frames)} analysis frames, {len(people)} person boxes, {len(cands)} candidates")
    anchor = (ball.x * wa / info.width, ball.y * ha / info.height) if ball else None
    cx, cy = wa / 2, ha / 2
    sigma = max(1.5, tol / 3)
    track, flight = None, None
    pool = cands
    for attempt in range(3):
        tr = track_ball(pool, anchor, 1 / fps_a, diag_a)
        if tr is None or len(tr) < 4:
            break
        start = anchor or _extrapolate_start(tr)
        fl = _fit(tr, start, cx, cy, max(wa, ha), fps_a, sigma, opt.carry, opt.club)
        verdict = _implausible(fl, tol)
        _log(f"track {attempt + 1}: {len(tr)} points, rms {fl.rms_px:.2f} px" + (f" - rejected ({verdict})" if verdict else ""))
        if track is None:
            track, flight = tr, fl            # keep the first as a last resort
        if not verdict:
            track, flight = tr, fl
            break
        pool = pool.without(tr.idx)          # e.g. the tee or a bird: try the next-best chain

    if anchor is None and track is not None:
        anchor = _extrapolate_start(track)
        warnings.append("The ball at address was not found; the start point is extrapolated.")
        codes.append(("start_extrapolated", ""))
    if anchor is None:
        raise RuntimeError("Neither the ball at address nor the ball in flight was found. Try --ball X,Y.")
    verdict = _implausible(flight, tol) if flight is not None else None
    if verdict:
        warnings.append(f"The track does not look like a normal shot ({verdict}).")
        codes.append(("implausible", verdict))
    if flight is None or flight.project(to_ground=True) is None:
        flight = default_flight(anchor, cx, cy, max(wa, ha), fps_a, club=opt.club)
        track = None
        warnings.append("The ball could not be tracked in flight; a default flight is drawn.")
        codes.append(("no_track", ""))
        verdict = None
    elif track is not None and len(track) < 8:
        codes.append(("few_points", str(len(track))))
    stats = flight.stats()
    if (opt.to_green is not None and not opt.carry and track is not None and stats
            and stats["carry_m"] > opt.to_green + GREEN_SLACK_M + 5):
        # The hole says the ball cannot have gone that far (a 196 m tee shot on a 153 m par 3,
        # 250 m from just short of the green): fit again with the ball landing by the green –
        # where it most likely went – and say so.
        limit = round(float(opt.to_green) + 5, 1)
        refit = _fit(track, anchor, cx, cy, max(wa, ha), fps_a, sigma, limit, opt.club)
        if refit.project(to_ground=True) is not None:
            flight = refit
            warnings.append(f"The estimate ({stats['carry_m']:.0f} m) was longer than the hole allows; the flight follows the hole.")
            codes.append(("hole_limit", f"{stats['carry_m']:.0f}"))
            stats = flight.stats()
    off = off_frame_reason(flight, wa, ha)
    if off:
        # Apex or landing far outside the picture (or no real landing): nobody could grab the
        # handles. Draw a plausible in-frame guess from the same start instead, and flag it.
        _log(f"flight rejected ({off}): drawing an in-frame guess")
        guess = into_frame(flight, wa, ha, max(wa, ha), fps_a, opt.club)
        if guess.project(to_ground=True) is not None:
            flight = guess
        warnings.append(f"The fitted flight left the picture ({off}); the path is a guess - check it.")
        codes.append(("off_frame", off))
        stats = flight.stats()
    if opt.carry and stats and abs(stats["carry_m"] - opt.carry) > 0.15 * opt.carry:
        warnings.append(f"The given carry ({opt.carry:.0f} m) does not fit the track well; the best guess is {stats['carry_m']:.0f} m.")
        codes.append(("carry_mismatch", f"{stats['carry_m']:.0f}"))
    return ShotAnalysis(impact, ball, track, flight, anchor, sa, (wa, ha), fps_a, tol, cands, color_at_impact,
                        warnings, codes, verdict)


def _write_debug(dst, img, cands, track, anchor, flight, impact, ball, stats, warnings, tol):
    if img is None:
        return
    vis = (img * 0.6).astype(np.uint8)
    tmax = max(float(cands.t.max()) if len(cands) else 1.0, 1e-3)
    for t, u, v, w in zip(cands.t, cands.u, cands.v, cands.w):
        c = cv2.applyColorMap(np.uint8([[int(255 * t / tmax)]]), cv2.COLORMAP_TURBO)[0, 0].tolist()
        cv2.circle(vis, (int(u), int(v)), 2 if w > 0.5 else 1, c, -1)
    proj = flight.project(to_ground=True)
    if proj is not None:
        _, pu, pv, _ = proj
        pts = np.stack([pu, pv], 1).astype(np.int32)
        cv2.polylines(vis, [pts], False, (0, 0, 255), 2, cv2.LINE_AA)
    if track is not None:
        for u, v in zip(track.u, track.v):
            cv2.circle(vis, (int(u), int(v)), int(tol), (0, 255, 0), 1, cv2.LINE_AA)
    if anchor:
        cv2.drawMarker(vis, (int(anchor[0]), int(anchor[1])), (255, 128, 0), cv2.MARKER_CROSS, 24, 2)
    base = dst.with_suffix("")
    cv2.imwrite(str(base) + "_debug.png", vis)
    info = {
        "impact": impact.__dict__ if impact else None,
        "ball": ball.__dict__ if ball else None,
        "track": None if track is None else {"t": track.t.round(4).tolist(), "u": track.u.round(1).tolist(),
                                             "v": track.v.round(1).tolist(), "anchored": track.anchored},
        "flight": {"params": dict(zip(("V", "theta", "phi", "kl", "ks", "pitch", "log_h", "log_f", "dt0"),
                                      np.round(flight.params, 5).tolist())),
                   "rms_px": flight.rms_px, "fitted": flight.fitted},
        "stats": stats, "warnings": warnings,
    }
    Path(str(base) + "_debug.json").write_text(json.dumps(info, indent=2, default=float), encoding="utf-8")


def _extrapolate_start(track: Track) -> tuple[float, float]:
    k = min(6, len(track))
    deg = min(2, k - 1)
    return (float(np.polyval(np.polyfit(track.t[:k], track.u[:k], deg), 0)),
            float(np.polyval(np.polyfit(track.t[:k], track.v[:k], deg), 0)))


def _fit(track: Track, anchor, cx, cy, long_side, fps_a, sigma, carry=None, club=None) -> Flight:
    flight = fit_flight(track.t, track.u, track.v, anchor, cx, cy, long_side, fps_a, sigma, carry, club)
    sim = flight.project(to_ground=False)
    if sim is not None:
        ts, pu, pv, _ = sim
        tq = np.clip(track.t - flight.t_offset, 0, ts[-1])
        err = np.hypot(np.interp(tq, ts, pu) - track.u, np.interp(tq, ts, pv) - track.v)
        keep = err < max(4 * sigma, 3 * flight.rms_px)
        if 4 <= keep.sum() < len(keep):
            flight = fit_flight(track.t[keep], track.u[keep], track.v[keep], anchor, cx, cy, long_side, fps_a, sigma, carry, club)
    return flight


def _implausible(flight: Flight, tol: float) -> str | None:
    """Reason why a fitted flight does not look like a full golf shot, else None."""
    st = flight.stats()
    if not st:
        return "invalid flight"
    if flight.rms_px > 3 * tol:
        return f"poor fit, rms {flight.rms_px:.1f} px"
    if st["ball_speed_mph"] < 45:
        return f"too slow ({st['ball_speed_mph']:.0f} mph)"
    if st["flight_time_s"] < 1.2:
        return f"flight time too short ({st['flight_time_s']:.1f} s)"
    return None
