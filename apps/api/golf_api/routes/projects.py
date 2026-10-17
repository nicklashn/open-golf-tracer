"""Projects: list, create (empty or demo), load, save the document (optimistic concurrency),
version history and analysis jobs."""
from __future__ import annotations

import copy
import datetime as dt

from fastapi import APIRouter, Depends
from pydantic import BaseModel, Field
from sqlalchemy import select
from sqlalchemy.orm import Session
from sqlalchemy.orm.attributes import flag_modified

from .. import jobs
from ..db import get_db, utcnow
from ..deps import current_user
from ..documents import merged_document, new_document, validate_document
from ..errors import ApiError, not_found
from ..media_urls import media_url, public_media
from ..models import Job, Media, Project, ProjectVersion, User
from ..storage import storage

router = APIRouter(prefix="/projects", tags=["projects"])

AUTO_SNAPSHOT_EVERY = dt.timedelta(minutes=10)
KEEP_AUTO_VERSIONS = 30


class CreateIn(BaseModel):
    name: str = Field("Untitled", max_length=120)


class RenameIn(BaseModel):
    name: str = Field(min_length=1, max_length=120)


class SaveIn(BaseModel):
    document: dict
    baseVersion: int
    force: bool = False


class DuplicateIn(BaseModel):
    # The editor's own document (a save that conflicted, kept as a copy); default: the saved one.
    document: dict | None = None
    name: str | None = Field(None, max_length=120)


class VersionIn(BaseModel):
    label: str = Field("", max_length=120)


class AnalyzeIn(BaseModel):
    mediaId: str


class RetrackIn(BaseModel):
    mediaId: str
    impactTime: float = Field(ge=0)
    # False: impactTime is just when the user clicked the ball; the strike is searched after it.
    timeIsImpact: bool = True
    ball: dict | None = None          # {"x", "y"} in source pixels
    shotId: str | None = None
    slowmo: float = Field(1.0, ge=1, le=16)


def get_project(db: Session, user: User, project_id: str) -> Project:
    p = db.get(Project, project_id)
    if p is None or p.user_id != user.id or p.deleted_at is not None:
        raise not_found("The project")
    return p


def _project_media(db: Session, p: Project) -> list[Media]:
    return list(db.scalars(select(Media).where(Media.project_id == p.id).order_by(Media.created_at)).all())


def _active_jobs(db: Session, p: Project) -> list[Job]:
    return list(db.scalars(select(Job).where(Job.project_id == p.id, Job.kind.notin_(("export", "compose")),
                                             Job.status.in_(("queued", "running")))).all())


def summary(db: Session, p: Project) -> dict:
    media = _project_media(db, p)
    doc = merged_document(p)
    poster = next((m for m in media if (m.derived or {}).get("poster")), None)
    duration = sum((c["out"] - c["in"]) / c.get("speed", 1) if c.get("kind") == "video" else c.get("duration", 0)
                   for c in doc.get("clips", []))
    active = _active_jobs(db, p)
    return {
        "id": p.id,
        "name": p.name,
        "updatedAt": p.updated_at.isoformat(),
        "createdAt": p.created_at.isoformat(),
        "posterUrl": media_url(poster, "poster") if poster else None,
        "duration": round(duration, 2),
        "shots": len([s for s in doc.get("shots", []) if s.get("visible", True)]),
        "aspect": (doc.get("format") or {}).get("aspect", "original"),
        "processing": [jobs.public(j) for j in active],
        "isDemo": p.is_demo,
        "failed": any(m.status == "failed" for m in media),
    }


@router.get("")
def list_projects(db: Session = Depends(get_db), user: User = Depends(current_user)):
    rows = db.scalars(select(Project).where(Project.user_id == user.id, Project.deleted_at.is_(None))
                      .order_by(Project.updated_at.desc())).all()
    return {"projects": [summary(db, p) for p in rows]}


@router.post("")
def create_project(body: CreateIn, db: Session = Depends(get_db), user: User = Depends(current_user)):
    p = Project(user_id=user.id, name=body.name.strip() or "Untitled", document=new_document(body.name))
    db.add(p)
    db.commit()
    return summary(db, p)


@router.post("/demo")
def create_demo(locale: str | None = None, db: Session = Depends(get_db), user: User = Depends(current_user)):
    from ..demo import create_demo_project

    p = create_demo_project(db, user, locale)
    return summary(db, p)


