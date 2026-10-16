"""Sign in with ChatGPT: "Make a video for me" on the user's ChatGPT plan.

Follows OpenAI's guide for open-source, locally hosted apps
(https://developers.openai.com/siwc/token-sharing-open-source):

- OAuth code flow with PKCE (S256), state and nonce. The API itself is the loopback listener
  (http://127.0.0.1:<API port>/api/ai/chatgpt/callback), so the browser that signs in must run
  on the same PC as the app;
- the first sign-in registers the app (client_id=dynamic_agent_client + agent_name_hint); the
  issued client id is kept and reused, also after signing out;
- one stable, opaque host id per installation (urn:uuid:…, kept in DATA_DIR/.chatgpt-host-id);
- the ID token is checked (RS256 against OpenAI's JWKS, issuer, audience, expiry, nonce) and the
  grant must include chatgpt.tokens.use.direct;
- the tokens never leave the server. The exporter gets an access token, refreshed here first
  when it expires within REFRESH_MARGIN; the rotating refresh token is replaced with it.
"""
from __future__ import annotations

import base64
import contextlib
import datetime as dt
import hashlib
import hmac
import ipaddress
import json
import secrets
import ssl
import threading
import time
import uuid
from dataclasses import dataclass
from typing import Any
from urllib.parse import urlencode, urlparse

import httpx
from sqlalchemy.orm import Session

from .config import settings
from .db import utcnow
from .models import AiSettings, ChatGptAccount

ISSUER = "https://auth.openai.com"
AUTHORIZE_URL = f"{ISSUER}/api/accounts/authorize"
TOKEN_URL = f"{ISSUER}/api/accounts/oauth/token"
REVOKE_URL = f"{ISSUER}/api/accounts/oauth/revoke"
JWKS_URL = f"{ISSUER}/.well-known/jwks.json"
API_BASE = "https://api.openai.com/v1"
DIRECT_SCOPE = "chatgpt.tokens.use.direct"
SCOPES = f"openid profile email offline_access resource.invoke {DIRECT_SCOPE}"
NEW_CLIENT = "dynamic_agent_client"
AGENT_NAME = "Open Golf Tracer"
CALLBACK_PATH = "/api/ai/chatgpt/callback"
# Where the browser goes after the callback when the attempt is unknown (dev.mjs serves the web app here).
DEFAULT_WEB = "http://localhost:3000"
REFRESH_MARGIN = dt.timedelta(minutes=10)
PENDING_TTL = 600
UNUSABLE_REFRESH = {"invalid_grant", "invalid_refresh_token", "token_expired", "refresh_token_expired", "refresh_token_invalidated",
                    "refresh_token_reused"}
SIGN_IN_AGAIN = "The ChatGPT sign-in has expired or was disconnected. Sign in with ChatGPT again under Settings → AI."


class ChatGptError(Exception):
    def __init__(self, code: str, message: str):
        super().__init__(message)
        self.code = code
        self.message = message


def _http() -> httpx.Client:
    try:  # the OS certificate store: some PCs intercept HTTPS (antivirus)
        import truststore

        verify: Any = truststore.SSLContext(ssl.PROTOCOL_TLS_CLIENT)
    except ImportError:
        verify = True
    return httpx.Client(timeout=30, verify=verify, headers={"User-Agent": "OpenGolfTracer"})


def _b64u(b: bytes) -> str:
    return base64.urlsafe_b64encode(b).rstrip(b"=").decode()


def _unb64u(s: str) -> bytes:
    return base64.urlsafe_b64decode(s + "=" * (-len(s) % 4))


def host_id() -> str:
    """This installation's ext_agent_host_id: made once, then always the same."""
    f = settings().data_dir / ".chatgpt-host-id"
    if not f.exists():
        f.parent.mkdir(parents=True, exist_ok=True)
        f.write_text(f"urn:uuid:{uuid.uuid4()}", encoding="utf-8")
        with contextlib.suppress(OSError):
            f.chmod(0o600)
    return f.read_text(encoding="utf-8").strip()


