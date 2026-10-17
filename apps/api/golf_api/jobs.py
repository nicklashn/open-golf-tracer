"""Database-backed job queue (no Redis needed locally): claim with an atomic conditional
UPDATE, heartbeats, retries with backoff, cancellation, logs and recovery after restarts.

Every claim gets a lease id. Heartbeats, completion and failure only count when they carry the
job's current lease: a worker that was asleep (the PC slept) while its job was queued again
learns that it lost the job and stops without writing anything – a lost lease is not a cancel."""
from __future__ import annotations

import datetime as dt
import logging
import secrets
from typing import Any

from sqlalchemy import or_, select, update
from sqlalchemy.orm import Session

from .db import session_scope, utcnow
from .models import Export, Job

log = logging.getLogger("golf.jobs")

STALE_AFTER = dt.timedelta(seconds=90)
# A job queued again for a missing heartbeat waits this long before another worker may take it:
# its own worker may just have been asleep and takes it back with its next heartbeat.
REQUEUE_GRACE = dt.timedelta(seconds=45)
# Lost workers (app closed, PC off) don't use up attempts; this many in a row do fail the job
# (one that takes its worker down with it every time).
MAX_INTERRUPTIONS = 8
# What a heartbeat tells the worker.
OK, CANCELED, LOST = "ok", "canceled", "lost"
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
            status="running", locked_by=worker, lease=secrets.token_hex(8), attempts=Job.attempts + 1, started_at=now,
            heartbeat_at=now, updated_at=now, message="Starter"))
        if res.rowcount == 1:  # type: ignore[attr-defined]
            db.commit()
            return db.get(Job, jid)
    db.commit()
    return None


def owns(job: Job, lease: str | None) -> bool:
    """Whether the holder of `lease` still has the job. None: a caller from before leases."""
    if lease is None:
        return True
    # Queued with the same lease: queued again while its worker slept, and nobody took it since.
    return job.lease == lease and job.status in ("running", "queued")


def beat(job_id: str, lease: str | None, progress: float | None = None, message: str | None = None) -> str:
    """Heartbeat with progress: OK, CANCELED (the user cancelled: stop and report it) or LOST (the
    job was given to another worker or is gone: stop quietly, write nothing)."""
    with session_scope() as db:
        job = db.get(Job, job_id)
        if job is None or not owns(job, lease):
            return LOST
        if lease is not None and job.status == "queued":
            # Its worker is back (the PC woke up) before anyone else took the job: carry on.
            log.info("job %s (%s) taken back by its worker", job.id, job.kind)
            job.status, job.attempts, job.interruptions = "running", job.attempts + 1, max(0, job.interruptions - 1)
            sync_export(db, job)
        job.heartbeat_at = job.updated_at = utcnow()
        if progress is not None:
            job.progress = max(0.0, min(1.0, float(progress)))
        if message is not None:
            job.message = message[:200]
        return OK if not job.cancel_requested and job.status == "running" else CANCELED


def heartbeat(job_id: str, progress: float | None = None, message: str | None = None, lease: str | None = None) -> bool:
    """Updates progress; returns False when the worker should stop (canceled or lost)."""
    return beat(job_id, lease, progress, message) == OK


def append_log(job_id: str, text: str) -> None:
    with session_scope() as db:
        job = db.get(Job, job_id)
        if job is not None:
            job.log = (job.log + text)[-LOG_LIMIT:]


def complete(db: Session, job: Job, result: dict[str, Any] | None = None, lease: str | None = None) -> bool:
    """False (and nothing written) when the lease was lost."""
    if not owns(job, lease):
        return False
    job.status = "succeeded"
    job.progress = 1.0
    job.message = "Done"
    job.result = result or {}
    job.finished_at = job.updated_at = utcnow()
    job.interruptions = 0
    return True


def fail(db: Session, job: Job, error: str, retry: bool = True, lease: str | None = None) -> bool:
    """False (and nothing written) when the lease was lost."""
    if not owns(job, lease):
        return False
    job.error = error[-4000:]
    job.updated_at = utcnow()
    if job.cancel_requested:
        job.status, job.message, job.finished_at = "canceled", "Annulleret", utcnow()
    elif retry and job.attempts < job.max_attempts:
        job.status = "queued"
        job.message = "Retrying"
        job.lease = None
        job.run_after = utcnow() + dt.timedelta(seconds=10 * 2 ** max(0, job.attempts - 1))
    else:
        job.status, job.message, job.finished_at = "failed", "Fejlede", utcnow()
    sync_export(db, job)
    return True


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
    job.lease = None
    job.result = {}
    job.message = "Queued"
    job.attempts = max(0, job.attempts - 1)  # waiting for the user is not a failed attempt
    job.run_after = job.updated_at = utcnow()


def defer(db: Session, job: Job, seconds: float, message: str) -> None:
    """Back in the queue to run again later (e.g. a video waits for analysis); not counted as an attempt."""
    job.status = "queued"
    job.message = message[:200]
    job.locked_by = job.lease = None
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


def requeue_stale(db: Session, grace: dt.timedelta = REQUEUE_GRACE) -> int:
    """Jobs whose worker went quiet (no heartbeat: it died, or the PC slept) go back to the queue;
    called on startup and periodically. The lease is kept, so a worker that only slept can take
    its job back within `grace` (see beat); a lost worker does not count as a failed attempt."""
    now = utcnow()
    cutoff = now - STALE_AFTER
    stale = db.scalars(select(Job).where(Job.status == "running", or_(Job.heartbeat_at.is_(None), Job.heartbeat_at < cutoff))).all()
    for job in stale:
        job.interruptions += 1
        job.error = "Workeren stoppede uventet."
        job.updated_at = now
        if job.cancel_requested:
            job.status, job.message, job.finished_at = "canceled", "Annulleret", now
        elif job.interruptions > MAX_INTERRUPTIONS:
            log.warning("job %s (%s) lost its worker %d times – failed", job.id, job.kind, job.interruptions)
            job.status, job.message, job.finished_at = "failed", "Fejlede", now
        else:
            log.warning("job %s (%s) lost its worker – queued again", job.id, job.kind)
            job.status, job.message = "queued", "Retrying"
            job.attempts = max(0, job.attempts - 1)
            job.run_after = now + grace
        sync_export(db, job)
    return len(stale)


def sync_export(db: Session, job: Job) -> None:
    """An export's row follows its job when the job is queued again, fails or is cancelled
    (the exporter only reports start and success itself)."""
    if job.kind != "export" or job.status not in ("queued", "running", "failed", "canceled"):
        return
    e = db.scalars(select(Export).where(Export.job_id == job.id)).first()
    if e is None or e.status == "succeeded":
        return
    if job.status in ("failed", "canceled"):
        e.status, e.finished_at = job.status, e.finished_at or utcnow()
    elif job.status == "queued" and e.status == "running":
        e.status = "queued"


def public(job: Job) -> dict[str, Any]:
    return {"id": job.id, "kind": job.kind, "status": job.status, "progress": round(job.progress, 4), "message": job.message,
            "projectId": job.project_id, "mediaId": job.media_id, "error": job.error[-500:] if job.status == "failed" else "",
            # Stable codes the web app translates (space.DISK_FULL).
            "errorCode": "disk_full" if job.status == "failed" and "[disk_full]" in (job.error or "") else "",
            "result": job.result if job.status in ("succeeded", AWAITING) else {}, "attempts": job.attempts,
            "createdAt": job.created_at.isoformat(), "updatedAt": job.updated_at.isoformat()}
