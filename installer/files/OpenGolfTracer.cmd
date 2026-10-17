@echo off
rem Open Golf Tracer (installed version) - starts the app and opens the browser. Close the window to stop it.
rem scripts\dev.mjs finds the bundled Python in runtime\python by itself. OGT_NO_BROWSER=1 keeps the browser
rem closed (the release smoke test).
setlocal
cd /d "%~dp0"
title Open Golf Tracer
set "PATH=%~dp0runtime\node;%~dp0runtime\ffmpeg\bin;%PATH%"
rem Node trusts the Windows certificate store too, so AI providers in the cloud still work when
rem antivirus intercepts HTTPS (the bundled Node supports --use-system-ca).
set "NODE_OPTIONS=--use-system-ca %NODE_OPTIONS%"

rem A proxy set in HTTP(S)_PROXY is used for the internet (AI providers, maps), never for the app's
rem own ports on this PC.
set "NODE_USE_ENV_PROXY=1"
if defined NO_PROXY (set "NO_PROXY=127.0.0.1,localhost,%NO_PROXY%") else (set "NO_PROXY=127.0.0.1,localhost")

echo.
echo   Open Golf Tracer is starting - the browser opens by itself in a moment.
echo   Keep this window open while you use the app. Close it to stop Open Golf Tracer.
echo.
rem --single: when it is already running (the shortcut clicked twice) only the browser is opened,
rem and when another program uses port 3000 or 8000 free ports are picked (see scripts\dev.mjs).
node scripts\dev.mjs --prod --open --single
if errorlevel 1 pause
