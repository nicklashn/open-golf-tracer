@echo off
rem Open Golf Tracer (installed version) - starts the app and opens the browser. Close the window to stop it.
rem scripts\dev.mjs finds the bundled Python in runtime\python by itself.
setlocal
cd /d "%~dp0"
title Open Golf Tracer
set "PATH=%~dp0runtime\node;%~dp0runtime\ffmpeg\bin;%PATH%"
rem Node trusts the Windows certificate store too, so AI providers in the cloud still work when
rem antivirus intercepts HTTPS (the bundled Node supports --use-system-ca).
set "NODE_OPTIONS=--use-system-ca %NODE_OPTIONS%"

rem Already running (e.g. the shortcut was clicked twice)? Then just open the browser.
curl -sf -o nul http://127.0.0.1:3000/ >nul 2>nul && (start "" http://localhost:3000 & exit /b 0)

echo.
echo   Open Golf Tracer is starting - the browser opens by itself in a moment.
echo   Keep this window open while you use the app. Close it to stop Open Golf Tracer.
echo.
node scripts\dev.mjs --prod --open
if errorlevel 1 pause
