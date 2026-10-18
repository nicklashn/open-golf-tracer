"""Settings → About: the app version (root package.json is the single source), the PC it runs on,
the diagnostics bundle for bug reports and the once-a-day update check against GitHub."""
from __future__ import annotations

import datetime as dt
import io
import json
import logging
import platform
import re
import shutil
import subprocess
import sys
import threading
import zipfile
from collections import deque
from pathlib import Path
from typing import Any

import httpx
from sqlalchemy import select
from sqlalchemy.orm import Session

from . import performance
from .config import ROOT, app_version, settings
from .models import AiSettings, ChatGptAccount, Job
from .redact import redact

log = logging.getLogger("golf.api")

REPO = "nicklashn/open-golf-tracer"
RELEASES_URL = f"https://github.com/{REPO}/releases"
LATEST_API = f"https://api.github.com/repos/{REPO}/releases/latest"
UPDATE_FILE = "update-check.json"
CHECK_EVERY = dt.timedelta(days=1)
NOTICES = ROOT / "THIRD_PARTY_NOTICES.txt"
LOG_FILES = 3          # newest launcher log files in the diagnostics bundle
LOG_LINES = 3000       # last lines of each
JOBS = 100             # newest jobs summarised


_ffmpeg: list[str] = []


def ffmpeg_version() -> str:
    """First line of `ffmpeg -version`, e.g. "ffmpeg version 7.1.1-essentials_build-www.gyan.dev".
    Kept once known; a failed or slow call is tried again next time."""
    if _ffmpeg:
        return _ffmpeg[0]
    exe = shutil.which("ffmpeg")
    if not exe:
        return ""
    try:
        out = subprocess.run([exe, "-hide_banner", "-version"], capture_output=True, text=True, timeout=30).stdout
    except (OSError, subprocess.SubprocessError) as exc:
        log.info("ffmpeg -version failed: %s", type(exc).__name__)
        return ""
    first = out.splitlines()[0].split(" Copyright")[0].strip() if out else ""
    if first:
        _ffmpeg.append(first)
    return first


def os_name() -> str:
    if sys.platform == "win32":
        return f"Windows {platform.release()} ({platform.version()}, {platform.machine()})"
    return f"{platform.system()} {platform.release()} ({platform.machine()})"


def log_dir() -> Path:
    return settings().data_dir / "logs"


def info() -> dict[str, Any]:
    hw = performance.hardware()
    return {
        "app": settings().app_name,
        "version": app_version(),
        "os": os_name(),
        "python": platform.python_version(),
        "inference": hw.get("inference", "CPU"),
        "providers": hw.get("providers", []),
        "gpus": [g.get("name", "") for g in hw.get("gpus", [])],
        "ffmpeg": ffmpeg_version(),
        "dataDir": str(settings().data_dir.resolve()),
        "notices": NOTICES.exists(),
    }


# --- update check ----------------------------------------------------------------------------


def parse_version(v: str) -> tuple[int, ...] | None:
    m = re.match(r"^\s*v?(\d+(?:\.\d+)*)", v or "")
    return tuple(int(p) for p in m[1].split(".")) if m else None


def is_newer(latest: str, current: str) -> bool:
    a, b = parse_version(latest), parse_version(current)
    if a is None or b is None:
        return False
    n = max(len(a), len(b))
    return a + (0,) * (n - len(a)) > b + (0,) * (n - len(b))


def _update_path() -> Path:
    return settings().data_dir / UPDATE_FILE


def _load_update() -> dict[str, Any]:
    try:
        data = json.loads(_update_path().read_text(encoding="utf-8"))
        return data if isinstance(data, dict) else {}
    except (OSError, ValueError):
        return {}


def _save_update(data: dict[str, Any]) -> None:
    p = _update_path()
    p.parent.mkdir(parents=True, exist_ok=True)
    tmp = p.with_suffix(".tmp")
    tmp.write_text(json.dumps(data, indent=2), encoding="utf-8")
    tmp.replace(p)


def fetch_latest() -> dict[str, str]:
    """The newest published release on GitHub: {tag, url}. Only the version goes out (in the
    User-Agent); nothing about the PC or its projects."""
    r = httpx.get(LATEST_API, timeout=6, follow_redirects=True,
                  headers={"Accept": "application/vnd.github+json", "User-Agent": f"open-golf-tracer/{app_version()}"})
    r.raise_for_status()
    body = r.json()
    url = str(body.get("html_url") or "")
    return {"tag": str(body.get("tag_name") or ""), "url": url if url.startswith(f"https://github.com/{REPO}/") else RELEASES_URL}


_update_lock = threading.Lock()
_checking = threading.Event()


def _check() -> None:
    """Asks GitHub and stores the answer (or why it failed) in update-check.json."""
    try:
        latest = fetch_latest()
        result = {"latest": latest["tag"].lstrip("v"), "url": latest["url"], "error": ""}
    except (httpx.HTTPError, ValueError, KeyError) as exc:
        result = {"error": type(exc).__name__}
        log.info("update check failed: %s", type(exc).__name__)
    finally:
        _checking.clear()
    with _update_lock:
        data = _load_update()
        data.update(result)
        _save_update(data)


def _status(data: dict[str, Any]) -> dict[str, Any]:
    enabled = data.get("enabled", True) is not False
    latest = str(data.get("latest") or "")
    return {"enabled": enabled, "current": app_version(), "latest": latest or None, "url": data.get("url") or RELEASES_URL,
            "newer": enabled and is_newer(latest, app_version()), "checkedAt": data.get("checkedAt")}


