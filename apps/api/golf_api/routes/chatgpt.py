"""Sign in with ChatGPT (Settings → AI). The flow and the token handling are in golf_api.chatgpt;
the callback is opened by the browser on this PC (OpenAI redirects to 127.0.0.1)."""
from __future__ import annotations

from urllib.parse import urlencode

from fastapi import APIRouter, Depends, Request
from fastapi.responses import RedirectResponse
from pydantic import BaseModel, Field
from sqlalchemy.orm import Session

from .. import chatgpt
from ..db import get_db
from ..deps import current_user
from ..errors import ApiError
from ..models import User

router = APIRouter(prefix="/ai/chatgpt", tags=["ai"])


class StartIn(BaseModel):
    # The web app's origin (window.location.origin), to come back to after the sign-in.
    returnTo: str = Field("", max_length=300)
    # Register another ChatGPT account instead of signing in to the saved one.
    newAccount: bool = False


def _error(e: chatgpt.ChatGptError) -> ApiError:
    return ApiError(409 if e.code in ("signed_out", "sign_in_again", "no_plan") else 502, f"chatgpt_{e.code}", e.message)


@router.post("/start")
def start(body: StartIn, db: Session = Depends(get_db), user: User = Depends(current_user)):
    return {"url": chatgpt.start(db, user.id, body.returnTo, body.newAccount), "redirectUri": chatgpt.redirect_uri()}


@router.get("/callback")
def callback(request: Request, db: Session = Depends(get_db)):
    out = chatgpt.callback(db, dict(request.query_params))
    q = {"chatgpt": out.reason, **({"first": "1"} if out.first else {})}
    return RedirectResponse(f"{out.return_to}/app/settings?{urlencode(q)}#ai", status_code=303)


@router.post("/signout")
def signout(db: Session = Depends(get_db), user: User = Depends(current_user)):
    return {"revoked": chatgpt.signout(db, user.id)}


@router.get("/models")
def models(db: Session = Depends(get_db), user: User = Depends(current_user)):
    try:
        return {"models": chatgpt.models(db, user.id)}
    except chatgpt.ChatGptError as e:
        raise _error(e) from e