def redirect_uri() -> str:
    """Only the port may differ between sign-ins; host and path stay as they are."""
    port = urlparse(settings().api_url).port or 8000
    return f"http://127.0.0.1:{port}{CALLBACK_PATH}"


def _web_origin(url: str) -> str:
    """The web app's origin to return to: localhost, an IP address or a name in ALLOWED_HOSTS."""
    with contextlib.suppress(ValueError):
        u = urlparse(url)
        name = (u.hostname or "").lower()
        if u.scheme in ("http", "https") and name and not u.username and u.path.strip("/") == "" and not u.query:
            allowed = {h.strip().lower() for h in settings().allowed_hosts.split(",") if h.strip()}
            ok = name == "localhost" or name.endswith(".localhost") or name in allowed
            if not ok:
                with contextlib.suppress(ValueError):
                    ipaddress.ip_address(name)
                    ok = True
            if ok:
                return f"{u.scheme}://{u.netloc}"
    return DEFAULT_WEB


# --- sign-in ----------------------------------------------------------------------------------

_pending: dict[str, dict[str, Any]] = {}
_pending_lock = threading.Lock()


def start(db: Session, user_id: str, return_to: str, new_account: bool = False) -> str:
    """The authorize URL for a fresh attempt (state, nonce and PKCE verifier stay here)."""
    row = db.get(ChatGptAccount, user_id)
    client_id = row.client_id if row and row.client_id and not new_account else ""
    state, nonce, verifier = secrets.token_urlsafe(32), secrets.token_urlsafe(32), secrets.token_urlsafe(48)
    params = {
        "client_id": client_id or NEW_CLIENT,
        "response_type": "code",
        "redirect_uri": redirect_uri(),
        "scope": SCOPES,
        "resource": API_BASE,
        "state": state,
        "nonce": nonce,
        "code_challenge": _b64u(hashlib.sha256(verifier.encode()).digest()),
        "code_challenge_method": "S256",
        "ext_agent_host_id": host_id(),
    }
    if not client_id:
        params["agent_name_hint"] = AGENT_NAME
    elif row is not None:
        if row.email:
            params["login_hint"] = row.email
        # Plan use was declined last time: ask for consent again (the user chose to enable it).
        if row.problem == "no_plan":
            params["prompt"] = "consent"
    now = time.time()
    with _pending_lock:
        for k in [k for k, p in _pending.items() if p["created"] + PENDING_TTL < now]:
            del _pending[k]
        _pending[state] = {"user_id": user_id, "client_id": client_id, "nonce": nonce, "verifier": verifier, "redirect_uri": params["redirect_uri"],
                           "return_to": _web_origin(return_to), "created": now}
    return f"{AUTHORIZE_URL}?{urlencode(params)}"


@dataclass
class CallbackResult:
    ok: bool
    reason: str
    return_to: str
    first: bool = False


_jwks_cache: dict[str, Any] = {"keys": [], "at": 0.0}


def _jwks(force: bool = False) -> list[dict[str, Any]]:
    if force or not _jwks_cache["keys"] or _jwks_cache["at"] + 3600 < time.time():
        with _http() as c:
            r = c.get(JWKS_URL)
            r.raise_for_status()
            _jwks_cache.update(keys=r.json().get("keys", []), at=time.time())
    return _jwks_cache["keys"]


# DER prefix of a PKCS#1 v1.5 DigestInfo for SHA-256.
_SHA256_INFO = bytes.fromhex("3031300d060960864801650304020105000420")


