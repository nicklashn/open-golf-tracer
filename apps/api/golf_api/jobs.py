"""Database-backed job queue (no Redis needed locally): claim with an atomic conditional
UPDATE, heartbeats, retries with backoff, cancellation, logs and recovery after restarts."""
from __future__ import annotations

import datetime as dt
import logging
from typing import Any

from sqlalchemy import or_, select, update
from sqlalchemy.orm import Session

from .db import session_scope, utcnow
from .models import Job

log = logging.getLogger("golf.jobs")

STALE_AFTER = dt.timedelta(seconds=90)
# A job parked until the user answers questions (the "compose" job of "Make a video for me").
AWAITING = "awaiting_answers"
LOG_LIMIT = 60_000


def enqueue(db: Session, kind: str, payload: dict[str, Any] | None = None, *, user_id: str | None = None,
            project_id: str | None = None, media_id: str | None = None, max_attempts: int = 3) -> Job:
    job = Job(kind=kind, payload=payload or {}, user_id=user_id, project_id=project_id, media_id=media_id,
              max_attempts=max_attempts, message="Queued")
    db.add(job)
    db.flush()
    return job


def claim(db: Session, kinds: list[str], worker: str) -> Job | None:
    now = utcnow()
    ids = db.scalars(select(Job.id).where(Job.status == "queued", Job.kind.in_(kinds), Job.run_after <= now)
                     .order_by(Job.created_at).limit(5)).all()
    for jid in ids:
        res = db.execute(update(Job).where(Job.id == jid, Job.status == "queued").values(
            status="running", locked_by=worker, attempts=Job.attempts + 1, started_at=now, heartbeat_at=now,
            updated_at=now, message="Starter"))
        if res.rowcount == 1:  # type: ignore[attr-defined]
            db.commit()
            return db.get(Job, jid)
    db.commit()
    return None


def heartbeat(job_id: str, progress: float | None = None, message: str | None = None) -> bool:
    """Updates progress; returns False when the job was canceled (the worker should stop)."""
    with session_scope() as db:
        job = db.get(Job, job_id)
        if job is None:
            return False
        job.heartbeat_at = job.updated_at = utcnow()
        if progress is not None:
            job.progress = max(0.0, min(1.0, float(progress)))
        if message is not None:
            job.message = message[:200]
        return not job.cancel_requested and job.status == "running"


def append_log(job_id: str, text: str) -> None:
    with session_scope() as db:
        job = db.get(Job, job_id)
        if job is not None:
            job.log = (job.log + text)[-LOG_LIMIT:]


def complete(db: Session, job: Job, result: dict[str, Any] | None = None) -> None:
    job.status = "succeeded"
    job.progress = 1.0
    job.message = "Done"
    job.result = result or {}
    job.finished_at = job.updated_at = utcnow()


def fail(db: Session, job: Job, error: str, retry: bool = True) -> None:
    job.error = error[-4000:]
    job.updated_at = utcnow()
    if job.cancel_requested:
        job.status, job.message, job.finished_at = "canceled", "Annulleret", utcnow()
    elif retry and job.attempts < job.max_attempts:
        job.status = "queued"
        job.message = "Retrying"
        job.run_after = utcnow() + dt.timedelta(seconds=10 * 2 ** max(0, job.attempts - 1))
    else:
        job.status, job.message, job.finished_at = "failed", "Fejlede", utcnow()


def await_answers(db: Session, job: Job, result: dict[str, Any], message: str = "Waiting for answers") -> None:
    """Parks a job until the user answers its questions (see `answer`); no worker holds it meanwhile."""
    job.status = AWAITING
    job.result = result
    job.message = message[:200]
    job.locked_by = None
    job.updated_at = utcnow()


def answer(db: Session, job: Job, payload: dict[str, Any]) -> None:
    """Back in the queue with the answers merged into its payload."""
    job.payload = {**(job.payload or {}), **payload}
    job.status = "queued"
    job.result = {}
    job.message = "Queued"
    job.attempts = max(0, job.attempts - 1)  # waiting for the user is not a failed attempt
    job.run_after = job.updated_at = utcnow()


def defer(db: Session, job: Job, seconds: float, message: str) -> None:
    """Back in the queue to run again later (e.g. a video waits for analysis); not counted as an attempt."""
    job.status = "queued"
    job.message = message[:200]
    job.locked_by = None
    job.attempts = max(0, job.attempts - 1)
    job.run_after = utcnow() + dt.timedelta(seconds=max(1.0, min(600.0, seconds)))
    job.updated_at = utcnow()


def cancel(db: Session, job: Job) -> None:
    if job.status in ("queued", AWAITING):
        job.status, job.message, job.finished_at = "canceled", "Annulleret", utcnow()
    elif job.status == "running":
        job.cancel_requested = True
        job.message = "Annullerer"
    job.updated_at = utcnow()


def requeue_stale(db: Session) -> int:
    """Jobs whose worker died (no heartbeat) go back to the queue; called on startup and periodically."""
    cutoff = utcnow() - STALE_AFTER
    stale = db.scalars(select(Job).where(Job.status == "running", or_(Job.heartbeat_at.is_(None), Job.heartbeat_at < cutoff))).all()
    for job in stale:
        log.warning("job %s (%s) lost its worker – queued again", job.id, job.kind)
        fail(db, job, "Workeren stoppede uventet.", retry=True)
    return len(stale)


def public(job: Job) -> dict[str, Any]:
    return {"id": job.id, "kind": job.kind, "status": job.status, "progress": round(job.progress, 4), "message": job.message,
            "projectId": job.project_id, "mediaId": job.media_id, "error": job.error[-500:] if job.status == "failed" else "",
            "result": job.result if job.status in ("succeeded", AWAITING) else {}, "attempts": job.attempts,
            "createdAt": job.created_at.isoformat(), "updatedAt": job.updated_at.isoformat()}
