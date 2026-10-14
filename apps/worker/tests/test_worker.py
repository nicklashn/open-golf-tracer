import base64
import json
import os
from pathlib import Path

import pytest
from testkit import upload

ROOT = Path(__file__).resolve().parents[3]


def _drain(kinds):
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


def test_ingest_makes_proxy_thumbs_waveform(client, tiny_video):
    res = upload(client, tiny_video)
    _drain(["ingest"])
    m = client.get(f"/api/media/{res['media']['id']}").json()
    assert m["status"] == "ready"
    assert {"original", "proxy", "poster", "thumbs", "waveform"} <= set(m["urls"])
    assert m["thumbs"]["count"] >= 2
    proxy = client.get(m["urls"]["proxy"])
    assert proxy.status_code == 200 and proxy.content[4:8] == b"ftyp"
    wf = client.get(m["urls"]["waveform"]).json()
    peaks = base64.b64decode(wf["peaks"])
    assert wf["rate"] == 100 and abs(len(peaks) - 200) <= 2 and max(peaks) > 50


@pytest.mark.slow
@pytest.mark.skipif(not (ROOT / "models" / "yolo26x.pt").exists(), reason="YOLO weights missing")
def test_analysis_job_finds_shots(client):
    import subprocess
    import sys

    vid = ROOT / "tests" / "out" / "multi.mp4"
    if not vid.exists():
        subprocess.run([sys.executable, str(ROOT / "tests" / "make_synthetic.py"), str(vid), "--shots", "3"], check=True)
    res = upload(client, vid)
    _drain(["analyze"])
    doc = client.get(f"/api/projects/{res['projectId']}").json()["document"]
    assert len(doc["shots"]) == 3
    assert all(s["mediaId"] == res["media"]["id"] for s in doc["shots"])
    # The retrack job tracks one shot again from a known strike time.
    r = client.post(f"/api/projects/{res['projectId']}/retrack", json={"mediaId": res["media"]["id"], "impactTime": 11.0})
    assert r.status_code == 200
    _drain(["retrack"])
    jobs = client.get("/api/jobs", params={"project_id": res["projectId"]}).json()["jobs"]
    rt = next(j for j in jobs if j["kind"] == "retrack")
    assert rt["status"] == "succeeded", rt
    assert abs(rt["result"]["shot"]["impactTime"] - 11.0) < 0.05
    os.environ.pop("X", None)
    json.dumps(doc)
