@echo off
rem Open Golf Tracer - installs everything needed to run the app locally.
rem Run again after an update; steps already done are skipped quickly.
setlocal
cd /d "%~dp0"

where python >nul 2>nul || (echo [!] Python 3.11+ is missing: https://www.python.org/downloads/ & pause & exit /b 1)
where node >nul 2>nul || (echo [!] Node.js 20.11+ is missing: https://nodejs.org/ & pause & exit /b 1)
where ffmpeg >nul 2>nul || (
  echo [!] FFmpeg is missing. Install it with:  winget install Gyan.FFmpeg
  echo     and open a new terminal window afterwards.
  pause & exit /b 1
)

if not exist ".venv\Scripts\python.exe" (
  echo == Creating the Python environment ==
  python -m venv .venv || goto :fail
)
set "PY=.venv\Scripts\python.exe"
"%PY%" -m pip install --upgrade pip >nul

"%PY%" -c "import torch" >nul 2>nul
if errorlevel 1 (
  where nvidia-smi >nul 2>nul
  if errorlevel 1 (
    echo == Installing PyTorch (CPU) ==
    "%PY%" -m pip install torch torchvision --index-url https://download.pytorch.org/whl/cpu || goto :fail
  ) else (
    echo == Installing PyTorch (CUDA 12.8) ==
    "%PY%" -m pip install torch torchvision --index-url https://download.pytorch.org/whl/cu128 || goto :fail
  )
)
echo == Installing Python packages ==
"%PY%" -m pip install -r apps\worker\requirements.txt -r requirements-dev.txt || goto :fail

echo == Fetching RF-DETR weights (ball detector) ==
"%PY%" -c "from shottracer.detect import RfDetrBallDetector; RfDetrBallDetector()" >nul 2>nul || echo [!] Could not fetch the weights - they are tried again at the first analysis.

echo == Installing Node packages ==
call npm install || goto :fail

echo == Preparing the database ==
pushd apps\api
"..\..\%PY%" -m alembic upgrade head || (popd & goto :fail)
popd

if not exist ".env" copy .env.example .env >nul

echo.
echo Done. Start the app with start.bat
pause
exit /b 0

:fail
echo.
echo [!] Setup stopped at an error (see above).
pause
exit /b 1
