"""Downloads the ball detector (RF-DETR Large as ONNX) to models/, checked against its SHA-256.
The app also does this by itself at the first analysis; setup and the installer build call it
up front. Usage: python scripts/fetch_model.py"""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from shottracer.detect import ensure_onnx_model  # noqa: E402

print(ensure_onnx_model())
