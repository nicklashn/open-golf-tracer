"""Export requests, history and downloads."""
from __future__ import annotations

from fastapi import APIRouter, Depends
from pydantic import BaseModel
from sqlalchemy import select
from sqlalchemy.orm import Session

from .. import jobs
from ..db import get_db
from ..deps import current_user
from ..documents import merged_document, validate_document
from ..errors import ApiError, not_found
from ..media_urls import export_url
from ..models import Export, Job, Media, User
from ..storage import storage
from .projects import get_project

router = APIRouter(tags=["exports"])


class ExportIn(BaseModel):
    settings: dict
    document: dict | None = None      # the editor sends its current document (saved first)
    locale: str | None = None         # the UI language: graphics in the export are drawn in it


def public_export(db: Session, e: Export) -> dict:
    job = db.get(Job, e.job_id) if e.job_id else None
    return {"id": e.id, "projectId": e.project_id, "projectName": e.project_name, "settings": e.settings, "status": e.status,
            "progress": job.progress if job else (1.0 if e.status == "succeeded" else 0.0), "message": job.message if job else "",
            "jobId": e.job_id, "size": e.size, "width": e.width, "height": e.height, "duration": e.duration,
            "url": export_url(e) if e.status == "succeeded" else None,
            "previewUrl": export_url(e, download=False) if e.status == "succeeded" else None, "createdAt": e.created_at.isoformat(),
            "finishedAt": e.finished_at.isoformat() if e.finished_at else None, "error": job.error[-300:] if job and e.status == "failed" else ""}


@router.post("/projects/{project_id}/exports")
def create_export(project_id: str, body: ExportIn, db: Session = Depends(get_db), user: User = Depends(current_user)):
    p = get_project(db, user, project_id)
    doc = validate_document(body.document) if body.document is not None else merged_document(p)
    if not doc.get("clips"):
        raise ApiError(422, "empty_project", "The project has no video to export.")
    s = body.settings or {}
    if s.get("preset") not in ("shorts", "youtube1080", "youtube4k", "original"):
        raise ApiError(422, "invalid_settings", "Ukendt eksportformat.")
    media = {m.id: m for m in db.scalars(select(Media).where(Media.project_id == p.id)).all()}
    missing = [mid for mid in doc.get("media", {}) if mid not in media]
    if missing:
        raise ApiError(422, "unknown_media", "The project refers to files that do not exist.")
    e = Export(user_id=user.id, project_id=p.id, project_name=p.name, settings=s)
    db.add(e)
    db.flush()
    locale = body.locale if body.locale in ("da", "en") else (user.locale if user.locale in ("da", "en") else "en")
    job = jobs.enqueue(db, "export", {"export_id": e.id, "document": doc, "settings": s, "locale": locale},
                       user_id=user.id, project_id=p.id, max_attempts=2)
    e.job_id = job.id
    db.commit()
    return public_export(db, e)


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
