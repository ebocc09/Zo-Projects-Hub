@echo off
REM ====================================================================
REM  Charging Tracker - launcher
REM
REM  Double-click this file to start the dashboard.
REM  Keep the window that opens - closing it stops the dashboard.
REM ====================================================================

setlocal
cd /d "%~dp0"

REM Node, in order of preference:
REM   1. the runtime bundled beside this file - the portable build, which
REM      needs no install and no admin rights
REM   2. the one shared runtime at the hub root - the hub-wide portable build
REM      ships a single copy there rather than 88 MB per board
REM   3. whatever is on PATH - a normal developer checkout
REM   4. a no-admin portable install under %USERPROFILE%\nodejs
REM The same launcher therefore works from either zip and from a git clone.
set "NODE="
if exist "%~dp0runtime\node.exe" set "NODE=%~dp0runtime\node.exe"

if not defined NODE (
  if exist "%~dp0..\..\runtime\node.exe" set "NODE=%~dp0..\..\runtime\node.exe"
)

if not defined NODE (
  where node >nul 2>&1 && set "NODE=node"
)

if not defined NODE (
  for /d %%D in ("%USERPROFILE%\nodejs\node-v*-win-x64") do (
    if exist "%%D\node.exe" set "NODE=%%D\node.exe"
  )
)

if not defined NODE (
  echo.
  echo   Node.js was not found.
  echo.
  echo   If you unzipped the portable build, the runtime folder is
  echo   missing - re-copy the whole folder rather than just the files
  echo   you recognise.
  echo.
  echo   Otherwise install Node from https://nodejs.org, or see the
  echo   "Node without admin rights" section of README.md.
  echo.
  pause
  exit /b 1
)

echo.
echo   Charging Tracker
echo   ----------------
echo   Dashboard : http://localhost:3118
echo.
echo   Your browser will open automatically. You may be asked to
echo   sign in to Garage the first time - you must be on the Tesla
echo   network or VPN.
echo.
echo   KEEP THIS WINDOW OPEN. Closing it stops the dashboard.
echo   Press Ctrl+C to stop.
echo.

REM How charge-complete alerts are delivered.
REM   webhook - POST straight to the Power Automate flow URL. This is the
REM             normal path and it works.
REM   outlook - fallback that sends via the local Outlook client, for a flow
REM             triggered by "When a new email arrives". Only needed if the
REM             flow URL is unavailable. See README.
set "ALERT_TRANSPORT=webhook"

REM Which Garage environment to start in. Leave this commented out for the
REM normal case - the dashboard remembers whichever one you last picked in
REM Admin, and the Production / Engineering switch stays available.
REM
REM Uncomment to PIN one environment. The switch is then disabled in the UI
REM and the admin panel says why. Useful if this copy should only ever be
REM allowed to touch engineering.
REM   set "GARAGE_ENV=prod"
REM   set "GARAGE_ENV=eng"

"%NODE%" server.js

echo.
echo   Dashboard stopped.
pause
