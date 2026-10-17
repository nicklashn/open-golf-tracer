"""Read-modify-write of shared JSON columns from several writers at once (analyses of a round's
clips side by side, an upload attaching a clip, parallel upload chunks): no update may be lost."""
import threading
import time

from testkit import local_user


def _together(n, fn):
    errors = []
    start = threading.Barrier(n)

    def run(i):
        try:
            start.wait()
            fn(i)
        except Exception as exc:  # noqa: BLE001
            errors.append(exc)

    ts = [threading.Thread(target=run, args=(i,)) for i in range(n)]
    for t in ts:
        t.start()
    for t in ts:
        t.join()
    assert not errors, errors


def test_concurrent_analysis_writers_lose_nothing(client):
    p = client.post("/api/projects", json={"name": "Runde"}).json()
    from golf_api.db import session_scope
    from golf_api.documents import update_analysis
    from golf_api.models import Project

    def writer(i):
        for k in range(15):
            def change(a, key=f"med_{i}_{k}"):
                time.sleep(0.002)          # widen the window between read and write
                a[key] = {"attach": {"id": key}, "shots": []}

            with session_scope() as db:
                update_analysis(db, p["id"], change)

    _together(4, writer)
    with session_scope() as db:
        assert len(db.get(Project, p["id"]).analysis) == 60


def test_worker_store_analysis_keeps_an_attached_clip(client):
    """The worker storing shots for clip A while an upload attaches clip B (worker code path)."""
    p = client.post("/api/projects", json={"name": "Runde"}).json()
    from golf_api.db import session_scope
    from golf_api.documents import update_analysis
    from golf_api.models import Project
    from golf_worker.tasks import _store_analysis

    def run(i):
        for k in range(10):
            if i == 0:
                _store_analysis(p["id"], "med_a", [{"id": f"s{k}"}], "running")
            else:
                with session_scope() as db:
                    update_analysis(db, p["id"], lambda a, k=k: a.__setitem__(f"med_b{k}", {"attach": {"id": f"med_b{k}"}}))

    _together(2, run)
    with session_scope() as db:
        a = db.get(Project, p["id"]).analysis
    assert a["med_a"]["shots"] == [{"id": "s9"}]
    assert {f"med_b{k}" for k in range(10)} <= set(a)


def test_parallel_chunks_are_all_recorded(client, monkeypatch):
    user = local_user(client)
    from golf_api.config import settings
    from golf_api.db import session_scope
    from golf_api.models import Upload
    from golf_api.routes.uploads import _store_chunk

    monkeypatch.setattr(settings(), "upload_chunk_bytes", 1024)
    up = client.post("/api/uploads", json={"filename": "a.mp4", "size": 1024 * 24, "kind": "video"}).json()
    assert up["chunks"] == 24

    def send(i):
        for idx in range(i, 24, 4):
            _store_chunk(up["id"], idx, b"x" * 1024, user["id"])

    _together(4, send)
    with session_scope() as db:
        assert sorted(db.get(Upload, up["id"]).received) == list(range(24))
