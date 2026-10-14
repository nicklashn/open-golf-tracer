from testkit import local_user, upload


def test_every_user_gets_every_export_option(client, tiny_video):
    pid = upload(client, tiny_video)["projectId"]
    for settings in ({"preset": "youtube4k", "hdr": "keep", "fps": 60}, {"preset": "shorts"}):
        r = client.post(f"/api/projects/{pid}/exports", json={"settings": settings})
        assert r.status_code == 200, r.text
        assert r.json()["settings"] == settings
        assert "watermark" not in r.json()
    from golf_api.db import session_scope
    from golf_api.models import Job

    with session_scope() as db:
        payloads = [j.payload for j in db.query(Job).filter(Job.kind == "export")]
    assert payloads and all("watermark" not in p and "max_short_side" not in p for p in payloads)


def test_me_reports_server_limits(client):
    user = local_user(client)
    assert "plan" not in user and "billing" not in user and "email" not in user
    assert user["limits"] == {"max_upload_bytes": 20_000_000_000, "max_video_seconds": 7200}


def test_upload_limit_is_configurable_and_projects_are_uncapped(client, tiny_video, monkeypatch):
    from golf_api import config

    monkeypatch.setenv("MAX_UPLOAD_BYTES", "1000")
    config.settings.cache_clear()
    r = client.post("/api/uploads", json={"filename": "a.mp4", "size": 5000, "kind": "video"})
    assert r.status_code == 413 and r.json()["error"]["code"] == "upload_too_large"
    assert client.post("/api/projects", json={"name": "A"}).status_code == 200
    assert client.post("/api/projects", json={"name": "B"}).status_code == 200
