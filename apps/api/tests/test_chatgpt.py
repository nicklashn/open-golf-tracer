"""Sign in with ChatGPT against a fake OpenAI (httpx.MockTransport): registration, the token
exchange, ID-token checks, refresh with a rotating refresh token, sign-out, and that no token
reaches a browser, a log line or the data export."""
import base64
import datetime as dt
import hashlib
import io
import json
import logging
import secrets
import time
import zipfile
from urllib.parse import parse_qs, urlparse

import httpx
import pytest

ISSUED = "oaiapp_test123"
ACCESS = "at-SECRET-ACCESS-0123456789"
REFRESH = "rt-SECRET-REFRESH-0123456789"
SCOPE = "chatgpt.tokens.use.direct email offline_access openid profile resource.invoke"


def _b64u(b: bytes) -> str:
    return base64.urlsafe_b64encode(b).rstrip(b"=").decode()


def _prime(bits: int) -> int:
    small = [p for p in range(3, 2000, 2) if all(p % q for q in range(3, int(p ** 0.5) + 1, 2))]
    while True:
        c = secrets.randbits(bits) | (1 << (bits - 1)) | 1
        if any(c % p == 0 for p in small):
            continue
        d, r = c - 1, 0
        while d % 2 == 0:
            d, r = d // 2, r + 1
        for a in (2, 3, 5, 7, 11, 13, 17, 19, 23, 29, 31, 37):
            x = pow(a, d, c)
            if x in (1, c - 1):
                continue
            for _ in range(r - 1):
                x = pow(x, 2, c)
                if x == c - 1:
                    break
            else:
                break
        else:
            return c


class Key:
    """A throwaway RSA key (no crypto library needed) that signs RS256 JWTs."""

    def __init__(self, kid: str):
        e = 65537
        while True:
            p, q = _prime(1024), _prime(1024)
            phi = (p - 1) * (q - 1)
            if p != q and phi % e:
                break
        self.n, self.e, self.d, self.kid = p * q, e, pow(e, -1, phi), kid

    def jwk(self) -> dict:
        size = (self.n.bit_length() + 7) // 8
        return {"kty": "RSA", "kid": self.kid, "alg": "RS256", "use": "sig", "n": _b64u(self.n.to_bytes(size, "big")),
                "e": _b64u(self.e.to_bytes(3, "big"))}

    def sign(self, claims: dict) -> str:
        h = _b64u(json.dumps({"alg": "RS256", "kid": self.kid, "typ": "JWT"}).encode())
        p = _b64u(json.dumps(claims).encode())
        size = (self.n.bit_length() + 7) // 8
        info = bytes.fromhex("3031300d060960864801650304020105000420") + hashlib.sha256(f"{h}.{p}".encode()).digest()
        em = b"\x00\x01" + b"\xff" * (size - len(info) - 3) + b"\x00" + info
        s = pow(int.from_bytes(em, "big"), self.d, self.n)
        return f"{h}.{p}.{_b64u(s.to_bytes(size, 'big'))}"


@pytest.fixture(scope="module")
def key():
    return Key("k1")


class FakeOpenAI:
    def __init__(self, key: Key):
        self.key = key
        self.requests: list[httpx.Request] = []
        self.token_replies: list[tuple[int, dict]] = []
        self.nonce = ""
        self.sub = "user-sub-1"
        self.models = {"models": [{"slug": "m-list", "display_name": "Model A", "visibility": "list"},
                                  {"slug": "m-hidden", "display_name": "Hidden", "visibility": "hide"},
                                  {"slug": "m-two", "display_name": "Model B", "visibility": "list"}]}

    def id_token(self, **extra) -> str:
        return self.key.sign({"iss": "https://auth.openai.com", "aud": ISSUED, "sub": self.sub, "email": "golfer@example.com", "name": "Golfer",
                              "exp": int(time.time()) + 3600, "iat": int(time.time()), "nonce": self.nonce, **extra})

    def tokens(self, scope: str = SCOPE, **id_extra) -> dict:
        return {"access_token": ACCESS, "refresh_token": REFRESH, "id_token": self.id_token(**id_extra), "token_type": "Bearer",
                "expires_in": 3600, "scope": scope}

    def handler(self, request: httpx.Request) -> httpx.Response:
        self.requests.append(request)
        url = str(request.url)
        if url == "https://auth.openai.com/.well-known/jwks.json":
            return httpx.Response(200, json={"keys": [self.key.jwk()]})
        if url == "https://auth.openai.com/api/accounts/oauth/token":
            status, body = self.token_replies.pop(0)
            return httpx.Response(status, json=body)
        if url == "https://auth.openai.com/api/accounts/oauth/revoke":
            return httpx.Response(200)
        if url == "https://api.openai.com/v1/models":
            return httpx.Response(200, json=self.models)
        return httpx.Response(404)

    def form(self, i: int = -1) -> dict[str, str]:
        tokens = [r for r in self.requests if r.url.path.endswith(("/oauth/token", "/oauth/revoke"))]
        return {k: v[0] for k, v in parse_qs(tokens[i].content.decode()).items()}


