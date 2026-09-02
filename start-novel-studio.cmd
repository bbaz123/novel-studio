@echo off
setlocal
cd /d "%~dp0"
set "URL=http://localhost:3737"

where node >nul 2>nul
if errorlevel 1 (
  echo [Novel Studio] Node.js not found. Please install Node.js 22+ first.
  pause
  exit /b 1
)

REM If the server is already running, just open the browser.
curl -s --max-time 2 -o nul "%URL%/api/works" >nul 2>&1
if not errorlevel 1 (
  start "" "%URL%"
  exit /b 0
)

REM Start the local server in its own console window.
start "Novel Studio Server" cmd /k "node server.js"

REM Wait briefly for the server to boot, then open the browser.
timeout /t 2 /nobreak >nul
start "" "%URL%"
exit /b 0