def _rs256_ok(key: dict[str, Any], data: bytes, sig: bytes) -> bool:
    try:
        n = int.from_bytes(_unb64u(key["n"]), "big")
        e = int.from_bytes(_unb64u(key["e"]), "big")
    except (KeyError, ValueError):
        return False
    size = (n.bit_length() + 7) // 8
    s = int.from_bytes(sig, "big")
    if len(sig) != size or s >= n:
        return False
    info = _SHA256_INFO + hashlib.sha256(data).digest()
    want = b"\x00\x01" + b"\xff" * (size - len(info) - 3) + b"\x00" + info
    return hmac.compare_digest(pow(s, e, n).to_bytes(size, "big"), want)


def verify_id_token(token: str, client_id: str, nonce: str) -> dict[str, Any]:
    """The ID token's claims after checking signature, issuer, audience, expiry and nonce."""
    try:
        h, p, s = token.split(".")
        header, claims, sig = json.loads(_unb64u(h)), json.loads(_unb64u(p)), _unb64u(s)
    except ValueError as e:
        raise ChatGptError("id_token", "The ID token is malformed.") from e
    if header.get("alg") != "RS256":
        raise ChatGptError("id_token", "The ID token is not signed with RS256.")
    signed = f"{h}.{p}".encode()

    def candidates(force: bool) -> list[dict[str, Any]]:
        return [k for k in _jwks(force) if k.get("kty") == "RSA" and (not header.get("kid") or k.get("kid") == header["kid"])]

    try:
        ok = any(_rs256_ok(k, signed, sig) for k in candidates(False)) or any(_rs256_ok(k, signed, sig) for k in candidates(True))
    except httpx.HTTPError as e:
        raise ChatGptError("network", "Could not load OpenAI's signing keys.") from e
    if not ok:
        raise ChatGptError("id_token", "The ID token's signature is not valid.")
    aud = claims.get("aud")
    if claims.get("iss") != ISSUER or client_id not in (aud if isinstance(aud, list) else [aud]):
        raise ChatGptError("id_token", "The ID token is for another issuer or app.")
    if not isinstance(claims.get("exp"), int | float) or claims["exp"] < time.time() - 60:
        raise ChatGptError("id_token", "The ID token has expired.")
    if not hmac.compare_digest(str(claims.get("nonce", "")), nonce) or not claims.get("sub"):
        raise ChatGptError("id_token", "The ID token does not belong to this sign-in.")
    return claims


def _token_error(r: httpx.Response) -> str:
    with contextlib.suppress(ValueError):
        j = r.json()
        if isinstance(j, dict):
            err = j.get("error")
            if isinstance(err, dict):
                err = err.get("code") or err.get("type")
            return str(err or "")
    return ""


def _first_model(token: str) -> str:
    with contextlib.suppress(httpx.HTTPError, ChatGptError, ValueError):
        return next((m["slug"] for m in _list_models(token)), "")
    return ""


