"""Chunked, resumable uploads of large files (several GB). Chunks are written at their offset
into a preallocated temp file; completion validates with ffprobe and creates the media row."""
from __future__ import annotations

import json
import logging
import os
import re
import time
from pathlib import Path

from fastapi import APIRouter, Depends, Request
from fastapi.concurrency import run_in_threadpool
from pydantic import BaseModel, Field
from sqlalchemy import select
from sqlalchemy.orm import Session

from .. import chronology, jobs
from ..config import settings
from ..db import SessionLocal, get_db, utcnow, write_lock
from ..deps import current_user
from ..documents import media_ref, new_document, update_analysis
from ..errors import ApiError, not_found
from ..limits import check_duration, check_upload
from ..media_urls import public_media
from ..models import Media, Project, Upload, User
from ..probe import ProbeError, probe_file
from ..space import disk_full, need_space, upload_need
from ..storage import media_prefix, storage, tmp_dir
from .projects import get_project, summary

router = APIRouter(prefix="/uploads", tags=["uploads"])
log = logging.getLogger("golf.api")

ALLOWED_EXT = {"video": {".mp4", ".mov", ".m4v", ".mkv", ".avi", ".webm", ".mts", ".hevc"},
               "audio": {".mp3", ".m4a", ".aac", ".wav", ".ogg", ".flac"},
               "image": {".png", ".jpg", ".jpeg", ".webp"}}
MAX_IMAGE_BYTES = 25 * 1024 * 1024


class CreateIn(BaseModel):
    filename: str = Field(min_length=1, max_length=255)
    size: int = Field(gt=0)
    kind: str = Field("video", pattern="^(video|audio|image)$")
    projectId: str | None = None
    # The browser's File.lastModified (ms): the last fallback for when a clip was filmed.
    lastModified: float | None = Field(None, ge=0)


def _clean_name(name: str) -> str:
    name = os.path.basename(name.replace("\\", "/"))
    name = re.sub(r"[\x00-\x1f<>:\"|?*]", "_", name).strip(" .") or "video"
    return name[:200]


def _tmp_path(up: Upload) -> Path:
    return tmp_dir() / "uploads" / f"{up.id}.part"


def _meta_path(up: Upload) -> Path:
    """What the browser told about the file beyond its name and size (kept until completion, no column)."""
    return tmp_dir() / "uploads" / f"{up.id}.json"


def _last_modified(up: Upload) -> float | None:
    try:
        value = json.loads(_meta_path(up).read_text(encoding="utf-8")).get("lastModified")
    except (OSError, ValueError, AttributeError):
        return None
    return float(value) if isinstance(value, int | float) else None


def _discard(up: Upload) -> None:
    _tmp_path(up).unlink(missing_ok=True)
    _meta_path(up).unlink(missing_ok=True)


def _get(db: Session, user: User, upload_id: str) -> Upload:
    up = db.get(Upload, upload_id)
    if up is None or up.user_id != user.id:
        raise not_found("Uploaden")
    return up


