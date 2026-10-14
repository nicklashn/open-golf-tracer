import importlib.util
import os
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "api" / "tests"))

from testkit import app, client, env, tiny_video  # noqa: E402,F401

# YOLO (requirements-yolo.txt) is optional; without it the tests run on RF-DETR.
YOLO = Path(__file__).resolve().parents[3] / "models" / "yolo26x.pt"
HAS_YOLO = YOLO.exists() and importlib.util.find_spec("ultralytics") is not None


@pytest.fixture(autouse=True)
def _yolo_for_drawn_videos(monkeypatch):
    """The analysis tests use drawn videos whose ball is a flat dot; RF-DETR finds it but with
    ~0.1 confidence, so they run on YOLO when its weights are present (see test_engine.py)."""
    if HAS_YOLO and not os.environ.get("GOLF_DETECTOR"):
        monkeypatch.setenv("GOLF_DETECTOR", "yolo")
    from shottracer.detect import get_detector

    get_detector.cache_clear()
    yield
    get_detector.cache_clear()