@pytest.fixture()
def openai(env, key, monkeypatch):
    from golf_api import chatgpt

    fake = FakeOpenAI(key)
    monkeypatch.setattr(chatgpt, "_http", lambda: httpx.Client(transport=httpx.MockTransport(fake.handler)))
    monkeypatch.setattr(chatgpt, "_jwks_cache", {"keys": [], "at": 0.0})
    return fake


def _internal():
    from golf_api.config import settings

    return {"authorization": f"Bearer {settings().internal_token}"}


def _start(client, openai, **body) -> dict[str, str]:
    r = client.post("/api/ai/chatgpt/start", json={"returnTo": "http://localhost:3000", **body})
    assert r.status_code == 200, r.text
    q = {k: v[0] for k, v in parse_qs(urlparse(r.json()["url"]).query).items()}
    openai.nonce = q["nonce"]
    return q


def _sign_in(client, openai, **id_extra) -> httpx.Response:
    q = _start(client, openai)
    openai.token_replies.append((200, openai.tokens(**id_extra)))
    return client.get("/api/ai/chatgpt/callback", params={"code": "c0de", "state": q["state"], "scope": SCOPE, "client_id": ISSUED},
                      follow_redirects=False)


def _row():
    from golf_api.db import session_scope
    from golf_api.models import ChatGptAccount

    with session_scope() as db:
        rows = db.query(ChatGptAccount).all()
        assert len(rows) <= 1
        if not rows:
            return None
        db.expunge(rows[0])
        return rows[0]


def test_first_sign_in_registers_and_stores_tokens(client, openai, caplog):
    caplog.set_level(logging.DEBUG)
    q = _start(client, openai)
    assert urlparse(client.post("/api/ai/chatgpt/start", json={}).json()["url"]).netloc == "auth.openai.com"
    assert q["client_id"] == "dynamic_agent_client" and q["agent_name_hint"] == "Open Golf Tracer"
    assert q["ext_agent_host_id"].startswith("urn:uuid:")
    assert q["redirect_uri"] == "http://127.0.0.1:8000/api/ai/chatgpt/callback"
    assert q["response_type"] == "code" and q["code_challenge_method"] == "S256" and q["resource"] == "https://api.openai.com/v1"
    assert q["scope"].split() == ["openid", "profile", "email", "offline_access", "resource.invoke", "chatgpt.tokens.use.direct"]
    assert "id_token_hint" not in q

    openai.token_replies.append((200, openai.tokens()))
    r = client.get("/api/ai/chatgpt/callback", params={"code": "c0de", "state": q["state"], "client_id": ISSUED}, follow_redirects=False)
    assert r.status_code == 303
    assert r.headers["location"] == "http://localhost:3000/app/settings?chatgpt=ok&first=1#ai"

    form = openai.form(0)
    assert form["grant_type"] == "authorization_code" and form["client_id"] == ISSUED and form["code"] == "c0de"
    assert form["redirect_uri"] == q["redirect_uri"] and form["resource"] == "https://api.openai.com/v1" and "client_secret" not in form
    assert _b64u(hashlib.sha256(form["code_verifier"].encode()).digest()) == q["code_challenge"]

    row = _row()
    assert row is not None
    assert (row.client_id, row.subject, row.access_token, row.refresh_token) == (ISSUED, "user-sub-1", ACCESS, REFRESH)
    assert row.expires_at is not None and "chatgpt.tokens.use.direct" in row.scopes.split()

    s = client.get("/api/ai/settings").json()
    assert s["provider"] == "chatgpt" and s["model"] == "m-list"
    assert s["chatgpt"] | {"expiresAt": None} == {"signedIn": True, "registered": True, "email": "go…@example.com", "expiresAt": None,
                                                    "problem": ""}
    assert s["effective"]["provider"] == "chatgpt" and s["effective"]["cloud"] and s["effective"]["keyMasked"] == ""

    # The exporter gets the access token for a job of this user …
    job = client.post("/api/ai/test").json()
    cfg = client.get(f"/api/internal/jobs/{job['id']}/ai", headers=_internal()).json()
    assert cfg["apiKey"] == ACCESS and cfg["model"] == "m-list" and cfg["baseUrl"] == "https://api.openai.com/v1"

    # … nothing a browser can read has a token.
    for path in ("/api/ai/settings", "/api/auth/me", "/api/jobs", "/api/account/usage", "/api/ai/chatgpt/models"):
        text = client.get(path).text
        assert ACCESS not in text and REFRESH not in text, path
    with zipfile.ZipFile(io.BytesIO(client.get("/api/account/export").content)) as z:
        for name in z.namelist():
            assert ACCESS.encode() not in z.read(name) and REFRESH.encode() not in z.read(name), name
    assert ACCESS not in caplog.text and REFRESH not in caplog.text
    # The app logs paths, not the callback's code (the test client's own log line has it).
    assert not [r for r in caplog.records if r.name.startswith("golf") and "c0de" in r.getMessage()]

    # Signing in again reuses the issued client id and the host id.
    q2 = _start(client, openai)
    assert q2["client_id"] == ISSUED and "agent_name_hint" not in q2 and q2["login_hint"] == "golfer@example.com"
    assert q2["ext_agent_host_id"] == q["ext_agent_host_id"] and q2["state"] != q["state"] and q2["nonce"] != q["nonce"]


