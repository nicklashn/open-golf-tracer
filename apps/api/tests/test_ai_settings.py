"""AI settings for "Make a video for me": server defaults, the user's own choice, and that the
API key never reaches a browser, a log line or a data export."""
import io
import logging
import zipfile

KEY = "sk-ant-api03-VERY-SECRET-KEY-0123456789"


def _internal():
    from golf_api.config import settings

    return {"authorization": f"Bearer {settings().internal_token}"}


def test_defaults_come_from_env(client, monkeypatch):
    monkeypatch.setenv("AI_PROVIDER", "ollama")
    monkeypatch.setenv("AI_MODEL", "qwen2.5")
    from golf_api import config

    config.settings.cache_clear()
    s = client.get("/api/ai/settings").json()
    assert s["provider"] == "server"
    assert s["effective"] == {"provider": "ollama", "model": "qwen2.5", "baseUrl": "http://localhost:11434/v1", "source": "server",
                              "keyMasked": "", "maxTokens": 20000, "cloud": False, "vision": False}
    assert s["vision"] is False


def test_own_settings_key_masked_and_never_leaked(client, caplog):
    caplog.set_level(logging.DEBUG)
    r = client.put("/api/ai/settings", json={"provider": "anthropic", "model": "", "baseUrl": "", "apiKey": KEY, "maxTokens": 6000})
    assert r.status_code == 200, r.text
    s = r.json()
    assert s["effective"]["provider"] == "anthropic" and s["effective"]["model"] == "claude-haiku-5-5" and s["effective"]["cloud"]
    assert s["keyMasked"] == "sk-…6789"

    # The exporter gets the key for a job of this user …
    job = client.post("/api/ai/test").json()
    cfg = client.get(f"/api/internal/jobs/{job['id']}/ai", headers=_internal()).json()
    assert cfg["apiKey"] == KEY and cfg["maxTokens"] == 6000

    # … nothing a browser can read has it.
    for path in ("/api/ai/settings", "/api/auth/me", "/api/jobs", "/api/account/usage"):
        assert KEY not in client.get(path).text, path
    data = client.get("/api/account/export")
    assert data.status_code == 200
    with zipfile.ZipFile(io.BytesIO(data.content)) as z:
        for name in z.namelist():
            assert KEY.encode() not in z.read(name), name
    assert KEY not in caplog.text

    # Saving without a key keeps it; an empty key removes it.
    client.put("/api/ai/settings", json={"provider": "anthropic", "maxTokens": 6000})
    assert client.get("/api/ai/settings").json()["keyMasked"] == "sk-…6789"
    client.put("/api/ai/settings", json={"provider": "anthropic", "apiKey": "", "maxTokens": 6000})
    assert client.get("/api/ai/settings").json()["keyMasked"] == ""


def test_key_is_dropped_when_provider_or_address_changes(client):
    """A stored key is never sent to another host: changing provider or the base URL's origin
    without typing a key again removes it."""
    def put(**kw):
        r = client.put("/api/ai/settings", json={"maxTokens": 6000, **kw})
        assert r.status_code == 200, r.text
        return r.json()

    def key():
        job = client.post("/api/ai/test").json()
        return client.get(f"/api/internal/jobs/{job['id']}/ai", headers=_internal()).json()["apiKey"]

    put(provider="openai-compatible", baseUrl="https://api.openai.com/v1", apiKey=KEY)
    # Same origin (the default is api.openai.com too, or another path on it): the key stays.
    assert put(provider="openai-compatible", baseUrl="")["keyCleared"] is False
    assert put(provider="openai-compatible", baseUrl="https://API.openai.com:443/v2")["keyMasked"] == "sk-…6789"
    assert key() == KEY
    # Another host: dropped, and the answer says so.
    s = put(provider="openai-compatible", baseUrl="https://evil.example/v1")
    assert s["keyCleared"] is True and s["keyMasked"] == "" and key() == ""
    # With a new key in the same request it is kept for the new host.
    s = put(provider="openai-compatible", baseUrl="https://openrouter.ai/api/v1", apiKey="sk-or-v1-NEW-KEY-0000")
    assert s["keyCleared"] is False and key() == "sk-or-v1-NEW-KEY-0000"
    # Another provider: dropped as well.
    s = put(provider="anthropic", baseUrl="")
    assert s["keyCleared"] is True and key() == ""


