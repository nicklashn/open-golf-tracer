import os
from pathlib import Path
from types import SimpleNamespace

import numpy as np
import pytest

from shottracer.detect import Box, OnnxRfDetrBallDetector, feet_roi


class FakeSession:
    """Stands in for an onnxruntime session: input shape [batch, 3, 704, 704]."""

    def __init__(self, batch="batch"):
        self.shape = [batch, 3, 704, 704]
        self.calls = []

    def get_inputs(self):
        return [SimpleNamespace(name="input", shape=self.shape)]

    def run(self, _outputs, feeds):
        """Each image's outputs depend only on that image (as a real network's), so batching
        must not change them."""
        x = feeds["input"]
        self.calls.append(len(x))
        logits = np.full((len(x), 300, 91), -10.0, np.float32)
        boxes = np.zeros((len(x), 300, 4), np.float32)
        for b in range(len(x)):
            m = x[b].mean(axis=(1, 2))
            logits[b, 5, 37] = m[0]                       # a "sports ball"
            boxes[b, 5] = (0.5 + 0.05 * m[1], 0.75, 0.01, 0.02)
            logits[b, 9, 1] = 2.0 + m[2]                  # a "person"
            boxes[b, 9] = (0.25, 0.5 + 0.05 * m[0], 0.2, 0.6)
        return [boxes, logits]


def test_feet_roi_reaches_a_face_on_ball_mid_swing():
    """Real face-on clip: golfer box 268 x 626 px mid-backswing, ball 0.75 box widths to the right."""
    golfer = Box(20, 675, 288, 1301)
    roi = feet_roi(golfer, 1080, 1920)
    assert roi.x1 <= 492 <= roi.x2 and roi.y1 <= 1245 <= roi.y2
    # ...but not out to the cup 330 px further away.
    assert roi.x2 < 621


def test_far_away_players_are_not_the_golfer():
    from shottracer.detect import pick_golfer

    far = Box(735, 786, 749, 853)  # someone down the fairway in a 1080x1920 clip
    assert pick_golfer([far], 1080, 1920) is None
    golfer = Box(300, 900, 600, 1700)
    assert pick_golfer([far, golfer], 1080, 1920) is golfer


def test_onnx_postprocessing_matches_rfdetr():
    """Sigmoid scores, COCO ids from the flat top-k index, cxcywh boxes scaled to the image
    (as rfdetr's PostProcess), without running a real model."""
    import numpy as np

    from shottracer.detect import OnnxRfDetrBallDetector

    logits = np.full((1, 300, 91), -10.0, np.float32)
    boxes = np.zeros((1, 300, 4), np.float32)
    logits[0, 5, 37] = 0.0  # sports ball, sigmoid 0.5
    boxes[0, 5] = (0.5, 0.75, 0.01, 0.02)
    logits[0, 9, 1] = 2.0  # person, sigmoid 0.88
    boxes[0, 9] = (0.25, 0.5, 0.2, 1.4)  # taller than the image: clamped

    class Session(FakeSession):
        def run(self, _outputs, feeds):
            assert feeds["input"].shape == (1, 3, 704, 704)
            return [boxes, logits]

    det = OnnxRfDetrBallDetector.__new__(OnnxRfDetrBallDetector)
    det._init([Session()])
    out = det._predict(np.zeros((1000, 2000, 3), np.uint8), 0.05)
    assert [k for k, _ in out] == ["person", "sports ball"]
    person, ball = out[0][1], out[1][1]
    assert abs(person.conf - 0.8808) < 1e-3
    assert np.allclose((person.x1, person.y1, person.x2, person.y2), (300, 0, 700, 1000))
    assert abs(ball.conf - 0.5) < 1e-6
    assert np.allclose((ball.x1, ball.y1, ball.x2, ball.y2), (990, 740, 1010, 760))


def _fake_detector(sessions: int = 1, batch: int = 1, dim="batch") -> OnnxRfDetrBallDetector:
    det = OnnxRfDetrBallDetector.__new__(OnnxRfDetrBallDetector)
    det._init([FakeSession(dim) for _ in range(sessions)], batch)
    return det


def _images(n: int) -> list[np.ndarray]:
    rng = np.random.default_rng(3)
    return [rng.integers(0, 255, (360 + 8 * i, 640, 3), np.uint8) for i in range(n)]


def _key(people):
    return [[(round(b.x1, 6), round(b.y1, 6), round(b.x2, 6), round(b.y2, 6), round(b.conf, 9)) for b in p] for p in people]


def test_batched_and_parallel_detections_equal_one_by_one():
    imgs = _images(7)
    one = _fake_detector()
    ref = [one.people(img) for img in imgs]
    for sessions, batch in ((1, 4), (2, 1), (3, 2)):
        det = _fake_detector(sessions, batch)
        assert _key(det.people_many(imgs)) == _key(ref)
        calls = [c for s in _sessions(det) for c in s.calls]
        assert sum(calls) == len(imgs) and max(calls) <= batch
    # A model with a fixed batch of 1 never gets more than one frame per call.
    det = _fake_detector(1, 4, dim=1)
    assert det.batch == 1 and _key(det.people_many(imgs)) == _key(ref)


def _sessions(det):
    out = []
    while not det._free.empty():
        out.append(det._free.get())
    for s in out:
        det._free.put(s)
    return out


