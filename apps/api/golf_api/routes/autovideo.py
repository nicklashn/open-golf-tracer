"""Make a video for me: starts the `compose` job for a project and takes the user's answers
when it stops to ask. The work itself (summary, plan, compose) runs in the Node exporter."""
from __future__ import annotations

from fastapi import APIRouter, Depends
from pydantic import BaseModel, Field, field_validator
from sqlalchemy.orm import Session

from .. import ai
from .. import jobs as q
from ..db import get_db, utcnow
from ..deps import current_user
from ..errors import ApiError, not_found
from ..models import AiSettings, Job, User
from .projects import _project_media, get_project

router = APIRouter(tags=["autovideo"])

KINDS = ("youtube", "highlight", "shorts")
# Up to 12 questions plus a keep/drop choice per shot ("shot:<id>") shown on the question cards.
MAX_ANSWERS = 250


def _short_map(v: dict[str, str] | None, limit: int, max_len: int) -> dict[str, str] | None:
    if v is None:
        return None
    if len(v) > limit:
        raise ValueError("too many entries")
    return {str(k)[:80]: str(x)[:max_len] for k, x in v.items()}


class AutoVideoIn(BaseModel):
    projectId: str = Field(max_length=40)
    preference: str = Field("", max_length=1000)
    locale: str = Field("en", pattern="^(da|en)$")
    # Layer names as the user's layer panel shows them, so generated layers read the same.
    names: dict[str, str] = {}
    # Only these clips (media ids); empty = all clips of the project.
    mediaIds: list[str] = Field(default_factory=list, max_length=200)
    # Answer every question with its default instead of stopping to ask.
    yes: bool = False
    answers: dict[str, str] | None = None

    @field_validator("names")
    @classmethod
    def _names(cls, v: dict[str, str]) -> dict[str, str]:
        return _short_map(v, 40, 60) or {}

    @field_validator("answers")
    @classmethod
    def _answers(cls, v: dict[str, str] | None) -> dict[str, str] | None:
        return _short_map(v, MAX_ANSWERS, 80)


class AnswersIn(BaseModel):
    answers: dict[str, str] = {}

    @field_validator("answers")
    @classmethod
    def _answers(cls, v: dict[str, str]) -> dict[str, str]:
        return _short_map(v, MAX_ANSWERS, 80) or {}


@router.post("/autovideo")
def start(body: AutoVideoIn, db: Session = Depends(get_db), user: User = Depends(current_user)):
    p = get_project(db, user, body.projectId)
    media = {m.id for m in _project_media(db, p)}
    unknown = [m for m in body.mediaIds if m not in media]
    if unknown:
        raise ApiError(422, "unknown_media", "Some of the chosen clips are not in this project.")
    payload = {
        "project_id": p.id,
        "preference": body.preference.strip(),
        "locale": body.locale,
        "names": body.names,
        "media_ids": body.mediaIds,
        "yes": body.yes,
        "answers": body.answers,
    }
    job = q.enqueue(db, "compose", payload, user_id=user.id, project_id=p.id, max_attempts=2)
    db.commit()
    return q.public(job)


@router.post("/jobs/{job_id}/answers")
def answer(job_id: str, body: AnswersIn, db: Session = Depends(get_db), user: User = Depends(current_user)):
    j = db.get(Job, job_id)
    if j is None or j.user_id != user.id or j.kind != "compose":
        raise not_found("The job")
    if j.status != q.AWAITING:
        raise ApiError(409, "not_waiting", "This video is not waiting for answers.")
    # The plan the questions came from goes along, so it is not made (or paid for) twice, and so
    # do the tokens the first AI call used (the ceiling is per video).
    # Answers the AI found itself from still frames (putts) go along too.
    r = j.result or {}
    q.answer(db, j, {"answers": body.answers, "plan": r.get("plan"), "usage": r.get("usage"), "vision": r.get("vision")})
    db.commit()
    return q.public(j)


# --- AI settings ------------------------------------------------------------------------------


class AiSettingsIn(BaseModel):
    provider: str = Field(pattern="^(server|none|ollama|openai-compatible|anthropic)$")
    model: str = Field("", max_length=120)
    baseUrl: str = Field("", max_length=300, pattern=r"^(|https?://\S+)$")
    # None keeps the stored key, "" removes it.
    apiKey: str | None = Field(None, max_length=400)
    maxTokens: int = Field(8000, ge=500, le=200_000)
    # Still frames from the green when the putt count is unsure; None keeps the stored choice.
    vision: bool | None = None


@router.get("/ai/settings")
def get_ai_settings(db: Session = Depends(get_db), user: User = Depends(current_user)):
    return ai.public(db, user)


@router.put("/ai/settings")
def put_ai_settings(body: AiSettingsIn, db: Session = Depends(get_db), user: User = Depends(current_user)):
    row = db.get(AiSettings, user.id)
    if row is None:
        row = AiSettings(user_id=user.id, api_key="", vision=ai.effective(db, user.id)["vision"])
        db.add(row)
    row.provider, row.model, row.base_url, row.max_tokens = body.provider, body.model.strip(), body.baseUrl.strip(), body.maxTokens
    if body.apiKey is not None:
        row.api_key = body.apiKey.strip()
    if body.vision is not None:
        row.vision = body.vision
    row.updated_at = utcnow()
    db.commit()
    return ai.public(db, user)


@router.post("/ai/test")
def test_ai(db: Session = Depends(get_db), user: User = Depends(current_user)):
    """A minimal call with the user's AI settings, run by the exporter (which has the adapters)."""
    if ai.effective(db, user.id)["provider"] == "none":
        raise ApiError(422, "ai_off", "No AI provider is chosen.")
    job = q.enqueue(db, "ai_test", {}, user_id=user.id, max_attempts=1)
    db.commit()
    return q.public(job)
