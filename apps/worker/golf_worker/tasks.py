"""Job handlers: ingest (poster, proxy, thumbnails, waveform) and analysis (shottracer)."""
from __future__ import annotations

import base64
import copy
import json
import logging
import math
import os
import subprocess
import time
from collections.abc import Callable
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from typing import Any

import numpy as np

from golf_api.db import session_scope, utcnow
from golf_api.documents import clean_shot
from golf_api.models import Media, Project
from golf_api.storage import storage, tmp_dir

from .ffmpeg import Canceled, ffmpeg, h264_args, hwaccel_args, run, tonemap_filter

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


def _save_derived(media_id: str, key: str, path: Path, extra: dict[str, Any] | None = None) -> None:
    with session_scope() as db:
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

def ingest(job: dict, report: Report) -> dict:
    m = _media(job["payload"]["media_id"])
    src = storage().local_path(m.storage_key)
    prefix = m.storage_key.rsplit("/", 1)[0]
    probe = m.probe or {}
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

    if m.kind == "video":
        def proxy():
            vp9 = os.environ.get("PROXY_CODEC", "h264").lower() == "vp9"
            out = work / ("proxy.webm" if vp9 else "proxy.mp4")
            fps = float(probe.get("fps") or 30)
            filters = [tonemap_filter()] if hdr else []
            filters.append(_vf_scale(probe.get("width", 0), probe.get("height", 0), PROXY_LONG_SIDE))
            if fps > PROXY_MAX_FPS + 1:
                filters.append(f"fps={PROXY_MAX_FPS}")
            filters.append("format=yuv420p")
            if vp9:
                # Browsers without H.264 (e.g. open-source Chromium in CI) need VP9.
                codec = ["-c:v", "libvpx-vp9", "-deadline", "realtime", "-cpu-used", "8", "-row-mt", "1", "-b:v", "0", "-crf", "34",
                         "-g", str(PROXY_KEYINT), "-pix_fmt", "yuv420p", "-c:a", "libopus", "-b:a", "96k", "-ac", "2"]
            else:
                codec = [*h264_args(crf=23, keyint=PROXY_KEYINT, fast_decode=True), "-c:a", "aac", "-b:a", "128k", "-ac", "2", "-movflags", "+faststart"]
            cmd = [ffmpeg(), "-y", "-v", "error", *hwaccel_args(), "-i", str(src), "-map", "0:v:0", "-map", "0:a:0?", "-vf", ",".join(filters),
                   *codec, str(out)]
            run(cmd, dur, lambda f: report(0.1 + 0.6 * f, "Making the preview"))
            _save_derived(m.id, f"{prefix}/{out.name}", out)
        steps.append(("proxy", proxy))

        def thumbs():
            n = int(min(MAX_THUMBS, max(10, math.ceil(dur))))
            interval = max(dur / n, 1 / max(1.0, float(probe.get("fps") or 30)))
            n = max(1, min(n, int(dur / interval)))
            rows = math.ceil(n / THUMB_COLS)
            out = work / "thumbs.jpg"
            vf = ",".join(f for f in (tonemap_filter() if hdr else "", f"fps=1/{interval:.5f}", f"scale=-2:{THUMB_HEIGHT}",
                                      f"tile={THUMB_COLS}x{rows}", "format=yuvj420p") if f)
            run([ffmpeg(), "-y", "-v", "error", *hwaccel_args(), "-i", str(src), "-an", "-vf", vf, "-frames:v", "1", "-q:v", "5", str(out)],
                dur, lambda f: report(0.7 + 0.15 * f, "Making thumbnails"))
            w = round(THUMB_HEIGHT * probe.get("width", 16) / max(1, probe.get("height", 9)) / 2) * 2
            info = {"count": n, "cols": THUMB_COLS, "rows": rows, "width": w, "height": THUMB_HEIGHT, "interval": interval}
            meta = work / "thumbs.json"
            meta.write_text(json.dumps(info))
            _save_derived(m.id, f"{prefix}/thumbs.jpg", out, {"thumbs_info": info})
            _save_derived(m.id, f"{prefix}/thumbs.json", meta)
        steps.append(("thumbs", thumbs))

    if m.kind in ("video", "audio") and (probe.get("hasAudio") or m.kind == "audio"):
        def waveform():
            out = work / "waveform.json"
            peaks = waveform_peaks(src)
            out.write_text(json.dumps({"rate": WAVE_RATE, "length": len(peaks), "peaks": base64.b64encode(peaks.tobytes()).decode()}))
            _save_derived(m.id, f"{prefix}/waveform.json", out)
        steps.append(("waveform", waveform))

    labels = {"poster": "Making the poster", "proxy": "Making the preview", "thumbs": "Making thumbnails", "waveform": "Making the waveform"}
    for i, (name, fn) in enumerate(steps):
        if not report(i / max(1, len(steps)) * 0.95, labels[name]):
            raise Canceled()
        try:
            fn()
        except Canceled:
            raise
        except Exception as exc:
            # Thumbnails or the waveform failing must not block editing; the proxy must work.
            if name in ("proxy",) or m.kind == "image":
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
    with session_scope() as db:
        p = db.get(Project, project_id)
        if p is None:
            return
        a = copy.deepcopy(p.analysis or {})
        prev = a.get(media_id, {})
        a[media_id] = {**prev, "shots": shots, "status": status, "warnings": warnings or [], "updatedAt": utcnow().isoformat(),
                       "place": place if place is not None else prev.get("place")}
        p.analysis = a


