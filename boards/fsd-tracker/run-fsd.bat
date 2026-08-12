@echo off
REM ====================================================================
REM  FSD Tracker - report launcher
REM
REM  Double-click to build today's report onto your Desktop.
REM  Pass a date or range to override:
REM      run-fsd.bat 2026-08-01
REM      run-fsd.bat 2026-07-26..2026-08-01
REM ====================================================================

setlocal
cd /d "%~dp0"

REM Prefer Node on PATH; fall back to the no-admin portable install.
set "NODE="
where node >nul 2>&1 && set "NODE=node"

if not defined NODE (
  for /d %%D in ("%USERPROFILE%\nodejs\node-v*-win-x64") do (
    if exist "%%D\node.exe" set "NODE=%%D\node.exe"
  )
)

if not defined NODE (
  echo.
  echo   Node.js was not found.
  echo   Install it from https://nodejs.org, or see the Charging Tracker
  echo   README for the portable no-admin setup.
  echo.
  pause
  exit /b 1
)

echo.
echo   FSD Tracker
echo   -----------
echo   Report goes to your Desktop.
echo   You must be on the Tesla network or VPN.
echo.

"%NODE%" fsd-tracker.js %*

echo.
pause
