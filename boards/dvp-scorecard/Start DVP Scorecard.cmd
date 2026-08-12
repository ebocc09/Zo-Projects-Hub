@echo off
rem  Starts the dashboard and opens it in the default browser.
rem
rem  Node, in order of preference: a runtime bundled beside this file, then the
rem  one shared runtime at the hub root — the portable build ships a single
rem  copy there rather than 88 MB per board — then whatever is on PATH. So the
rem  same launcher works from a git checkout, from the hub zip, and from a
rem  board folder lifted out of it on its own.

setlocal
cd /d "%~dp0"

set "NODE=%~dp0runtime\node.exe"
if not exist "%NODE%" set "NODE=%~dp0..\..\runtime\node.exe"
if not exist "%NODE%" set "NODE=node"

where /q "%NODE%" 2>nul || if not exist "%NODE%" (
  echo.
  echo   Node could not be found.
  echo.
  echo   If you unzipped the portable build, the runtime folder is missing —
  echo   re-copy the whole folder rather than just the files you recognise.
  echo.
  pause
  exit /b 1
)

rem  Give the server a moment to bind before the browser asks for the page.
start "" /min cmd /c "timeout /t 2 >nul & start "" http://localhost:3130"

echo.
echo   DVP Scorecard is starting on http://localhost:3130
echo   Close this window to stop it.
echo.

"%NODE%" server.js

rem  Only reached if the server exits, which usually means the port is taken.
echo.
echo   The server stopped. If it exited immediately, port 3130 is probably
echo   already in use — close the other copy, or change "port" in config.json.
echo.
pause
