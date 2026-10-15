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

echo == Installing Python packages ==
"%PY%" -m pip install -r apps\worker\requirements.txt -r requirements-dev.txt || goto :fail
rem Optional, only for GOLF_DETECTOR=rfdetr-torch and scripts\export_onnx.py: pip install -r requirements-torch.txt

echo == Fetching the ball detector (RF-DETR, ONNX) ==
"%PY%" scripts\fetch_model.py >nul 2>nul || echo [!] Could not fetch the model - it is tried again at the first analysis.

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
