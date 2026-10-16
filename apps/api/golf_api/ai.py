"""Which AI model "Make a video for me" uses: the user's own settings, else the .env defaults.

With `vision` on, the exporter may also send a few still frames from the green when the putt
count is unsure (local with Ollama, to the provider with a cloud model). Off by default.

The API key is only ever handed to the exporter (internal endpoint). Browsers see it masked;
it is not logged and not part of projects or the data export. With "chatgpt" (Sign in with
ChatGPT, see chatgpt.py) the exporter gets a fresh access token the same way."""
from __future__ import annotations

from typing import Any

from sqlalchemy.orm import Session

from . import chatgpt
from .config import settings
from .models import AiSettings, User

PROVIDERS = ("none", "ollama", "openai-compatible", "anthropic", "chatgpt")
# "chatgpt" needs a sign-in in the browser, so it can only be chosen under Settings → AI.
SERVER_PROVIDERS = ("none", "ollama", "openai-compatible", "anthropic")
DEFAULTS = {
    "ollama": {"baseUrl": "http://localhost:11434/v1", "model": "llama3.1"},
    "openai-compatible": {"baseUrl": "https://api.openai.com/v1", "model": "gpt-4o-mini"},
    "anthropic": {"baseUrl": "https://api.anthropic.com", "model": "claude-opus-5-5"},
    # The model is picked from the signed-in account's list.
    "chatgpt": {"baseUrl": chatgpt.API_BASE, "model": ""},
}
# Providers that send the summary to someone else's computer.
CLOUD = ("openai-compatible", "anthropic", "chatgpt")


def mask(key: str) -> str:
    if not key:
        return ""
    return f"{key[:3]}…{key[-4:]}" if len(key) >= 12 else "••••"


def _server() -> dict[str, Any]:
    s = settings()
    provider = s.ai_provider if s.ai_provider in SERVER_PROVIDERS else "none"
    d = DEFAULTS.get(provider, {})
    return {"provider": provider, "model": s.ai_model or d.get("model", ""), "baseUrl": s.ai_base_url or d.get("baseUrl", ""),
            "apiKey": s.ai_api_key, "maxTokens": max(500, s.ai_max_tokens), "vision": s.ai_vision}


def effective(db: Session, user_id: str | None) -> dict[str, Any]:
    """The AI configuration a job of this user runs with (key included – internal use only)."""
    row = db.get(AiSettings, user_id) if user_id else None
    if row is None:
        return {**_server(), "source": "server"}
    # Once saved, the user's own choice on still frames wins, also with the server's model.
    if row.provider not in PROVIDERS:
        return {**_server(), "vision": bool(row.vision), "source": "server"}
    d = DEFAULTS.get(row.provider, {})
    if row.provider == "chatgpt":
        return {"provider": "chatgpt", "model": row.model, "baseUrl": chatgpt.API_BASE, "apiKey": "", "maxTokens": max(500, row.max_tokens),
                "vision": bool(row.vision), "source": "user"}
    return {"provider": row.provider, "model": row.model or d.get("model", ""), "baseUrl": row.base_url or d.get("baseUrl", ""),
            "apiKey": row.api_key, "maxTokens": max(500, row.max_tokens), "vision": bool(row.vision), "source": "user"}


def public(db: Session, user: User) -> dict[str, Any]:
    """For the settings page and the video dialog: no key, only whether one is set (masked)."""
    row = db.get(AiSettings, user.id)
    eff = effective(db, user.id)
    server = _server()
    return {
        "provider": row.provider if row else "server",
        "model": row.model if row else "",
        "baseUrl": row.base_url if row else "",
        "keyMasked": mask(row.api_key) if row else "",
        "maxTokens": row.max_tokens if row else server["maxTokens"],
        "vision": eff["vision"],
        "effective": {"provider": eff["provider"], "model": eff["model"], "baseUrl": eff["baseUrl"], "source": eff["source"],
                      "keyMasked": mask(eff["apiKey"]), "maxTokens": eff["maxTokens"], "cloud": eff["provider"] in CLOUD,
                      "vision": eff["vision"] and eff["provider"] != "none"},
        "server": {"provider": server["provider"], "model": server["model"], "keyMasked": mask(server["apiKey"])},
        "chatgpt": chatgpt.public(db, user.id),
        "providers": ["server", *PROVIDERS],
        "defaults": DEFAULTS,
    }


def for_job(db: Session, user_id: str | None) -> dict[str, Any]:
    """effective() for the exporter. With "chatgpt" the key is a valid access token (refreshed
    here when needed), or `error` says why there is none."""
    eff = effective(db, user_id)
    if eff["provider"] == "chatgpt":
        try:
            eff["apiKey"] = chatgpt.access_token(db, user_id)
        except chatgpt.ChatGptError as e:
            eff["error"] = e.message
    return eff
