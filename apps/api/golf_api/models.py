"""SQLAlchemy models. Changes need an Alembic migration (apps/api/alembic/versions)."""
from __future__ import annotations

import datetime as dt
import secrets

from sqlalchemy import JSON, BigInteger, Boolean, Float, ForeignKey, Index, Integer, String, Text
from sqlalchemy.orm import Mapped, mapped_column

from .db import Base, UTCDateTime, utcnow


def new_id(prefix: str) -> str:
    return f"{prefix}_{secrets.token_urlsafe(12).replace('-', 'x').replace('_', 'z')}"


class User(Base):
    """The single local user (see deps.local_user). There is no login; the row only exists so
    every project, file and export has an owner."""
    __tablename__ = "users"
    id: Mapped[str] = mapped_column(String(40), primary_key=True, default=lambda: new_id("usr"))
    locale: Mapped[str] = mapped_column(String(8), default="en")
    units: Mapped[str] = mapped_column(String(4), default="m")
    onboarding_done: Mapped[bool] = mapped_column(Boolean, default=False)
    created_at: Mapped[dt.datetime] = mapped_column(UTCDateTime(), default=utcnow)


class Project(Base):
    __tablename__ = "projects"
    id: Mapped[str] = mapped_column(String(40), primary_key=True, default=lambda: new_id("prj"))
    user_id: Mapped[str] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), index=True)
    name: Mapped[str] = mapped_column(String(120), default="")
    document: Mapped[dict] = mapped_column(JSON, default=dict)
    doc_version: Mapped[int] = mapped_column(Integer, default=0)
    # Shots found by analysis, merged into the document on load (worker never edits the document).
    analysis: Mapped[dict] = mapped_column(JSON, default=dict)
    poster_media_id: Mapped[str | None] = mapped_column(String(40))
    is_demo: Mapped[bool] = mapped_column(Boolean, default=False)
    created_at: Mapped[dt.datetime] = mapped_column(UTCDateTime(), default=utcnow)
    updated_at: Mapped[dt.datetime] = mapped_column(UTCDateTime(), default=utcnow)
    deleted_at: Mapped[dt.datetime | None] = mapped_column(UTCDateTime())


class ProjectVersion(Base):
    __tablename__ = "project_versions"
    id: Mapped[str] = mapped_column(String(40), primary_key=True, default=lambda: new_id("ver"))
    project_id: Mapped[str] = mapped_column(ForeignKey("projects.id", ondelete="CASCADE"), index=True)
    doc_version: Mapped[int] = mapped_column(Integer)
    document: Mapped[dict] = mapped_column(JSON)
    label: Mapped[str] = mapped_column(String(120), default="")
    auto: Mapped[bool] = mapped_column(Boolean, default=True)
    created_at: Mapped[dt.datetime] = mapped_column(UTCDateTime(), default=utcnow)


class Media(Base):
    __tablename__ = "media"
    id: Mapped[str] = mapped_column(String(40), primary_key=True, default=lambda: new_id("med"))
    user_id: Mapped[str] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), index=True)
    project_id: Mapped[str | None] = mapped_column(ForeignKey("projects.id", ondelete="SET NULL"), index=True)
    kind: Mapped[str] = mapped_column(String(16))                          # video | audio | image
    filename: Mapped[str] = mapped_column(String(255))
    size: Mapped[int] = mapped_column(BigInteger, default=0)
    storage_key: Mapped[str] = mapped_column(String(400))
    probe: Mapped[dict] = mapped_column(JSON, default=dict)
    derived: Mapped[dict] = mapped_column(JSON, default=dict)              # proxy, poster, thumbs, waveform keys
    status: Mapped[str] = mapped_column(String(16), default="processing")  # processing | ready | failed
    created_at: Mapped[dt.datetime] = mapped_column(UTCDateTime(), default=utcnow)


class Upload(Base):
    __tablename__ = "uploads"
    id: Mapped[str] = mapped_column(String(40), primary_key=True, default=lambda: new_id("upl"))
    user_id: Mapped[str] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), index=True)
    project_id: Mapped[str | None] = mapped_column(String(40))
    kind: Mapped[str] = mapped_column(String(16), default="video")
    filename: Mapped[str] = mapped_column(String(255))
    size: Mapped[int] = mapped_column(BigInteger)
    chunk_size: Mapped[int] = mapped_column(Integer)
    received: Mapped[list] = mapped_column(JSON, default=list)
    status: Mapped[str] = mapped_column(String(16), default="open")        # open | complete | failed
    media_id: Mapped[str | None] = mapped_column(String(40))
    created_at: Mapped[dt.datetime] = mapped_column(UTCDateTime(), default=utcnow)
    updated_at: Mapped[dt.datetime] = mapped_column(UTCDateTime(), default=utcnow, onupdate=utcnow)


