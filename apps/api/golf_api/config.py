"""Settings from environment variables / `.env` (see `.env.example`). Secrets live only there."""
from __future__ import annotations

import functools
import json
import secrets
from pathlib import Path

from pydantic import Field
from pydantic_settings import BaseSettings, SettingsConfigDict

ROOT = Path(__file__).resolve().parents[3]
API_DIR = Path(__file__).resolve().parents[1]


@functools.cache
def app_version() -> str:
    """The product version: the root package.json is the single source (the release workflow
    checks that the tag matches it)."""
    try:
        return str(json.loads((ROOT / "package.json").read_text("utf-8"))["version"])
    except (OSError, ValueError, KeyError):
        return "0.0.0"


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=(ROOT / ".env", ROOT / ".env.local"), env_file_encoding="utf-8", extra="ignore")

    env: str = Field("development", alias="APP_ENV")
    app_name: str = "Open Golf Tracer"
    api_url: str = Field("http://localhost:8000", alias="API_URL")
    # Media URLs handed to the browser; relative keeps them on the web origin (Next rewrite).
    media_base_url: str = Field("/api", alias="MEDIA_BASE_URL")

    database_url: str = Field("", alias="DATABASE_URL")
    data_dir: Path = Field(ROOT / "data", alias="DATA_DIR")

    # SECRET_KEY signs the media URLs; INTERNAL_TOKEN authenticates the workers.
    secret_key: str = Field("", alias="SECRET_KEY")
    internal_token: str = Field("", alias="INTERNAL_TOKEN")

    # Safety limits for uploads.
    max_upload_bytes: int = Field(20_000_000_000, alias="MAX_UPLOAD_BYTES")
    max_video_seconds: int = Field(7200, alias="MAX_VIDEO_SECONDS")

    upload_chunk_bytes: int = 8 * 1024 * 1024
    # Extra host names the app may be opened under besides localhost and IP addresses (comma separated),
    # e.g. "mypc.local" with LISTEN_HOST=0.0.0.0. Other names are refused (DNS rebinding).
    allowed_hosts: str = Field("", alias="ALLOWED_HOSTS")
    log_level: str = Field("INFO", alias="LOG_LEVEL")
    # GEO_LOOKUP=0: never send a video's GPS position to OpenStreetMap on its own (the setting
    # under Settings can then not turn it on); opening "Measure on the map" still works.
    geo_lookup: bool = Field(True, alias="GEO_LOOKUP")

    # Optional AI model for "Make a video for me" (none | ollama | openai-compatible | anthropic).
    # They can be overridden under Settings → AI; the key never leaves the server.
    ai_provider: str = Field("none", alias="AI_PROVIDER")
    ai_model: str = Field("", alias="AI_MODEL")
    ai_base_url: str = Field("", alias="AI_BASE_URL")
    ai_api_key: str = Field("", alias="AI_API_KEY")
    ai_max_tokens: int = Field(20000, alias="AI_MAX_TOKENS")
    # Let the model look at a few still frames from the green when the putt count is unsure.
    ai_vision: bool = Field(False, alias="AI_VISION")

    @property
    def is_dev(self) -> bool:
        return self.env != "production"

    @property
    def db_url(self) -> str:
        return self.database_url or f"sqlite:///{(self.data_dir / 'open-golf-tracer.db').as_posix()}"


def _ensure_secret(s: Settings) -> None:
    """Locally a missing SECRET_KEY is generated once and kept in data/.secret so signed media
    URLs survive restarts. In production it must be set explicitly."""
    s.data_dir.mkdir(parents=True, exist_ok=True)
    for attr, fname in (("secret_key", ".secret"), ("internal_token", ".internal-token")):
        if getattr(s, attr):
            continue
        if not s.is_dev:
            raise RuntimeError(f"{attr.upper()} must be set in production")
        f = s.data_dir / fname
        if not f.exists():
            f.write_text(secrets.token_urlsafe(48), encoding="utf-8")
        setattr(s, attr, f.read_text(encoding="utf-8").strip())


@functools.cache
def settings() -> Settings:
    s = Settings()  # type: ignore[call-arg]
    _ensure_secret(s)
    return s

