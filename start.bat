@echo off
rem Open Golf Tracer - starts the API, worker, exporter and web and opens the browser. Close the window to stop.
cd /d "%~dp0"
if not exist ".venv\Scripts\python.exe" (
  echo Run setup.bat first.
  pause
  exit /b 1
)
rem Build the web app the first time and again when the code has changed (e.g. after git pull).
node scripts\needs-build.mjs
if errorlevel 1 (
  echo == Building the web app ==
  call npm run build || (pause & exit /b 1)
)
node scripts\dev.mjs --prod --open --single %*
