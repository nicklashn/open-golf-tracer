"""Golfer and address-ball detection with a COCO-pretrained model (RF-DETR by default, YOLO optional).

COCO's "sports ball" class finds a golf ball at address reasonably well once we
zoom into the region around the golfer's feet. A classical white-blob search is
the fallback when the network finds nothing.
"""
from __future__ import annotations

import functools
import threading
from dataclasses import dataclass
from pathlib import Path
from typing import Any

import cv2
import numpy as np

PERSON, SPORTS_BALL = 0, 32
MODELS_DIR = Path(__file__).resolve().parent.parent / "models"
MODEL_CANDIDATES = ("yolo26x.pt", "yolo11x.pt")


@dataclass
class Box:
    x1: float
    y1: float
    x2: float
    y2: float
    conf: float = 1.0

    @property
    def w(self) -> float:
        return self.x2 - self.x1

    @property
    def h(self) -> float:
        return self.y2 - self.y1

    @property
    def center(self) -> tuple[float, float]:
        return (self.x1 + self.x2) / 2, (self.y1 + self.y2) / 2

    def scaled(self, s: float) -> Box:
        return Box(self.x1 * s, self.y1 * s, self.x2 * s, self.y2 * s, self.conf)


@dataclass
class Ball:
    x: float
    y: float
    r: float
    conf: float
    source: str  # "rf-detr", "yolo", "blob" or "manual"


@functools.cache
def load_model(name: str | None = None):
    import torch
    from ultralytics import YOLO

    MODELS_DIR.mkdir(exist_ok=True)
    errors = []
    for cand in ([name] if name else MODEL_CANDIDATES):
        try:
            model = YOLO(str(MODELS_DIR / cand))
            model.to("cuda" if torch.cuda.is_available() else "cpu")
            return model
        except Exception as exc:  # weights for a newer family may not exist in this ultralytics version
            errors.append(f"{cand}: {exc}")
    raise RuntimeError("Could not load a YOLO model:\n" + "\n".join(errors))


def _predict(model, img: np.ndarray, classes: list[int], imgsz: int, conf: float) -> list[tuple[int, Box]]:
    res = model.predict(img, imgsz=imgsz, conf=conf, classes=classes, verbose=False)[0]
    out = []
    for (x1, y1, x2, y2), c, k in zip(res.boxes.xyxy.tolist(), res.boxes.conf.tolist(), res.boxes.cls.tolist()):
        out.append((int(k), Box(x1, y1, x2, y2, c)))
    return out


def detect_people(model, img: np.ndarray, imgsz: int = 1280) -> list[Box]:
    return [b for k, b in _predict(model, img, [PERSON], imgsz, 0.25) if k == PERSON]


def pick_golfer(people: list[Box], width: int, height: int) -> Box | None:
    """The golfer is usually the largest, most central person in frame. Small figures are
    players further down the course, never the golfer (a 67 px one in a 1920 px frame once
    sent the ball search to the wrong feet)."""
    people = [b for b in people if b.h >= 0.15 * height]
    if not people:
        return None

    def score(b: Box) -> float:
        cx, cy = b.center
        centrality = 1 - min(1.0, abs(cx - width / 2) / (width / 2))
        return b.w * b.h * (0.5 + centrality)

    return max(people, key=score)


def feet_roi(golfer: Box, width: int, height: int) -> Box:
    # Sideways reach scales with the golfer's height: the box width shrinks mid-swing, and
    # face-on the ball sits well in front of the feet (a real clip had it 0.75 widths out).
    reach = max(0.7 * golfer.w, 0.5 * golfer.h)
    return Box(max(0, golfer.x1 - reach), max(0, golfer.y1 + 0.5 * golfer.h),
               min(width, golfer.x2 + reach), min(height, golfer.y2 + 0.3 * golfer.h))