def test_models_keep_the_listed_ones(client, openai):
    _sign_in(client, openai)
    r = client.get("/api/ai/chatgpt/models")
    assert r.json() == {"models": [{"slug": "m-list", "name": "Model A"}, {"slug": "m-two", "name": "Model B"}]}
    assert openai.requests[-1].headers["authorization"] == f"Bearer {ACCESS}"


def test_state_mismatch_and_declined_consent_store_nothing(client, openai):
    _start(client, openai)
    r = client.get("/api/ai/chatgpt/callback", params={"code": "c0de", "state": "forged", "client_id": ISSUED}, follow_redirects=False)
    assert r.status_code == 303 and "chatgpt=state" in r.headers["location"]
    q = _start(client, openai)
    r = client.get("/api/ai/chatgpt/callback", params={"error": "access_denied", "state": q["state"]}, follow_redirects=False)
    assert r.headers["location"] == "http://localhost:3000/app/settings?chatgpt=denied#ai"
    # A state is used once.
    r = client.get("/api/ai/chatgpt/callback", params={"code": "c0de", "state": q["state"], "client_id": ISSUED}, follow_redirects=False)
    assert "chatgpt=state" in r.headers["location"]
    # A new registration without an issued client id is incomplete.
    q = _start(client, openai)
    r = client.get("/api/ai/chatgpt/callback", params={"code": "c0de", "state": q["state"]}, follow_redirects=False)
    assert "chatgpt=incomplete" in r.headers["location"]
    assert _row() is None
    assert not [r for r in openai.requests if r.url.path.endswith("/oauth/token")]


def test_id_token_must_match_nonce_signature_and_audience(client, openai):
    for extra, what in (({"nonce": "other"}, "nonce"), ({"aud": "someone-else"}, "aud"), ({"exp": int(time.time()) - 3600}, "exp")):
        r = _sign_in(client, openai, **extra)
        assert "chatgpt=id_token" in r.headers["location"], what
    other = Key("k1")
    real = openai.key
    openai.key = other
    q = _start(client, openai)
    tok = openai.tokens()
    openai.key = real
    openai.token_replies.append((200, tok))
    r = client.get("/api/ai/chatgpt/callback", params={"code": "c", "state": q["state"], "client_id": ISSUED}, follow_redirects=False)
    assert "chatgpt=id_token" in r.headers["location"]
    assert _row() is None


def test_missing_plan_scope_keeps_no_tokens_and_asks_for_consent_next_time(client, openai):
    q = _start(client, openai)
    openai.token_replies.append((200, openai.tokens(scope="openid profile email offline_access")))
    r = client.get("/api/ai/chatgpt/callback", params={"code": "c", "state": q["state"], "client_id": ISSUED}, follow_redirects=False)
    assert r.headers["location"] == "http://localhost:3000/app/settings?chatgpt=no_plan#ai"
    row = _row()
    assert row is not None and row.client_id == ISSUED and row.access_token == "" and row.refresh_token == "" and row.problem == "no_plan"
    assert client.get("/api/ai/settings").json()["chatgpt"]["signedIn"] is False
    q = _start(client, openai)
    assert q["client_id"] == ISSUED and q["prompt"] == "consent"


def _expire_soon():
    from golf_api.db import session_scope
    from golf_api.models import ChatGptAccount

    with session_scope() as db:
        row = db.query(ChatGptAccount).one()
        row.expires_at = dt.datetime.now(dt.UTC) + dt.timedelta(minutes=2)


