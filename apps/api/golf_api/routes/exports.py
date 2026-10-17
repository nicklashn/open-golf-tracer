"""Export requests, history and downloads: one at a time, several at once (the videos of one
"Make a video for me"), all of those as one zip, and opening the exports folder on this PC."""
from __future__ import annotations

import ipaddress
import os
import shutil
import subprocess
import sys
import tempfile
import zipfile
from pathlib import Path

from fastapi import APIRouter, BackgroundTasks, Depends, Request
from fastapi.responses import FileResponse
from pydantic import BaseModel, Field
from sqlalchemy import select
from sqlalchemy.orm import Session

from .. import jobs
from ..db import get_db
from ..deps import current_user
from ..documents import merged_document, validate_document
from ..errors import ApiError, not_found
from ..media_urls import export_url
from ..models import Export, Job, Media, Project, User, new_id
from ..space import export_need, need_space
from ..storage import storage, tmp_dir, user_prefix
from .projects import get_project

router = APIRouter(tags=["exports"])


class ExportIn(BaseModel):
    settings: dict
    document: dict | None = None      # the editor sends its current document (saved first)
    locale: str | None = None         # the UI language: graphics in the export are drawn in it
    # A made video's description and chapters for YouTube, as the export dialog showed them;
    # kept with the export so "My videos" can copy it.
    publishText: str | None = Field(None, max_length=8000)


def public_export(db: Session, e: Export) -> dict:
    job = db.get(Job, e.job_id) if e.job_id else None
    status = e.status
    if status in ("queued", "running") and job is not None and job.status in ("queued", "failed", "canceled"):
        # Rows from before the queue kept them in step (an exporter that crashed mid-export).
        status = job.status
    return {"id": e.id, "projectId": e.project_id, "projectName": e.project_name, "settings": e.settings, "status": status,
            "progress": job.progress if job else (1.0 if e.status == "succeeded" else 0.0), "message": job.message if job else "",
            "jobId": e.job_id, "size": e.size, "width": e.width, "height": e.height, "duration": e.duration,
            "url": export_url(e) if status == "succeeded" else None,
            "previewUrl": export_url(e, download=False) if status == "succeeded" else None, "createdAt": e.created_at.isoformat(),
            "finishedAt": e.finished_at.isoformat() if e.finished_at else None, "error": job.error[-300:] if job and status == "failed" else "",
            "errorCode": jobs.public(job)["errorCode"] if job else ""}


PRESETS = ("shorts", "youtube1080", "youtube4k", "original")


class BatchIn(BaseModel):
    projectIds: list[str] = Field(min_length=1, max_length=100)
    settings: dict
    locale: str | None = None         # as ExportIn.locale


def _check_settings(s: dict) -> dict:
    if s.get("preset") not in PRESETS:
        raise ApiError(422, "invalid_settings", "Ukendt eksportformat.")
    return s


def _export_locale(user: User, asked: str | None) -> str:
    """The language graphics are drawn in: the one asked for, else the account's (older web apps)."""
    return asked if asked in ("da", "en") else (user.locale if user.locale in ("da", "en") else "en")


def _queue_export(db: Session, user: User, p: Project, doc: dict, s: dict, locale: str,
                  publish_text: str | None = None) -> Export:
    if not doc.get("clips"):
        raise ApiError(422, "empty_project", "The project has no video to export.")
    media = {m.id: m for m in db.scalars(select(Media).where(Media.project_id == p.id)).all()}
    missing = [mid for mid in doc.get("media", {}) if mid not in media]
    if missing:
        raise ApiError(422, "unknown_media", "The project refers to files that do not exist.")
    seconds = sum((c["out"] - c["in"]) / (c.get("speed") or 1) if c.get("kind") == "video" else c.get("duration", 0)
                  for c in doc.get("clips", []))
    need_space(export_need(seconds, s["preset"]))
    kept = {**s, "publishText": publish_text.strip()} if publish_text and publish_text.strip() else s
    e = Export(user_id=user.id, project_id=p.id, project_name=p.name, settings=kept)
    db.add(e)
    db.flush()
    job = jobs.enqueue(db, "export", {"export_id": e.id, "document": doc, "settings": s, "locale": locale},
                       user_id=user.id, project_id=p.id, max_attempts=2)
    e.job_id = job.id
    return e


@router.post("/projects/{project_id}/exports")
def create_export(project_id: str, body: ExportIn, db: Session = Depends(get_db), user: User = Depends(current_user)):
    p = get_project(db, user, project_id)
    doc = validate_document(body.document) if body.document is not None else merged_document(p)
    e = _queue_export(db, user, p, doc, _check_settings(body.settings or {}), _export_locale(user, body.locale), body.publishText)
    db.commit()
    return public_export(db, e)


@router.post("/exports/batch")
def create_batch(body: BatchIn, db: Session = Depends(get_db), user: User = Depends(current_user)):
    """Exports several projects with one preset (the videos of one "Make a video for me"). They
    share a batch id (kept in the settings) for "Download all"; projects without video are skipped."""
    batch = new_id("bat")
    s = {**_check_settings(body.settings or {}), "batch": batch}
    out = []
    for pid in dict.fromkeys(body.projectIds):
        p = get_project(db, user, pid)
        doc = merged_document(p)
        if doc.get("clips"):
            out.append(_queue_export(db, user, p, doc, s, _export_locale(user, body.locale)))
    if not out:
        raise ApiError(422, "empty_project", "The project has no video to export.")
    db.commit()
    return {"batch": batch, "exports": [public_export(db, e) for e in out]}


