"""Make a video for me: the compose job, its wait for answers and the exporter's endpoints."""
from testkit import upload


def _internal():
    from golf_api.config import settings

    return {"authorization": f"Bearer {settings().internal_token}"}


def _round(client, tiny_video):
    p = client.post("/api/projects", json={"name": "Runde"}).json()
    media = upload(client, tiny_video, project_id=p["id"])["media"]["id"]
    return p, media


def _finish_media_jobs(project_id):
    from golf_api.db import session_scope
    from golf_api.models import Job

    with session_scope() as db:
        for j in db.query(Job).filter(Job.project_id == project_id, Job.kind != "compose").all():
            j.status = "succeeded"


def test_start_ask_answer_and_derive(client, tiny_video):
    p, media = _round(client, tiny_video)
    auth = _internal()
    r = client.post("/api/autovideo", json={"projectId": p["id"], "preference": "YouTube, kun gode slag", "locale": "da",
                                           "names": {"statCard": "Tal"}})
    assert r.status_code == 200, r.text
    job = r.json()
    assert job["kind"] == "compose" and job["status"] == "queued"

    # The exporter claims it; ingest/analysis still running, so it waits.
    claimed = client.post("/api/internal/jobs/claim", json={"kinds": ["compose"], "worker": "x"}, headers=auth).json()["job"]
    assert claimed["id"] == job["id"]
    assert claimed["payload"]["preference"] == "YouTube, kun gode slag" and claimed["payload"]["names"] == {"statCard": "Tal"}
    info = client.get(f"/api/internal/jobs/{job['id']}/project", headers=auth).json()
    assert info["pending"] == 2 and media in info["document"]["media"]
    assert client.post(f"/api/internal/jobs/{job['id']}/defer", json={"seconds": 1, "message": "Waiting for analysis"},
                       headers=auth).json()["status"] == "queued"

    _finish_media_jobs(p["id"])
    assert client.get(f"/api/internal/jobs/{job['id']}/project", headers=auth).json()["pending"] == 0

    # Questions: the job parks and shows them to the user.
    plan = {"kind": "youtube", "title": "Runde", "includeShotIds": [], "questions": [{"id": "doubtful", "text": "?",
            "options": [{"id": "keep", "label": "Ja"}, {"id": "drop", "label": "Nej"}], "default": "keep"}]}
    client.post(f"/api/internal/jobs/{job['id']}/await", json={"result": {"plan": plan, "questions": plan["questions"]}}, headers=auth)
    listed = client.get("/api/jobs", params={"project_id": p["id"], "active": True}).json()["jobs"]
    waiting = next(j for j in listed if j["id"] == job["id"])
    assert waiting["status"] == "awaiting_answers" and waiting["result"]["questions"][0]["id"] == "doubtful"
    # Nobody can claim it while it waits.
    assert client.post("/api/internal/jobs/claim", json={"kinds": ["compose"], "worker": "x"}, headers=auth).json()["job"] is None

    r = client.post(f"/api/jobs/{job['id']}/answers", json={"answers": {"doubtful": "drop"}})
    assert r.status_code == 200 and r.json()["status"] == "queued"
    assert client.post(f"/api/jobs/{job['id']}/answers", json={"answers": {}}).status_code == 409

    from golf_api.db import session_scope
    from golf_api.models import Job

    with session_scope() as db:
        j = db.get(Job, job["id"])
        j.run_after = j.created_at
    claimed = client.post("/api/internal/jobs/claim", json={"kinds": ["compose"], "worker": "x"}, headers=auth).json()["job"]
    assert claimed["payload"]["answers"] == {"doubtful": "drop"} and claimed["payload"]["plan"]["title"] == "Runde"

    # The generated video becomes a new project with its own media rows.
    doc = client.get(f"/api/projects/{p['id']}").json()["document"]
    made = client.post(f"/api/internal/jobs/{job['id']}/derive", json={"name": "Runde – YouTube", "document": doc}, headers=auth).json()
    loaded = client.get(f"/api/projects/{made['id']}").json()
    assert loaded["name"] == "Runde – YouTube"
    assert set(loaded["document"]["media"]).isdisjoint({media})
    client.post(f"/api/internal/jobs/{job['id']}/complete", json={"result": {"projects": [made]}}, headers=auth)
    assert client.get(f"/api/projects/{p['id']}").json()["document"]["media"].keys() == {media}


def test_cancel_while_waiting_and_unknown_ids(client, tiny_video):
    p, _ = _round(client, tiny_video)
    job = client.post("/api/autovideo", json={"projectId": p["id"]}).json()
    client.post(f"/api/internal/jobs/{job['id']}/await", json={"result": {"questions": []}}, headers=_internal())
    assert client.post(f"/api/jobs/{job['id']}/cancel").json()["status"] == "canceled"

    # Unknown projects and jobs are not found.
    assert client.post("/api/autovideo", json={"projectId": "prj_nope"}).status_code == 404
    assert client.post("/api/jobs/job_nope/answers", json={"answers": {}}).status_code == 404


def test_rejects_clips_from_other_projects_and_oversized_input(client, tiny_video):
    p, _ = _round(client, tiny_video)
    r = client.post("/api/autovideo", json={"projectId": p["id"], "mediaIds": ["med_nope"]})
    assert r.status_code == 422
    r = client.post("/api/autovideo", json={"projectId": p["id"], "preference": "x" * 1001})
    assert r.status_code == 422


def test_answers_take_a_choice_per_shot(client, tiny_video):
    p, _ = _round(client, tiny_video)
    job = client.post("/api/autovideo", json={"projectId": p["id"]}).json()
    client.post(f"/api/internal/jobs/{job['id']}/await", json={"result": {"questions": []}}, headers=_internal())
    answers = {"doubtful": "keep", **{f"shot:s{i}": "drop" for i in range(60)}}
    r = client.post(f"/api/jobs/{job['id']}/answers", json={"answers": answers})
    assert r.status_code == 200, r.text
    too_many = {f"shot:s{i}": "drop" for i in range(300)}
    assert client.post("/api/autovideo", json={"projectId": p["id"], "answers": too_many}).status_code == 422