def test_refresh_rotates_the_refresh_token(client, openai):
    _sign_in(client, openai)
    job = client.post("/api/ai/test").json()
    _expire_soon()
    openai.token_replies.append((200, {"access_token": "at-NEW", "refresh_token": "rt-NEW", "expires_in": 3600, "scope": SCOPE,
                                       "id_token": openai.id_token()}))
    cfg = client.get(f"/api/internal/jobs/{job['id']}/ai", headers=_internal()).json()
    assert cfg["apiKey"] == "at-NEW"
    form = openai.form()
    assert form == {"grant_type": "refresh_token", "client_id": ISSUED, "refresh_token": REFRESH, "resource": "https://api.openai.com/v1"}
    row = _row()
    assert row is not None and row.refresh_token == "rt-NEW" and row.access_token == "at-NEW"
    assert row.expires_at is not None and row.expires_at > dt.datetime.now(dt.UTC) + dt.timedelta(minutes=50)
    # Still fresh: no second refresh.
    n = len(openai.requests)
    assert client.get(f"/api/internal/jobs/{job['id']}/ai", headers=_internal()).json()["apiKey"] == "at-NEW"
    assert len(openai.requests) == n


def test_refresh_failure_says_sign_in_again(client, openai):
    _sign_in(client, openai)
    job = client.post("/api/ai/test").json()
    # A temporary failure keeps the tokens.
    _expire_soon()
    openai.token_replies.append((503, {"error": "temporarily_unavailable"}))
    cfg = client.get(f"/api/internal/jobs/{job['id']}/ai", headers=_internal()).json()
    assert cfg["apiKey"] == "" and "Try again" in cfg["error"]
    row = _row()
    assert row is not None and row.refresh_token == REFRESH
    # A dead refresh token does not.
    openai.token_replies.append((400, {"error": "refresh_token_reused"}))
    cfg = client.get(f"/api/internal/jobs/{job['id']}/ai", headers=_internal()).json()
    assert cfg["apiKey"] == "" and "Sign in with ChatGPT again" in cfg["error"]
    row = _row()
    assert row is not None and row.refresh_token == "" and row.access_token == "" and row.client_id == ISSUED
    s = client.get("/api/ai/settings").json()["chatgpt"]
    assert s["signedIn"] is False and s["problem"] == "sign_in_again"
    assert client.get("/api/ai/chatgpt/models").json()["error"]["code"] == "chatgpt_sign_in_again"


def test_sign_out_revokes_and_keeps_the_registration(client, openai):
    _sign_in(client, openai)
    r = client.post("/api/ai/chatgpt/signout")
    assert r.json() == {"revoked": True}
    form = openai.form()
    assert form == {"token": REFRESH, "token_type_hint": "refresh_token", "client_id": ISSUED}
    row = _row()
    assert row is not None and row.client_id == ISSUED and row.access_token == "" and row.refresh_token == ""
    assert client.get("/api/ai/settings").json()["chatgpt"]["signedIn"] is False
    job = client.post("/api/ai/test").json()
    cfg = client.get(f"/api/internal/jobs/{job['id']}/ai", headers=_internal()).json()
    assert cfg["apiKey"] == "" and "Sign in with ChatGPT" in cfg["error"]
    assert _start(client, openai)["client_id"] == ISSUED


def test_return_to_only_goes_back_to_this_app(client, openai):
    for origin, back in (("https://evil.example", "http://localhost:3000"), ("http://192.168.1.20:3000", "http://192.168.1.20:3000"),
                         ("javascript:alert(1)", "http://localhost:3000")):
        q = _start(client, openai, returnTo=origin)
        r = client.get("/api/ai/chatgpt/callback", params={"error": "access_denied", "state": q["state"]}, follow_redirects=False)
        assert r.headers["location"].startswith(f"{back}/app/settings?"), origin


def test_chatgpt_is_not_a_server_default(client, monkeypatch):
    monkeypatch.setenv("AI_PROVIDER", "chatgpt")
    from golf_api import config

    config.settings.cache_clear()
    assert client.get("/api/ai/settings").json()["effective"]["provider"] == "none"


def test_migration_0004_up_and_down(env):
    from alembic import command
    from alembic.config import Config
    from sqlalchemy import inspect

    from golf_api.config import API_DIR
    from golf_api.db import engine

    cfg = Config(str(API_DIR / "alembic.ini"))
    cfg.set_main_option("script_location", str(API_DIR / "alembic"))
    command.upgrade(cfg, "0003")
    assert "chatgpt_accounts" not in inspect(engine()).get_table_names()
    command.upgrade(cfg, "head")
    cols = {c["name"] for c in inspect(engine()).get_columns("chatgpt_accounts")}
    assert {"client_id", "access_token", "refresh_token", "expires_at", "scopes", "email"} <= cols
    command.downgrade(cfg, "0003")
    assert "chatgpt_accounts" not in inspect(engine()).get_table_names()