def _blob_ball(gray: np.ndarray, roi: Box, diag: float) -> Ball | None:
    """White, round, small blob – the classic look of a golf ball on grass/mat."""
    x1, y1, x2, y2 = int(roi.x1), int(roi.y1), int(roi.x2), int(roi.y2)
    crop = gray[y1:y2, x1:x2]
    if crop.size == 0:
        return None
    k = max(5, int(diag * 0.008) | 1)
    tophat = cv2.morphologyEx(crop, cv2.MORPH_TOPHAT, cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (k, k)))
    thr = max(35.0, float(np.percentile(tophat, 99.7)))
    bw = (tophat >= thr).astype(np.uint8)
    n, lab, stats, cent = cv2.connectedComponentsWithStats(bw, 8)
    best, best_score = None, 0.0
    max_area = (diag * 0.012) ** 2
    for i in range(1, n):
        x, y, w, h, area = stats[i]
        if area < 3 or area > max_area or max(w, h) > 2.5 * min(w, h) + 1:
            continue
        fill = area / float(w * h)
        bright = float(crop[lab == i].mean())
        s = bright * fill * (1 + 0.5 * (y + h) / crop.shape[0])  # balls sit low in the ROI
        if s > best_score:
            best_score = s
            best = Ball(x1 + cent[i][0], y1 + cent[i][1], max(1.5, (w + h) / 4), 0.2, "blob")
    return best


def find_ball(model, frame: np.ndarray, golfer: Box | None, allow_blob: bool = True) -> Ball | None:
    return search_ball(lambda img: [b for _, b in _predict(model, img, [SPORTS_BALL], 1280, 0.05)],
                       frame, golfer, allow_blob, "yolo")


def search_ball(predict_balls, frame: np.ndarray, golfer: Box | None, allow_blob: bool, source: str) -> Ball | None:
    """Most confident sports-ball box near the golfer's feet, from the whole frame and a zoomed
    crop. `predict_balls(img)` returns the detector's sports-ball boxes in img's pixels."""
    h, w = frame.shape[:2]
    diag = float(np.hypot(w, h))
    roi = feet_roi(golfer, w, h) if golfer else Box(0, h * 0.4, w, h)
    max_side = diag * 0.04

    best: Ball | None = None

    def consider(b: Box, ox: float = 0, oy: float = 0):
        nonlocal best
        if max(b.w, b.h) > max_side:
            return
        cx, cy = b.center[0] + ox, b.center[1] + oy
        if not (roi.x1 <= cx <= roi.x2 and roi.y1 <= cy <= roi.y2):
            return
        if best is None or b.conf > best.conf:
            best = Ball(cx, cy, max(1.5, (b.w + b.h) / 4), b.conf, source)

    for b in predict_balls(frame):
        consider(b)
    # Zoomed pass on the feet region: the network sees the ball at 2-4x the pixel size.
    crop = frame[int(roi.y1):int(roi.y2), int(roi.x1):int(roi.x2)]
    if crop.size:
        for b in predict_balls(crop):
            consider(b, roi.x1, roi.y1)
    if best is None and golfer is not None:
        # The "golfer" may be someone else (or cut off): search the lower frame instead.
        best = search_ball(predict_balls, frame, None, False, source)
    if best is None and allow_blob:
        best = _blob_ball(cv2.cvtColor(frame, cv2.COLOR_BGR2GRAY), roi, diag)
    return best


# --- detector interface ----------------------------------------------------------------------
# The default is RF-DETR (Apache-2.0). Ultralytics YOLO (AGPL-3.0) stays available as
# GOLF_DETECTOR=yolo; see docs/licensing.md. Custom detectors: GOLF_DETECTOR=<module>:<class>.

class BallDetector:
    """Finds people (to locate the golfer) and the ball at address."""

    name = "base"

    def people(self, img: np.ndarray) -> list[Box]:
        raise NotImplementedError

    def ball(self, frame: np.ndarray, golfer: Box | None, allow_blob: bool = True) -> Ball | None:
        raise NotImplementedError


class YoloBallDetector(BallDetector):
    name = "ultralytics-yolo"

    def __init__(self, weights: str | None = None):
        self.model = load_model(weights)

    def people(self, img: np.ndarray) -> list[Box]:
        return detect_people(self.model, img)

    def ball(self, frame: np.ndarray, golfer: Box | None, allow_blob: bool = True) -> Ball | None:
        return find_ball(self.model, frame, golfer, allow_blob)


# RF-DETR reports original COCO category ids (1..90 with gaps); class_names is the 80-list.
_COCO91 = (*range(1, 12), *range(13, 26), 27, 28, *range(31, 45), *range(46, 66), 67, 70,
           *range(72, 83), *range(84, 91))


