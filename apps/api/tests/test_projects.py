from testkit import local_user, upload


def _doc(name="Test"):
    return {"schemaVersion": 1, "name": name, "media": {}, "clips": [], "shots": [], "layers": []}


def test_project_crud_and_conflicts(client):
    p = client.post("/api/projects", json={"name": "Runde 1"}).json()
    assert client.get("/api/projects").json()["projects"][0]["id"] == p["id"]
    loaded = client.get(f"/api/projects/{p['id']}").json()
    v = loaded["docVersion"]
    r = client.put(f"/api/projects/{p['id']}/document", json={"document": _doc("Ny"), "baseVersion": v})
    assert r.status_code == 200 and r.json()["docVersion"] == v + 1
    r = client.put(f"/api/projects/{p['id']}/document", json={"document": _doc(), "baseVersion": v})
    assert r.status_code == 409
    r = client.put(f"/api/projects/{p['id']}/document", json={"document": {"schemaVersion": 1, "clips": [{"kind": "x"}]},
                                                              "baseVersion": v + 1})
    assert r.status_code == 422 and r.json()["error"]["code"] == "invalid_document"
    vers = client.get(f"/api/projects/{p['id']}/versions").json()["versions"]
    assert len(vers) >= 1
    client.post(f"/api/projects/{p['id']}/versions", json={"label": "Før farver"})
    vid = client.get(f"/api/projects/{p['id']}/versions").json()["versions"][0]["id"]
    assert client.post(f"/api/projects/{p['id']}/versions/{vid}/restore").status_code == 200
    assert client.delete(f"/api/projects/{p['id']}").status_code == 200
    assert client.get(f"/api/projects/{p['id']}").status_code == 404


def test_rows_of_other_users_stay_hidden(client, tiny_video):
    """An old multi-user database keeps its other users' rows, but only the local user's are served."""
    from golf_api.db import session_scope
    from golf_api.models import Media, Project, User

    me = local_user(client)
    res = upload(client, tiny_video)
    pid, mid = res["projectId"], res["media"]["id"]
    media_url = res["media"]["urls"]["original"]
    with session_scope() as db:
        other = User()
        db.add(other)
        db.flush()
        db.get(Project, pid).user_id = other.id
        db.get(Media, mid).user_id = other.id
    assert local_user(client)["id"] == me["id"]
    assert client.get("/api/projects").json()["projects"] == []
    assert client.get(f"/api/projects/{pid}").status_code == 404
    assert client.put(f"/api/projects/{pid}/document", json={"document": _doc(), "baseVersion": 1}).status_code == 404
    assert client.get(f"/api/media/{mid}").status_code == 404
    # A signed URL works on its own (that is its purpose) but only for that one file.
    assert client.get(media_url, headers={"range": "bytes=0-9"}).status_code == 206


def test_chunked_upload_creates_project(client, tiny_video):
    res = upload(client, tiny_video, chunk_order=None)
    assert res["media"]["kind"] == "video"
    assert res["media"]["width"] == 320 and res["media"]["hasAudio"]
    p = client.get(f"/api/projects/{res['projectId']}").json()
    assert p["document"]["clips"][0]["mediaId"] == res["media"]["id"]
    jobs = client.get("/api/jobs", params={"project_id": res["projectId"]}).json()["jobs"]
    assert sorted(j["kind"] for j in jobs) == ["analyze", "ingest"]


def test_upload_rejects_fake_video(client, tmp_path):
    fake = tmp_path / "evil.mp4"
    fake.write_bytes(b"not a video at all" * 100)
    r = client.post("/api/uploads", json={"filename": fake.name, "size": fake.stat().st_size, "kind": "video"})
    up = r.json()
    client.put(f"/api/uploads/{up['id']}/chunks/0", content=fake.read_bytes())
    r = client.post(f"/api/uploads/{up['id']}/complete")
    assert r.status_code == 415 and r.json()["error"]["code"] == "invalid_media"


def test_upload_resume_reports_missing_chunks(client, tiny_video, monkeypatch):
    from golf_api import config

    monkeypatch.setattr(config.settings(), "upload_chunk_bytes", 16 * 1024)
    data = tiny_video.read_bytes()
    up = client.post("/api/uploads", json={"filename": "a.mp4", "size": len(data), "kind": "video"}).json()
    assert up["chunks"] > 2
    cs = up["chunkSize"]
    client.put(f"/api/uploads/{up['id']}/chunks/1", content=data[cs:2 * cs])
    st = client.get(f"/api/uploads/{up['id']}").json()
    assert st["received"] == [1]
    r = client.post(f"/api/uploads/{up['id']}/complete")
    assert r.status_code == 409
    for i in range(up["chunks"]):
        if i != 1:
            client.put(f"/api/uploads/{up['id']}/chunks/{i}", content=data[i * cs:(i + 1) * cs])
    assert client.post(f"/api/uploads/{up['id']}/complete").status_code == 200


def test_signed_url_tamper_and_range(client, tiny_video):
    res = upload(client, tiny_video)
    url = res["media"]["urls"]["original"]
    size = tiny_video.stat().st_size
    r = client.get(url, headers={"range": "bytes=10-19"})
    assert r.status_code == 206 and len(r.content) == 10 and r.headers["content-range"] == f"bytes 10-19/{size}"
    assert client.get(url, headers={"range": f"bytes={size + 5}-"}).status_code == 416
    bad = url[:-3] + ("AAA" if not url.endswith("AAA") else "BBB")
    assert client.get(bad).status_code == 403