def _zip_names(rows: list[Export]) -> list[tuple[Export, str]]:
    """File names inside the zip: the project names, made unique ("Hole 4.mp4", "Hole 4 (2).mp4")."""
    seen: dict[str, int] = {}
    out = []
    for e in rows:
        base = "".join(ch for ch in (e.project_name or "video").strip()[:60] if ch not in '\\/:*?"<>|') or "video"
        n = seen.get(base.lower(), 0) + 1
        seen[base.lower()] = n
        out.append((e, f"{base}.mp4" if n == 1 else f"{base} ({n}).mp4"))
    return out


@router.get("/exports/batches/{batch}/zip")
def download_batch(batch: str, background: BackgroundTasks, db: Session = Depends(get_db), user: User = Depends(current_user)):
    """The finished videos of a batch as one zip (stored, not compressed: MP4s don't shrink)."""
    rows = [e for e in db.scalars(select(Export).where(Export.user_id == user.id, Export.status == "succeeded")
                                  .order_by(Export.created_at)).all()
            if (e.settings or {}).get("batch") == batch and e.storage_key and storage().exists(e.storage_key)]
    if not rows:
        raise ApiError(404, "nothing_to_zip", "None of the videos is finished yet.")
    fd, tmp = tempfile.mkstemp(suffix=".zip", dir=tmp_dir())
    os.close(fd)
    with zipfile.ZipFile(tmp, "w", compression=zipfile.ZIP_STORED, allowZip64=True) as z:
        for e, name in _zip_names(rows):
            z.write(storage().local_path(e.storage_key), arcname=name)
    background.add_task(lambda: Path(tmp).unlink(missing_ok=True))
    name = f"{(rows[0].project_name or 'open-golf-tracer').strip()[:40]} ({len(rows)}).zip"
    return FileResponse(tmp, media_type="application/zip", filename=name)


class OpenFolderIn(BaseModel):
    exportId: str | None = Field(None, max_length=40)


def _loopback(host: str | None) -> bool:
    try:
        return host is not None and ipaddress.ip_address(host.strip().strip("[]")).is_loopback
    except ValueError:
        return host == "localhost"


def local_request(request: Request) -> bool:
    """True only for a browser on this PC: the connection comes from the loopback address, and so
    does every hop the web app's proxy names (it adds the browser's address to X-Forwarded-For)."""
    if not _loopback(request.client.host if request.client else None):
        return False
    hops = [h for h in request.headers.get("x-forwarded-for", "").split(",") if h.strip()]
    return all(_loopback(h) for h in hops)


def _reveal(path: Path, select_file: Path | None) -> None:
    """Shows the folder in the system's file manager (Explorer, Finder, the desktop's default)."""
    if sys.platform == "win32":
        if select_file is not None:
            subprocess.Popen(["explorer", f"/select,{select_file}"])  # noqa: S603, S607 - fixed program, our own path
        else:
            os.startfile(path)  # type: ignore[attr-defined]  # noqa: S606
        return
    opener = ["open", "-R", str(select_file)] if sys.platform == "darwin" and select_file else ["open" if sys.platform == "darwin" else "xdg-open", str(path)]
    if not shutil.which(opener[0]):
        raise ApiError(501, "cannot_open", "The folder could not be opened on this PC.")
    subprocess.Popen(opener, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)  # noqa: S603 - fixed program, our own path


@router.post("/exports/open-folder")
def open_folder(body: OpenFolderIn, request: Request, db: Session = Depends(get_db), user: User = Depends(current_user)):
    """Opens the exports folder on this PC (with the video selected where the system can). Only for
    a browser on the same machine: from another device it would open a window nobody sees."""
    if not local_request(request):
        raise ApiError(403, "local_only", "This only works on the PC that runs Open Golf Tracer.")
    folder = storage().local_path(f"{user_prefix(user.id)}/exports")
    folder.mkdir(parents=True, exist_ok=True)
    pick = None
    if body.exportId:
        e = db.get(Export, body.exportId)
        if e is None or e.user_id != user.id:
            raise not_found("Eksporten")
        if e.storage_key and storage().exists(e.storage_key):
            pick = storage().local_path(e.storage_key)
    try:
        _reveal(folder, pick)
    except OSError as exc:
        raise ApiError(501, "cannot_open", "The folder could not be opened on this PC.") from exc
    return {"ok": True}


@router.get("/exports")
def list_exports(project_id: str | None = None, db: Session = Depends(get_db), user: User = Depends(current_user)):
    stmt = select(Export).where(Export.user_id == user.id)
    if project_id:
        stmt = stmt.where(Export.project_id == project_id)
    rows = db.scalars(stmt.order_by(Export.created_at.desc()).limit(200)).all()
    return {"exports": [public_export(db, e) for e in rows]}


@router.get("/exports/{export_id}")
def get_export(export_id: str, db: Session = Depends(get_db), user: User = Depends(current_user)):
    e = db.get(Export, export_id)
    if e is None or e.user_id != user.id:
        raise not_found("Eksporten")
    return public_export(db, e)


@router.delete("/exports/{export_id}")
def delete_export(export_id: str, db: Session = Depends(get_db), user: User = Depends(current_user)):
    e = db.get(Export, export_id)
    if e is None or e.user_id != user.id:
        raise not_found("Eksporten")
    if e.status in ("queued", "running") and e.job_id:
        j = db.get(Job, e.job_id)
        if j:
            jobs.cancel(db, j)
    if e.storage_key:
        storage().delete(e.storage_key)
    db.delete(e)
    db.commit()
    return {"ok": True}
