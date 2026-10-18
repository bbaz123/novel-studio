@echo off
setlocal EnableDelayedExpansion
cd /d "%~dp0"

REM P06 (2026-10-18): port + readiness probe.
REM The old script hard-coded http://localhost:3737 and treated "curl can connect" as ready.
REM Two consequences: (1) with PORT=3800 the server listened on 3800 while the script
REM probed 3737, so it never found it; (2) a foreign program owning the port counted as
REM ready and opened a dead page. Now the port comes from the same PORT env var as the
REM server, and readiness means `curl --fail /api/readiness` returned 200.
set "PORT=%PORT%"
if not defined PORT set "PORT=3737"
echo(!PORT!| findstr /r /x "[0-9][0-9]*" >nul
if errorlevel 1 goto bad_port
set /a PORT_NUM=PORT 2>nul
if !PORT_NUM! LSS 1 goto bad_port
if !PORT_NUM! GTR 65535 goto bad_port
set "URL=http://127.0.0.1:!PORT!"

where node >nul 2>nul
if errorlevel 1 (
  echo [Novel Studio] Node.js not found. Please install Node.js 22+ first.
  if not defined NOVELSTUDIO_SCRIPT_SILENT pause
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
  if not defined NOVELSTUDIO_SCRIPT_SILENT pause
  exit /b 1
)

REM Already-ready service: just open the page.
curl -s --fail --max-time 2 -o nul "!URL!/api/readiness" >nul 2>&1
if not errorlevel 1 (
  echo [Novel Studio] Service already ready at !URL!
  if not defined NOVELSTUDIO_NO_BROWSER start "" "!URL!"
  exit /b 0
)

REM Something answers on the port but /api/readiness is not 200: a foreign program may
REM own it, or the service is still starting. Do not claim ready, do not open the browser,
REM and do not start a second instance (that would only hit EADDRINUSE).
curl -s --max-time 2 -o nul "!URL!/api/health" >nul 2>&1
if not errorlevel 1 (
  echo [Novel Studio] Port !PORT! is answering, but /api/readiness is not OK.
  echo   Another program may own this port, or the service is still starting.
  echo   Not opening the browser. Close the occupant or choose another PORT.
  if not defined NOVELSTUDIO_SCRIPT_SILENT pause
  exit /b 1
)

REM Launch the local server in its own console window. NOVELSTUDIO_NO_START is test-only.
if not defined NOVELSTUDIO_NO_START (
  start "Novel Studio Server" cmd /k "node server.js"
)

REM Poll /api/readiness: only 200 opens the browser; the default budget is 60 seconds.
REM NOVELSTUDIO_READY_TIMEOUT_SEC is test-only (shortens the wait).
set "READY_TIMEOUT=60"
if defined NOVELSTUDIO_READY_TIMEOUT_SEC set "READY_TIMEOUT=%NOVELSTUDIO_READY_TIMEOUT_SEC%"
set /a TRIES=0
:waitloop
set /a TRIES+=1
curl -s --fail --max-time 1 -o nul "!URL!/api/readiness" >nul 2>&1
if not errorlevel 1 goto ready
if !TRIES! GEQ !READY_TIMEOUT! goto timeout
timeout /t 1 /nobreak >nul
goto waitloop

:ready
if not defined NOVELSTUDIO_NO_BROWSER start "" "!URL!"
exit /b 0

:timeout
echo [Novel Studio] Service did not become ready within !READY_TIMEOUT!s at !URL!
echo   Check the server window for errors (port in use / migration failed / Node version).
echo   The browser was NOT opened because the service is not ready.
if not defined NOVELSTUDIO_SCRIPT_SILENT pause
exit /b 1

:bad_port
echo [Novel Studio] Invalid PORT "!PORT!": must be an integer between 1 and 65535.
echo   Set PORT before running this script, or unset it to use the default 3737.
if not defined NOVELSTUDIO_SCRIPT_SILENT pause
exit /b 1
