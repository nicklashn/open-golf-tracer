"""Project documents (see packages/schema). The API validates against the JSON Schema generated
from the zod schema, so browser, exporter and server agree on the shape."""
from __future__ import annotations

import copy
import functools
import json
from typing import Any

from jsonschema import Draft202012Validator

from .chronology import clip_slot
from .config import ROOT
from .errors import ApiError
from .models import Media, Project

SCHEMA_VERSION = 1
MAX_DOC_BYTES = 5 * 1024 * 1024
SHOT_KEYS = {"id", "mediaId", "source", "kind", "impactTime", "confidence", "warnings", "camera", "anchor", "track", "params",
             "rmsPx", "auto", "constraints", "timing", "slowmo", "club", "style", "visible", "label"}


@functools.cache
def _validator() -> Draft202012Validator:
    schema = json.loads((ROOT / "packages/schema/json/project.schema.json").read_text(encoding="utf-8"))
    return Draft202012Validator(schema)


def validate_document(doc: Any) -> dict[str, Any]:
    if not isinstance(doc, dict):
        raise ApiError(422, "invalid_document", "The project has an invalid format.")
    size = len(json.dumps(doc, separators=(",", ":")))
    if size > MAX_DOC_BYTES:
        raise ApiError(413, "document_too_large", "The project is too large to save.")
    errors = sorted(_validator().iter_errors(doc), key=lambda e: list(e.path))
    if errors:
        e = errors[0]
        where = "/".join(str(p) for p in e.path) or "(rod)"
        raise ApiError(422, "invalid_document", f"The project has an invalid field: {where}", {"path": where, "error": e.message[:300]})
    return doc


def media_ref(m: Media) -> dict[str, Any]:
    p = m.probe or {}
    return {"id": m.id, "kind": m.kind, "name": m.filename[:255], "width": int(p.get("width") or 0), "height": int(p.get("height") or 0),
            "fps": float(p.get("fps") or 0), "duration": float(p.get("duration") or 0), "hdr": bool(p.get("hdr")),
            "hasAudio": bool(p.get("hasAudio")), "geo": p.get("geo"), "recordedAt": p.get("recordedAt"),
            "recordedAtSource": p.get("recordedAtSource")}


def new_document(name: str, video: Media | None = None) -> dict[str, Any]:
    doc: dict[str, Any] = {"schemaVersion": SCHEMA_VERSION, "name": name[:120], "media": {}, "clips": [], "shots": [], "layers": [],
                           "audioTracks": [], "dismissedShots": []}
    if video is not None:
        add_video(doc, video)
    return doc


def attach_video(doc: dict[str, Any], ref: dict[str, Any]) -> None:
    """Adds a clip of the whole video, placed among the other clips in the round order (chronology.py,
    like clipSlot in the editor)."""
    doc.setdefault("media", {})[ref["id"]] = ref
    _place_clip(doc, ref["id"])


def _place_clip(doc: dict[str, Any], media_id: str) -> None:
    clips = doc.setdefault("clips", [])
    clip = {"id": f"clip_{media_id[-8:]}_{len(clips)}", "kind": "video", "mediaId": media_id, "in": 0,
            "out": round(float(doc["media"][media_id].get("duration") or 0), 4), "speed": 1, "volume": 1, "muted": False}
    clips.insert(clip_slot(doc, media_id), clip)


def add_video(doc: dict[str, Any], m: Media) -> None:
    doc.setdefault("media", {})[m.id] = media_ref(m)
    if m.kind == "video":
        dur = float((m.probe or {}).get("duration") or 0)
        doc.setdefault("clips", []).append({"id": f"clip_{m.id[-8:]}_{len(doc['clips'])}", "kind": "video", "mediaId": m.id,
                                            "in": 0, "out": round(dur, 4), "speed": 1, "volume": 1, "muted": False})


def clean_shot(shot: dict[str, Any], media_id: str) -> dict[str, Any]:
    s = {k: copy.deepcopy(v) for k, v in shot.items() if k in SHOT_KEYS}
    s["mediaId"] = media_id
    s["id"] = f"{media_id[-6:]}_{shot['id']}"[:64]
    return s


def merged_document(p: Project) -> dict[str, Any]:
    """The stored document plus analysis results the editor has not seen yet."""
    doc = copy.deepcopy(p.document or new_document(p.name))
    have = {s.get("id") for s in doc.get("shots", [])}
    gone = set(doc.get("dismissedShots", []))
    for media_id, res in (p.analysis or {}).items():
        # A new clip is placed once its hole is known too (the round order may go by hole).
        new = media_id not in doc.get("media", {}) and bool(res.get("attach"))
        if new:
            doc.setdefault("media", {})[media_id] = copy.deepcopy(res["attach"])
        if media_id not in doc.get("media", {}):
            continue
        place = dict(res.get("place") or {})
        geo = place.pop("geo", None)
        if geo and not doc["media"][media_id].get("geo"):
            doc["media"][media_id]["geo"] = geo
        current = doc["media"][media_id].get("place") or {}
        # A place without a hole (an ambiguous tee) is replaced once the round resolves it.
        if "course" in place and (not current or (not current.get("hole") and place.get("hole"))):
            doc["media"][media_id]["place"] = {k: v for k, v in place.items() if k not in ("alternatives", "margin")}
        if new:
            _place_clip(doc, media_id)
        for shot in res.get("shots", []):
            if shot["id"] not in have and shot["id"] not in gone:
                doc.setdefault("shots", []).append(shot)
                have.add(shot["id"])
    # As played: by where each video sits on the timeline, then by time (byTimeline() in TS).
    first: dict[str, int] = {}
    for i, c in enumerate(doc.get("clips", [])):
        first.setdefault(c.get("mediaId", ""), i)
    doc["shots"] = sorted(doc.get("shots", []), key=lambda s: (first.get(s.get("mediaId", ""), 1 << 30), s.get("impactTime", 0)))
    return doc
