import datetime as dt

import pytest
from testkit import local_user


def test_no_login_needed_and_one_local_user(client):
    a = local_user(client)
    assert local_user(client)["id"] == a["id"]
    assert "email" not in a and "role" not in a
    assert client.post("/api/projects", json={"name": "Runde"}).status_code == 200
    from golf_api.db import session_scope
    from golf_api.models import User

    with session_scope() as db:
        assert db.query(User).count() == 1


def test_earliest_existing_user_becomes_the_local_user(client):
    """An existing database keeps showing the projects of its first user."""
    from golf_api.db import session_scope
    from golf_api.models import Project, User

    now = dt.datetime.now(dt.UTC)
    with session_scope() as db:
        late, early = User(created_at=now), User(created_at=now - dt.timedelta(days=30))
        db.add_all([late, early])
        db.flush()
        db.add(Project(user_id=early.id, name="Old round", document={}))
        db.add(Project(user_id=late.id, name="Someone else", document={}))
        early_id = early.id
    assert local_user(client)["id"] == early_id
    assert [p["name"] for p in client.get("/api/projects").json()["projects"]] == ["Old round"]


def test_settings_and_data_export(client):
    r = client.patch("/api/account", json={"locale": "en", "units": "yd"})
    assert r.json()["user"]["locale"] == "en" and r.json()["user"]["units"] == "yd"
    assert local_user(client)["units"] == "yd"
    z = client.get("/api/account/export")
    assert z.status_code == 200 and z.headers["content-type"] == "application/zip"


def test_auth_routes_are_gone(client):
    for path in ("/api/auth/login", "/api/auth/signup", "/api/auth/logout"):
        assert client.post(path, json={}).status_code == 404
    assert client.get("/api/auth/me").status_code == 404
    assert client.get("/api/admin/stats").status_code == 404
    assert client.get("/api/dev/inbox").status_code == 404


def test_writes_from_other_sites_are_refused(client):
    r = client.post("/api/projects", json={"name": "x"}, headers={"sec-fetch-site": "cross-site"})
    assert r.status_code == 403 and r.json()["error"]["code"] == "cross_site"
    r = client.post("/api/projects", json={"name": "x"}, headers={"origin": "http://evil.example"})
    assert r.status_code == 403
    assert client.post("/api/projects", json={"name": "x"}, headers={"sec-fetch-site": "same-origin"}).status_code == 200
    assert client.post("/api/projects", json={"name": "x"}, headers={"origin": "http://localhost"}).status_code == 200
    # Behind the Next.js proxy the browser's host arrives as x-forwarded-host.
    r = client.post("/api/projects", json={"name": "x"}, headers={"origin": "http://localhost:3000", "x-forwarded-host": "localhost:3000"})
    assert r.status_code == 200
    # Reading is harmless (the browser does not hand cross-site responses to the other page).
    assert client.get("/api/projects", headers={"sec-fetch-site": "cross-site"}).status_code == 200


def test_unknown_host_names_are_refused(client, monkeypatch):
    # DNS rebinding: a site points its own name at 127.0.0.1 and reads the API as same-origin.
    assert client.get("/api/projects", headers={"host": "evil.example:3000"}).status_code == 403
    assert client.get("/api/projects", headers={"x-forwarded-host": "evil.example"}).status_code == 403
    # The Next proxy sends Host 127.0.0.1:<api port> and the browser's host as x-forwarded-host.
    assert client.get("/api/projects", headers={"host": "127.0.0.1:8000", "x-forwarded-host": "localhost:3000"}).status_code == 200
    assert client.get("/api/projects", headers={"host": "127.0.0.1:8000", "x-forwarded-host": "evil.example:3000"}).status_code == 403
    for ok in ("localhost:3000", "127.0.0.1:3000", "192.168.1.20:3000", "[::1]:3000"):
        assert client.get("/api/projects", headers={"host": ok}).status_code == 200, ok
    from golf_api.config import settings

    monkeypatch.setenv("ALLOWED_HOSTS", "mypc.local")
    settings.cache_clear()
    assert client.get("/api/projects", headers={"host": "mypc.local:3000"}).status_code == 200
    settings.cache_clear()


def test_forwarded_host_cannot_hide_a_rebinding_host(client):
    """A rebinding page on evil.example:8000 talks to the API directly and adds its own
    x-forwarded-host: the real Host is still checked, so it is refused."""
    evil = {"host": "evil.example:8000"}
    assert client.get("/api/projects", headers=evil).status_code == 403
    for xfh in ("localhost", "localhost:3000", "127.0.0.1", "localhost, evil.example:3000", "evil.example:3000, localhost"):
        h = {**evil, "x-forwarded-host": xfh}
        assert client.get("/api/projects", headers=h).status_code == 403, xfh
        r = client.put("/api/ai/settings", json={"provider": "ollama"}, headers={**h, "origin": "http://evil.example:8000"})
        assert r.status_code == 403, xfh
    # A forged localhost entry in front of the name our proxy adds doesn't help either.
    h = {"host": "127.0.0.1:8000", "x-forwarded-host": "localhost:3000, evil.example:3000"}
    assert client.get("/api/projects", headers=h).status_code == 403


def test_feedback_error_and_usage_routes_are_gone(client):
    assert client.post("/api/feedback", json={"message": "x"}).status_code == 404
    assert client.post("/api/client-errors", json={"message": "x"}).status_code == 404
    assert client.get("/api/account/usage").status_code == 404


def test_geo_lookup_setting(client, monkeypatch):
    """On by default; off, the editor's own place lookup returns nothing without asking OSM."""
    from golf_api import config
    from golf_api.routes import geo

    monkeypatch.setattr(geo, "place_at", lambda lat, lon: {"course": "X"})
    me = local_user(client)
    assert me["geoLookup"] is True and me["geoLookupAllowed"] is True
    assert client.get("/api/geo/place?lat=56.2&lon=9.7").json() == {"course": "X"}
    assert client.patch("/api/account", json={"geo_lookup": False}).json()["user"]["geoLookup"] is False
    monkeypatch.setattr(geo, "place_at", lambda lat, lon: pytest.fail("no OSM lookup when it is off"))
    assert client.get("/api/geo/place?lat=56.2&lon=9.7").json() is None
    client.patch("/api/account", json={"geo_lookup": True})
    monkeypatch.setenv("GEO_LOOKUP", "0")
    config.settings.cache_clear()
    try:
        me = local_user(client)
        assert me["geoLookup"] is False and me["geoLookupAllowed"] is False
        assert client.get("/api/geo/place?lat=56.2&lon=9.7").json() is None
    finally:
        config.settings.cache_clear()