def _place(m: Media, src: Path) -> dict | None:
    """Course, hole and distance to the green from the video's GPS (OpenStreetMap). Optional:
    no GPS, no network or an unmapped course just means no place."""
    try:
        from golf_api.probe import probe_file
        from golf_api.routes.geo import place_at

        geo = (m.probe or {}).get("geo") or probe_file(src).get("geo")   # uploads from before GPS was read
        if not geo:
            return None
        found = place_at(float(geo["lat"]), float(geo["lon"]))
        return {**found, "geo": geo} if found else {"geo": geo}
    except Exception as exc:  # noqa: BLE001
        log.warning("place for %s could not be found: %s", m.id, exc)
        return None


MARGIN_TRUSTED_M = 15   # a neighbour's hole is trusted when no other hole is within this much


def _round_holes(project_id: str, skip: str) -> list[tuple[str, str]]:
    """(recorded at, hole) of the project's other clips whose hole is certain."""
    out = []
    with session_scope() as db:
        p = db.get(Project, project_id)
        for mid, res in ((p.analysis or {}) if p else {}).items():
            pl = res.get("place") or {}
            if mid == skip or not pl.get("hole") or pl.get("alternatives") or float(pl.get("margin") or 0) < MARGIN_TRUSTED_M:
                continue
            mm = db.get(Media, mid)
            rec = (mm.probe or {}).get("recordedAt") if mm else None
            if rec:
                out.append((rec, pl["hole"]))
    return out


def _resolve_tee(project_id: str, m: Media, place: dict) -> dict:
    """A tee shared by several holes: pick the one that fits the round (the holes filmed just
    before and after). Unresolved, the place keeps no hole – and caps nothing."""
    from golf_api.routes.geo import pick_alternative

    rec = (m.probe or {}).get("recordedAt")
    if not rec:
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
            with session_scope() as db:
                p = db.get(Project, project_id)
                a = copy.deepcopy(p.analysis or {})
                if mid in a:
                    a[mid]["place"] = resolved
                    p.analysis = a


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
    pool = ThreadPoolExecutor(max_workers=1)
    place_job = pool.submit(_place, m, src)
    try:
        place = place_job.result(timeout=25)
    except Exception:  # noqa: BLE001 - timeout or lookup error: analyse without it
        place = None
    pool.shutdown(wait=False)
    if place and place.get("alternatives"):
        place = _resolve_tee(project_id, m, place)
    to_green = (place or {}).get("toGreen")
    opt = Options(to_green=float(to_green) if to_green is not None else None)
    res = run_analysis(src, opt, progress=progress, on_shot=on_shot)
    _store_analysis(project_id, m.id, found, "done", res.get("warnings"), place)
    _resolve_round(project_id)
    return {"media_id": m.id, "shots": len(found), "seconds": res.get("seconds"), "media": res.get("media")}


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
    res = run_analysis(src, opt, progress=progress)
    if not res["shots"]:
        raise RuntimeError("The shot could not be tracked. Try clicking exactly on the ball before the strike.")
    shot = clean_shot(res["shots"][0], m.id)
    shot["id"] = pl.get("shot_id") or f"manual_{int(time.time() * 1000) % 10**10}"
    shot["source"] = "manual" if not pl.get("shot_id") else shot.get("source", "auto")
    shot["visible"] = True
    return {"shot": shot}


HANDLERS: dict[str, Callable[[dict, Report], dict]] = {"ingest": ingest, "analyze": analyze, "retrack": retrack}