def callback(db: Session, params: dict[str, str]) -> CallbackResult:
    """Handles OpenAI's redirect: validates state, exchanges the code, checks the ID token and
    the plan permission, then stores the registration and the tokens."""
    with _pending_lock:
        p = _pending.pop(params.get("state", ""), None)
    if p is None or p["created"] + PENDING_TTL < time.time():
        return CallbackResult(False, "state", DEFAULT_WEB if p is None else p["return_to"])
    back = p["return_to"]
    if params.get("error"):
        return CallbackResult(False, "denied" if params["error"] == "access_denied" else "error", back)
    code = params.get("code", "")
    issued = params.get("client_id", "")
    if p["client_id"]:
        if issued and issued != p["client_id"]:
            return CallbackResult(False, "client_mismatch", back)
        client_id = p["client_id"]
    else:
        if not issued or issued == NEW_CLIENT:
            return CallbackResult(False, "incomplete", back)
        client_id = issued
    if not code:
        return CallbackResult(False, "error", back)
    try:
        with _http() as c:
            r = c.post(TOKEN_URL, data={"grant_type": "authorization_code", "client_id": client_id, "code": code, "code_verifier": p["verifier"],
                                        "redirect_uri": p["redirect_uri"], "resource": API_BASE})
    except httpx.HTTPError:
        return CallbackResult(False, "network", back)
    if r.status_code != 200:
        return CallbackResult(False, "invalid_grant" if _token_error(r) == "invalid_grant" else "token_error", back)
    try:
        tok = r.json()
        claims = verify_id_token(str(tok.get("id_token", "")), client_id, p["nonce"])
    except ValueError:
        return CallbackResult(False, "token_error", back)
    except ChatGptError as e:
        return CallbackResult(False, "network" if e.code == "network" else "id_token", back)
    row = db.get(ChatGptAccount, p["user_id"])
    if row is not None and row.client_id == client_id and row.subject and row.subject != claims["sub"]:
        return CallbackResult(False, "account_mismatch", back)
    if row is None:
        row = ChatGptAccount(user_id=p["user_id"])
        db.add(row)
    scopes = str(tok.get("scope", "")).split()
    plan = DIRECT_SCOPE in scopes and bool(tok.get("access_token")) and bool(tok.get("refresh_token"))
    row.client_id, row.subject = client_id, str(claims["sub"])
    row.email, row.name = str(claims.get("email", ""))[:320], str(claims.get("name", ""))[:200]
    row.scopes = " ".join(scopes)
    row.access_token = str(tok["access_token"]) if plan else ""
    row.refresh_token = str(tok["refresh_token"]) if plan else ""
    row.expires_at = utcnow() + dt.timedelta(seconds=int(tok.get("expires_in") or 3600)) if plan else None
    row.problem = "" if plan else "no_plan"
    row.updated_at = utcnow()
    if plan:
        ai = db.get(AiSettings, p["user_id"])
        if ai is None:
            ai = AiSettings(user_id=p["user_id"], api_key="", vision=settings().ai_vision)
            db.add(ai)
        if ai.provider != "chatgpt":
            ai.provider, ai.model, ai.base_url = "chatgpt", "", ""
        if not ai.model:
            ai.model = _first_model(row.access_token)
        ai.updated_at = utcnow()
    db.commit()
    return CallbackResult(plan, "ok" if plan else "no_plan", back, first=plan and not p["client_id"])


# --- tokens -----------------------------------------------------------------------------------

_refresh_lock = threading.Lock()


def _clear(row: ChatGptAccount, problem: str) -> None:
    row.access_token = row.refresh_token = ""
    row.expires_at = None
    row.problem = problem
    row.updated_at = utcnow()


