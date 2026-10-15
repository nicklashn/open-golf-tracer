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
                              "keyMasked": "", "maxTokens": 8000, "cloud": False}


def test_own_settings_key_masked_and_never_leaked(client, caplog):
    caplog.set_level(logging.DEBUG)
    r = client.put("/api/ai/settings", json={"provider": "anthropic", "model": "", "baseUrl": "", "apiKey": KEY, "maxTokens": 6000})
    assert r.status_code == 200, r.text
    s = r.json()
    assert s["effective"]["provider"] == "anthropic" and s["effective"]["model"] == "claude-opus-5-5" and s["effective"]["cloud"]
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