def test_storage_keys_reject_traversal():
    import pytest

    from golf_api.storage import StorageError, safe_key

    for k in ("../etc/passwd", "/abs", "a/../../b", "a\\b", "."):
        with pytest.raises(StorageError):
            safe_key(k)
    assert safe_key("users/x/media/y/original.mp4") == "users/x/media/y/original.mp4"


def test_more_clips_join_a_round_and_copies_get_their_own_media(client, tiny_video):
    """Videos uploaded into an existing project are merged into its document on load (an open
    editor never conflicts), and a duplicate points at its own media rows."""
    p = client.post("/api/projects", json={"name": "Runde"}).json()
    a = upload(client, tiny_video, project_id=p["id"])["media"]["id"]
    b = upload(client, tiny_video, project_id=p["id"])["media"]["id"]
    doc = client.get(f"/api/projects/{p['id']}").json()["document"]
    assert set(doc["media"]) == {a, b}
    assert [c["mediaId"] for c in doc["clips"]] == [a, b]
    jobs = client.get("/api/jobs", params={"project_id": p["id"]}).json()["jobs"]
    assert sorted(j["kind"] for j in jobs) == ["analyze", "analyze", "ingest", "ingest"]

    copy = client.post(f"/api/projects/{p['id']}/duplicate").json()
    loaded = client.get(f"/api/projects/{copy['id']}").json()
    ids = set(loaded["document"]["media"])
    assert ids.isdisjoint({a, b}) and len(ids) == 2
    assert {c["mediaId"] for c in loaded["document"]["clips"]} == ids
    # ... so the copy can be saved (it used to keep the original's ids and get 422).
    r = client.put(f"/api/projects/{copy['id']}/document", json={"document": loaded["document"], "baseVersion": loaded["docVersion"]})
    assert r.status_code == 200, r.text


def test_place_from_analysis_reaches_the_document(client, tiny_video):
    """The hole found during analysis (and later resolved from the round) is merged into the
    video's media on load; a hole-less place is replaced once a hole is known."""
    from golf_api.db import session_scope
    from golf_api.models import Project

    res = upload(client, tiny_video)
    pid, mid = res["projectId"], res["media"]["id"]

    def set_place(place):
        with session_scope() as db:
            p = db.get(Project, pid)
            a = dict(p.analysis or {})
            a[mid] = {**a.get(mid, {}), "shots": [], "status": "done", "place": place}
            p.analysis = a

    set_place({"course": "Testbane", "hole": "", "par": None, "fromTee": None, "toGreen": None, "line": [],
               "alternatives": [{"hole": "7"}, {"hole": "17"}], "geo": {"lat": 56.2, "lon": 9.7}})
    media = client.get(f"/api/projects/{pid}").json()["document"]["media"][mid]
    assert media["place"]["course"] == "Testbane" and media["place"]["hole"] == ""
    assert "alternatives" not in media["place"] and media["geo"]["lat"] == 56.2
    set_place({"course": "Testbane", "hole": "17", "par": 5, "fromTee": 0, "toGreen": 447, "line": [], "margin": 30})
    media = client.get(f"/api/projects/{pid}").json()["document"]["media"][mid]
    assert media["place"]["hole"] == "17" and "margin" not in media["place"]


def test_sample_project_is_named_in_the_apps_language(client):
    da = client.post("/api/projects/demo", params={"locale": "da"}).json()
    assert da["name"] == "Eksempel: drive på rangen" and da["isDemo"]
    en = client.post("/api/projects/demo", params={"locale": "en"}).json()
    assert en["name"] == "Example: drive at the range"


def test_finished_export_can_be_watched_as_well_as_downloaded(client, tiny_video):
    from golf_api.db import session_scope
    from golf_api.models import Export

    pid = upload(client, tiny_video)["projectId"]
    e = client.post(f"/api/projects/{pid}/exports", json={"settings": {"preset": "original"}}).json()
    assert e["url"] is None and e["previewUrl"] is None
    with session_scope() as db:
        row = db.get(Export, e["id"])
        row.status, row.storage_key = "succeeded", "x/exports/e.mp4"
    done = client.get(f"/api/exports/{e['id']}").json()
    assert done["url"] and done["previewUrl"] and done["url"] != done["previewUrl"]


def test_export_job_carries_the_ui_language(client, tiny_video):
    """The exporter draws stat cards and dates in the language the user asked for the export in."""
    from golf_api.db import session_scope
    from golf_api.models import Export, Job

    pid = upload(client, tiny_video)["projectId"]
    e = client.post(f"/api/projects/{pid}/exports", json={"settings": {"preset": "original"}, "locale": "da"}).json()
    plain = client.post(f"/api/projects/{pid}/exports", json={"settings": {"preset": "original"}}).json()
    odd = client.post(f"/api/projects/{pid}/exports", json={"settings": {"preset": "original"}, "locale": "xx"}).json()
    with session_scope() as db:
        def payload(x):
            return db.get(Job, db.get(Export, x["id"]).job_id).payload

        assert payload(e)["locale"] == "da"
        # Without one (older web apps) the account's language is used.
        assert payload(plain)["locale"] in ("da", "en") and payload(odd)["locale"] in ("da", "en")