@router.get("/{project_id}")
def load_project(project_id: str, db: Session = Depends(get_db), user: User = Depends(current_user)):
    p = get_project(db, user, project_id)
    from .disk import restore_previews

    if restore_previews(db, p) or db.dirty:   # previews deleted under Settings → Storage come back
        db.commit()
    return {**summary(db, p), "document": merged_document(p), "docVersion": p.doc_version,
            "media": [public_media(m) for m in _project_media(db, p)]}


@router.patch("/{project_id}")
def rename_project(project_id: str, body: RenameIn, db: Session = Depends(get_db), user: User = Depends(current_user)):
    p = get_project(db, user, project_id)
    p.name = body.name.strip()
    doc = copy.deepcopy(p.document or {})
    doc["name"] = p.name
    p.document = doc
    p.updated_at = utcnow()
    db.commit()
    return summary(db, p)


@router.delete("/{project_id}")
def delete_project(project_id: str, db: Session = Depends(get_db), user: User = Depends(current_user)):
    p = get_project(db, user, project_id)
    for m in _project_media(db, p):
        shared = db.scalars(select(Media.id).where(Media.storage_key == m.storage_key, Media.id != m.id)).first()
        if not shared:   # duplicated projects point at the same files
            storage().delete_prefix(m.storage_key.rsplit("/", 1)[0])
        db.delete(m)
    for j in _active_jobs(db, p):
        jobs.cancel(db, j)
    p.deleted_at = utcnow()
    p.document, p.analysis = {}, {}
    db.commit()
    return {"ok": True}


@router.post("/{project_id}/duplicate")
def duplicate_project(project_id: str, body: DuplicateIn | None = None, db: Session = Depends(get_db),
                      user: User = Depends(current_user)):
    p = get_project(db, user, project_id)
    doc = merged_document(p)
    if body is not None and body.document is not None:
        doc = validate_document(body.document)
        _check_media(db, p, doc)
    q = copy_project(db, user, p, doc, (body.name if body and body.name else None) or f"{p.name} (copy)")
    db.commit()
    return summary(db, q)


def copy_project(db: Session, user: User, p: Project, doc: dict, name: str) -> Project:
    """A new project with `doc` (written against p's media ids) and its own media rows.
    Used by duplicate and by generated videos; the caller commits."""
    doc = copy.deepcopy(doc)
    doc["name"] = name[:120]
    q = Project(user_id=user.id, name=doc["name"], document=doc, analysis={})
    db.add(q)
    db.flush()
    # Media rows are shared by reference: the copy points at the same files.
    for m in _project_media(db, p):
        m2 = Media(user_id=user.id, project_id=q.id, kind=m.kind, filename=m.filename, size=0, storage_key=m.storage_key,
                   probe=m.probe, derived=m.derived, status=m.status)
        db.add(m2)
        db.flush()
        _rename_media(doc, m.id, m2.id)
    # The renames mutate the dict the first flush already stored; mark it changed explicitly
    # (otherwise the copy keeps the original's media ids and cannot be saved).
    q.document = doc
    flag_modified(q, "document")
    return q


def _rename_media(doc: dict, old: str, new: str) -> None:
    if old in doc.get("media", {}):
        ref = doc["media"].pop(old)
        ref["id"] = new
        doc["media"][new] = ref
    for coll in ("clips", "shots", "audioTracks"):
        for item in doc.get(coll, []):
            if item.get("mediaId") == old:
                item["mediaId"] = new
    for layer in doc.get("layers", []):
        if layer.get("props", {}).get("mediaId") == old:
            layer["props"]["mediaId"] = new


def _check_media(db: Session, p: Project, doc: dict) -> None:
    media_ids = {m.id for m in _project_media(db, p)}
    unknown = [mid for mid in doc.get("media", {}) if mid not in media_ids]
    if unknown:
        raise ApiError(422, "unknown_media", "The project refers to files that do not exist.", {"media": unknown})


