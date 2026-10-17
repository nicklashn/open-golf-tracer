"""The worker's side of the job leases: a PC that slept mid-job, and keeping it awake."""
import datetime as dt
import threading


def _claim(kind="analyze", worker="w1"):
    from golf_api import jobs
    from golf_api.db import session_scope, utcnow
    from golf_api.models import Job

    with session_scope() as db:
        for j in db.query(Job).filter(Job.status == "queued").all():
            j.run_after = utcnow() - dt.timedelta(seconds=1)
    with session_scope() as db:
        return jobs.claim(db, [kind], worker).id


def _sleep_and_requeue(jid, taken_by_another: bool):
    """What happens while the PC sleeps: no heartbeat, housekeeping queues the job again (and,
    with two analysis slots, another one may take it)."""
    from golf_api import jobs
    from golf_api.db import session_scope, utcnow
    from golf_api.models import Job

    with session_scope() as db:
        db.get(Job, jid).heartbeat_at = utcnow() - dt.timedelta(minutes=5)
    with session_scope() as db:
        assert jobs.requeue_stale(db) == 1
    if taken_by_another:
        assert _claim(worker="w2") == jid


def _run(monkeypatch, jid, handler):
    from golf_worker import main

    monkeypatch.setitem(main.HANDLERS, "analyze", handler)
    main.run_job(jid)


def test_a_job_lost_while_the_pc_slept_is_not_cancelled(client, monkeypatch):
    from golf_api import jobs
    from golf_api.db import session_scope
    from golf_api.models import Job

    with session_scope() as db:
        jid = jobs.enqueue(db, "analyze").id
    assert _claim() == jid
    from golf_worker.ffmpeg import Canceled

    def handler(job, report):
        report(0.3, "Looking for the ball")
        _sleep_and_requeue(jid, taken_by_another=True)
        import time

        time.sleep(0.5)                       # report() throttles database writes
        if not report(0.4, "Looking for the ball"):
            raise Canceled()
        raise AssertionError("the worker should have learnt it lost the job")

    _run(monkeypatch, jid, handler)
    with session_scope() as db:
        j = db.get(Job, jid)
        # Still the other worker's running job: not "canceled", not failed, no attempt burnt.
        assert (j.status, j.cancel_requested, j.locked_by, j.attempts) == ("running", False, "w2", 1)


def test_a_worker_back_in_time_finishes_its_job(client, monkeypatch):
    from golf_api import jobs
    from golf_api.db import session_scope
    from golf_api.models import Job

    with session_scope() as db:
        jid = jobs.enqueue(db, "analyze").id
    _claim()

    def handler(job, report):
        _sleep_and_requeue(jid, taken_by_another=False)
        return {"shots": 3}

    _run(monkeypatch, jid, handler)
    with session_scope() as db:
        j = db.get(Job, jid)
        assert (j.status, j.result, j.cancel_requested) == ("succeeded", {"shots": 3}, False)


def test_a_real_cancel_still_cancels(client, monkeypatch):
    from golf_api import jobs
    from golf_api.db import session_scope
    from golf_api.models import Job
    from golf_worker.ffmpeg import Canceled

    with session_scope() as db:
        jid = jobs.enqueue(db, "analyze").id
    _claim()

    def handler(job, report):
        with session_scope() as db:
            jobs.cancel(db, db.get(Job, jid))
        import time

        time.sleep(0.5)
        if not report(0.5, "x"):
            raise Canceled()
        return {}

    _run(monkeypatch, jid, handler)
    with session_scope() as db:
        assert db.get(Job, jid).status == "canceled"


def test_keep_awake_while_jobs_run(monkeypatch):
    from golf_worker import awake

    calls = []
    done = threading.Event()

    def fake_set(busy):
        calls.append(busy)
        done.set()

    monkeypatch.setattr(awake.sys, "platform", "win32")
    monkeypatch.setattr(awake, "_set", fake_set)
    monkeypatch.setattr(awake, "_thread", None)
    monkeypatch.setattr(awake, "_running", 0)

    def wait_for(n):
        for _ in range(200):
            if len(calls) >= n:
                return
            done.wait(0.01)
            done.clear()

    with awake.held():
        wait_for(1)
        assert calls == [True]
        with awake.held():          # a second job: still one request
            pass
    wait_for(2)
    assert calls == [True, False]   # released when the last job ends
