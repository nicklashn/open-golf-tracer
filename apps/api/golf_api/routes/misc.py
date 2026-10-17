"""Health and public config."""
from __future__ import annotations

import shutil

from fastapi import APIRouter, Depends
from sqlalchemy import text
from sqlalchemy.orm import Session

from ..config import app_version, settings
from ..db import get_db

router = APIRouter(tags=["misc"])


@router.get("/health")
def health(db: Session = Depends(get_db)):
    db.execute(text("SELECT 1"))
    # app/version let the launcher tell this app apart from anything else on the port.
    return {"status": "ok", "app": "open-golf-tracer", "version": app_version(), "ffmpeg": bool(shutil.which("ffmpeg")), "ffprobe": bool(shutil.which("ffprobe")),
            "env": settings().env}


@router.get("/config/public")
def public_config():
    return {"chunkSize": settings().upload_chunk_bytes}
