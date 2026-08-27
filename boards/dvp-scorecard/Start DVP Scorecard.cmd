@echo off
rem  Starts the dashboard and opens it in the default browser.
rem
rem  Node, in order of preference: a runtime bundled beside this file, then the
rem  one shared runtime at the hub root — the portable build ships a single
rem  copy there rather than 88 MB per board — then whatever is on PATH. So the
rem  same launcher works from a git checkout, from the hub zip, and from a
rem  board folder lifted out of it on its own.
rem
rem  Failing all three, it fetches the shared runtime into the hub root. A copy
rem  downloaded from GitHub carries no binary — publish.js ships only what git
rem  tracks — so on a machine with no Node this is the one step that needs the
rem  network, and it needs it once for every board.

setlocal
cd /d "%~dp0"

set "NODE="
if exist "%~dp0runtime\node.exe" set "NODE=%~dp0runtime\node.exe"
if not defined NODE (
  if exist "%~dp0..\..\runtime\node.exe" set "NODE=%~dp0..\..\runtime\node.exe"
)
if not defined NODE (
  where /q node && set "NODE=node"
)

rem  A board folder lifted out on its own has no hub above it and so cannot
rem  fetch — that case falls through to the message below, as it did before.
if not defined NODE (
  if exist "%~dp0..\..\get-runtime.cmd" (
    call "%~dp0..\..\get-runtime.cmd" /nopause
    if exist "%~dp0..\..\runtime\node.exe" set "NODE=%~dp0..\..\runtime\node.exe"
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