class Job(Base):
    __tablename__ = "jobs"
    __table_args__ = (Index("ix_jobs_claim", "status", "kind", "run_after"),)
    id: Mapped[str] = mapped_column(String(40), primary_key=True, default=lambda: new_id("job"))
    kind: Mapped[str] = mapped_column(String(16))                          # ingest | analyze | retrack | export | compose
    status: Mapped[str] = mapped_column(String(16), default="queued")      # queued | running | awaiting_answers | succeeded | failed | canceled
    progress: Mapped[float] = mapped_column(Float, default=0.0)
    message: Mapped[str] = mapped_column(String(200), default="")
    payload: Mapped[dict] = mapped_column(JSON, default=dict)
    result: Mapped[dict] = mapped_column(JSON, default=dict)
    attempts: Mapped[int] = mapped_column(Integer, default=0)
    max_attempts: Mapped[int] = mapped_column(Integer, default=3)
    error: Mapped[str] = mapped_column(Text, default="")
    log: Mapped[str] = mapped_column(Text, default="")
    cancel_requested: Mapped[bool] = mapped_column(Boolean, default=False)
    user_id: Mapped[str | None] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), index=True)
    project_id: Mapped[str | None] = mapped_column(String(40), index=True)
    media_id: Mapped[str | None] = mapped_column(String(40), index=True)
    locked_by: Mapped[str | None] = mapped_column(String(80))
    # Set by each claim; only its holder may report on the job (see jobs.owns).
    lease: Mapped[str | None] = mapped_column(String(32))
    # Times its worker went quiet (app closed, PC asleep); unlike failures these keep the attempts.
    interruptions: Mapped[int] = mapped_column(Integer, default=0, server_default="0")
    heartbeat_at: Mapped[dt.datetime | None] = mapped_column(UTCDateTime())
    run_after: Mapped[dt.datetime] = mapped_column(UTCDateTime(), default=utcnow)
    started_at: Mapped[dt.datetime | None] = mapped_column(UTCDateTime())
    finished_at: Mapped[dt.datetime | None] = mapped_column(UTCDateTime())
    created_at: Mapped[dt.datetime] = mapped_column(UTCDateTime(), default=utcnow)
    updated_at: Mapped[dt.datetime] = mapped_column(UTCDateTime(), default=utcnow, index=True)


class Export(Base):
    __tablename__ = "exports"
    id: Mapped[str] = mapped_column(String(40), primary_key=True, default=lambda: new_id("exp"))
    user_id: Mapped[str] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), index=True)
    project_id: Mapped[str | None] = mapped_column(ForeignKey("projects.id", ondelete="SET NULL"), index=True)
    job_id: Mapped[str | None] = mapped_column(String(40))
    project_name: Mapped[str] = mapped_column(String(120), default="")
    settings: Mapped[dict] = mapped_column(JSON, default=dict)
    storage_key: Mapped[str | None] = mapped_column(String(400))
    size: Mapped[int] = mapped_column(BigInteger, default=0)
    width: Mapped[int] = mapped_column(Integer, default=0)
    height: Mapped[int] = mapped_column(Integer, default=0)
    duration: Mapped[float] = mapped_column(Float, default=0.0)
    status: Mapped[str] = mapped_column(String(16), default="queued")
    seen: Mapped[bool] = mapped_column(Boolean, default=False)
    created_at: Mapped[dt.datetime] = mapped_column(UTCDateTime(), default=utcnow)
    finished_at: Mapped[dt.datetime | None] = mapped_column(UTCDateTime())


class CustomStyle(Base):
    __tablename__ = "custom_styles"
    id: Mapped[str] = mapped_column(String(40), primary_key=True, default=lambda: new_id("sty"))
    user_id: Mapped[str] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), index=True)
    name: Mapped[str] = mapped_column(String(60))
    style: Mapped[dict] = mapped_column(JSON)
    created_at: Mapped[dt.datetime] = mapped_column(UTCDateTime(), default=utcnow)


class AiSettings(Base):
    """The AI model for "Make a video for me" (provider "server" = use the .env defaults).
    Kept apart from users so the key can never end up in public_user() or the data export."""
    __tablename__ = "ai_settings"
    user_id: Mapped[str] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), primary_key=True)
    provider: Mapped[str] = mapped_column(String(32), default="server")
    model: Mapped[str] = mapped_column(String(120), default="")
    base_url: Mapped[str] = mapped_column(String(300), default="")
    api_key: Mapped[str] = mapped_column(Text, default="")
    max_tokens: Mapped[int] = mapped_column(Integer, default=16000)
    # Still frames from the green may be sent when the putt count is unsure (off by default).
    vision: Mapped[bool] = mapped_column(Boolean, default=False, server_default="0")
    updated_at: Mapped[dt.datetime] = mapped_column(UTCDateTime(), default=utcnow)


class ChatGptAccount(Base):
    """"Sign in with ChatGPT": the registration (issued client id) and its tokens. Secrets like
    AiSettings.api_key: only the exporter gets a fresh access token, never a browser or an export.
    Signing out clears the tokens and keeps the registration for the next sign-in."""
    __tablename__ = "chatgpt_accounts"
    user_id: Mapped[str] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), primary_key=True)
    client_id: Mapped[str] = mapped_column(String(200), default="")
    subject: Mapped[str] = mapped_column(String(200), default="")
    email: Mapped[str] = mapped_column(String(320), default="")
    name: Mapped[str] = mapped_column(String(200), default="")
    access_token: Mapped[str] = mapped_column(Text, default="")
    refresh_token: Mapped[str] = mapped_column(Text, default="")
    expires_at: Mapped[dt.datetime | None] = mapped_column(UTCDateTime(), nullable=True)
    # Space separated, as granted by the token endpoint.
    scopes: Mapped[str] = mapped_column(Text, default="")
    # Why the tokens can't be used ("" = fine): "sign_in_again", "no_plan".
    problem: Mapped[str] = mapped_column(String(40), default="")
    updated_at: Mapped[dt.datetime] = mapped_column(UTCDateTime(), default=utcnow)
