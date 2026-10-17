"""Job handlers: ingest (poster, proxy, thumbnails, waveform) and analysis (shottracer)."""
from __future__ import annotations

import base64
import gc
import json
import logging
import math
import os
import subprocess
import threading
import time
from collections.abc import Callable
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from typing import Any

import numpy as np

from golf_api import performance, space
from golf_api.chronology import epoch
from golf_api.db import session_scope, utcnow, write_lock
from golf_api.documents import clean_shot, update_analysis
from golf_api.models import Media, Project
from golf_api.storage import storage, tmp_dir

from .ffmpeg import Canceled, cuda_ok, ffmpeg, h264_args, hwaccel_args, run, tonemap_filter

log = logging.getLogger("golf.worker")

PROXY_LONG_SIDE = 1280
PROXY_MAX_FPS = 60
PROXY_KEYINT = 4            # short GOP: seeking decodes at most 3 extra frames
THUMB_HEIGHT = 90
THUMB_COLS = 10
MAX_THUMBS = 150
WAVE_RATE = 100             # peaks per second

Report = Callable[[float, str], bool]   # returns False when the job was canceled


def _media(media_id: str) -> Media:
    with session_scope() as db:
        m = db.get(Media, media_id)
        if m is None:
            raise LookupError(f"media {media_id} not found")
        db.expunge(m)
        return m


_derived_lock = threading.Lock()   # ingest steps run in parallel and each rewrites media.derived


def _save_derived(media_id: str, key: str, path: Path, extra: dict[str, Any] | None = None) -> None:
    with _derived_lock, session_scope() as db:
        write_lock(db)    # Settings → Storage may remove a proxy key meanwhile
        m = db.get(Media, media_id)
        if m is None:
            return
        storage().put_file(key, path, move=True)
        d = dict(m.derived or {})
        d[_variant(key)] = key
        if extra:
            d.update(extra)
        m.derived = d


def _variant(key: str) -> str:
    name = key.rsplit("/", 1)[-1]
    return {"proxy.mp4": "proxy", "proxy.webm": "proxy", "poster.jpg": "poster", "thumbs.jpg": "thumbs", "thumbs.json": "thumbs_meta",
            "waveform.json": "waveform"}.get(name, name)


def _vf_scale(w: int, h: int, long_side: int) -> str:
    if max(w, h) <= long_side:
        return "scale=trunc(iw/2)*2:trunc(ih/2)*2"
    return f"scale={long_side}:-2" if w >= h else f"scale=-2:{long_side}"


# --- ingest ------------------------------------------------------------------------------------

NVDEC_CODECS = ("h264", "hevc", "vp9", "av1")


def _thumb_plan(probe: dict) -> dict:
    dur = float(probe.get("duration") or 0)
    n = int(min(MAX_THUMBS, max(10, math.ceil(dur))))
    interval = max(dur / n, 1 / max(1.0, float(probe.get("fps") or 30)))
    n = max(1, min(n, int(dur / interval)))
    w = round(THUMB_HEIGHT * probe.get("width", 16) / max(1, probe.get("height", 9)) / 2) * 2
    return {"count": n, "cols": THUMB_COLS, "rows": math.ceil(n / THUMB_COLS), "width": w, "height": THUMB_HEIGHT, "interval": interval}


def _proxy_size(w: int, h: int) -> tuple[int, int]:
    if max(w, h) <= PROXY_LONG_SIDE:
        return w // 2 * 2, h // 2 * 2
    if w >= h:
        return PROXY_LONG_SIDE, round(h * PROXY_LONG_SIDE / w / 2) * 2
    return round(w * PROXY_LONG_SIDE / h / 2) * 2, PROXY_LONG_SIDE


def _gpu_proxy_ok(probe: dict) -> bool:
    """Decode and scale on the GPU: plain 8-bit 4:2:0 SDR without rotation (HDR tone mapping and
    autorotation need CPU frames)."""
    return (not probe.get("hdr") and not probe.get("rotation") and probe.get("codec") in NVDEC_CODECS
            and probe.get("pix_fmt") in ("yuv420p", "yuvj420p") and bool(probe.get("width")) and cuda_ok())


