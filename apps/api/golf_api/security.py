"""Signed media URLs."""
from __future__ import annotations

import base64
import hashlib
import hmac
import json
import time

from .config import settings


def _b64(b: bytes) -> str:
    return base64.urlsafe_b64encode(b).rstrip(b"=").decode()


def _unb64(s: str) -> bytes:
    return base64.urlsafe_b64decode(s + "=" * (-len(s) % 4))


def sign(payload: dict, ttl: int) -> str:
    """Compact signed token: base64(json).base64(hmac). Used for media URLs."""
    body = dict(payload, exp=int(time.time()) + ttl)
    raw = _b64(json.dumps(body, separators=(",", ":")).encode())
    mac = hmac.new(settings().secret_key.encode(), raw.encode(), hashlib.sha256).digest()[:20]
    return f"{raw}.{_b64(mac)}"


def unsign(token: str) -> dict | None:
    try:
        raw, mac = token.split(".", 1)
        want = hmac.new(settings().secret_key.encode(), raw.encode(), hashlib.sha256).digest()[:20]
        if not hmac.compare_digest(want, _unb64(mac)):
            return None
        body = json.loads(_unb64(raw))
        if body.get("exp", 0) < time.time():
            return None
        return body
    except (ValueError, json.JSONDecodeError):
        return None

