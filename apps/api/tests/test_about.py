"""Settings → About: version from package.json, redaction of keys and tokens in logs and in the
diagnostics bundle, the once-a-day update check and the local-only data folder."""
import datetime as dt
import io
import json
import logging
import zipfile

import pytest

from golf_api import about
from golf_api.config import ROOT
from golf_api.local_only import local_request as is_local
from golf_api.logging_setup import JsonFormatter
from golf_api.redact import redact

CASES = json.loads((ROOT / "scripts/test/redact-cases.json").read_text(encoding="utf-8"))["cases"]

FAKE_KEY = "sk-ant-api03-PLANTEDFAKEKEY0123456789abcdef"
FAKE_OWN_KEY = "my-own-provider-key-PLANTED-42"   # no recognisable shape: only the known-secret list catches it
FAKE_ACCESS = "eyJhbGciOiJSUzI1NiJ9.eyJQTEFOVEVEIjoiYWNjZXNzIn0.UExBTlRFRHNpZ25hdHVyZQ"
FAKE_REFRESH = "rt_PLANTED_refresh_token_value_77"


@pytest.mark.parametrize("case", CASES, ids=lambda c: c["in"][:40])
def test_redact_cases(case):
    out = redact(case["in"])
    if "secret" in case:
        assert case["secret"] not in out and "[redacted]" in out
    if "keep" in case:
        assert case["keep"] in out


def test_known_secrets_are_masked_whatever_their_shape():
    assert redact(f"failed with {FAKE_OWN_KEY}!", [FAKE_OWN_KEY]) == "failed with [redacted]!"


def test_log_lines_never_carry_a_key():
    rec = logging.LogRecord("golf.test", logging.ERROR, __file__, 1, "provider said no: Authorization: Bearer %s", (FAKE_KEY,), None)
    try:
        raise RuntimeError(f"401 for key {FAKE_KEY}")
    except RuntimeError:
        import sys
        rec.exc_info = sys.exc_info()
    line = JsonFormatter().format(rec)
    assert FAKE_KEY not in line and "PLANTEDFAKEKEY" not in line
    assert "provider said no" in line and "[redacted]" in line


def test_version_comes_from_package_json(client):
    want = json.loads((ROOT / "package.json").read_text(encoding="utf-8"))["version"]
    assert client.get("/api/openapi.json").json()["info"]["version"] == want
    r = client.get("/api/about").json()
    assert r["version"] == want and r["os"] and r["inference"] in ("DirectML", "CUDA", "CPU")
    assert r["dataDir"].endswith("data") and r["canOpenFolder"] is False   # TestClient is not on loopback


def test_notices_endpoint_always_answers(client):
    r = client.get("/api/about/notices")
    assert r.status_code == 200 and r.headers["content-type"].startswith("text/plain") and "licens" in r.text.lower()


def test_open_data_folder_is_local_only(client):
    assert client.post("/api/about/open-data-folder").status_code == 403


def test_is_local():
    class Req:
        def __init__(self, host, fwd=None):
            self.client = type("C", (), {"host": host})()
            self.headers = {"x-forwarded-for": fwd} if fwd else {}

    assert is_local(Req("127.0.0.1")) and is_local(Req("::1", "127.0.0.1"))
    assert not is_local(Req("192.168.1.20")) and not is_local(Req("127.0.0.1", "192.168.1.20"))
    assert not is_local(Req("127.0.0.1", "127.0.0.1, 10.0.0.5"))


def test_diagnostics_bundle_has_no_secrets(client, env):
    from golf_api import config, db
    from golf_api.deps import local_user
    from golf_api.models import ChatGptAccount, Job

    assert client.put("/api/ai/settings", json={"provider": "openai-compatible", "model": "gpt-x", "baseUrl": "http://localhost:1234/v1",
                                                 "apiKey": FAKE_OWN_KEY, "maxTokens": 6000}).status_code == 200
    with db.SessionLocal() as s:
        uid = local_user(s).id
        s.add(ChatGptAccount(user_id=uid, client_id="cid", access_token=FAKE_ACCESS, refresh_token=FAKE_REFRESH, email="golfer@example.com"))
        s.add(Job(kind="compose", status="failed", user_id=uid, error=f"401 from provider using {FAKE_OWN_KEY}",
                  payload={"document": {"name": "Secret round"}}))
        s.commit()
    data = config.settings().data_dir
    (data / "logs").mkdir(parents=True, exist_ok=True)
    (data / "logs" / "app-20261017.log").write_text(
        f"api     | provider call Authorization: Bearer {FAKE_KEY}\nexporter| key {FAKE_OWN_KEY} refresh {FAKE_REFRESH}\nworker  | ok line\n",
        encoding="utf-8")
    (data / "performance.json").write_text(json.dumps({"profile": "balanced", "note": f"token={FAKE_REFRESH}"}), encoding="utf-8")

    r = client.get("/api/about/diagnostics")
    assert r.status_code == 200 and r.headers["content-type"] == "application/zip"
    z = zipfile.ZipFile(io.BytesIO(r.content))
    names = set(z.namelist())
    assert {"about.json", "performance.json", "jobs.json", "README.txt", "logs/app-20261017.log"} <= names
    blob = "\n".join(z.read(n).decode("utf-8") for n in names)
    secrets = [FAKE_KEY, FAKE_OWN_KEY, FAKE_ACCESS, FAKE_REFRESH, "PLANTED", config.settings().secret_key, config.settings().internal_token]
    for s_ in secrets:
        assert s_ not in blob, s_
    assert "golfer@example.com" not in blob and "Secret round" not in blob
    about_json = json.loads(z.read("about.json"))
    assert about_json["ai"]["user"] == {"provider": "openai-compatible", "model": "gpt-x", "keySet": True, "vision": False}
    assert about_json["ai"]["chatgptSignedIn"] is True
    assert "ok line" in z.read("logs/app-20261017.log").decode()
    assert json.loads(z.read("jobs.json"))[0]["kind"] == "compose"


