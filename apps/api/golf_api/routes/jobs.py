"""Job status for the UI and a Server-Sent Events stream with progress and analysis results."""
from __future__ import annotations

import asyncio
import datetime as dt
import json

from fastapi import APIRouter, Depends, Request
from fastapi.responses import StreamingResponse
from sqlalchemy import select
from sqlalchemy.orm import Session

from .. import jobs as q
from ..db import SessionLocal, get_db
from ..deps import current_user
from ..errors import not_found
from ..media_urls import export_url, public_media
from ..models import Export, Job, Media, Project, User

router = APIRouter(tags=["jobs"])


@router.get("/jobs")
def list_jobs(project_id: str | None = None, active: bool = False, db: Session = Depends(get_db), user: User = Depends(current_user)):
    stmt = select(Job).where(Job.user_id == user.id)
    if project_id:
        stmt = stmt.where(Job.project_id == project_id)
    if active:
        stmt = stmt.where(Job.status.in_(("queued", "running", q.AWAITING)))
    rows = db.scalars(stmt.order_by(Job.created_at.desc()).limit(100)).all()
    return {"jobs": [q.public(j) for j in rows]}


@router.post("/jobs/{job_id}/cancel")
def cancel_job(job_id: str, db: Session = Depends(get_db), user: User = Depends(current_user)):
    j = db.get(Job, job_id)
    if j is None or j.user_id != user.id:
        raise not_found("Jobbet")
    q.cancel(db, j)
    if j.kind == "export":
        e = db.scalars(select(Export).where(Export.job_id == j.id)).first()
        if e and j.status == "canceled":
            e.status = "canceled"
    db.commit()
    return q.public(j)


def _snapshot(user_id: str, project_id: str | None, since: dt.datetime | None) -> tuple[list[dict], dt.datetime | None]:
    """Jobs (and their side effects) for this user changed after `since`."""
    with SessionLocal() as db:
        stmt = select(Job).where(Job.user_id == user_id)
        if project_id:
            stmt = stmt.where((Job.project_id == project_id) | (Job.kind == "export"))
        if since is not None:
            stmt = stmt.where(Job.updated_at > since)
        rows = db.scalars(stmt.order_by(Job.updated_at).limit(50)).all()
        events = []
        newest = since
        for j in rows:
            ev = {"type": "job", "job": q.public(j)}
            if j.status == "succeeded" and j.kind in ("analyze", "ingest", "retrack") and j.project_id:
                p = db.get(Project, j.project_id)
                m = db.get(Media, j.media_id) if j.media_id else None
                if m:
                    ev["media"] = public_media(m)
                if p and j.kind == "analyze" and m:
                    res = (p.analysis or {}).get(m.id, {})
                    ev["shots"] = res.get("shots", [])
                    if res.get("place"):
                        ev["place"] = {"mediaId": m.id, **res["place"]}
            if j.kind == "export" and j.status == "succeeded":
                e = db.scalars(select(Export).where(Export.job_id == j.id)).first()
                if e:
                    ev["export"] = {"id": e.id, "url": export_url(e), "projectName": e.project_name}
            if j.kind == "analyze" and j.status == "running" and j.project_id and j.media_id:
                p = db.get(Project, j.project_id)
                if p:
                    ev["shots"] = (p.analysis or {}).get(j.media_id, {}).get("shots", [])
            events.append(ev)
            newest = j.updated_at if newest is None else max(newest, j.updated_at)
        return events, newest


@router.get("/events")
async def events(request: Request, project_id: str | None = None, user: User = Depends(current_user)):
    user_id = user.id

    async def stream():
        since: dt.datetime | None = None
        # Start with the current state of active jobs, then follow changes.
        with SessionLocal() as db:
            stmt = select(Job).where(Job.user_id == user_id, Job.status.in_(("queued", "running", q.AWAITING)))
            if project_id:
                stmt = stmt.where(Job.project_id == project_id)
            for j in db.scalars(stmt).all():
                yield f"event: job\ndata: {json.dumps({'type': 'job', 'job': q.public(j)})}\n\n"
            latest = db.scalars(select(Job.updated_at).where(Job.user_id == user_id).order_by(Job.updated_at.desc()).limit(1)).first()
            since = latest
        yield "retry: 3000\n\n"
        ticks = 0
        while not await request.is_disconnected():
            evs, since = await asyncio.to_thread(_snapshot, user_id, project_id, since)
            for ev in evs:
                yield f"event: {ev['type']}\ndata: {json.dumps(ev, default=str)}\n\n"
            ticks += 1
            if ticks % 30 == 0:
                yield ": keep-alive\n\n"
            await asyncio.sleep(0.5)

    return StreamingResponse(stream(), media_type="text/event-stream",
                             headers={"Cache-Control": "no-cache, no-transform", "X-Accel-Buffering": "no", "Connection": "keep-alive"})