def test_people_and_ball_on_one_frame_run_the_network_once():
    det = _fake_detector()
    frame = _images(1)[0]
    det.people(frame)
    det._predict(frame, 0.05)            # ball(): the same full frame, a lower threshold
    det._predict(frame[100:300, 0:400], 0.05)   # the zoomed crop is a new image
    assert _sessions(det)[0].calls == [1, 1]


ONNX = Path(os.environ.get("GOLF_ONNX_MODEL", "") or Path(__file__).resolve().parents[2] / "models" / "rf-detr-large.onnx")


@pytest.mark.skipif(not ONNX.exists(), reason="RF-DETR ONNX model not downloaded")
def test_real_model_parallel_sessions_match_one_session():
    pytest.importorskip("onnxruntime")
    from shottracer.runtime import Runtime

    rng = np.random.default_rng(0)
    imgs = [rng.integers(0, 255, (540, 960, 3), np.uint8) for _ in range(3)]
    one = OnnxRfDetrBallDetector(ONNX, Runtime(gpu=False))
    two = OnnxRfDetrBallDetector(ONNX, Runtime(sessions=2, threads=2, gpu=False))
    a = [one._predict(img, 0.01) for img in imgs]
    b = [two._predict(img, 0.01) for img in imgs]
    assert [[(k, x.x1, x.y1, x.conf) for k, x in d] for d in a] == [[(k, x.x1, x.y1, x.conf) for k, x in d] for d in b]
    assert _key(one.people_many(imgs)) == _key(two.people_many(imgs))


def test_preprocessing_matches_rfdetr():
    """Resizing before the scaling (the fast way) gives rfdetr's numbers: RGB in [0, 1], bilinear
    resize, ImageNet normalisation, CHW."""
    import cv2

    img = _images(1)[0]
    rgb = cv2.cvtColor(img, cv2.COLOR_BGR2RGB).astype(np.float32) / 255
    x = cv2.resize(rgb, (704, 704), interpolation=cv2.INTER_LINEAR)
    ref = ((x - OnnxRfDetrBallDetector.MEAN) / OnnxRfDetrBallDetector.STD).transpose(2, 0, 1)
    out = _fake_detector()._prep(img)
    assert out.shape == (3, 704, 704) and out.dtype == np.float32 and out.flags.c_contiguous
    assert np.abs(out - ref).max() < 1e-4


class DmlSession(FakeSession):
    """A DirectML session that notices Run calls overlapping with any other DirectML session's."""
    running = [0]
    overlaps = [0]

    def get_providers(self):
        return ["DmlExecutionProvider", "CPUExecutionProvider"]

    def run(self, _outputs, feeds):
        import time

        DmlSession.running[0] += 1
        if DmlSession.running[0] > 1:
            DmlSession.overlaps[0] += 1
        time.sleep(0.005)
        try:
            return super().run(_outputs, feeds)
        finally:
            DmlSession.running[0] -= 1


def test_directml_runs_one_call_at_a_time_across_sessions_and_detectors():
    """Two DirectML sessions running at once failed on an RTX 5070 (DmlFusedNode); an old and a
    new detector (a profile change during an analysis) must not overlap either."""
    from concurrent.futures import ThreadPoolExecutor

    a, b = (OnnxRfDetrBallDetector.__new__(OnnxRfDetrBallDetector) for _ in range(2))
    a._init([DmlSession(), DmlSession()])
    b._init([DmlSession()])
    assert a.provider == "DmlExecutionProvider" and b.parallel == 2   # a second caller prepares the next frame
    imgs = _images(6)
    DmlSession.overlaps[0] = 0
    with ThreadPoolExecutor(4) as ex:
        list(ex.map(lambda d: d.people_many(imgs), [a, b, a, b]))
    assert DmlSession.overlaps[0] == 0


def test_directml_gets_one_session_and_reports_why_sessions_failed(monkeypatch):
    import sys

    from shottracer.runtime import Runtime

    made = []

    class FakeOrt(SimpleNamespace):
        class ExecutionMode:
            ORT_SEQUENTIAL = "seq"

        @staticmethod
        def SessionOptions():  # noqa: N802 - onnxruntime's name
            return SimpleNamespace()

        @staticmethod
        def InferenceSession(path, opts, providers):  # noqa: N802
            made.append((providers, opts))
            if "CUDAExecutionProvider" in providers and len(made) == 2:
                raise RuntimeError("CUDA failure 2: out of memory")
            return FakeSession()

    ort = FakeOrt(get_available_providers=lambda: ["DmlExecutionProvider", "CPUExecutionProvider"])
    monkeypatch.setitem(sys.modules, "onnxruntime", ort)
    det = OnnxRfDetrBallDetector(Path("x.onnx"), Runtime(sessions=3))
    assert det.sessions == 1 and len(made) == 1 and made[0][0][0] == "DmlExecutionProvider"
    assert made[0][1].enable_mem_pattern is False and made[0][1].execution_mode == "seq"   # the DirectML rules

    made.clear()
    ort.get_available_providers = lambda: ["CUDAExecutionProvider", "CPUExecutionProvider"]
    det = OnnxRfDetrBallDetector(Path("x.onnx"), Runtime(sessions=3))
    assert det.sessions == 1 and "out of memory" in (det.session_error or "")
