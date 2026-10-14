@echo off
rem Drag one or more golf videos (or a folder) onto this file.
cd /d "%~dp0"
if "%~1"=="" (
  echo Drag one or more videos onto Tracer.bat
  pause
  exit /b 1
)
echo Do you know the shot's carry? Then apex and ball speed are right too.
set "CARRY="
set /p CARRY=Carry in metres (just press Enter to skip):
if defined CARRY set "CARRY=%CARRY:,=.%"
echo.
echo Which club? It keeps the estimate realistic.
echo   d = driver   w = wood/hybrid   l = long iron (3-5)   m = mid iron (6-8)
echo   s = short iron (9-PW)   g = wedge   Enter = auto
set "CK="
set "CLUB="
set /p CK=Club:
if /i "%CK%"=="d" set "CLUB=--club driver"
if /i "%CK%"=="w" set "CLUB=--club wood"
if /i "%CK%"=="l" set "CLUB=--club longIron"
if /i "%CK%"=="m" set "CLUB=--club midIron"
if /i "%CK%"=="s" set "CLUB=--club shortIron"
if /i "%CK%"=="g" set "CLUB=--club wedge"
if defined CARRY (
  ".venv\Scripts\python.exe" -m shottracer %* --carry %CARRY% %CLUB% --stats --open
) else (
  ".venv\Scripts\python.exe" -m shottracer %* %CLUB% --stats --open
)
pause