def proxy_cmds(src: Path, out: Path, thumbs: Path | None, probe: dict, vp9: bool = False) -> list[list[str]]:
    """ffmpeg commands that make the proxy, and the thumbnail sprite from the same decode, best first."""
    w, h = int(probe.get("width") or 0), int(probe.get("height") or 0)
    fps = float(probe.get("fps") or 30)
    rate = [f"fps={PROXY_MAX_FPS}"] if fps > PROXY_MAX_FPS + 1 else []
    t = _thumb_plan(probe)
    if vp9:
        # Browsers without H.264 (e.g. open-source Chromium in CI) need VP9.
        audio = ["-c:a", "libopus", "-b:a", "96k", "-ac", "2"]
    else:
        audio = ["-c:a", "aac", "-b:a", "128k", "-ac", "2", "-movflags", "+faststart"]

    def build(pre: list[str], chain: list[str], download: list[str], video: list[str]) -> list[str]:
        graph = "[0:v:0]" + ",".join(chain)
        if thumbs:
            sprite = [f"fps=1/{t['interval']:.5f}", *download, f"scale={t['width']}:{t['height']}:flags=area",
                      f"tile={t['cols']}x{t['rows']}", "format=yuvj420p"]
            graph += f",split=2[pv][tv];[tv]{','.join(sprite)}[th]"
        else:
            graph += "[pv]"
        cmd = [ffmpeg(), "-y", "-v", "error", *pre, "-i", str(src), "-filter_complex", graph, "-map", "[pv]", "-map", "0:a:0?",
               *video, *audio, str(out)]
        return cmd + (["-map", "[th]", "-frames:v", "1", "-q:v", "5", str(thumbs)] if thumbs else [])

    cmds = []
    if not vp9 and _gpu_proxy_ok(probe):
        pw, ph = _proxy_size(w, h)
        cmds.append(build(["-hwaccel", "cuda", "-hwaccel_output_format", "cuda"], [*rate, f"scale_cuda={pw}:{ph}"],
                          ["hwdownload", "format=nv12"], h264_args(crf=23, keyint=PROXY_KEYINT, cuda_frames=True)))
    if vp9:
        video = ["-c:v", "libvpx-vp9", "-deadline", "realtime", "-cpu-used", "8", "-row-mt", "1", "-b:v", "0", "-crf", "34",
                 "-g", str(PROXY_KEYINT), "-pix_fmt", "yuv420p"]
    else:
        video = h264_args(crf=23, keyint=PROXY_KEYINT, fast_decode=True, preview=True)
    chain = [tonemap_filter()] if probe.get("hdr") else []
    chain += [*rate, _vf_scale(w, h, PROXY_LONG_SIDE) + ":flags=area", "format=yuv420p"]
    cmds.append(build(hwaccel_args(), chain, [], video))
    return cmds