def test_versions_compare():
    assert about.is_newer("0.5.10", "0.5.4") and about.is_newer("v1.0", "0.9.9") and about.is_newer("0.6", "0.5.4")
    assert not about.is_newer("0.5.4", "0.5.4") and not about.is_newer("0.5.4", "0.5.10") and not about.is_newer("", "0.5.4")


def test_update_check_once_a_day_and_opt_out(client, env, monkeypatch):
    from golf_api import config

    calls = []

    def fake():
        calls.append(1)
        return {"tag": "v99.0.0", "url": "https://github.com/nicklashn/open-golf-tracer/releases/tag/v99.0.0"}

    monkeypatch.setattr(about, "fetch_latest", fake)
    monkeypatch.setattr(config.settings(), "env", "development")   # tests never ask GitHub otherwise
    r = about.update_status(wait=True)
    assert r["enabled"] and r["newer"] and r["latest"] == "99.0.0" and r["url"].endswith("v99.0.0")
    assert client.get("/api/about/update").json()["newer"] is True
    assert len(calls) == 1                     # cached for a day
    t = dt.datetime.now(dt.UTC) + dt.timedelta(days=1, minutes=1)
    about.update_status(now=t, wait=True)
    assert len(calls) == 2

    r = client.put("/api/about/update", json={"enabled": False}).json()
    assert r["enabled"] is False and r["newer"] is False
    about.update_status(now=t + dt.timedelta(days=5), wait=True)
    assert len(calls) == 2                     # off means no request at all
    assert json.loads((config.settings().data_dir / about.UPDATE_FILE).read_text())["enabled"] is False


def test_update_check_failure_waits_a_day(client, env, monkeypatch):
    import httpx

    from golf_api import config

    calls = []

    def offline():
        calls.append(1)
        raise httpx.ConnectError("offline")

    monkeypatch.setattr(about, "fetch_latest", offline)
    monkeypatch.setattr(config.settings(), "env", "development")
    r = about.update_status(wait=True)
    assert r["newer"] is False and r["latest"] is None
    about.update_status(wait=True)
    assert len(calls) == 1


def test_update_check_runs_in_the_background(client, env, monkeypatch):
    import threading

    from golf_api import config

    gate, done = threading.Event(), threading.Event()

    def slow():
        gate.wait(5)
        done.set()
        return {"tag": "v99.0.0", "url": "https://github.com/nicklashn/open-golf-tracer/releases/tag/v99.0.0"}

    monkeypatch.setattr(about, "fetch_latest", slow)
    monkeypatch.setattr(config.settings(), "env", "development")
    assert client.get("/api/about/update").json()["latest"] is None   # answers at once, GitHub still pending
    gate.set()
    assert done.wait(5)
    for _ in range(50):
        if client.get("/api/about/update").json()["newer"]:
            break
        threading.Event().wait(0.05)
    assert client.get("/api/about/update").json()["latest"] == "99.0.0"


def test_update_check_is_skipped_in_tests(client, monkeypatch):
    monkeypatch.setattr(about, "fetch_latest", lambda: pytest.fail("must not ask GitHub from tests"))
    assert client.get("/api/about/update").json()["newer"] is False and about.update_status(wait=True)["newer"] is False


def test_both_open_folder_endpoints_share_the_strict_local_check(app, monkeypatch):
    """The data folder (About) and the exports folder use the same check: a forged loopback hop in
    X-Forwarded-For does not hide the address the web app's proxy appended."""
    from fastapi.testclient import TestClient

    from golf_api import local_only
    from golf_api.routes import about as about_routes
    from golf_api.routes import exports

    assert about_routes.local_request is local_only.local_request is exports.local_request
    monkeypatch.setattr(about_routes.subprocess, "Popen", lambda *a, **k: None)
    monkeypatch.setattr(exports, "_reveal", lambda folder, pick: None)
    with TestClient(app, base_url="http://localhost", client=("127.0.0.1", 50000)) as c:
        forged = {"x-forwarded-for": "127.0.0.1, 192.168.1.20"}
        for path in ("/api/about/open-data-folder", "/api/exports/open-folder"):
            r = c.post(path, json={}, headers=forged)
            assert r.status_code == 403 and r.json()["error"]["code"] == "local_only", path
            assert c.post(path, json={}).status_code == 200, path
        assert c.get("/api/about", headers=forged).json()["canOpenFolder"] is False
        assert c.get("/api/about").json()["canOpenFolder"] is True
