"""Sample project with a bundled demo video, so new users can try the editor without their own clip."""
from __future__ import annotations

import copy
import json
import shutil

from sqlalchemy.orm import Session

from . import jobs
from .config import ROOT
from .documents import clean_shot, new_document
from .errors import ApiError
from .models import Media, Project, User
from .probe import probe_file
from .storage import media_prefix, storage, tmp_dir

DEMO_DIR = ROOT / "assets" / "demo"


def create_demo_project(db: Session, user: User) -> Project:
    video = DEMO_DIR / "demo.mp4"
    if not video.exists():
        raise ApiError(503, "demo_missing", "The demo video is missing. Run setup again.")
    p = Project(user_id=user.id, name="Example: drive at the range", is_demo=True)
    db.add(p)
    db.flush()
    info = probe_file(video)
    m = Media(user_id=user.id, project_id=p.id, kind="video", filename="demo.mp4", size=0, storage_key="", probe=info, status="processing")
    db.add(m)
    db.flush()
    m.storage_key = f"{media_prefix(user.id, m.id)}/original.mp4"
    tmp = tmp_dir() / f"demo-{m.id}.mp4"
    shutil.copyfile(video, tmp)
    storage().put_file(m.storage_key, tmp, move=True)
    doc = new_document(p.name, m)
    analysis_file = DEMO_DIR / "demo.analysis.json"
    if analysis_file.exists():
        # Precomputed analysis: the demo works instantly, even without the GPU model.
        res = json.loads(analysis_file.read_text(encoding="utf-8"))
        shots = [clean_shot(copy.deepcopy(s), m.id) for s in res.get("shots", [])]
        p.analysis = {m.id: {"shots": shots, "warnings": res.get("warnings", [])}}
        jobs.enqueue(db, "ingest", {"media_id": m.id}, user_id=user.id, project_id=p.id, media_id=m.id)
    else:
        jobs.enqueue(db, "ingest", {"media_id": m.id}, user_id=user.id, project_id=p.id, media_id=m.id)
        jobs.enqueue(db, "analyze", {"media_id": m.id}, user_id=user.id, project_id=p.id, media_id=m.id)
    p.document = doc
    p.doc_version = 1
    db.commit()
    return p
