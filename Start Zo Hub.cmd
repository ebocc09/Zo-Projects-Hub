@echo off
rem  Starts the dashboard and opens it in the default browser.
rem
rem  Uses the bundled runtime if this is the portable build, otherwise falls
rem  back to whatever Node is on PATH — so the same launcher works from a
rem  git checkout and from the zip.
rem
rem  Failing both, it fetches one. A copy downloaded from GitHub carries no
rem  binary — publish.js can only ship what git tracks, and a 92 MB node.exe
rem  does not belong in a public repo — so on a machine with no Node there is
rem  nothing to run until get-runtime.cmd has been round once. That is the one
rem  path that needs the network, and it needs it exactly once.

setlocal
cd /d "%~dp0"

set "NODE="
if exist "%~dp0runtime\node.exe" set "NODE=%~dp0runtime\node.exe"
if not defined NODE (
  where /q node && set "NODE=node"
)

if not defined NODE (
  if exist "%~dp0get-runtime.cmd" (
    call "%~dp0get-runtime.cmd" /nopause
    if exist "%~dp0runtime\node.exe" set "NODE=%~dp0runtime\node.exe"
  )
)

if not defined NODE (
  echo.
  echo   Node could not be found, and could not be fetched. Any reason for the
  echo   fetch failing is printed above.
  echo.
  echo   If you unzipped the portable build, the runtime folder is missing —
  echo   re-copy the whole folder rather than just the files you recognise.
  echo.
  pause
  exit /b 1
)

rem  Ask the runtime for the port rather than hardcoding it, so that changing
rem  "port" in config.json — which is what this window tells you to do when the
rem  port is taken — also moves the browser and the messages below. Same
rem  precedence as the server: PORT from the environment, then config.json,
rem  then 3100.
rem  Read through a temp file rather than `for /f ... in (backticks)`: that form
rem  hands the command to `cmd /c "..."`, which strips the outer quote pair when
rem  the line both starts and ends with one — as it does here, quoted node path
rem  through to quoted -p script — and the runtime is invoked as `node" -p "...`.
if defined PORT goto :portknown
"%NODE%" -p "Number(require('./config.json').port)" > "%~dp0.port.tmp" 2>nul
set /p PORT=<"%~dp0.port.tmp"
del "%~dp0.port.tmp" >nul 2>&1
:portknown
rem  Empty means config.json is missing or malformed, NaN means it has no
rem  usable "port". Either way the server would fall back to 3100, so match it.
if not defined PORT set "PORT=3100"
if "%PORT%"=="NaN" set "PORT=3100"

rem  Give the server a moment to bind before the browser asks for the page.
start "" /min cmd /c "timeout /t 2 >nul & start "" http://localhost:%PORT%"

echo.
echo   Zo Projects Hub is starting on http://localhost:%PORT%
echo   Close this window to stop it.
echo.

"%NODE%" server.js

rem  Only reached if the server exits, which usually means the port is taken.
echo.
echo   The server stopped. If it exited immediately, port %PORT% is probably
echo   already in use — close the other copy, or change "port" in config.json.
echo.
pause
