"""Endpoints for workers (the Node exporter): claim jobs, report progress, read inputs,
store results. Authenticated with INTERNAL_TOKEN, never exposed to browsers (the web
proxy blocks /api/internal)."""
from __future__ import annotations

from fastapi import APIRouter, Depends
from pydantic import BaseModel, Field
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from .. import jobs as q
from ..db import get_db, utcnow
from ..deps import internal_auth
from ..documents import merged_document, validate_document
from ..errors import ApiError, not_found
from ..models import Export, Job, Media, Project, User
from ..storage import storage, user_prefix

router = APIRouter(prefix="/internal", tags=["internal"], dependencies=[Depends(internal_auth)])


class ClaimIn(BaseModel):
    kinds: list[str]
    worker: str = Field(max_length=80)


class ProgressIn(BaseModel):
    # The lease from the claim (exporters from before leases send none).
    lease: str | None = Field(None, max_length=32)
    progress: float | None = None
    message: str | None = Field(None, max_length=200)
    log: str | None = None


class CompleteIn(BaseModel):
    lease: str | None = Field(None, max_length=32)
    result: dict = {}


class FailIn(BaseModel):
    lease: str | None = Field(None, max_length=32)
    error: str
    retry: bool = True


class DeferIn(BaseModel):
    lease: str | None = Field(None, max_length=32)
    seconds: float = 5
    message: str = Field("Waiting", max_length=200)


class AwaitIn(BaseModel):
    lease: str | None = Field(None, max_length=32)
    result: dict = {}
    message: str = Field("Waiting for answers", max_length=200)


class DeriveIn(BaseModel):
    name: str = Field(max_length=120)
    document: dict


class ExportDoneIn(BaseModel):
    width: int
    height: int
    duration: float


@router.post("/jobs/claim")
def claim(body: ClaimIn, db: Session = Depends(get_db)):
    j = q.claim(db, body.kinds, body.worker)
    if j is None:
        return {"job": None}
    return {"job": {**q.public(j), "payload": j.payload, "userId": j.user_id, "lease": j.lease}}


@router.post("/jobs/{job_id}/progress")
def progress(job_id: str, body: ProgressIn):
    """continue=False: stop. lost=True as well: the job is not this worker's any more – stop
    without reporting a failure (it was queued again while the worker was away)."""
    state = q.beat(job_id, body.lease, body.progress, body.message)
    if body.log and state != q.LOST:
        q.append_log(job_id, body.log)
    return {"continue": state == q.OK, "lost": state == q.LOST}


@router.post("/jobs/{job_id}/complete")
def complete(job_id: str, body: CompleteIn, db: Session = Depends(get_db)):
    j = db.get(Job, job_id)
    if j is None:
        raise not_found("Jobbet")
    if not q.complete(db, j, body.result, body.lease):
        return {"ok": False, "lost": True}
    db.commit()
    return {"ok": True}


@router.post("/jobs/{job_id}/fail")
def fail(job_id: str, body: FailIn, db: Session = Depends(get_db)):
    j = db.get(Job, job_id)
    if j is None:
        raise not_found("Jobbet")
    error, retry = body.error, body.retry
    if any(x in error for x in ("No space left on device", "ENOSPC", "[disk_full]")):
        # A full disk stays full until the user makes room: no retry, and a message they can act on.
        error, retry = (error if "[disk_full]" in error else f"[disk_full] The disk is full. {error}"), False
    if not q.fail(db, j, error, retry, body.lease):
        return {"status": "lost"}
    db.commit()
    return {"status": j.status}


def _job(db: Session, job_id: str) -> Job:
    j = db.get(Job, job_id)
    if j is None:
        raise not_found("The job")
    return j


@router.post("/jobs/{job_id}/defer")
def defer(job_id: str, body: DeferIn, db: Session = Depends(get_db)):
    j = _job(db, job_id)
    if not q.owns(j, body.lease):
        return {"status": "lost"}
    q.defer(db, j, body.seconds, body.message)
    db.commit()
    return {"status": j.status}


@router.post("/jobs/{job_id}/await")
def await_answers(job_id: str, body: AwaitIn, db: Session = Depends(get_db)):
    j = _job(db, job_id)
    if not q.owns(j, body.lease):
        return {"status": "lost"}
    q.await_answers(db, j, body.result, body.message)
    db.commit()
    return {"status": j.status}


@router.get("/jobs/{job_id}/project")
def job_project(job_id: str, db: Session = Depends(get_db)):
    """The job's project as the editor would load it, and how many of its media jobs
    (ingest, analysis) are still running – a video waits for those."""
    j = _job(db, job_id)
    p = db.get(Project, j.project_id) if j.project_id else None
    if p is None or p.user_id != j.user_id or p.deleted_at is not None:
        raise not_found("The project")
    pending = db.scalar(select(func.count()).select_from(Job).where(
        Job.project_id == p.id, Job.kind.in_(("ingest", "analyze", "retrack")), Job.status.in_(("queued", "running")))) or 0
    return {"id": p.id, "name": p.name, "document": merged_document(p), "pending": int(pending)}


@router.get("/jobs/{job_id}/ai")
def job_ai(job_id: str, db: Session = Depends(get_db)):
    """The AI model the job's user has chosen, key included (workers only)."""
    from .. import ai

    return ai.for_job(db, _job(db, job_id).user_id)


@router.post("/jobs/{job_id}/derive")
def derive(job_id: str, body: DeriveIn, db: Session = Depends(get_db)):
    """Saves a generated video as a new project of the job's user, next to the job's project."""
    from .projects import copy_project

    j = _job(db, job_id)
    p = db.get(Project, j.project_id) if j.project_id else None
    user = db.get(User, j.user_id) if j.user_id else None
    if p is None or user is None or p.user_id != user.id:
        raise not_found("The project")
    doc = validate_document(body.document)
    new = copy_project(db, user, p, doc, body.name)
    db.commit()
    return {"id": new.id, "name": new.name}


@router.get("/media/{media_id}")
def media_path(media_id: str, db: Session = Depends(get_db)):
    m = db.get(Media, media_id)
    if m is None:
        raise not_found("The file")
    st = storage()
    derived = {k: str(st.local_path(v)) for k, v in (m.derived or {}).items() if isinstance(v, str) and k != "thumbs_info"}
    return {"id": m.id, "kind": m.kind, "path": str(st.local_path(m.storage_key)), "probe": m.probe, "derived": derived}


@router.post("/exports/{export_id}/start")
def export_start(export_id: str, db: Session = Depends(get_db)):
    e = db.get(Export, export_id)
    if e is None:
        raise not_found("Eksporten")
    if e.status != "canceled":
        e.status = "running"
    e.storage_key = f"{user_prefix(e.user_id)}/exports/{e.id}.mp4"
    path = storage().local_path(e.storage_key)
    path.parent.mkdir(parents=True, exist_ok=True)
    db.commit()
    return {"path": str(path)}


@router.post("/exports/{export_id}/done")
def export_done(export_id: str, body: ExportDoneIn, db: Session = Depends(get_db)):
    e = db.get(Export, export_id)
    if e is None or not e.storage_key:
        raise not_found("Eksporten")
    if not storage().exists(e.storage_key):
        raise ApiError(409, "missing_output", "The export file was not found.")
    e.size = storage().size(e.storage_key)
    e.width, e.height, e.duration = body.width, body.height, body.duration
    e.status, e.finished_at = "succeeded", utcnow()
    db.commit()
    return {"ok": True, "size": e.size}
