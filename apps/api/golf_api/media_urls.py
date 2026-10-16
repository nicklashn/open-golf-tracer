"""Signed, expiring media URLs. A <video>/<img> tag can load the file directly, and a URL only
ever grants that one file."""
from __future__ import annotations

from typing import Any

from .config import settings
from .models import Export, Media
from .security import sign

TTL = 6 * 3600
VARIANTS = ("original", "proxy", "poster", "thumbs", "thumbs_meta", "waveform")


def media_url(m: Media, variant: str, ttl: int = TTL) -> str | None:
    if variant == "original":
        key = m.storage_key
    else:
        key = (m.derived or {}).get(variant)
    if not key:
        return None
    tok = sign({"u": m.user_id, "k": key, "n": f"{m.filename}" if variant == "original" else variant}, ttl)
    return f"{settings().media_base_url}/m/{tok}"


def export_url(e: Export, ttl: int = TTL, download: bool = True) -> str | None:
    if not e.storage_key:
        return None
    name = f"{(e.project_name or 'open-golf-tracer').strip()[:60]}.mp4"
    tok = sign({"u": e.user_id, "k": e.storage_key, "n": name, "d": 1 if download else 0}, ttl)
    return f"{settings().media_base_url}/m/{tok}"


def public_media(m: Media) -> dict[str, Any]:
    p = m.probe or {}
    return {
        "id": m.id,
        "kind": m.kind,
        "name": m.filename,
        "size": m.size,
        "status": m.status,
        "projectId": m.project_id,
        "width": p.get("width", 0),
        "height": p.get("height", 0),
        "fps": p.get("fps", 0),
        "duration": p.get("duration", 0),
        "hdr": bool(p.get("hdr")),
        "hasAudio": bool(p.get("hasAudio")),
        "geo": p.get("geo"),
        "recordedAt": p.get("recordedAt"),
        "recordedAtSource": p.get("recordedAtSource"),
        "urls": {v: media_url(m, v) for v in VARIANTS if v == "original" or (m.derived or {}).get(v)},
        "thumbs": (m.derived or {}).get("thumbs_info"),
        "createdAt": m.created_at.isoformat(),
    }
