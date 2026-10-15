#!/usr/bin/env bash
# Open Golf Tracer – local setup for macOS/Linux (Windows: setup.bat).
set -euo pipefail
cd "$(dirname "$0")"

command -v python3 >/dev/null || { echo "Python 3.11+ mangler"; exit 1; }
command -v node >/dev/null || { echo "Node.js 20.11+ mangler"; exit 1; }
command -v ffmpeg >/dev/null || { echo "FFmpeg mangler (brew install ffmpeg / apt install ffmpeg)"; exit 1; }

[ -x .venv/bin/python ] || python3 -m venv .venv
PY=.venv/bin/python
$PY -m pip install --upgrade pip >/dev/null
$PY -m pip install -r apps/worker/requirements.txt -r requirements-dev.txt
# Optional, only for GOLF_DETECTOR=rfdetr-torch and scripts/export_onnx.py: pip install -r requirements-torch.txt

echo "== Henter bolddetektoren (RF-DETR, ONNX) =="
$PY scripts/fetch_model.py >/dev/null 2>&1 \
  || echo "Kunne ikke hente modellen – der prøves igen ved første analyse."

npm install
(cd apps/api && ../../$PY -m alembic upgrade head)
[ -f .env ] || cp .env.example .env
echo "Færdig. Start med: npm run build && node scripts/dev.mjs --prod --open   (eller npm run dev under udvikling)"
