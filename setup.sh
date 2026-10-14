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
if ! $PY -c "import torch" 2>/dev/null; then
  if command -v nvidia-smi >/dev/null; then
    $PY -m pip install torch torchvision --index-url https://download.pytorch.org/whl/cu128
  elif [ "$(uname)" = "Darwin" ]; then
    $PY -m pip install torch torchvision
  else
    $PY -m pip install torch torchvision --index-url https://download.pytorch.org/whl/cpu
  fi
fi
$PY -m pip install -r apps/worker/requirements.txt -r requirements-dev.txt

echo "== Henter RF-DETR-vægte (bolddetektor) =="
$PY -c "from shottracer.detect import RfDetrBallDetector; RfDetrBallDetector()" >/dev/null 2>&1 \
  || echo "Kunne ikke hente vægtene – der prøves igen ved første analyse."

npm install
(cd apps/api && ../../$PY -m alembic upgrade head)
[ -f .env ] || cp .env.example .env
echo "Færdig. Start med: npm run build && node scripts/dev.mjs --prod --open   (eller npm run dev under udvikling)"