def ingest(job: dict, report: Report) -> dict:
    m = _media(job["payload"]["media_id"])
    src = storage().local_path(m.storage_key)
    prefix = m.storage_key.rsplit("/", 1)[0]
    probe = m.probe or {}
    # The preview is written next to the original: make sure it fits before an hour of encoding.
    space.check_worker(int(src.stat().st_size * space.PROXY_SHARE) if src.exists() and m.kind != "image" else 0)
    work = tmp_dir() / f"ingest-{m.id}-{int(time.time())}"
    work.mkdir(parents=True, exist_ok=True)
    steps: list[tuple[str, Callable[[], None]]] = []
    hdr = bool(probe.get("hdr"))
    dur = float(probe.get("duration") or 0)

    if m.kind in ("video", "image"):
        def poster():
            out = work / "poster.jpg"
            vf = ",".join(f for f in (tonemap_filter() if hdr else "", _vf_scale(probe.get("width", 0), probe.get("height", 0), 1280),
                                      "format=yuvj420p") if f)
            at = [] if m.kind == "image" else ["-ss", f"{min(1.0, dur / 3):.3f}"]
            run([ffmpeg(), "-y", "-v", "error", *at, "-i", str(src), "-frames:v", "1", "-vf", vf, "-q:v", "3", str(out)])
            _save_derived(m.id, f"{prefix}/poster.jpg", out)
        steps.append(("poster", poster))

    if m.kind in ("video", "audio") and (probe.get("hasAudio") or m.kind == "audio"):
        def waveform():
            out = work / "waveform.json"
            peaks = waveform_peaks(src)
            out.write_text(json.dumps({"rate": WAVE_RATE, "length": len(peaks), "peaks": base64.b64encode(peaks.tobytes()).decode()}))
            _save_derived(m.id, f"{prefix}/waveform.json", out)
        steps.append(("waveform", waveform))

    def proxy():
        vp9 = os.environ.get("PROXY_CODEC", "h264").lower() == "vp9"
        out = work / ("proxy.webm" if vp9 else "proxy.mp4")
        sprite = work / "thumbs.jpg"
        cmds = proxy_cmds(src, out, sprite, probe, vp9)
        for i, cmd in enumerate(cmds):
            try:
                t0 = time.perf_counter()
                run(cmd, dur, lambda f: report(0.05 + 0.9 * f, "Making the preview"))
                log.info("preview for %s made in %.1f s (%s)", m.id, time.perf_counter() - t0,
                         "GPU decode+scale" if "scale_cuda" in cmd[cmd.index("-filter_complex") + 1] else cmd[cmd.index("-c:v") + 1])
                break
            except Canceled:
                raise
            except Exception as exc:
                if i == len(cmds) - 1:
                    raise
                log.warning("GPU preview failed for %s, using the CPU: %s", m.id, exc)
                out.unlink(missing_ok=True)
                sprite.unlink(missing_ok=True)
        _save_derived(m.id, f"{prefix}/{out.name}", out)
        if not sprite.exists() or sprite.stat().st_size == 0:
            log.warning("ingest thumbs missing for %s", m.id)
            return
        info = _thumb_plan(probe)
        meta = work / "thumbs.json"
        meta.write_text(json.dumps(info))
        _save_derived(m.id, f"{prefix}/thumbs.jpg", sprite, {"thumbs_info": info})
        _save_derived(m.id, f"{prefix}/thumbs.json", meta)

    # The poster and waveform are quick; they run beside the single decode that makes the proxy
    # and thumbnails.
    labels = {"poster": "Making the poster", "waveform": "Making the waveform"}
    if not report(0.0, "Making the preview" if m.kind == "video" else labels[steps[0][0]] if steps else ""):
        raise Canceled()
    with ThreadPoolExecutor(max_workers=max(1, len(steps))) as pool:
        side = [(name, pool.submit(fn)) for name, fn in steps]
        if m.kind == "video":
            proxy()
        for name, fut in side:
            try:
                fut.result()
            except Exception as exc:
                # The poster or waveform failing must not block editing; the proxy must work.
                if m.kind == "image":
                    raise
                log.warning("ingest %s failed for %s: %s", name, m.id, exc)
    with session_scope() as db:
        mm = db.get(Media, m.id)
        if mm is not None:
            mm.status = "ready"
    for f in work.glob("*"):
        f.unlink(missing_ok=True)
    work.rmdir()
    return {"media_id": m.id}


def waveform_peaks(src: Path) -> np.ndarray:
    sr = 8000
    out = subprocess.run([ffmpeg(), "-v", "error", "-i", str(src), "-vn", "-ac", "1", "-ar", str(sr), "-f", "s16le", "-"],
                         capture_output=True, timeout=1800).stdout
    a = np.frombuffer(out, np.int16).astype(np.float32) / 32768.0
    hop = sr // WAVE_RATE
    n = len(a) // hop
    if n == 0:
        return np.zeros(0, np.uint8)
    pk = np.abs(a[: n * hop]).reshape(n, hop).max(1)
    # Perceptual scale so quiet passages are still visible.
    return np.clip(np.sqrt(pk) * 255, 0, 255).astype(np.uint8)


# --- analysis ----------------------------------------------------------------------------------

def _store_analysis(project_id: str, media_id: str, shots: list[dict], status: str, warnings: list[str] | None = None,
                    place: dict | None = None) -> None:
    def change(a: dict) -> None:
        prev = a.get(media_id, {})
        a[media_id] = {**prev, "shots": shots, "status": status, "warnings": warnings or [], "updatedAt": utcnow().isoformat(),
                       "place": place if place is not None else prev.get("place")}

    with session_scope() as db:
        update_analysis(db, project_id, change)


def _place(m: Media, src: Path) -> dict | None:
    """Course, hole and distance to the green from the video's GPS (OpenStreetMap). Optional:
    no GPS, no network or an unmapped course just means no place."""
    try:
        from golf_api.models import User
        from golf_api.probe import probe_file
        from golf_api.routes.common import geo_lookup_enabled
        from golf_api.routes.geo import green_distance, place_at

        geo = (m.probe or {}).get("geo") or probe_file(src).get("geo")   # uploads from before GPS was read
        if not geo:
            return None
        with session_scope() as db:
            allowed = geo_lookup_enabled(db.get(User, m.user_id))
        if not allowed:   # Settings → "Look courses up on OpenStreetMap" off, or GEO_LOOKUP=0
            return {"geo": geo}
        found = place_at(float(geo["lat"]), float(geo["lon"]))
        if not found:
            return {"geo": geo}
        return {**found, "geo": geo, "greenM": green_distance(float(geo["lat"]), float(geo["lon"]))}
    except Exception as exc:  # noqa: BLE001
        log.warning("place for %s could not be found: %s", m.id, exc)
        return None


