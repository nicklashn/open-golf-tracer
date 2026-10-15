@echo off
rem Open Golf Tracer (installed version) - sets up the Python part with the bundled Python:
rem PyTorch (CUDA when there is an NVIDIA card), the Python packages and the ball detector weights.
rem The installer runs it hidden ("prepare.cmd /hidden") and shows the step from runtime\setup-status.txt;
rem OpenGolfTracer.cmd runs it again if it did not finish. Details go to runtime\setup.log.
rem Plain venv + pip on purpose: no junctions, which newer Windows 11 builds refuse to follow (error 448).
setlocal
cd /d "%~dp0"

set "STATUS=%~dp0runtime\setup-status.txt"
set "RESULT=%~dp0runtime\setup-result.txt"
set "LOG=%~dp0runtime\setup.log"
set "PY=.venv\Scripts\python.exe"
set "PIP_DISABLE_PIP_VERSION_CHECK=1"
set "PIP_NO_CACHE_DIR=1"
set "PATH=%~dp0runtime\node;%~dp0runtime\ffmpeg\bin;%PATH%"
del ".venv\.ready" "%RESULT%" >nul 2>nul
> "%LOG%" echo Open Golf Tracer setup %DATE% %TIME%

set "HIDDEN="
if /i "%~1"=="/hidden" set "HIDDEN=1"
if not defined HIDDEN (
  title Open Golf Tracer - setup
  echo.
  echo   Open Golf Tracer is finishing its setup. The first time this downloads 1-3 GB
  echo   and takes 5-15 minutes. Keep this window open.
  echo.
)

call :step 1 "Preparing Python"
rem A .venv from an older installation may point to a Python that is no longer there.
"%PY%" -c "import sys" >nul 2>nul || rmdir /s /q .venv >nul 2>nul
if not exist "%PY%" (
  "%~dp0runtime\python\python.exe" -m venv .venv >> "%LOG%" 2>&1 || goto :fail
)
"%PY%" -m pip install --upgrade pip >> "%LOG%" 2>&1

call :step 2 "Downloading the analysis engine (PyTorch, the biggest part)"
"%PY%" -c "import torch" >nul 2>nul
if errorlevel 1 (
  where nvidia-smi >nul 2>nul
  if errorlevel 1 (
    "%PY%" -m pip install torch torchvision --index-url https://download.pytorch.org/whl/cpu >> "%LOG%" 2>&1 || goto :fail
  ) else (
    "%PY%" -m pip install torch torchvision --index-url https://download.pytorch.org/whl/cu128 >> "%LOG%" 2>&1 || goto :fail
  )
)

call :step 3 "Installing the rest"
"%PY%" -m pip install -r apps\worker\requirements.txt >> "%LOG%" 2>&1 || goto :fail

call :step 4 "Fetching the ball detector"
"%PY%" -c "from shottracer.detect import RfDetrBallDetector; RfDetrBallDetector()" >> "%LOG%" 2>&1 || >> "%LOG%" echo [!] Weights not fetched now - tried again at the first analysis.

> ".venv\.ready" echo ok
> "%RESULT%" echo ok
if not defined HIDDEN echo   Done.
exit /b 0

:step
> "%STATUS%" echo %~1
>> "%LOG%" echo == %~1/4 %~2 ==
if not defined HIDDEN echo   [%~1/4] %~2
exit /b 0

:fail
> "%RESULT%" echo fail
if defined HIDDEN exit /b 1
echo.
echo [!] The setup stopped (details in runtime\setup.log). Check the internet connection
echo     and start Open Golf Tracer again - it continues where it stopped.
pause
exit /b 1