def _status(up: Upload) -> dict:
    n = -(-up.size // up.chunk_size)
    return {"id": up.id, "chunkSize": up.chunk_size, "chunks": n, "received": sorted(up.received), "status": up.status,
            "mediaId": up.media_id}


@router.post("")
def create_upload(body: CreateIn, db: Session = Depends(get_db), user: User = Depends(current_user)):
    name = _clean_name(body.filename)
    ext = Path(name).suffix.lower()
    if ext and ext not in ALLOWED_EXT[body.kind]:
        raise ApiError(415, "unsupported_type", f"The file type {ext} is not supported here.")
    if body.kind == "image" and body.size > MAX_IMAGE_BYTES:
        raise ApiError(413, "too_large", "Images may be at most 25 MB.")
    check_upload(body.size)
    if body.projectId:
        get_project(db, user, body.projectId)
    # Uploads under way have their part files (sparse until written) and previews still to come.
    pending = sum(upload_need(u.size - len(u.received or []) * u.chunk_size, u.kind)
                  for u in db.scalars(select(Upload).where(Upload.user_id == user.id, Upload.status == "open")).all())
    need_space(upload_need(body.size, body.kind), max(0, pending))
    up = Upload(user_id=user.id, project_id=body.projectId, kind=body.kind, filename=name, size=body.size,
                chunk_size=settings().upload_chunk_bytes, received=[])
    db.add(up)
    db.commit()
    path = _tmp_path(up)
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("wb") as f:
        f.truncate(body.size)   # sparse preallocation: chunks can arrive in any order
    if body.lastModified:
        _meta_path(up).write_text(json.dumps({"lastModified": body.lastModified}), encoding="utf-8")
    return _status(up)


@router.get("/{upload_id}")
def upload_status(upload_id: str, db: Session = Depends(get_db), user: User = Depends(current_user)):
    return _status(_get(db, user, upload_id))


@router.put("/{upload_id}/chunks/{index}")
async def put_chunk(upload_id: str, index: int, request: Request, user: User = Depends(current_user)):
    # The body arrives on the event loop; the file write and the database work (8 MB each, many
    # uploads at once) run in the thread pool so they never stall other requests.
    limit = settings().upload_chunk_bytes
    parts, size = [], 0
    async for part in request.stream():
        size += len(part)
        if size > limit:
            raise ApiError(422, "bad_chunk", "The chunk is too large.")
        parts.append(part)
    return await run_in_threadpool(_store_chunk, upload_id, index, b"".join(parts), user.id)


def _store_chunk(upload_id: str, index: int, body: bytes, user_id: str) -> dict:
    db = SessionLocal()
    try:
        up = db.get(Upload, upload_id)
        if up is None or up.user_id != user_id:
            raise not_found("Uploaden")
        if up.status != "open":
            raise ApiError(409, "upload_closed", "The upload is already finished.")
        n = -(-up.size // up.chunk_size)
        if not 0 <= index < n:
            raise ApiError(422, "bad_chunk", "Ugyldigt stykke.")
        expected = min(up.chunk_size, up.size - index * up.chunk_size)
        if len(body) > expected:
            raise ApiError(422, "bad_chunk", "The chunk is too large.")
        if len(body) != expected:
            raise ApiError(422, "bad_chunk", f"The chunk was incomplete ({len(body)} of {expected} bytes).")
        path = _tmp_path(up)
        if not path.exists():
            raise ApiError(410, "upload_expired", "The upload has expired. Start over.")
        try:
            with path.open("r+b") as f:
                f.seek(index * up.chunk_size)
                f.write(body)
        except OSError as exc:
            if disk_full(exc):
                raise ApiError(507, "disk_full", "The disk is full.") from exc
            raise
        write_lock(db)          # chunks arrive in parallel; each adds itself to `received`
        db.refresh(up)
        if index not in up.received:
            up.received = sorted({*up.received, index})
        up.updated_at = utcnow()
        db.commit()
        return {"received": len(up.received), "chunks": n}
    finally:
        db.close()


@router.post("/{upload_id}/complete")
def complete_upload(upload_id: str, db: Session = Depends(get_db), user: User = Depends(current_user)):
    up = _get(db, user, upload_id)
    if up.status == "complete" and up.media_id:
        m = db.get(Media, up.media_id)
        return {"media": public_media(m) if m else None, "projectId": up.project_id}
    n = -(-up.size // up.chunk_size)
    missing = sorted(set(range(n)) - set(up.received))
    if missing:
        raise ApiError(409, "chunks_missing", "Not all parts have been received yet.", {"missing": missing[:50]})
    path = _tmp_path(up)
    t0 = time.perf_counter()
    try:
        info = probe_file(path)
    except ProbeError as exc:
        up.status = "failed"
        db.commit()
        _discard(up)
        raise ApiError(415, "invalid_media", str(exc)) from exc
    if info["kind"] != up.kind and not (up.kind == "audio" and info["kind"] == "video"):
        up.status = "failed"
        db.commit()
        _discard(up)
        raise ApiError(415, "wrong_kind", {"video": "The file is not a video.", "audio": "The file is not an audio file.",
                                          "image": "The file is not an image."}[up.kind])
    try:
        if up.kind == "video":
            check_duration(info["duration"])
            if not info.get("fps") or info["fps"] > 1000:
                raise ApiError(415, "invalid_media", "The video has an invalid frame rate.")
    except ApiError:
        # Rejected for good: free the (multi-GB) part file now, not after 48 hours.
        up.status = "failed"
        db.commit()
        _discard(up)
        raise
    if info["kind"] == "video":
        chronology.settle(info, up.filename, _last_modified(up))

    project: Project | None = None
    if up.project_id:
        project = get_project(db, user, up.project_id)
    elif up.kind == "video":
        project = Project(user_id=user.id, name=Path(up.filename).stem[:120] or "New video")
        db.add(project)
        db.flush()
    m = Media(user_id=user.id, project_id=project.id if project else None, kind=up.kind, filename=up.filename, size=up.size,
              storage_key="", probe=info, status="processing" if up.kind in ("video", "audio") else "ready")
    db.add(m)
    db.flush()
    ext = Path(up.filename).suffix.lower() or {"video": ".mp4", "audio": ".m4a", "image": ".png"}[up.kind]
    m.storage_key = f"{media_prefix(user.id, m.id)}/original{ext}"
    t_probe = time.perf_counter()
    storage().put_file(m.storage_key, path, move=True)
    _meta_path(up).unlink(missing_ok=True)
    t_move = time.perf_counter()
    up.status, up.media_id = "complete", m.id
    if project is not None and up.kind == "video" and not up.project_id:
        # A brand-new project: the server writes the first document (no editor is open yet).
        project.document = new_document(project.name, m)
        project.doc_version = 1
    elif project is not None and up.kind == "video":
        # Another clip for an existing project (a round). The stored document is not touched –
        # an open editor would conflict – it is merged in on load, like analysis results.
        # Under the write lock: analyses of the round's other clips write the same column.
        ref = media_ref(m)
        update_analysis(db, project.id, lambda a: a.__setitem__(m.id, {**a.get(m.id, {}), "attach": ref, "shots": [], "status": "queued"}))
    # Ingest (proxy, thumbnails, waveform) and analysis run in parallel: the editor opens as
    # soon as the proxy is ready and shots appear while the analysis is still running.
    jobs.enqueue(db, "ingest", {"media_id": m.id}, user_id=user.id, project_id=project.id if project else None, media_id=m.id)
    if up.kind == "video" and project is not None:
        jobs.enqueue(db, "analyze", {"media_id": m.id}, user_id=user.id, project_id=project.id, media_id=m.id)
    db.commit()
    t_end = time.perf_counter()
    if t_end - t0 > 5:
        log.warning("upload %s: complete took %.1f s (probe+checks %.1f, move %.1f, database %.1f)", upload_id, t_end - t0,
                    t_probe - t0, t_move - t_probe, t_end - t_move)
    return {"media": public_media(m), "projectId": project.id if project else None,
            "project": summary(db, project) if project else None}


@router.delete("/{upload_id}")
def abort_upload(upload_id: str, db: Session = Depends(get_db), user: User = Depends(current_user)):
    up = _get(db, user, upload_id)
    if up.status == "open":
        up.status = "failed"
        _discard(up)
        db.commit()
    return {"ok": True}
