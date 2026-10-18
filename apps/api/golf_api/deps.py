"""Request dependencies: the local user and the internal-token guard.

Open Golf Tracer is a single-user app that runs on your own PC, so there is no login. Every
request acts as one internal "local user" row, which keeps the user_id foreign keys (projects,
media, exports, ...) working. Only the local machine can reach the app by default (see
README.md, "Use it from another device").
"""
from __future__ import annotations

import hmac
import threading

from fastapi import Depends, Request
from sqlalchemy import select
from sqlalchemy.orm import Session

from .config import settings
from .db import get_db
from .errors import ApiError
from .models import User

_lock = threading.Lock()
_local_ids: dict[str, str] = {}   # database URL -> id of its local user


def local_user(db: Session) -> User:
    """The local user: the earliest created user (so an existing database keeps its projects),
    created on first use when the database has none. The id is cached per database."""
    key = settings().db_url
    cached = _local_ids.get(key)
    if cached is not None:
        user = db.get(User, cached)
        if user is not None:
            return user
    with _lock:
        user = db.scalars(select(User).order_by(User.created_at, User.id).limit(1)).first()
        if user is None:
            user = User()
            db.add(user)
            db.commit()
        _local_ids[key] = user.id
        return user


def current_user(db: Session = Depends(get_db)) -> User:
    return local_user(db)


def internal_auth(request: Request) -> None:
    """Workers (exporter) authenticate with the shared INTERNAL_TOKEN."""
    auth = request.headers.get("authorization", "")
    if not hmac.compare_digest(auth.encode(), f"Bearer {settings().internal_token}".encode()):
        raise ApiError(401, "unauthenticated", "Internal access requires a token.")
