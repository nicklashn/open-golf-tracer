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
        # A lost worker is not a failed attempt; it is counted apart.
        assert j.status == "queued" and j.attempts == 0 and j.interruptions == 1


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


def _stale(jid):
    from golf_api.db import session_scope, utcnow
    from golf_api.models import Job

    with session_scope() as db:
        db.get(Job, jid).heartbeat_at = utcnow() - dt.timedelta(minutes=10)


def _claim_now(kind, worker):
    """Claims a queued job right away (skipping the grace a stale requeue waits)."""
    from golf_api import jobs
    from golf_api.db import session_scope, utcnow
    from golf_api.models import Job

    with session_scope() as db:
        for j in db.query(Job).filter(Job.status == "queued").all():
            j.run_after = utcnow() - dt.timedelta(seconds=1)
    with session_scope() as db:
        j = jobs.claim(db, [kind], worker)
        return j.id, j.lease


def test_a_worker_that_slept_takes_its_job_back_or_loses_it_quietly(client):
    """The PC sleeps mid-analysis: housekeeping queues the job again before the worker's next
    heartbeat. Back in time, the worker carries on; too late (another slot has it), it stops
    without writing – the job is never marked cancelled."""
    from golf_api import jobs
    from golf_api.db import session_scope
    from golf_api.models import Job

    with session_scope() as db:
        jid = jobs.enqueue(db, "analyze").id
    _, lease = _claim_now("analyze", "w1")
    _stale(jid)
    with session_scope() as db:
        assert jobs.requeue_stale(db) == 1
    with session_scope() as db:
        assert jobs.claim(db, ["analyze"], "w2") is None      # the grace for its own worker
    assert jobs.beat(jid, lease, 0.5, "awake again") == jobs.OK
    with session_scope() as db:
        j = db.get(Job, jid)
        assert (j.status, j.attempts, j.interruptions, j.lease) == ("running", 1, 0, lease)

    _stale(jid)
    with session_scope() as db:
        jobs.requeue_stale(db)
    _, lease2 = _claim_now("analyze", "w2")
    assert lease2 != lease
    assert jobs.beat(jid, lease, 0.6, "late") == jobs.LOST
    assert not jobs.heartbeat(jid, 0.6, "late", lease=lease)
    with session_scope() as db:
        j = db.get(Job, jid)
        assert not jobs.fail(db, j, "Cancelled by the user", retry=False, lease=lease)
        assert not jobs.complete(db, j, {"x": 1}, lease=lease)
    with session_scope() as db:
        j = db.get(Job, jid)
        assert (j.status, j.cancel_requested, j.progress) == ("running", False, 0.5)
        assert jobs.complete(db, j, {"x": 2}, lease=lease2)
    with session_scope() as db:
        assert db.get(Job, jid).result == {"x": 2}


def test_lost_workers_do_not_use_up_attempts(client):
    from golf_api import jobs
    from golf_api.db import session_scope
    from golf_api.models import Job

    with session_scope() as db:
        jid = jobs.enqueue(db, "analyze", max_attempts=3).id
    for _ in range(jobs.MAX_INTERRUPTIONS):     # the app closed during the analysis, again and again
        _claim_now("analyze", "w")
        _stale(jid)
        with session_scope() as db:
            jobs.requeue_stale(db)
            assert db.get(Job, jid).status == "queued"
    _claim_now("analyze", "w")
    _stale(jid)
    with session_scope() as db:
        jobs.requeue_stale(db)
        j = db.get(Job, jid)
        assert j.status == "failed"       # one that takes its worker down every time does end


def test_internal_api_leases_and_export_rows(client):
    user = local_user(client)
    from golf_api import jobs
    from golf_api.config import settings
    from golf_api.db import session_scope
    from golf_api.models import Export

    with session_scope() as db:
        e = Export(user_id=user["id"], settings={"preset": "shorts"})
        db.add(e)
        db.flush()
        j = jobs.enqueue(db, "export", {"export_id": e.id}, user_id=user["id"], max_attempts=1)
        e.job_id, jid, eid = j.id, j.id, e.id
    auth = {"authorization": f"Bearer {settings().internal_token}"}
    job = client.post("/api/internal/jobs/claim", json={"kinds": ["export"], "worker": "x"}, headers=auth).json()["job"]
    lease = job["lease"]
    assert lease and job["id"] == jid
    assert client.post(f"/api/internal/exports/{eid}/start", headers=auth).status_code == 200
    _stale(jid)
    with session_scope() as db:
        jobs.requeue_stale(db)
        assert db.get(Export, eid).status == "queued"     # not "running" forever after a crash
    _, lease2 = _claim_now("export", "y")
    r = client.post(f"/api/internal/jobs/{jid}/progress", json={"lease": lease, "progress": 0.4}, headers=auth).json()
    assert r == {"continue": False, "lost": True}
    assert client.post(f"/api/internal/jobs/{jid}/fail", json={"lease": lease, "error": "x", "retry": False},
                       headers=auth).json()["status"] == "lost"
    assert client.post(f"/api/internal/jobs/{jid}/complete", json={"lease": lease, "result": {}}, headers=auth).json()["ok"] is False
    r = client.post(f"/api/internal/jobs/{jid}/progress", json={"lease": lease2, "progress": 0.4}, headers=auth).json()
    assert r == {"continue": True, "lost": False}
    assert client.post(f"/api/internal/jobs/{jid}/fail", json={"lease": lease2, "error": "boom"}, headers=auth).json()["status"] == "failed"
    assert client.get(f"/api/exports/{eid}").json()["status"] == "failed"


def test_export_rows_left_running_by_old_versions_show_their_job(client):
    user = local_user(client)
    from golf_api import jobs
    from golf_api.db import session_scope
    from golf_api.models import Export

    with session_scope() as db:
        e = Export(user_id=user["id"], settings={"preset": "shorts"}, status="running")
        db.add(e)
        db.flush()
        j = jobs.enqueue(db, "export", {"export_id": e.id}, user_id=user["id"])
        j.status, j.error, e.job_id, eid = "failed", "crashed", j.id, e.id
    assert client.get(f"/api/exports/{eid}").json()["status"] == "failed"
