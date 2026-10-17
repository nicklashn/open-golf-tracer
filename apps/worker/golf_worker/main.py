"""Worker loop: claims jobs from the database queue and runs them.

Two lanes run in parallel so a long analysis never blocks proxies for the next upload:
  media lane:    ingest (default 2 at once; 1 on machines with 4 cores or fewer)
  analysis lane: analyze, retrack, tune (GPU; default 1 at once)
How many run at once comes from Settings → Performance (golf_api.performance), read before each claim.

python -m golf_worker [--once] [--lanes media,analysis]
"""
from __future__ import annotations

import argparse
import logging
import os
import socket
import sys
import threading
import time
import traceback
from pathlib import Path

from sqlalchemy import select

ROOT = Path(__file__).resolve().parents[3]
for p in (ROOT, ROOT / "apps" / "api"):
    if str(p) not in sys.path:
        sys.path.insert(0, str(p))

from golf_api import jobs, logging_setup, performance  # noqa: E402
from golf_api.config import settings  # noqa: E402
from golf_api.db import session_scope  # noqa: E402
from golf_api.main import migrate  # noqa: E402
from golf_api.models import Job, Media  # noqa: E402

from .ffmpeg import Canceled  # noqa: E402
from .tasks import HANDLERS  # noqa: E402

log = logging.getLogger("golf.worker")

LANES = {"media": ["ingest"], "analysis": ["analyze", "retrack", "tune"]}
LANE_MAX = {"media": performance.MAX_INGESTS, "analysis": performance.MAX_ANALYSES}
HEARTBEAT_S = 15
ALONE = {"tune"}   # runs with nothing else in its lane: it measures the GPU, and must not fill it under an analysis

_busy: dict[str, list[str]] = {}   # lane -> kinds of the jobs it runs now
_busy_lock = threading.Lock()


def lane_threads(lane: str) -> int:
    """How many jobs of this lane may run now (Settings → Performance, or INGEST_PARALLEL);
    read again before each claim, so a new profile needs no restart."""
    perf, _ = performance.effective()
    return max(1, min(LANE_MAX.get(lane, 1), perf.ingests if lane == "media" else perf.analyses))


def run_job(job_id: str) -> None:
    with session_scope() as db:
        j = db.get(Job, job_id)
        assert j is not None
        job = {**jobs.public(j), "payload": j.payload}
    canceled = threading.Event()
    last = {"p": 0.0, "msg": "", "t": 0.0}
    stop = threading.Event()

    def report(progress: float, message: str) -> bool:
        if progress >= 0:
            last["p"] = progress
        last["msg"] = message
        now = time.monotonic()
        if now - last["t"] > 0.4:              # do not hammer the database
            last["t"] = now
            if not jobs.heartbeat(job_id, last["p"], message):
                canceled.set()
        return not canceled.is_set()

    def beat():
        while not stop.wait(HEARTBEAT_S):
            if not jobs.heartbeat(job_id, last["p"], last["msg"] or None):
                canceled.set()

    t = threading.Thread(target=beat, daemon=True)
    t.start()
    t0 = time.perf_counter()
    try:
        result = HANDLERS[job["kind"]](job, report)
        with session_scope() as db:
            j = db.get(Job, job_id)
            jobs.complete(db, j, result)
        log.info("job %s (%s) done in %.1f s", job_id, job["kind"], time.perf_counter() - t0)
    except Canceled:
        with session_scope() as db:
            j = db.get(Job, job_id)
            j.cancel_requested = True
            jobs.fail(db, j, "Cancelled by the user", retry=False)
        log.info("job %s cancelled", job_id)
    except Exception as exc:
        tb = traceback.format_exc()
        log.error("job %s (%s) failed: %s", job_id, job["kind"], exc)
        jobs.append_log(job_id, tb)
        retry = not isinstance(exc, (LookupError, ValueError))
        with session_scope() as db:
            j = db.get(Job, job_id)
            jobs.fail(db, j, str(exc) or exc.__class__.__name__, retry=retry)
            if j.status == "failed" and j.kind == "ingest" and j.media_id:
                m = db.get(Media, j.media_id)
                if m:
                    m.status = "failed"
    finally:
        stop.set()


def claimable(db, lane: str, kinds: list[str]) -> list[str]:
    """The kinds a free thread of this lane may claim now (call with _busy_lock held). A waiting
    Optimise gets the lane to itself: no new analyses start until it has run, the running ones
    finish first."""
    alone = [k for k in kinds if k in ALONE]
    if not alone:
        return kinds
    busy = _busy.get(lane, [])
    if any(k in ALONE for k in busy):
        return []
    waiting = db.scalars(select(Job.id).where(Job.status == "queued", Job.kind.in_(alone))).first()
    if waiting:
        return [] if busy else alone
    return [k for k in kinds if k not in ALONE]


def lane_loop(name: str, kinds: list[str], once: bool, worker_id: str, slot: int = 0, lane: str = "") -> None:
    idle = 0.5
    lane = lane or name
    while True:
        jid = None
        if slot < lane_threads(lane):
            with session_scope() as db, _busy_lock:
                now = claimable(db, lane, kinds)
                j = jobs.claim(db, now, f"{worker_id}:{name}") if now else None
                if j:
                    jid, kind = j.id, j.kind
                    _busy.setdefault(lane, []).append(kind)
        if jid:
            try:
                run_job(jid)
            finally:
                with _busy_lock:
                    _busy[lane].remove(kind)
            idle = 0.5
            continue
        if once:
            return
        time.sleep(idle)
        idle = min(2.0, idle * 1.5)


def _warm_detector() -> None:
    try:
        from shottracer.detect import get_detector

        from .tasks import apply_performance

        apply_performance()
        get_detector()
        log.info("ball detector ready")
    except Exception as exc:  # noqa: BLE001 - the first analysis will try (and report) again
        log.warning("the ball detector could not be loaded in advance: %s", exc)


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(prog="golf_worker")
    ap.add_argument("--once", action="store_true", help="empty the queue and stop")
    ap.add_argument("--lanes", default="media,analysis")
    a = ap.parse_args(argv)
    logging_setup.setup(settings().log_level)
    migrate()
    with session_scope() as db:
        n = jobs.requeue_stale(db)
        if n:
            log.info("%d interrupted jobs queued again", n)
    worker_id = f"{socket.gethostname()}-{os.getpid()}"
    lanes = [x.strip() for x in a.lanes.split(",") if x.strip() in LANES]
    if "analysis" in lanes and not a.once:
        # Load the ball detector now (torch + weights take 20-50 s cold), not when the first
        # video is waiting for its analysis.
        threading.Thread(target=_warm_detector, daemon=True).start()
    log.info("worker %s starting with lanes: %s", worker_id, ", ".join(f"{ln} x{lane_threads(ln)} (up to {LANE_MAX[ln]})" for ln in lanes))
    # Up to LANE_MAX threads per lane; the performance profile decides how many of them claim jobs.
    threads = [threading.Thread(target=lane_loop, args=(ln if i == 0 else f"{ln}{i + 1}", LANES[ln], a.once, worker_id, i, ln), daemon=True)
               for ln in lanes for i in range(LANE_MAX[ln] if not a.once else lane_threads(ln))]
    for t in threads:
        t.start()
    try:
        for t in threads:
            while t.is_alive():
                t.join(0.5)
    except KeyboardInterrupt:
        log.info("worker stopping")
    return 0


if __name__ == "__main__":
    sys.exit(main())