MARGIN_TRUSTED_M = 15   # a neighbour's hole is trusted when no other hole is within this much


def _round_holes(project_id: str, skip: str) -> list[tuple[float, str]]:
    """(recorded at, hole) of the project's other clips whose hole is certain."""
    out = []
    with session_scope() as db:
        p = db.get(Project, project_id)
        for mid, res in ((p.analysis or {}) if p else {}).items():
            pl = res.get("place") or {}
            if mid == skip or not pl.get("hole") or pl.get("alternatives") or float(pl.get("margin") or 0) < MARGIN_TRUSTED_M:
                continue
            mm = db.get(Media, mid)
            rec = epoch((mm.probe or {}).get("recordedAt")) if mm else None
            if rec is not None:
                out.append((rec, pl["hole"]))
    return out


def _resolve_tee(project_id: str, m: Media, place: dict) -> dict:
    """A tee shared by several holes: pick the one that fits the round (the holes filmed just
    before and after). Unresolved, the place keeps no hole – and caps nothing."""
    from golf_api.routes.geo import pick_alternative

    rec = epoch((m.probe or {}).get("recordedAt"))
    if rec is None:
        return place
    holes = _round_holes(project_id, m.id)
    prev = max((h for h in holes if h[0] < rec), default=None)
    nxt = min((h for h in holes if h[0] > rec), default=None)
    return pick_alternative(place, prev[1] if prev else None, nxt[1] if nxt else None)


def _resolve_round(project_id: str) -> None:
    """Clips analysed earlier with an ambiguous tee may be resolvable now (their hole number
    for titles and maps; their analysis is not redone)."""
    with session_scope() as db:
        p = db.get(Project, project_id)
        pending = [(mid, res) for mid, res in ((p.analysis or {}) if p else {}).items() if (res.get("place") or {}).get("alternatives")]
        media = {mid: db.get(Media, mid) for mid, _ in pending}
        for mm in media.values():
            if mm is not None:
                db.expunge(mm)
    for mid, res in pending:
        mm = media.get(mid)
        if mm is None:
            continue
        resolved = _resolve_tee(project_id, mm, res["place"])
        if not resolved.get("alternatives"):
            def change(a: dict, mid: str = mid, resolved: dict = resolved) -> None:
                if mid in a:
                    a[mid]["place"] = resolved

            with session_scope() as db:
                update_analysis(db, project_id, change)


def apply_performance() -> int:
    """Hands the current performance profile to the engine; returns its revision (for step_down)."""
    from shottracer import hwdecode, runtime

    perf, data = performance.effective()
    hwdecode.on_failure(_decode_failed)
    rt = runtime.Runtime(sessions=perf.sessions, batch=perf.batch, threads=perf.threads, gpu=perf.gpu,
                         decoder=perf.decoder, decode_failed=tuple(sorted(data.get("decodeFailed") or {})))
    if rt != runtime.current():
        log.info("performance: %s profile -> %s", data["profile"], rt)
    runtime.configure(rt)
    return int(data.get("rev", 0))


def _decode_failed(key: str, reason: str) -> None:
    """A GPU decoder failed in an analysis (it went on on the CPU): saved, so later jobs skip it."""
    if performance.record_decode_failure(key, reason):
        log.warning("GPU decoding failed (%s); those videos are decoded on the CPU until Optimise runs again", key)


def _with_fallback(run: Callable[[], dict], report: Report) -> dict:
    """Runs an analysis; out of (GPU) memory or a lost GPU device, it steps the saved profile down
    and tries once more."""
    rev = apply_performance()
    try:
        return run()
    except Canceled:
        raise
    except Exception as exc:
        if not performance.is_device_error(exc):
            raise
        change = performance.step_down(rev, str(exc) or type(exc).__name__)
        log.warning("analysis ran out of memory or lost the GPU (%s); trying again with %s", exc,
                    f"the {change['to']} profile" if change else "the current settings")
        from shottracer.detect import get_detector

        get_detector.cache_clear()   # frees the old sessions' GPU memory
        gc.collect()
        report(-1, "Out of memory – trying again with gentler settings")
        apply_performance()
        res = run()
        res["perfFallback"] = change or {"to": performance.load().get("profile")}
        return res