def test_validation_and_no_test_without_a_provider(client):
    assert client.put("/api/ai/settings", json={"provider": "skynet"}).status_code == 422
    assert client.put("/api/ai/settings", json={"provider": "ollama", "baseUrl": "file:///etc"}).status_code == 422
    assert client.post("/api/ai/test").status_code == 422  # provider none (server default)


def test_answers_carry_the_first_calls_tokens(client, tiny_video):
    from testkit import upload

    p = client.post("/api/projects", json={"name": "R"}).json()
    upload(client, tiny_video, project_id=p["id"])
    job = client.post("/api/autovideo", json={"projectId": p["id"]}).json()
    usage = {"calls": 1, "inputTokens": 900, "outputTokens": 100, "cacheReadTokens": 0, "cacheWriteTokens": 0}
    client.post(f"/api/internal/jobs/{job['id']}/await", json={"result": {"plan": {"title": "x"}, "questions": [], "usage": usage}},
                headers=_internal())
    client.post(f"/api/jobs/{job['id']}/answers", json={"answers": {}})
    from golf_api.db import session_scope
    from golf_api.models import Job

    with session_scope() as db:
        assert db.get(Job, job["id"]).payload["usage"] == usage


def test_vision_is_off_by_default_and_round_trips(client, monkeypatch):
    s = client.get("/api/ai/settings").json()
    assert s["vision"] is False and s["effective"]["vision"] is False

    monkeypatch.setenv("AI_VISION", "1")
    monkeypatch.setenv("AI_PROVIDER", "ollama")
    from golf_api import config

    config.settings.cache_clear()
    assert client.get("/api/ai/settings").json()["effective"]["vision"] is True

    # Saving without the field keeps the server's default; then the user's own choice wins.
    r = client.put("/api/ai/settings", json={"provider": "anthropic", "apiKey": KEY, "maxTokens": 9000})
    assert r.json()["vision"] is True
    r = client.put("/api/ai/settings", json={"provider": "anthropic", "maxTokens": 9000, "vision": False})
    assert r.json()["vision"] is False and r.json()["effective"]["vision"] is False
    r = client.put("/api/ai/settings", json={"provider": "server", "maxTokens": 9000, "vision": True})
    assert r.json()["effective"] | {"keyMasked": ""} == {"provider": "ollama", "model": "llama3.1", "baseUrl": "http://localhost:11434/v1",
                                                         "source": "server", "keyMasked": "", "maxTokens": 20000, "cloud": False,
                                                         "vision": True}

    job = client.post("/api/ai/test").json()
    cfg = client.get(f"/api/internal/jobs/{job['id']}/ai", headers=_internal()).json()
    assert cfg["vision"] is True
    # No provider: nothing can look, whatever the switch says.
    r = client.put("/api/ai/settings", json={"provider": "none", "maxTokens": 9000, "vision": True})
    assert r.json()["effective"]["vision"] is False
    assert client.put("/api/ai/settings", json={"provider": "none", "vision": "maybe"}).status_code == 422


def test_answers_carry_what_the_ai_saw(client, tiny_video):
    from testkit import upload

    p = client.post("/api/projects", json={"name": "R"}).json()
    upload(client, tiny_video, project_id=p["id"])
    job = client.post("/api/autovideo", json={"projectId": p["id"]}).json()
    vision = {"answers": {"putts:7": "2", "holed:7": "yes"}, "notes": ["AI'en talte 2 putts på hul 7 ud fra billeder."]}
    client.post(f"/api/internal/jobs/{job['id']}/await", json={"result": {"plan": {"title": "x"}, "questions": [], "vision": vision}},
                headers=_internal())
    client.post(f"/api/jobs/{job['id']}/answers", json={"answers": {"shot:s1": "keep"}})
    from golf_api.db import session_scope
    from golf_api.models import Job

    with session_scope() as db:
        j = db.get(Job, job["id"])
        assert j is not None
        assert j.payload["vision"] == vision and j.payload["answers"] == {"shot:s1": "keep"}


