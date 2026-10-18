"""Golfer and address-ball detection with a COCO-pretrained model (RF-DETR by default, YOLO optional).

COCO's "sports ball" class finds a golf ball at address reasonably well once we
zoom into the region around the golfer's feet. A classical white-blob search is
the fallback when the network finds nothing.
"""
from __future__ import annotations

import functools
import queue
import threading
from concurrent.futures import ThreadPoolExecutor
from contextlib import nullcontext
from dataclasses import dataclass
from pathlib import Path
from typing import Any

import cv2
import numpy as np

from . import runtime
from .runtime import Runtime

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
    parallel = 1   # inference calls worth running at the same time

    def people(self, img: np.ndarray) -> list[Box]:
        raise NotImplementedError

    def people_many(self, imgs: list[np.ndarray]) -> list[list[Box]]:
        return [self.people(img) for img in imgs]

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


ONNX_SIZE = 121_750_754
_verified: dict[Path, tuple[int, int]] = {}   # model -> (size, mtime_ns) whose hash was checked


def _model_ok(path: Path) -> bool:
    """The model on disk is the published one: size first (cheap), then SHA-256 - once per process
    and file version (size, mtime), so a restart costs one hash (~0.3 s) and no more."""
    try:
        st = path.stat()
    except OSError:
        return False
    stamp = (st.st_size, st.st_mtime_ns)
    if _verified.get(path) == stamp:
        return True
    if st.st_size != ONNX_SIZE or _sha256(path) != ONNX_SHA256:
        return False
    _verified[path] = stamp
    return True


def ensure_onnx_model() -> Path:
    """The ONNX model, checked against ONNX_SHA256 and downloaded when it is missing or damaged
    (a cut-off download, a disk error). A GOLF_ONNX_MODEL of your own is used as it is."""
    import logging
    import os
    import urllib.request

    path = onnx_model_path()
    if os.environ.get("GOLF_ONNX_MODEL") or _model_ok(path):
        return path
    if path.exists():
        logging.getLogger(__name__).warning("%s does not match the published model; downloading it again", path)
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
    _verified.pop(path, None)
    return path


