@echo off
rem Open Golf Tracer (installed version) - sets up the Python part: a private Python, PyTorch
rem (CUDA when there is an NVIDIA card) and the ball detector weights. Runs at the end of the
rem installation and again from OpenGolfTracer.cmd if it did not finish. Safe to run again to repair.
setlocal
cd /d "%~dp0"
title Open Golf Tracer - setup

set "UV=%~dp0runtime\uv\uv.exe"
set "UV_PYTHON_INSTALL_DIR=%~dp0runtime\python"
set "UV_CACHE_DIR=%~dp0runtime\uv-cache"
set "UV_PYTHON_PREFERENCE=only-managed"
set "UV_NO_CONFIG=1"
rem The OS certificate store, for PCs where antivirus intercepts HTTPS.
set "UV_NATIVE_TLS=1"
set "PATH=%~dp0runtime\node;%~dp0runtime\ffmpeg\bin;%PATH%"
set "PY=.venv\Scripts\python.exe"
del ".venv\.ready" >nul 2>nul

echo.
echo   Open Golf Tracer is being set up.
echo   The first time this downloads 1-3 GB and takes 5-15 minutes. Keep this window open.
echo.

if not exist "%PY%" (
  echo == Python ==
  "%UV%" venv .venv --python 3.12 || goto :fail
)

"%PY%" -c "import torch" >nul 2>nul
if errorlevel 1 (
  where nvidia-smi >nul 2>nul
  if errorlevel 1 (
    echo == PyTorch ^(CPU^) ==
    "%UV%" pip install --python "%PY%" torch torchvision --index-url https://download.pytorch.org/whl/cpu || goto :fail
  ) else (
    echo == PyTorch ^(NVIDIA CUDA 12.8^) ==
    "%UV%" pip install --python "%PY%" torch torchvision --index-url https://download.pytorch.org/whl/cu128 || goto :fail
  )
)

echo == Python packages ==
"%UV%" pip install --python "%PY%" -r apps\worker\requirements.txt || goto :fail

echo == Ball detector (RF-DETR) ==
"%PY%" -c "from shottracer.detect import RfDetrBallDetector; RfDetrBallDetector()" >nul 2>nul || echo [!] Could not fetch the weights now - they are tried again at the first analysis.

"%UV%" cache prune >nul 2>nul
echo ok> ".venv\.ready"
echo.
echo   Done.
exit /b 0

:fail
echo.
echo [!] The setup stopped at an error (see above). Check the internet connection and start
echo     Open Golf Tracer again - it continues where it stopped.
pause
exit /b 1