def test_migration_0003_adds_vision_to_existing_settings(env):
    from alembic import command
    from alembic.config import Config
    from sqlalchemy import inspect, text

    from golf_api.config import API_DIR
    from golf_api.db import engine

    cfg = Config(str(API_DIR / "alembic.ini"))
    cfg.set_main_option("script_location", str(API_DIR / "alembic"))
    command.upgrade(cfg, "0002")
    with engine().begin() as c:
        c.execute(text("INSERT INTO users (id, locale, units, onboarding_done, created_at) VALUES ('u1', 'da', 'm', 1, '2026-01-01 00:00:00')"))
        c.execute(text("INSERT INTO ai_settings (user_id, provider, model, base_url, api_key, max_tokens, updated_at) "
                       "VALUES ('u1', 'ollama', '', '', '', 8000, '2026-01-01 00:00:00')"))
    command.upgrade(cfg, "head")
    assert "vision" in {col["name"] for col in inspect(engine()).get_columns("ai_settings")}
    with engine().connect() as c:
        assert c.execute(text("SELECT vision FROM ai_settings WHERE user_id = 'u1'")).scalar() in (0, False)
    command.downgrade(cfg, "0002")
    assert "vision" not in {col["name"] for col in inspect(engine()).get_columns("ai_settings")}


def _fake_dpapi(monkeypatch):
    """DPAPI only exists on Windows: a reversible stand-in exercises the storage path."""
    from golf_api import secretbox

    monkeypatch.setattr(secretbox, "available", lambda: True)
    monkeypatch.setattr(secretbox, "_protect", lambda b: b"X" + bytes(x ^ 0x5A for x in b))

    def unprotect(b: bytes) -> bytes:
        if not b.startswith(b"X"):
            raise OSError("wrong user")
        return bytes(x ^ 0x5A for x in b[1:])

    monkeypatch.setattr(secretbox, "_unprotect", unprotect)


def _raw(sql: str) -> list:
    from sqlalchemy import text

    from golf_api.db import session_scope

    with session_scope() as db:
        return [tuple(r) for r in db.execute(text(sql)).all()]


def test_secrets_are_encrypted_at_rest_on_windows(client, monkeypatch):
    _fake_dpapi(monkeypatch)
    client.put("/api/ai/settings", json={"provider": "anthropic", "apiKey": KEY, "maxTokens": 6000})
    [(stored,)] = _raw("SELECT api_key FROM ai_settings")
    assert stored.startswith("dpapi:") and KEY not in stored
    assert client.get("/api/ai/settings").json()["keyMasked"] == "sk-…6789"
    job = client.post("/api/ai/test").json()
    assert client.get(f"/api/internal/jobs/{job['id']}/ai", headers=_internal()).json()["apiKey"] == KEY


def test_plaintext_secrets_from_older_versions_are_encrypted_on_start(client, monkeypatch):
    from sqlalchemy import text
    from testkit import local_user

    from golf_api import secretbox
    from golf_api.db import session_scope

    uid = local_user(client)["id"]
    with session_scope() as db:
        db.execute(text("INSERT INTO ai_settings (user_id, provider, model, base_url, api_key, max_tokens, vision, updated_at) "
                        "VALUES (:u, 'anthropic', '', '', :k, 6000, 0, '2026-01-01 00:00:00')"), {"u": uid, "k": KEY})
        db.execute(text("INSERT INTO chatgpt_accounts (user_id, client_id, subject, email, name, access_token, refresh_token, scopes, problem, "
                        "updated_at) VALUES (:u, 'c', '', '', '', 'acc-PLAIN', 'ref-PLAIN', '', '', '2026-01-01 00:00:00')"), {"u": uid})
    # Not Windows: nothing changes and the plaintext still reads.
    assert secretbox.migrate() == 0
    assert client.get("/api/ai/settings").json()["keyMasked"] == "sk-…6789"
    _fake_dpapi(monkeypatch)
    assert secretbox.migrate() == 3
    assert secretbox.migrate() == 0
    [(k,)] = _raw("SELECT api_key FROM ai_settings")
    [(a, r)] = _raw("SELECT access_token, refresh_token FROM chatgpt_accounts")
    assert all(v.startswith("dpapi:") for v in (k, a, r)) and "PLAIN" not in a + r and KEY not in k
    from golf_api.models import ChatGptAccount

    with session_scope() as db:
        row = db.get(ChatGptAccount, uid)
        assert row is not None and (row.access_token, row.refresh_token) == ("acc-PLAIN", "ref-PLAIN")
    assert client.get("/api/ai/settings").json()["keyMasked"] == "sk-…6789"
    # A value sealed for another Windows user reads as "not set" instead of failing.
    with session_scope() as db:
        db.execute(text("UPDATE ai_settings SET api_key = 'dpapi:AAAA'"))
    assert client.get("/api/ai/settings").json()["keyMasked"] == ""