@router.put("/{project_id}/document")
def save_document(project_id: str, body: SaveIn, db: Session = Depends(get_db), user: User = Depends(current_user)):
    p = get_project(db, user, project_id)
    if body.baseVersion != p.doc_version and not body.force:
        raise ApiError(409, "version_conflict", "The project was changed elsewhere. Reload or overwrite.",
                       {"docVersion": p.doc_version})
    doc = validate_document(body.document)
    _check_media(db, p, doc)
    p.document = doc
    p.name = (doc.get("name") or p.name)[:120]
    p.doc_version += 1
    p.updated_at = utcnow()
    last = db.scalars(select(ProjectVersion).where(ProjectVersion.project_id == p.id).order_by(ProjectVersion.created_at.desc())
                      .limit(1)).first()
    if last is None or utcnow() - last.created_at > AUTO_SNAPSHOT_EVERY:
        db.add(ProjectVersion(project_id=p.id, doc_version=p.doc_version, document=doc, auto=True))
        old = db.scalars(select(ProjectVersion).where(ProjectVersion.project_id == p.id, ProjectVersion.auto.is_(True))
                         .order_by(ProjectVersion.created_at.desc()).offset(KEEP_AUTO_VERSIONS)).all()
        for v in old:
            db.delete(v)
    db.commit()
    return {"docVersion": p.doc_version, "updatedAt": p.updated_at.isoformat()}


@router.get("/{project_id}/versions")
def list_versions(project_id: str, db: Session = Depends(get_db), user: User = Depends(current_user)):
    p = get_project(db, user, project_id)
    rows = db.scalars(select(ProjectVersion).where(ProjectVersion.project_id == p.id).order_by(ProjectVersion.created_at.desc())
                      .limit(100)).all()
    return {"versions": [{"id": v.id, "docVersion": v.doc_version, "label": v.label, "auto": v.auto,
                          "createdAt": v.created_at.isoformat(), "shots": len(v.document.get("shots", [])),
                          "layers": len(v.document.get("layers", []))} for v in rows]}


@router.post("/{project_id}/versions")
def create_version(project_id: str, body: VersionIn, db: Session = Depends(get_db), user: User = Depends(current_user)):
    p = get_project(db, user, project_id)
    v = ProjectVersion(project_id=p.id, doc_version=p.doc_version, document=merged_document(p), label=body.label.strip(), auto=False)
    db.add(v)
    db.commit()
    return {"id": v.id}


@router.post("/{project_id}/versions/{version_id}/restore")
def restore_version(project_id: str, version_id: str, db: Session = Depends(get_db), user: User = Depends(current_user)):
    p = get_project(db, user, project_id)
    v = db.get(ProjectVersion, version_id)
    if v is None or v.project_id != p.id:
        raise not_found("Versionen")
    db.add(ProjectVersion(project_id=p.id, doc_version=p.doc_version, document=merged_document(p), label="Before restore",
                          auto=False))
    p.document = copy.deepcopy(v.document)
    p.doc_version += 1
    p.updated_at = utcnow()
    db.commit()
    return {"docVersion": p.doc_version, "document": merged_document(p)}


@router.post("/{project_id}/analyze")
def analyze(project_id: str, body: AnalyzeIn, db: Session = Depends(get_db), user: User = Depends(current_user)):
    p = get_project(db, user, project_id)
    m = db.get(Media, body.mediaId)
    if m is None or m.project_id != p.id or m.kind != "video":
        raise not_found("The video")
    for j in _active_jobs(db, p):
        if j.kind == "analyze" and j.media_id == m.id:
            return jobs.public(j)
    j = jobs.enqueue(db, "analyze", {"media_id": m.id}, user_id=user.id, project_id=p.id, media_id=m.id)
    db.commit()
    return jobs.public(j)


@router.post("/{project_id}/retrack")
def retrack(project_id: str, body: RetrackIn, db: Session = Depends(get_db), user: User = Depends(current_user)):
    """Track one shot again from a known strike time (and optionally the ball position) –
    used for "track again" and "add shot manually"."""
    p = get_project(db, user, project_id)
    m = db.get(Media, body.mediaId)
    if m is None or m.project_id != p.id or m.kind != "video":
        raise not_found("The video")
    dur = float((m.probe or {}).get("duration") or 0)
    if body.impactTime > dur:
        raise ApiError(422, "invalid_time", "Tidspunktet ligger efter videoens slutning.")
    ball = None
    if body.ball:
        x, y = float(body.ball.get("x", -1)), float(body.ball.get("y", -1))
        if not (0 <= x <= m.probe.get("width", 0) and 0 <= y <= m.probe.get("height", 0)):
            raise ApiError(422, "invalid_point", "Punktet ligger uden for billedet.")
        ball = {"x": x, "y": y}
    j = jobs.enqueue(db, "retrack", {"media_id": m.id, "impact": body.impactTime, "time_is_impact": body.timeIsImpact,
                                     "ball": ball, "shot_id": body.shotId, "slowmo": body.slowmo}, user_id=user.id, project_id=p.id, media_id=m.id, max_attempts=1)
    db.commit()
    return jobs.public(j)