def update_status(now: dt.datetime | None = None, wait: bool = False) -> dict[str, Any]:
    """What the banner needs, from the stored answer. When the check is on (default) and the last
    one is a day old, GitHub is asked in the background (the answer shows from the next page on;
    `wait` asks right away, for tests). A failed check also waits a day: the app works offline.
    Never from tests unless they ask for it."""
    now = now or dt.datetime.now(dt.UTC)
    start = False
    with _update_lock:
        data = _load_update()
        try:
            last = dt.datetime.fromisoformat(str(data.get("checkedAt")))
        except ValueError:
            last = None
        due = last is None or now - last >= CHECK_EVERY
        if _status(data)["enabled"] and due and settings().env != "test" and not _checking.is_set():
            data["checkedAt"] = now.isoformat(timespec="seconds")
            _save_update(data)
            _checking.set()
            start = True
    if start:
        if wait:
            _check()
            data = _load_update()
        else:
            threading.Thread(target=_check, name="update-check", daemon=True).start()
    return _status(data)


def set_update_check(enabled: bool) -> dict[str, Any]:
    with _update_lock:
        data = _load_update()
        data["enabled"] = enabled
        if enabled:
            data.pop("checkedAt", None)  # check right away when turned back on
        _save_update(data)
    return update_status()


# --- diagnostics bundle ----------------------------------------------------------------------


def known_secrets(db: Session) -> list[str]:
    """Every key and token the app holds, so they are masked even where no pattern catches them."""
    s = settings()
    out = [s.secret_key, s.internal_token, s.ai_api_key]
    out += [row.api_key for row in db.scalars(select(AiSettings)).all()]
    for acc in db.scalars(select(ChatGptAccount)).all():
        out += [acc.access_token, acc.refresh_token]
    return [x for x in out if x]


def _tail(path: Path, lines: int) -> str:
    with path.open(encoding="utf-8", errors="replace") as f:
        return "".join(deque(f, maxlen=lines))


def _iso(t: dt.datetime | None) -> str | None:
    return t.isoformat(timespec="seconds") if t else None


def job_summaries(db: Session) -> list[dict[str, Any]]:
    """Newest jobs without payloads or results (those hold project documents)."""
    rows = db.scalars(select(Job).order_by(Job.created_at.desc()).limit(JOBS)).all()
    return [{"id": j.id, "kind": j.kind, "status": j.status, "progress": round(j.progress or 0, 3), "attempts": j.attempts,
             "message": j.message, "error": (j.error or "")[:2000], "createdAt": _iso(j.created_at), "startedAt": _iso(j.started_at),
             "finishedAt": _iso(j.finished_at)} for j in rows]


def ai_summary(db: Session) -> dict[str, Any]:
    """Which AI provider is chosen, and whether a key is set, never the key."""
    row = db.scalars(select(AiSettings)).first()
    s = settings()
    return {"server": {"provider": s.ai_provider, "model": s.ai_model, "keySet": bool(s.ai_api_key)},
            "user": {"provider": row.provider, "model": row.model, "keySet": bool(row.api_key), "vision": bool(row.vision)} if row else None,
            "chatgptSignedIn": any(a.refresh_token for a in db.scalars(select(ChatGptAccount)).all())}


def diagnostics_zip(db: Session) -> bytes:
    """A zip for a bug report: version, PC, performance.json, recent logs and job summaries.
    Everything passes redact() with the app's own keys and tokens as known secrets."""
    secrets = known_secrets(db)

    def clean(text: str) -> str:
        return redact(text, secrets)

    def dump(obj: Any) -> str:
        return clean(json.dumps(obj, indent=2, ensure_ascii=False, default=str))

    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as z:
        about = info()
        about.update(hardware=performance.hardware(), config={"env": settings().env, "logLevel": settings().log_level,
                                                              "allowedHosts": bool(settings().allowed_hosts)},
                     ai=ai_summary(db), update=_load_update(), createdAt=dt.datetime.now(dt.UTC).isoformat(timespec="seconds"))
        z.writestr("about.json", dump(about))
        perf = settings().data_dir / performance.FILE
        z.writestr("performance.json", clean(perf.read_text(encoding="utf-8", errors="replace")) if perf.exists() else "{}\n")
        z.writestr("jobs.json", dump(job_summaries(db)))
        logs = sorted(log_dir().glob("app-*.log"), key=lambda p: p.stat().st_mtime, reverse=True)[:LOG_FILES] if log_dir().is_dir() else []
        for p in logs:
            z.writestr(f"logs/{p.name}", clean(_tail(p, LOG_LINES)))
        z.writestr("README.txt", "Open Golf Tracer diagnostics. Attach this zip to a bug report:\n"
                                 f"https://github.com/{REPO}/issues/new?template=bug.yml\n\n"
                                 "It holds the app version, the PC (OS, CPU/GPU, ONNX Runtime providers, FFmpeg), performance.json,\n"
                                 f"the last {LOG_LINES} lines of the newest {LOG_FILES} log files and a summary of the last {JOBS} jobs.\n"
                                 "API keys, ChatGPT tokens and anything shaped like a key or token are replaced by [redacted].\n"
                                 "No videos, project documents or project names are included. Log lines can contain file names\n"
                                 "and paths; look through the files before you share them if that matters to you.\n")
    return buf.getvalue()
