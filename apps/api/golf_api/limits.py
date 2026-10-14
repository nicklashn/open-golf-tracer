"""Safety limits for uploads (see config.py / `.env.example`)."""
from __future__ import annotations

from typing import Any

from .config import settings
from .errors import ApiError


def limits() -> dict[str, Any]:
    """The limits as shown to the web app (it mirrors them; the server enforces them)."""
    s = settings()
    return {"max_upload_bytes": s.max_upload_bytes, "max_video_seconds": s.max_video_seconds}


def check_upload(size: int) -> None:
    limit = settings().max_upload_bytes
    if size > limit:
        raise ApiError(413, "upload_too_large", "The file is larger than this server allows.", {"limit": limit})


def check_duration(seconds: float) -> None:
    limit = settings().max_video_seconds
    if seconds > limit:
        raise ApiError(413, "video_too_long", f"The video is longer than {limit // 60} minutes, which this server allows.",
                       {"limit": limit})
