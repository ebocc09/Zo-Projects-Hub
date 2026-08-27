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

rem  Ask the runtime for the port rather than hardcoding it, so that changing
rem  "port" in config.json — which is what this window tells you to do when the
rem  port is taken — also moves the browser and the messages below. Same
rem  precedence as the server: PORT from the environment, then config.json,
rem  then 3131.
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
rem  usable "port". Either way the server would fall back to 3131, so match it.
if not defined PORT set "PORT=3131"
if "%PORT%"=="NaN" set "PORT=3131"

rem  Give the server a moment to bind before the browser asks for the page.
start "" /min cmd /c "timeout /t 2 >nul & start "" http://localhost:%PORT%"

echo.
echo   The Compiler is starting on http://localhost:%PORT%
echo   Close this window to stop it.
echo.

"%NODE%" server.js

rem  Only reached if the server exits, which usually means the port is taken.
echo.
echo   The server stopped. If it exited immediately, port %PORT% is probably
echo   already in use — close the other copy, or change "port" in config.json.
echo.
pause