def access_token(db: Session, user_id: str | None) -> str:
    """A valid access token, refreshed first when it expires soon. Refreshes are serialised so a
    rotating refresh token is never used twice."""
    with _refresh_lock:
        row = db.get(ChatGptAccount, user_id) if user_id else None
        if row is not None:
            db.refresh(row)
        if row is None or not row.client_id:
            raise ChatGptError("signed_out", "Sign in with ChatGPT under Settings → AI to use your ChatGPT plan.")
        if row.problem == "no_plan":
            raise ChatGptError("no_plan", "Using your ChatGPT plan is not allowed for this app. Sign in with ChatGPT again under Settings → AI and allow it.")
        if not row.refresh_token:
            raise ChatGptError("sign_in_again" if row.problem else "signed_out", SIGN_IN_AGAIN if row.problem else
                               "Sign in with ChatGPT under Settings → AI to use your ChatGPT plan.")
        if row.access_token and row.expires_at and row.expires_at - utcnow() > REFRESH_MARGIN:
            return row.access_token
        try:
            with _http() as c:
                r = c.post(TOKEN_URL, data={"grant_type": "refresh_token", "client_id": row.client_id, "refresh_token": row.refresh_token,
                                            "resource": API_BASE})
        except httpx.HTTPError as e:
            raise ChatGptError("unavailable", "Could not reach OpenAI to renew the ChatGPT sign-in. Try again in a moment.") from e
        if r.status_code != 200:
            code = _token_error(r)
            if code in UNUSABLE_REFRESH:
                _clear(row, "sign_in_again")
                db.commit()
                raise ChatGptError("sign_in_again", SIGN_IN_AGAIN)
            if code == "invalid_client":
                # The registration is gone: the next sign-in registers the app again.
                _clear(row, "sign_in_again")
                row.client_id = ""
                db.commit()
                raise ChatGptError("sign_in_again", SIGN_IN_AGAIN)
            raise ChatGptError("unavailable", f"OpenAI could not renew the ChatGPT sign-in ({r.status_code}). Try again in a moment.")
        try:
            tok = r.json()
            access = str(tok["access_token"])
        except (ValueError, KeyError) as e:
            raise ChatGptError("unavailable", "OpenAI answered the token renewal with something unexpected.") from e
        # Replaced together: access token, expiry, granted scopes and the rotating refresh token.
        row.access_token = access
        row.refresh_token = str(tok.get("refresh_token") or row.refresh_token)
        row.expires_at = utcnow() + dt.timedelta(seconds=int(tok.get("expires_in") or 3600))
        row.scopes = str(tok.get("scope") or row.scopes)
        row.problem = "" if DIRECT_SCOPE in row.scopes.split() else "no_plan"
        row.updated_at = utcnow()
        db.commit()
        if row.problem:
            raise ChatGptError("no_plan", "Using your ChatGPT plan is no longer allowed for this app. Sign in with ChatGPT again under Settings → AI.")
        return access


def signout(db: Session, user_id: str) -> bool:
    """Revokes the renewable session at OpenAI, then forgets the tokens (the registration stays).
    False when OpenAI did not confirm the revocation (the tokens are forgotten anyway)."""
    with _refresh_lock:
        row = db.get(ChatGptAccount, user_id)
        if row is None:
            return True
        revoked = not row.refresh_token
        if row.refresh_token:
            with contextlib.suppress(httpx.HTTPError):
                with _http() as c:
                    r = c.post(REVOKE_URL, data={"token": row.refresh_token, "token_type_hint": "refresh_token", "client_id": row.client_id})
                revoked = r.status_code == 200
        _clear(row, "")
        row.scopes = ""
        db.commit()
        return revoked


def _list_models(token: str) -> list[dict[str, str]]:
    with _http() as c:
        r = c.get(f"{API_BASE}/models", headers={"Authorization": f"Bearer {token}"})
    if r.status_code == 401:
        raise ChatGptError("sign_in_again", SIGN_IN_AGAIN)
    if r.status_code != 200:
        raise ChatGptError("unavailable", f"OpenAI answered {r.status_code} for the list of models.")
    items = r.json().get("models") or []
    return [{"slug": str(m["slug"]), "name": str(m.get("display_name") or m["slug"])}
            for m in items if isinstance(m, dict) and m.get("visibility") == "list" and m.get("slug")]


def models(db: Session, user_id: str) -> list[dict[str, str]]:
    """The models the signed-in account may use, in the server's order."""
    token = access_token(db, user_id)
    try:
        return _list_models(token)
    except (httpx.HTTPError, ValueError) as e:
        raise ChatGptError("unavailable", "Could not load the list of models from OpenAI.") from e


def _mask_email(email: str) -> str:
    local, _, domain = email.partition("@")
    return f"{local[:2]}…@{domain}" if domain else ""


def public(db: Session, user_id: str) -> dict[str, Any]:
    """For the settings page: whether it is signed in, never a token."""
    row = db.get(ChatGptAccount, user_id)
    if row is None:
        return {"signedIn": False, "registered": False, "email": "", "expiresAt": None, "problem": ""}
    return {"signedIn": bool(row.refresh_token) and not row.problem, "registered": bool(row.client_id), "email": _mask_email(row.email),
            "expiresAt": row.expires_at.isoformat() if row.expires_at else None, "problem": row.problem}
