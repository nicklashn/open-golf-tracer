"""Exports RF-DETR Large (COCO, Apache-2.0) to ONNX for OnnxRfDetrBallDetector.
Needs requirements-torch.txt. The published file (shottracer/detect.py: ONNX_URL, ONNX_SHA256)
was made with this script; only re-run it to change the model, then publish the new file and
update the URL and hash. Usage: python scripts/export_onnx.py [OUT_DIR]"""
import hashlib
import sys
from pathlib import Path

from rfdetr import RFDETRLarge

out_dir = Path(sys.argv[1] if len(sys.argv) > 1 else Path(__file__).resolve().parents[1] / "models")
path = Path(RFDETRLarge().export(output_dir=str(out_dir), verbose=False))  # 704x704, opset 17, fp32
target = path.with_name("rf-detr-large.onnx")
path.replace(target)
print(target, hashlib.sha256(target.read_bytes()).hexdigest())