class OnnxRfDetrBallDetector(RfDetrBallDetector):
    """The same RF-DETR Large, exported to ONNX (scripts/export_onnx.py) and run with ONNX Runtime:
    no PyTorch needed (~40 MB instead of ~4 GB). On Windows the DirectML provider uses any GPU
    (NVIDIA, AMD, Intel); otherwise the CPU. Pre- and post-processing mirror rfdetr's predict().

    `Runtime.sessions` sessions may run at once (each costs GPU memory); a model exported with a
    dynamic batch dimension takes up to `Runtime.batch` frames per call (the published one is
    fixed at 1). With DirectML there is one session and one Run call at a time in the process:
    two sessions running side by side failed on an RTX 5070 ("DmlFusedNode ... DmlGraphFusionHelper"),
    though the ORT docs allow it. The GPU stays busy by preparing the next frames meanwhile."""

    name = "rf-detr-onnx"
    RESOLUTION = 704
    MEAN = np.array([0.485, 0.456, 0.406], np.float32)
    STD = np.array([0.229, 0.224, 0.225], np.float32)
    _SUB, _MUL = MEAN * 255, 1 / (STD * 255)   # the normalisation on 0-255 values
    NUM_SELECT = 300
    CACHE: int = 8   # the last few images: people() and ball() on the same frame run the network once

    def __init__(self, model: Path | None = None, rt: Runtime | None = None):
        import os

        import onnxruntime as ort

        rt = rt or runtime.current()
        path = model or ensure_onnx_model()
        available = ort.get_available_providers()
        providers = [p for p in ("DmlExecutionProvider", "CUDAExecutionProvider") if p in available and rt.gpu]
        n = 1 if "DmlExecutionProvider" in providers else max(1, rt.sessions)

        def options(gpu: bool):
            opts = ort.SessionOptions()
            if gpu and "DmlExecutionProvider" in providers:  # DirectML needs these (ORT docs)
                opts.enable_mem_pattern = False
                opts.execution_mode = ort.ExecutionMode.ORT_SEQUENTIAL
            threads = rt.threads or (max(1, (os.cpu_count() or 4) // n) if n > 1 else 0)
            opts.intra_op_num_threads = threads
            if threads:
                opts.inter_op_num_threads = 1
            return opts

        sessions = []
        error = None
        try:
            for _ in range(n):
                sessions.append(ort.InferenceSession(str(path), options(True), providers=[*providers, "CPUExecutionProvider"]))
        except Exception as exc:  # a broken GPU driver must not stop the analysis; a full GPU keeps the sessions it has
            error = f"{type(exc).__name__}: {exc}"
            if not sessions:
                sessions = [ort.InferenceSession(str(path), options(False), providers=["CPUExecutionProvider"])]
        self._init(sessions, rt.batch)
        self.session_error = error   # why fewer sessions (or the CPU) were used; Optimise shows it

    def _init(self, sessions: list, batch: int = 1) -> None:
        self.provider = sessions[0].get_providers()[0] if hasattr(sessions[0], "get_providers") else "CPUExecutionProvider"
        inp = sessions[0].get_inputs()[0]
        self.input = inp.name
        dim = inp.shape[0] if inp.shape else 1
        self.batch = max(1, batch) if not isinstance(dim, int) else max(1, dim)
        self.fixed_batch = dim if isinstance(dim, int) else None
        self.sessions = len(sessions)
        self.session_error: str | None = None
        self._free: queue.SimpleQueue = queue.SimpleQueue()   # one Run call per session at a time (DirectML)
        for s in sessions:
            self._free.put(s)
        self._cache: list = []    # (image, outputs), newest last; by identity, so a frame is never confused with another
        self._cache_lock = threading.Lock()
        # COCO category ids, as RF-DETR reports them (see _COCO91); only these two are used.
        self.names = {1: "person", 37: "sports ball"}

    @property
    def parallel(self) -> int:
        """Callers worth having at once: on a GPU one more than the sessions, so a frame is
        prepared on the CPU while the network runs on another."""
        return self.sessions + (self.provider != "CPUExecutionProvider")

    def _prep(self, img: np.ndarray) -> np.ndarray:
        # rfdetr: RGB in [0, 1], bilinear resize without antialiasing, ImageNet normalisation.
        # Resize and channel order commute with the per-pixel scaling, so they come first and the
        # arithmetic runs on 704x704 values, not a full-HD frame's (the same result, 39 -> 19 ms on 4 cores).
        # The resize itself stays in float: an 8-bit resize rounds (up to 0.75 grey levels off
        # rfdetr's input) and saves only ~2 ms of the ~3, beside the network.
        x = cv2.resize(img.astype(np.float32), (self.RESOLUTION, self.RESOLUTION), interpolation=cv2.INTER_LINEAR)
        x = cv2.cvtColor(x, cv2.COLOR_BGR2RGB)
        return np.ascontiguousarray(((x - self._SUB) * self._MUL).transpose(2, 0, 1))

    def _run(self, x: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
        s = self._free.get()
        try:
            with _DML_RUN if self.provider == "DmlExecutionProvider" else nullcontext():
                boxes, logits = s.run(None, {self.input: x})
        finally:
            self._free.put(s)
        return boxes, logits

    def _raw_many(self, imgs: list[np.ndarray]) -> list[tuple[np.ndarray, np.ndarray]]:
        """(boxes, logits) per image: cached, batched when the model allows, spread over the sessions."""
        with self._cache_lock:
            out: list = [next((r for im, r in self._cache if im is img), None) for img in imgs]
        todo = [i for i, r in enumerate(out) if r is None]
        chunks = [todo[j:j + self.batch] for j in range(0, len(todo), self.batch)]

        def prep(chunk: list[int]) -> np.ndarray:
            x = np.stack([self._prep(imgs[i]) for i in chunk])
            if self.fixed_batch and len(x) < self.fixed_batch:
                x = np.concatenate([x, np.zeros((self.fixed_batch - len(x), *x.shape[1:]), np.float32)])
            return x

        def run(chunk: list[int], x: np.ndarray | None = None):
            boxes, logits = self._run(prep(chunk) if x is None else x)
            return [(boxes[j:j + 1], logits[j:j + 1]) for j in range(len(chunk))]

        if len(chunks) > 1 and self.sessions > 1:
            with ThreadPoolExecutor(max_workers=min(self.sessions, len(chunks))) as ex:
                results = list(ex.map(run, chunks))
        elif len(chunks) > 1:   # one session: the next frames are prepared while the network runs
            with ThreadPoolExecutor(max_workers=2) as ex:
                results = [run(c, x) for c, x in zip(chunks, ex.map(prep, chunks))]
        else:
            results = [run(c) for c in chunks]
        with self._cache_lock:
            for chunk, res in zip(chunks, results):
                for i, r in zip(chunk, res):
                    out[i] = r
                    self._cache.append((imgs[i], r))
            del self._cache[: max(0, len(self._cache) - self.CACHE)]
        return out

    def _predict(self, img: np.ndarray, conf: float) -> list[tuple[str, Box]]:
        return self._post(*self._raw_many([img])[0], img.shape[1], img.shape[0], conf)

    def people_many(self, imgs: list[np.ndarray]) -> list[list[Box]]:
        return [[b for k, b in self._post(bx, lg, img.shape[1], img.shape[0], 0.25) if k == "person"]
                for img, (bx, lg) in zip(imgs, self._raw_many(imgs))]

    def _post(self, boxes: np.ndarray, logits: np.ndarray, w: int, h: int, conf: float) -> list[tuple[str, Box]]:
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
_DML_RUN = threading.Lock()   # one DirectML Run call at a time in the process (see OnnxRfDetrBallDetector)
_loaded: dict[tuple, BallDetector] = {}


def get_detector(weights: str | None = None) -> BallDetector:
    """The process's detector for the current Runtime (loaded once; a lock so a warm-up thread
    and the first job do not both load the model). A Runtime with other detector settings
    replaces it (the decoder settings do not: reloading the model on the GPU takes seconds); the
    old one's memory goes once no job holds it any more."""
    rt = runtime.current()
    key = (weights, rt.sessions, rt.batch, rt.threads, rt.gpu)
    with _detector_lock:
        if key not in _loaded:
            _loaded.clear()
            _loaded[key] = _make_detector(weights, rt)
        return _loaded[key]


get_detector.cache_clear = _loaded.clear  # type: ignore[attr-defined]


def _make_detector(weights: str | None = None, rt: Runtime | None = None) -> BallDetector:
    import importlib
    import importlib.util
    import os

    spec = os.environ.get("GOLF_DETECTOR", "").strip().lower()
    if spec == "blob":
        return BlobBallDetector()
    if spec == "yolo" or (weights and not spec):  # explicit YOLO weights (--model) mean YOLO
        return YoloBallDetector(weights)
    if spec in ("rfdetr-onnx", "onnx"):
        return OnnxRfDetrBallDetector(rt=rt)
    if spec in ("rfdetr-torch", "torch"):
        return RfDetrBallDetector()
    if spec and spec not in ("rfdetr", "rf-detr"):
        mod, _, cls = os.environ["GOLF_DETECTOR"].strip().partition(":")
        return getattr(importlib.import_module(mod), cls)()
    # RF-DETR as ONNX (no PyTorch needed); the PyTorch version only when ONNX Runtime is missing.
    if importlib.util.find_spec("onnxruntime") or not importlib.util.find_spec("rfdetr"):
        return OnnxRfDetrBallDetector(rt=rt)
    return RfDetrBallDetector()
