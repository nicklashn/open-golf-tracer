"""Housekeeping: requeue jobs whose worker died, remove stale temp files, old uploads, files
that could not be deleted earlier and expired map data."""
from __future__ import annotations

import datetime as dt
import logging
import time

from sqlalchemy import select

from . import jobs
from .db import session_scope, utcnow
from .models import Export, Job, Upload
from .storage import sweep_pending, tmp_dir

log = logging.getLogger("golf.maintenance")

UPLOAD_TTL = dt.timedelta(hours=48)
TMP_TTL = 24 * 3600


def run_once() -> dict:
    with session_scope() as db:
        requeued = jobs.requeue_stale(db)
        cutoff = utcnow() - UPLOAD_TTL
        old = db.scalars(select(Upload).where(Upload.status == "open", Upload.updated_at < cutoff)).all()
        for up in old:
            up.status = "failed"
            for ext in (".part", ".json"):
                (tmp_dir() / "uploads" / f"{up.id}{ext}").unlink(missing_ok=True)
        open_ids = set(db.scalars(select(Upload.id).where(Upload.status == "open")).all())
        # Exports left "running" by versions before the queue kept them in step with their job.
        stuck = db.execute(select(Export, Job.status).join(Job, Job.id == Export.job_id)
                           .where(Export.status.in_(("queued", "running")), Job.status.in_(("failed", "canceled")))).all()
        for e, status in stuck:
            e.status, e.finished_at = status, e.finished_at or utcnow()
    removed = 0
    now = time.time()
    for f in tmp_dir().rglob("*"):
        try:
            if not f.is_file():
                continue
            if f.parent.name == "uploads":
                # An upload's part file lives as long as the upload is open; orphans (a crash
                # between creating the file and the row, an older version) go by age.
                if f.name.split(".", 1)[0] in open_ids or now - f.stat().st_mtime < UPLOAD_TTL.total_seconds():
                    continue
            elif now - f.stat().st_mtime <= TMP_TTL:
                continue
            f.unlink(missing_ok=True)
            removed += 1
        except OSError:      # in use (Windows) or gone meanwhile: next time
            continue
    swept = sweep_pending()
    try:
        from .routes.geo import prune_cache

        pruned = prune_cache()
    except Exception as exc:  # noqa: BLE001 - map data is a convenience
        log.debug("map cache: %s", exc)
        pruned = 0
    if requeued or old or removed or swept or stuck or pruned:
        log.info("maintenance: %d jobs restarted, %d uploads expired, %d temp files deleted, %d late deletes, %d exports settled, "
                 "%d map files pruned", requeued, len(old), removed, swept, len(stuck), pruned)
    return {"requeued": requeued, "expired_uploads": len(old), "tmp_removed": removed, "late_deletes": swept, "exports_settled": len(stuck),
            "osm_pruned": pruned}
