import datetime as dt

from testkit import local_user


def test_claim_is_exclusive_and_stale_jobs_requeue(client):
    from golf_api import jobs
    from golf_api.db import session_scope, utcnow
    from golf_api.models import Job

    with session_scope() as db:
        jid = jobs.enqueue(db, "analyze", {"x": 1}).id
    with session_scope() as db:
        a = jobs.claim(db, ["analyze"], "w1")
        assert a is not None and a.id == jid
        assert jobs.claim(db, ["analyze"], "w2") is None
    assert jobs.heartbeat(jid, 0.5, "halvvejs")
    with session_scope() as db:
        j = db.get(Job, jid)
        j.heartbeat_at = utcnow() - dt.timedelta(minutes=10)
    with session_scope() as db:
        assert jobs.requeue_stale(db) == 1
        j = db.get(Job, jid)
        assert j.status == "queued" and j.attempts == 1


def test_failures_retry_then_fail(client):
    from golf_api import jobs
    from golf_api.db import session_scope
    from golf_api.models import Job

    with session_scope() as db:
        jid = jobs.enqueue(db, "ingest", max_attempts=2).id
    for expected in ("queued", "failed"):
        with session_scope() as db:
            j = db.get(Job, jid)
            j.run_after = j.created_at
            db.flush()
            j = jobs.claim(db, ["ingest"], "w")
            assert j is not None
            jobs.fail(db, j, "boom")
            assert j.status == expected


def test_cancel_and_internal_api(client):
    user = local_user(client)
    from golf_api import jobs
    from golf_api.config import settings
    from golf_api.db import session_scope

    with session_scope() as db:
        jid = jobs.enqueue(db, "export", {"a": 1}, user_id=user["id"]).id
    auth = {"authorization": f"Bearer {settings().internal_token}"}
    assert client.post("/api/internal/jobs/claim", json={"kinds": ["export"], "worker": "x"}).status_code == 401
    r = client.post("/api/internal/jobs/claim", json={"kinds": ["export"], "worker": "x"}, headers=auth).json()
    assert r["job"]["id"] == jid and r["job"]["payload"] == {"a": 1}
    assert client.post(f"/api/jobs/{jid}/cancel").json()["message"] == "Annullerer"
    r = client.post(f"/api/internal/jobs/{jid}/progress", json={"progress": 0.3, "log": "hej\n"}, headers=auth).json()
    assert r["continue"] is False
    assert client.post(f"/api/internal/jobs/{jid}/fail", json={"error": "stopped"}, headers=auth).json()["status"] == "canceled"


def test_health_and_errors(client):
    import json

    from golf_api.config import ROOT

    health = client.get("/api/health").json()
    assert health["status"] == "ok"
    # The launcher (scripts/dev.mjs) recognises a running copy by these two.
    assert health["app"] == "open-golf-tracer"
    assert health["version"] == json.loads((ROOT / "package.json").read_text("utf-8"))["version"]
    r = client.get("/api/projects")
    assert r.status_code == 200      # no login: everything acts as the local user
    assert r.headers["x-content-type-options"] == "nosniff"