def _within(seconds: float, fn: Callable[..., Any], *args: Any) -> Any:
    """fn(*args), or None after `seconds` (or on error). The call runs on a daemon thread: a map
    server that never answers must not keep the worker from shutting down (an executor's
    threads are joined at exit)."""
    out: list[Any] = [None]

    def run() -> None:
        try:
            out[0] = fn(*args)
        except Exception as exc:  # noqa: BLE001 - lookup error: go on without it
            log.debug("%s failed: %s", getattr(fn, "__name__", fn), exc)

    t = threading.Thread(target=run, name="place-lookup", daemon=True)
    t.start()
    t.join(seconds)
    return None if t.is_alive() else out[0]


def analyze(job: dict, report: Report) -> dict:
    from shottracer.pipeline import Options
    from shottracer.pipeline import analyze as run_analysis

    m = _media(job["payload"]["media_id"])
    project_id = job["projectId"] or m.project_id
    src = storage().local_path(m.storage_key)
    found: list[dict] = []
    _store_analysis(project_id, m.id, [], "running")

    def progress(f: float, msg: str) -> None:
        text = {"probe": "Reading the video", "audio": "Listening for strikes", "strikes": "Finding shots", "scan": "Looking for the ball",
                "done": "Done"}.get(msg.split(" ")[0], f"Analysing shot {msg.split(' ', 1)[1]}" if msg.startswith("shot") else msg)
        if not report(0.02 + 0.96 * f, text):
            raise Canceled()

    def on_shot(shot: dict) -> None:
        found.append(clean_shot(shot, m.id))
        _store_analysis(project_id, m.id, found, "running")
        report(-1, f"{len(found)} shots found")

    # Where on the course this was filmed (GPS + OpenStreetMap). The distance to the green caps
    # the carry an estimate may claim; a slow map server must not hold up the analysis long.
    place = _within(25, _place, m, src)
    if place and place.get("alternatives"):
        place = _resolve_tee(project_id, m, place)
    to_green = (place or {}).get("toGreen")
    green_m = (place or {}).pop("greenM", None)   # only steers the analysis (putting)
    opt = Options(to_green=float(to_green) if to_green is not None else None, green_m=float(green_m) if green_m is not None else None)

    def attempt() -> dict:
        found.clear()
        return run_analysis(src, opt, progress=progress, on_shot=on_shot)

    res = _with_fallback(attempt, report)
    # The final list, not the streamed one: putts found later can settle earlier ones.
    found = [clean_shot(s, m.id) for s in res["shots"]]
    _store_analysis(project_id, m.id, found, "done", res.get("warnings"), place)
    _resolve_round(project_id)
    out = {"media_id": m.id, "shots": len(found), "seconds": res.get("seconds"), "media": res.get("media")}
    if res.get("perfFallback"):
        out["perfFallback"] = res["perfFallback"]
    return out


def retrack(job: dict, report: Report) -> dict:
    from shottracer.pipeline import Options
    from shottracer.pipeline import analyze as run_analysis

    pl = job["payload"]
    m = _media(pl["media_id"])
    src = storage().local_path(m.storage_key)
    ball = (pl["ball"]["x"], pl["ball"]["y"]) if pl.get("ball") else None
    report(0.05, "Tracking the shot")

    def progress(f: float, msg: str) -> None:
        if not report(0.05 + 0.9 * f, "Tracking the shot"):
            raise Canceled()

    t = float(pl["impact"])
    if pl.get("time_is_impact", True) or ball is None:
        opt = Options(impact=t, ball=ball, slowmo=float(pl.get("slowmo") or 1))
    else:
        opt = Options(ball=ball, ref_time=t, slowmo=float(pl.get("slowmo") or 1))
    res = _with_fallback(lambda: run_analysis(src, opt, progress=progress), report)
    if not res["shots"]:
        raise RuntimeError("The shot could not be tracked. Try clicking exactly on the ball before the strike.")
    shot = clean_shot(res["shots"][0], m.id)
    shot["id"] = pl.get("shot_id") or f"manual_{int(time.time() * 1000) % 10**10}"
    shot["source"] = "manual" if not pl.get("shot_id") else shot.get("source", "auto")
    shot["visible"] = True
    return {"shot": shot}


def tune(job: dict, report: Report) -> dict:
    from .tuner import run_tuner

    return run_tuner(report)


HANDLERS: dict[str, Callable[[dict, Report], dict]] = {"ingest": ingest, "analyze": analyze, "retrack": retrack, "tune": tune}


def release_files() -> None:
    """After each job: close the video files the engine keeps open for frame reads (the lane
    threads live on, and Windows can't delete a project's videos while they are open)."""
    try:
        from shottracer.video import close_readers

        close_readers()
    except Exception as exc:  # noqa: BLE001
        log.debug("closing cached readers: %s", exc)
