"""Settings → Performance: the profile the worker runs with, the hardware it sees, and
"Optimise" (a short benchmark job in the analysis lane, golf_worker/tuner.py)."""
from __future__ import annotations

import os
from dataclasses import asdict

from fastapi import APIRouter, Depends
from pydantic import BaseModel, Field
from sqlalchemy import select
from sqlalchemy.orm import Session

from .. import jobs as q
from .. import performance
from ..db import get_db
from ..deps import current_user
from ..errors import ApiError
from ..models import Job, User

router = APIRouter(prefix="/performance", tags=["performance"])


class ProfileIn(BaseModel):
    profile: str = Field(pattern="^(gentle|balanced|max|tuned)$")


def _public(refresh: bool = False) -> dict:
    hw = performance.hardware(refresh)
    perf, data = performance.effective(hw)
    tuned = data.get("tuned")
    return {
        "profile": data["profile"],
        "effective": asdict(perf),
        "profiles": {name: asdict(performance.for_profile(name, hw, tuned)) for name in performance.PROFILES if name != "tuned" or tuned},
        "tuned": {"summary": tuned.get("summary"), "at": tuned.get("at")} if tuned else None,
        "fallback": data.get("fallback"),
        "cpuOnly": bool(data.get("cpuOnly")),
        "decodeFailed": performance.decode_failures(data),
        "hardware": hw,
        "ingestFromEnv": "INGEST_PARALLEL" in os.environ,
    }


@router.get("")
def get_performance(refresh: bool = False, user: User = Depends(current_user)):
    return _public(refresh)


@router.put("")
def put_performance(body: ProfileIn, user: User = Depends(current_user)):
    try:
        performance.set_profile(body.profile)
    except LookupError:
        raise ApiError(422, "not_tuned", "Run Optimise first.") from None
    return _public()


@router.post("/optimize")
def optimize(db: Session = Depends(get_db), user: User = Depends(current_user)):
    """One benchmark at a time: a second click returns the one already queued or running."""
    running = db.scalars(select(Job).where(Job.kind == "tune", Job.status.in_(("queued", "running")))).first()
    if running:
        return q.public(running)
    job = q.enqueue(db, "tune", {}, user_id=user.id, max_attempts=1)
    job.message = "Waiting for the analysis queue"
    db.commit()
    return q.public(job)