class RfDetrBallDetector(BallDetector):
    """RF-DETR Large, COCO-pretrained (Apache-2.0). Matched YOLO on the reference clips."""

    name = "rf-detr"

    def __init__(self):
        try:  # use the OS certificate store: some PCs intercept HTTPS (antivirus) for the weights download
            import truststore

            truststore.inject_into_ssl()
        except ImportError:
            pass
        from rfdetr import RFDETRLarge

        self.model = RFDETRLarge()
        self.names = dict(zip(_COCO91, self.model.class_names))

    def _predict(self, img: np.ndarray, conf: float) -> list[tuple[str, Box]]:
        det: Any = self.model.predict(cv2.cvtColor(img, cv2.COLOR_BGR2RGB), threshold=conf)  # one image -> Detections
        return [(self.names.get(int(k), ""), Box(float(x1), float(y1), float(x2), float(y2), float(c)))
                for (x1, y1, x2, y2), c, k in zip(det.xyxy, det.confidence, det.class_id)]

    def people(self, img: np.ndarray) -> list[Box]:
        return [b for k, b in self._predict(img, 0.25) if k == "person"]

    def ball(self, frame: np.ndarray, golfer: Box | None, allow_blob: bool = True) -> Ball | None:
        return search_ball(lambda img: [b for k, b in self._predict(img, 0.05) if k == "sports ball"],
                           frame, golfer, allow_blob, "rf-detr")


ONNX_MODEL = MODELS_DIR / "rf-detr-large.onnx"
# RF-DETR Large (COCO, Apache-2.0) exported with scripts/export_onnx.py (rfdetr 1.11.2, opset 17).
ONNX_URL = "https://github.com/nicklashn/open-golf-tracer/releases/download/models-v1/rf-detr-large.onnx"
ONNX_SHA256 = "7079f2aa7c8dcbd7b7e0a1368dd6a574e62a225516b62d9c3a1503282ddd1682"


def onnx_model_path() -> Path:
    import os

    return Path(os.environ.get("GOLF_ONNX_MODEL", "") or ONNX_MODEL)


