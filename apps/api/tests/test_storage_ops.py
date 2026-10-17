"""Disk space checks, Settings → Storage, and cleaning up after uploads and deletes."""
import os
import time

from testkit import local_user, upload

GB = 1024 ** 3


def drain(kinds):
    from golf_api import jobs
    from golf_api.db import session_scope
    from golf_worker.main import run_job

    while True:
        with session_scope() as db:
            j = jobs.claim(db, kinds, "test")
            jid = j.id if j else None
        if not jid:
            return
        run_job(jid)


def _free(monkeypatch, n):
    from golf_api import space

    monkeypatch.setattr(space, "free_bytes", lambda: n)


def test_upload_needs_room_for_the_file_and_its_preview(client, monkeypatch):
    _free(monkeypatch, 3 * GB)
    r = client.post("/api/uploads", json={"filename": "a.mp4", "size": int(1.5 * GB), "kind": "video"})
    assert r.status_code == 200
    # The first upload's part file is still to be written: a second one of the same size no longer fits.
    r = client.post("/api/uploads", json={"filename": "b.mp4", "size": int(1.5 * GB), "kind": "video"})
    assert r.status_code == 507 and r.json()["error"]["code"] == "disk_full"
    assert r.json()["error"]["details"]["free"] == 3 * GB


