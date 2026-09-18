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

REM Verify the built-in node:sqlite is actually usable.
REM A version *number* check is not enough: node:sqlite exists from 22.5 but stayed
REM behind --experimental-sqlite until 22.13, so 22.5-22.12 users would pass a
REM ">= 22" check and then crash on startup. Probing the capability is exact.
node -e "try{require('node:sqlite')}catch(e){process.exit(1)}" >nul 2>&1
if errorlevel 1 (
  echo [Novel Studio] Node.js 22.13 or newer is required - built-in node:sqlite is unavailable.
  echo   Current version:
  node -v
  echo   Note: Node 22.5-22.12 ships node:sqlite but keeps it behind --experimental-sqlite.
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

REM Poll until the server is ready, then open the browser (avoids opening a dead page on slow boots).
for /l %%i in (1,1,30) do (
  curl -s --max-time 1 -o nul "%URL%/api/works" >nul 2>&1
  if not errorlevel 1 (
    start "" "%URL%"
    exit /b 0
  )
  timeout /t 1 /nobreak >nul
)

start "" "%URL%"
exit /b 0