def _sha256(path: Path) -> str:
    import hashlib

    h = hashlib.sha256()
    with path.open("rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def ensure_onnx_model() -> Path:
    """The ONNX model, downloaded (and checked against ONNX_SHA256) the first time it is needed.
    A GOLF_ONNX_MODEL of your own is used as it is."""
    import os
    import urllib.request

    path = onnx_model_path()
    if path.exists() or os.environ.get("GOLF_ONNX_MODEL"):
        return path
    try:  # use the OS certificate store: some PCs intercept HTTPS (antivirus)
        import truststore

        truststore.inject_into_ssl()
    except ImportError:
        pass
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(".part")
    with urllib.request.urlopen(ONNX_URL, timeout=60) as r, tmp.open("wb") as f:
        while chunk := r.read(1 << 20):
            f.write(chunk)
    if _sha256(tmp) != ONNX_SHA256:
        tmp.unlink()
        raise RuntimeError(f"Checksum mismatch for {ONNX_URL}")
    tmp.replace(path)
    return path


class OnnxRfDetrBallDetector(RfDetrBallDetector):
    """The same RF-DETR Large, exported to ONNX (scripts/export_onnx.py) and run with ONNX Runtime:
    no PyTorch needed (~40 MB instead of ~4 GB). On Windows the DirectML provider uses any GPU
    (NVIDIA, AMD, Intel); otherwise the CPU. Pre- and post-processing mirror rfdetr's predict()."""

    name = "rf-detr-onnx"
    RESOLUTION = 704
    MEAN = np.array([0.485, 0.456, 0.406], np.float32)
    STD = np.array([0.229, 0.224, 0.225], np.float32)
    NUM_SELECT = 300

    def __init__(self, model: Path | None = None):
        import onnxruntime as ort

        path = model or ensure_onnx_model()
        available = ort.get_available_providers()
        providers = [p for p in ("DmlExecutionProvider", "CUDAExecutionProvider") if p in available]
        opts = ort.SessionOptions()
        if "DmlExecutionProvider" in providers:  # DirectML needs these (ORT docs)
            opts.enable_mem_pattern = False
            opts.execution_mode = ort.ExecutionMode.ORT_SEQUENTIAL
        try:
            self.session = ort.InferenceSession(str(path), opts, providers=[*providers, "CPUExecutionProvider"])
        except Exception:  # a broken GPU driver must not stop the analysis
            self.session = ort.InferenceSession(str(path), providers=["CPUExecutionProvider"])
        self.provider = self.session.get_providers()[0]
        self.input = self.session.get_inputs()[0].name
        self._run_lock = threading.Lock()  # DirectML sessions do not support concurrent Run calls
        # COCO category ids, as RF-DETR reports them (see _COCO91); only these two are used.
        self.names = {1: "person", 37: "sports ball"}

    def _predict(self, img: np.ndarray, conf: float) -> list[tuple[str, Box]]:
        h, w = img.shape[:2]
        # rfdetr: RGB in [0, 1], bilinear resize without antialiasing, ImageNet normalisation.
        rgb = cv2.cvtColor(img, cv2.COLOR_BGR2RGB).astype(np.float32) / 255
        x = cv2.resize(rgb, (self.RESOLUTION, self.RESOLUTION), interpolation=cv2.INTER_LINEAR)
        x = ((x - self.MEAN) / self.STD).transpose(2, 0, 1)[None]
        with self._run_lock:
            boxes, logits = self.session.run(None, {self.input: np.ascontiguousarray(x, np.float32)})
        prob = 1 / (1 + np.exp(-logits[0].astype(np.float64)))  # (queries, classes)
        flat = prob.ravel()
        top = np.argsort(-flat, kind="stable")[: self.NUM_SELECT]
        scores, query, label = flat[top], top // prob.shape[1], top % prob.shape[1]
        keep = scores > conf
        cx, cy, bw, bh = boxes[0][query[keep]].T.astype(np.float64)
        bw, bh = np.clip(bw, 0, None), np.clip(bh, 0, None)
        x1 = np.clip((cx - bw / 2) * w, 0, w)
        y1 = np.clip((cy - bh / 2) * h, 0, h)
        x2 = np.clip((cx + bw / 2) * w, 0, w)
        y2 = np.clip((cy + bh / 2) * h, 0, h)
        return [(self.names.get(int(k), ""), Box(float(a), float(b), float(c), float(d), float(s)))
                for a, b, c, d, s, k in zip(x1, y1, x2, y2, scores[keep], label[keep])]


class BlobBallDetector(BallDetector):
    """Licence-free fallback without a neural network: no people, white-blob ball search.
    Much less reliable; meant for tests and as a template for a custom detector."""

    name = "blob"

    def people(self, img: np.ndarray) -> list[Box]:
        return []

    def ball(self, frame: np.ndarray, golfer: Box | None, allow_blob: bool = True) -> Ball | None:
        h, w = frame.shape[:2]
        return _blob_ball(cv2.cvtColor(frame, cv2.COLOR_BGR2GRAY), Box(0, h * 0.4, w, h), float(np.hypot(w, h)))


_detector_lock = threading.Lock()


def get_detector(weights: str | None = None) -> BallDetector:
    """The process's detector (loaded once; a lock so a warm-up thread and the first job do
    not both load the model)."""
    with _detector_lock:
        return _make_detector(weights)


get_detector.cache_clear = lambda: _make_detector.cache_clear()  # type: ignore[attr-defined]


@functools.cache
def _make_detector(weights: str | None = None) -> BallDetector:
    import importlib
    import importlib.util
    import os

    spec = os.environ.get("GOLF_DETECTOR", "").strip().lower()
    if spec == "blob":
        return BlobBallDetector()
    if spec == "yolo" or (weights and not spec):  # explicit YOLO weights (--model) mean YOLO
        return YoloBallDetector(weights)
    if spec in ("rfdetr-onnx", "onnx"):
        return OnnxRfDetrBallDetector()
    if spec in ("rfdetr-torch", "torch"):
        return RfDetrBallDetector()
    if spec and spec not in ("rfdetr", "rf-detr"):
        mod, _, cls = os.environ["GOLF_DETECTOR"].strip().partition(":")
        return getattr(importlib.import_module(mod), cls)()
    # RF-DETR as ONNX (no PyTorch needed); the PyTorch version only when ONNX Runtime is missing.
    if importlib.util.find_spec("onnxruntime") or not importlib.util.find_spec("rfdetr"):
        return OnnxRfDetrBallDetector()
    return RfDetrBallDetector()