def test_export_needs_room(client, tiny_video, monkeypatch):
    res = upload(client, tiny_video)
    _free(monkeypatch, GB // 2)
    r = client.post(f"/api/projects/{res['projectId']}/exports", json={"settings": {"preset": "youtube1080"}})
    assert r.status_code == 507 and r.json()["error"]["code"] == "disk_full"


def test_ingest_on_a_full_disk_fails_without_retry(client, tiny_video, monkeypatch):
    res = upload(client, tiny_video)
    from golf_api import jobs
    from golf_api.db import session_scope
    from golf_api.models import Job
    from golf_worker.main import run_job

    _free(monkeypatch, GB // 2)
    with session_scope() as db:
        j = jobs.claim(db, ["ingest"], "t")
        jid = j.id
    run_job(jid)
    with session_scope() as db:
        j = db.get(Job, jid)
        assert j.status == "failed" and j.attempts == 1
        assert jobs.public(j)["errorCode"] == "disk_full"
    m = client.get(f"/api/media/{res['media']['id']}").json()
    assert m["status"] == "failed"


def test_full_disk_from_the_exporter_is_not_retried(client):
    user = local_user(client)
    from golf_api import jobs
    from golf_api.config import settings
    from golf_api.db import session_scope

    with session_scope() as db:
        jid = jobs.enqueue(db, "export", {}, user_id=user["id"]).id
    auth = {"authorization": f"Bearer {settings().internal_token}"}
    lease = client.post("/api/internal/jobs/claim", json={"kinds": ["export"], "worker": "x"}, headers=auth).json()["job"]["lease"]
    r = client.post(f"/api/internal/jobs/{jid}/fail", json={"lease": lease, "error": "ffmpeg: No space left on device"}, headers=auth)
    assert r.json()["status"] == "failed"      # max_attempts 3, but a full disk is not retried
    with session_scope() as db:
        from golf_api.models import Job

        assert jobs.public(db.get(Job, jid))["errorCode"] == "disk_full"


def test_rejected_uploads_free_their_part_file_at_once(client, tiny_video, monkeypatch):
    from golf_api.config import settings
    from golf_api.storage import tmp_dir

    monkeypatch.setattr(settings(), "max_video_seconds", 1)
    data = tiny_video.read_bytes()
    up = client.post("/api/uploads", json={"filename": "a.mp4", "size": len(data), "kind": "video"}).json()
    assert client.put(f"/api/uploads/{up['id']}/chunks/0", content=data).status_code == 200
    r = client.post(f"/api/uploads/{up['id']}/complete")
    assert r.json()["error"]["code"] == "video_too_long"
    assert not (tmp_dir() / "uploads" / f"{up['id']}.part").exists()
    assert client.get(f"/api/uploads/{up['id']}").json()["status"] == "failed"


def test_housekeeping_sweeps_orphan_part_files(client):
    from golf_api import maintenance
    from golf_api.storage import tmp_dir

    up = client.post("/api/uploads", json={"filename": "a.mp4", "size": 100, "kind": "video"}).json()
    folder = tmp_dir() / "uploads"
    orphan = folder / "upl_gone.part"
    orphan.write_bytes(b"x" * 10)
    old = time.time() - maintenance.UPLOAD_TTL.total_seconds() - 60
    for f in (orphan, folder / f"{up['id']}.part"):
        os.utime(f, (old, old))
    maintenance.run_once()
    assert not orphan.exists()
    assert (folder / f"{up['id']}.part").exists()     # its upload is still open (updated recently)


def test_deletes_blocked_by_open_files_are_retried_by_housekeeping(client, monkeypatch):
    from golf_api import maintenance
    from golf_api import storage as st

    s = st.storage()
    f = s.local_path("users/u/media/m/original.mp4")
    f.parent.mkdir(parents=True)
    f.write_bytes(b"x")
    real = st.shutil.rmtree

    def locked(p, *a, **k):
        raise PermissionError(32, "The process cannot access the file because it is being used by another process")

    monkeypatch.setattr(st.shutil, "rmtree", locked)
    monkeypatch.setattr(st.time, "sleep", lambda s: None)
    s.delete_prefix("users/u/media/m")
    assert f.exists() and st.pending_deletes() == ["users/u/media/m"]
    monkeypatch.setattr(st.shutil, "rmtree", real)
    maintenance.run_once()      # (the app's own housekeeping may get there first)
    assert not f.exists() and st.pending_deletes() == []


def test_moves_retry_while_windows_holds_the_file(env, monkeypatch, tmp_path):
    from golf_api import storage as st

    calls = {"n": 0}
    real = st.os.replace

    def flaky(a, b):
        calls["n"] += 1
        if calls["n"] < 3:
            raise PermissionError(13, "Access is denied")   # antivirus scanning the fresh file
        real(a, b)

    monkeypatch.setattr(st.os, "replace", flaky)
    src = tmp_path / "x.bin"
    src.write_bytes(b"abc")
    assert st.storage().put_file("users/u/x.bin", src, move=True) == 3
    assert calls["n"] == 3


def test_storage_settings_sizes_and_making_room(client, tiny_video):
    res = upload(client, tiny_video)
    pid, mid = res["projectId"], res["media"]["id"]
    drain(["ingest"])
    from golf_api.db import session_scope
    from golf_api.models import Export, Job, Media

    with session_scope() as db:      # the analysis would take the detector: say it is done
        for j in db.query(Job).filter(Job.kind == "analyze").all():
            j.status = "succeeded"
    from golf_api.storage import storage

    user = local_user(client)
    key = f"users/{user['id']}/exports/exp_t.mp4"
    p = storage().local_path(key)
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_bytes(b"x" * 1000)
    with session_scope() as db:
        db.add(Export(id="exp_t", user_id=user["id"], project_id=pid, status="succeeded", storage_key=key, size=1000))

    o = client.get("/api/storage").json()
    row = next(r for r in o["projects"] if r["id"] == pid)
    assert row["originals"] == tiny_video.stat().st_size and row["proxies"] > 0 and row["exports"] == 1000
    assert o["free"] > 0 and o["total"] >= o["free"]

    r = client.post("/api/storage/previews/delete", json={"projectIds": [pid]}).json()
    assert r["projects"] == [pid] and r["freed"] == row["proxies"]
    m = client.get(f"/api/media/{mid}").json()
    assert "proxy" not in m["urls"] and m["status"] == "ready"
    # Opening the project makes the preview again.
    client.get(f"/api/projects/{pid}")
    drain(["ingest"])
    assert "proxy" in client.get(f"/api/media/{mid}").json()["urls"]

    assert client.post("/api/storage/exports/delete", json={"projectIds": [pid]}).json() == {"deleted": 1, "freed": 1000}
    assert not p.exists()
    with session_scope() as db:
        assert db.get(Export, "exp_t") is None
        assert db.get(Media, mid) is not None

    from golf_api.config import settings

    osm = settings().data_dir / "cache" / "osm"
    osm.mkdir(parents=True, exist_ok=True)
    (osm / "a.json").write_text("{}")
    assert client.post("/api/storage/map-cache/clear").json()["freed"] == 2
    assert not (osm / "a.json").exists()
    # Nothing selected: nothing deleted.
    assert client.post("/api/storage/previews/delete", json={}).json()["projects"] == []
