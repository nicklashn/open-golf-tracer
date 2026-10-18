"""Made videos grouped under their round, exporting all of them at once, "Download all" as a zip,
and opening the exports folder (only for a browser on this PC)."""
from __future__ import annotations

import io
import zipfile

import pytest
from fastapi.testclient import TestClient
from testkit import local_user, upload


def _made_videos(client, tiny_video, n=2):
    """A round and n projects made from it by one "Make a video for me" (a compose job)."""
    from golf_api.db import session_scope
    from golf_api.models import Job

    src = upload(client, tiny_video)["projectId"]
    made = [client.post(f"/api/projects/{src}/duplicate").json() for _ in range(n)]
    for i, p in enumerate(made):
        client.patch(f"/api/projects/{p['id']}", json={"name": f"Hul {i + 1}"})
    user = local_user(client)
    with session_scope() as db:
        db.add(Job(kind="compose", status="succeeded", user_id=user["id"], project_id=src,
                   result={"kind": "shorts", "projects": [{"id": p["id"], "name": p["name"]} for p in made]}))
    return src, [p["id"] for p in made]


def test_project_list_says_which_round_a_made_video_came_from(client, tiny_video):
    src, made = _made_videos(client, tiny_video)
    rows = {p["id"]: p for p in client.get("/api/projects").json()["projects"]}
    assert rows[src]["sourceId"] is None and rows[src]["runId"] is None
    assert {rows[m]["sourceId"] for m in made} == {src}
    assert len({rows[m]["runId"] for m in made}) == 1 and rows[made[0]]["runKind"] == "shorts"


def test_export_all_queues_one_export_per_project_with_one_batch(client, tiny_video):
    _, made = _made_videos(client, tiny_video, 3)
    r = client.post("/api/exports/batch", json={"projectIds": made, "settings": {"preset": "shorts"}})
    assert r.status_code == 200, r.text
    body = r.json()
    assert len(body["exports"]) == 3
    assert {e["settings"]["batch"] for e in body["exports"]} == {body["batch"]}
    assert {e["projectId"] for e in body["exports"]} == set(made)
    assert client.post("/api/exports/batch", json={"projectIds": made, "settings": {"preset": "nope"}}).status_code == 422
    assert client.post("/api/exports/batch", json={"projectIds": ["prj_missing"], "settings": {"preset": "shorts"}}).status_code == 404


def test_download_all_zips_the_finished_videos_of_a_batch(client, tiny_video):
    from golf_api.db import session_scope
    from golf_api.models import Export
    from golf_api.storage import storage

    _, made = _made_videos(client, tiny_video, 3)
    body = client.post("/api/exports/batch", json={"projectIds": made, "settings": {"preset": "shorts"}}).json()
    batch = body["batch"]
    assert client.get(f"/api/exports/batches/{batch}/zip").status_code == 404
    # Two of three are done (both named alike: the names in the zip stay apart).
    with session_scope() as db:
        for i, e in enumerate(body["exports"][:2]):
            row = db.get(Export, e["id"])
            assert row is not None
            row.status, row.project_name = "succeeded", "Hul 1"
            key = f"users/{row.user_id}/exports/{row.id}.mp4"
            row.storage_key = key
            path = storage().local_path(key)
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_bytes(b"video%d" % i)
    r = client.get(f"/api/exports/batches/{batch}/zip")
    assert r.status_code == 200 and r.headers["content-type"] == "application/zip"
    z = zipfile.ZipFile(io.BytesIO(r.content))
    assert sorted(z.namelist()) == ["Hul 1 (2).mp4", "Hul 1.mp4"]
    assert sorted(z.read(n) for n in z.namelist()) == [b"video0", b"video1"]
    assert client.get("/api/exports/batches/bat_other/zip").status_code == 404


def test_open_folder_only_for_this_pc(app, monkeypatch):
    from golf_api.routes import exports

    opened = []
    monkeypatch.setattr(exports, "_reveal", lambda folder, pick: opened.append((folder, pick)))
    # Another device (TestClient's default peer is "testclient"; a LAN address the same).
    with TestClient(app, base_url="http://localhost") as c:
        r = c.post("/api/exports/open-folder", json={})
        assert r.status_code == 403 and r.json()["error"]["code"] == "local_only"
    with TestClient(app, base_url="http://localhost", client=("127.0.0.1", 50000)) as c:
        # Through the web app's proxy from another device: the browser's address is forwarded.
        r = c.post("/api/exports/open-folder", json={}, headers={"x-forwarded-for": "192.168.1.20"})
        assert r.status_code == 403
        assert c.post("/api/exports/open-folder", json={}, headers={"x-forwarded-for": "127.0.0.1"}).status_code == 200
        assert c.post("/api/exports/open-folder", json={}).status_code == 200
        assert c.post("/api/exports/open-folder", json={"exportId": "exp_nope"}).status_code == 404
    assert len(opened) == 2 and opened[0][0].name == "exports" and opened[0][0].is_dir()


@pytest.mark.parametrize("host,ok", [("127.0.0.1", True), ("::1", True), ("10.0.0.2", False), (None, False), ("testclient", False)])
def test_loopback(host, ok):
    from golf_api.local_only import _loopback

    assert _loopback(host) is ok
