"""Settings → Storage: how much each project takes (originals, previews, exports), the map
cache and the free space, and ways to make room. Previews (proxies) can be deleted because they
are made again when the project is opened; originals are only deleted with their project."""
from __future__ import annotations

import datetime as dt
import shutil
from pathlib import Path

from fastapi import APIRouter, Depends
from pydantic import BaseModel, Field
from sqlalchemy import select
from sqlalchemy.orm import Session

from .. import jobs
from ..config import settings
from ..db import get_db, utcnow, write_lock
from ..deps import current_user
from ..models import Export, Job, Media, Project, User
from ..storage import storage, tmp_dir

router = APIRouter(prefix="/storage", tags=["storage"])

PREVIEW = "proxy"


class ProjectsIn(BaseModel):
    projectIds: list[str] | None = Field(None, max_length=1000)
    # Or every project not edited for this many days.
    olderThanDays: int | None = Field(None, ge=0, le=3650)


def _size(p: Path) -> int:
    try:
        return p.stat().st_size if p.is_file() else 0
    except OSError:
        return 0


def _tree(p: Path) -> int:
    if not p.is_dir():
        return 0
    total = 0
    for f in p.rglob("*"):
        total += _size(f)
    return total


def _osm_dir() -> Path:
    return settings().data_dir / "cache" / "osm"


def _projects(db: Session, user: User, body: ProjectsIn) -> list[Project]:
    stmt = select(Project).where(Project.user_id == user.id, Project.deleted_at.is_(None))
    if body.projectIds is not None:
        stmt = stmt.where(Project.id.in_(body.projectIds))
    elif body.olderThanDays is not None:
        stmt = stmt.where(Project.updated_at < utcnow() - dt.timedelta(days=body.olderThanDays))
    else:
        return []
    return list(db.scalars(stmt).all())


@router.get("")
def overview(db: Session = Depends(get_db), user: User = Depends(current_user)):
    st = storage()
    seen: set[str] = set()      # duplicated projects share files: each is counted once
    rows = []
    projects = db.scalars(select(Project).where(Project.user_id == user.id, Project.deleted_at.is_(None))
                          .order_by(Project.updated_at.desc())).all()
    for p in projects:
        originals = previews = other = 0
        for m in db.scalars(select(Media).where(Media.project_id == p.id)).all():
            if m.storage_key and m.storage_key not in seen:
                seen.add(m.storage_key)
                originals += _size(st.local_path(m.storage_key))
            for variant, key in (m.derived or {}).items():
                if not isinstance(key, str) or key in seen:
                    continue
                seen.add(key)
                if variant == PREVIEW:
                    previews += _size(st.local_path(key))
                else:
                    other += _size(st.local_path(key))
        exports = sum(e.size or 0 for e in db.scalars(select(Export).where(Export.project_id == p.id, Export.status == "succeeded")).all())
        rows.append({"id": p.id, "name": p.name, "updatedAt": p.updated_at.isoformat(), "originals": originals,
                     "previews": previews + other, "proxies": previews, "exports": exports})
    loose = sum(e.size or 0 for e in db.scalars(select(Export).where(Export.user_id == user.id, Export.project_id.is_(None),
                                                                    Export.status == "succeeded")).all())
    usage = shutil.disk_usage(settings().data_dir)
    return {"projects": rows, "exportsWithoutProject": loose, "mapCache": _tree(_osm_dir()), "temp": _tree(tmp_dir()),
            "free": usage.free, "total": usage.total}


@router.post("/previews/delete")
def delete_previews(body: ProjectsIn, db: Session = Depends(get_db), user: User = Depends(current_user)):
    """Deletes the preview videos (made again when the project is opened). Projects with work
    under way are left alone."""
    st = storage()
    freed, done = 0, []
    write_lock(db)       # the worker writes media.derived when it makes a preview
    for p in _projects(db, user, body):
        busy = db.scalars(select(Job.id).where(Job.project_id == p.id, Job.status.in_(("queued", "running")),
                                               Job.kind.in_(("ingest", "analyze", "retrack", "export", "compose")))).first()
        if busy:
            continue
        for m in db.scalars(select(Media).where(Media.project_id == p.id, Media.kind == "video")).all():
            key = (m.derived or {}).get(PREVIEW)
            if not isinstance(key, str):
                continue
            freed += _size(st.local_path(key))
            st.delete(key)
            # Copies of the project point at the same file.
            for twin in db.scalars(select(Media).where(Media.storage_key == m.storage_key)).all():
                d = dict(twin.derived or {})
                if d.get(PREVIEW) == key:
                    d.pop(PREVIEW)
                    twin.derived = d
        done.append(p.id)
    db.commit()
    return {"projects": done, "freed": freed}


@router.post("/exports/delete")
def delete_exports(body: ProjectsIn, db: Session = Depends(get_db), user: User = Depends(current_user)):
    """Deletes finished exports (the videos under My videos) of the given projects."""
    freed, n = 0, 0
    ids = [p.id for p in _projects(db, user, body)]
    for e in db.scalars(select(Export).where(Export.user_id == user.id, Export.project_id.in_(ids),
                                             Export.status.in_(("succeeded", "failed", "canceled")))).all():
        if e.storage_key:
            freed += _size(storage().local_path(e.storage_key))
            storage().delete(e.storage_key)
        db.delete(e)
        n += 1
    db.commit()
    return {"deleted": n, "freed": freed}


@router.post("/map-cache/clear")
def clear_map_cache(_: User = Depends(current_user)):
    folder = _osm_dir()
    freed = _tree(folder)
    if folder.is_dir():
        shutil.rmtree(folder, ignore_errors=True)    # only a cache: anything left is fetched again
    return {"freed": freed}


def restore_previews(db: Session, p: Project) -> int:
    """Called when a project is opened: videos whose preview was deleted get it again (from a
    copy that still has one, or a new ingest). Returns how many ingests were queued."""
    queued = 0
    for m in db.scalars(select(Media).where(Media.project_id == p.id, Media.kind == "video", Media.status == "ready")).all():
        if (m.derived or {}).get(PREVIEW):
            continue
        twin = next((t for t in db.scalars(select(Media).where(Media.storage_key == m.storage_key, Media.id != m.id)).all()
                     if (t.derived or {}).get(PREVIEW) and storage().exists(t.derived[PREVIEW])), None)
        if twin is not None:
            m.derived = {**(m.derived or {}), PREVIEW: twin.derived[PREVIEW]}
            continue
        busy = db.scalars(select(Job.id).where(Job.media_id == m.id, Job.kind == "ingest", Job.status.in_(("queued", "running")))).first()
        if not busy and storage().exists(m.storage_key):
            jobs.enqueue(db, "ingest", {"media_id": m.id}, user_id=p.user_id, project_id=p.id, media_id=m.id)
            queued += 1
    return queued
