from __future__ import annotations

import subprocess
from pathlib import Path

import pytest
from fastapi.testclient import TestClient


@pytest.fixture()
def env(tmp_path, monkeypatch):
    monkeypatch.setenv("DATA_DIR", str(tmp_path / "data"))
    monkeypatch.setenv("APP_ENV", "test")
    monkeypatch.delenv("DATABASE_URL", raising=False)
    from golf_api import config, db, storage

    config.settings.cache_clear()
    storage.storage.cache_clear()
    db.reset_engine()
    yield tmp_path
    db.reset_engine()
    config.settings.cache_clear()


@pytest.fixture()
def app(env):
    from golf_api.main import create_app

    return create_app()


@pytest.fixture()
def client(app):
    with TestClient(app, base_url="http://localhost") as c:
        yield c


def local_user(c: TestClient) -> dict:
    """The single local user every request acts as (there is no login)."""
    r = c.get("/api/account")
    assert r.status_code == 200, r.text
    return r.json()["user"]


@pytest.fixture(scope="session")
def tiny_video(tmp_path_factory) -> Path:
    p = tmp_path_factory.mktemp("media") / "clip.mp4"
    subprocess.run(["ffmpeg", "-v", "error", "-y", "-f", "lavfi", "-i", "testsrc2=size=320x180:rate=30:duration=2",
                    "-f", "lavfi", "-i", "sine=frequency=440:duration=2", "-c:v", "libx264", "-pix_fmt", "yuv420p",
                    "-c:a", "aac", "-shortest", str(p)], check=True)
    return p


def upload(c: TestClient, path: Path, kind="video", project_id=None, chunk_order=None) -> dict:
    data = path.read_bytes()
    r = c.post("/api/uploads", json={"filename": path.name, "size": len(data), "kind": kind, "projectId": project_id})
    assert r.status_code == 200, r.text
    up = r.json()
    cs = up["chunkSize"]
    order = chunk_order or range(up["chunks"])
    for i in order:
        rr = c.put(f"/api/uploads/{up['id']}/chunks/{i}", content=data[i * cs:(i + 1) * cs],
                   headers={"content-type": "application/octet-stream"})
        assert rr.status_code == 200, rr.text
    r = c.post(f"/api/uploads/{up['id']}/complete")
    assert r.status_code == 200, r.text
    return r.json()
