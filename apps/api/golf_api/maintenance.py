"""Housekeeping: requeue jobs whose worker died, remove stale temp files and old uploads."""
from __future__ import annotations

import datetime as dt
import logging
import time

from sqlalchemy import select

from . import jobs
from .db import session_scope, utcnow
from .models import Upload
from .storage import tmp_dir

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
            (tmp_dir() / "uploads" / f"{up.id}.part").unlink(missing_ok=True)
    removed = 0
    now = time.time()
    for f in tmp_dir().rglob("*"):
        if f.is_file() and now - f.stat().st_mtime > TMP_TTL and f.parent.name != "uploads":
            f.unlink(missing_ok=True)
            removed += 1
    if requeued or old or removed:
        log.info("maintenance: %d jobs restarted, %d uploads expired, %d temp files deleted", requeued, len(old), removed)
    return {"requeued": requeued, "expired_uploads": len(old), "tmp_removed": removed}
