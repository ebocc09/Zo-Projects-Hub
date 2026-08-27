@echo off
rem ===========================================================================
rem  Fetch the bundled Node runtime, once, on a machine that has no Node.
rem ---------------------------------------------------------------------------
rem  The portable zip ships Node inside it. The GitHub copy cannot — a 92 MB
rem  binary has no business in the working tree of a public repo, and GitHub
rem  hard-rejects any blob at 100 MiB. So the runtime lives as a release asset
rem  on the same repository the folder was downloaded from, and this fetches it
rem  the first time a launcher finds nothing to run with.
rem
rem  github.com is reachable by definition here: it is where this folder came
rem  from. That is the whole reason the asset is not fetched from nodejs.org,
rem  which no one has confirmed is reachable from the Tesla network.
rem
rem  ── no PowerShell ──
rem
rem  curl.exe, tar.exe and certutil.exe are all in System32 on Windows 10 1803
rem  and later. Using them means no -ExecutionPolicy argument to be overridden
rem  by a machine policy we do not control, on a script whose entire job is to
rem  run on someone else's locked-down laptop.
rem
rem  They are called by full path, not by name. Git for Windows puts its own
rem  tar.exe and curl.exe ahead of System32 on PATH, and Git's tar is GNU tar —
rem  which reads "C:\..." as a remote host and fails with "Cannot connect to C:
rem  resolve failed". Only Windows' bsdtar unpacks a zip. Anyone with Git, MSYS
rem  or Cygwin installed would otherwise hit this, which is to say most of the
rem  people likely to be handed a checkout.
rem
rem  ── what is trusted ──
rem
rem  runtime.json is published through the estate's own hash-manifested channel
rem  and names the sha256 of the asset. The asset itself is not in that channel.
rem  So the bytes are checked against the manifest before anything is unpacked,
rem  and a mismatch deletes the download rather than running it.
rem
rem    get-runtime.cmd            interactive: reports what it did, waits
rem    get-runtime.cmd /nopause   from a launcher: no pause, exit code only
rem
rem  Exit codes: 0 the runtime is present, 1 it is not and here is why.
rem ===========================================================================

setlocal EnableExtensions

set "HUB=%~dp0"
set "DEST=%HUB%runtime"
set "JSON=%HUB%runtime.json"
set "QUIET="
if /i "%~1"=="/nopause" set "QUIET=1"

rem  See the header: by full path, so Git's GNU tar cannot win. A 32-bit cmd on
rem  64-bit Windows redirects System32 to SysWOW64, which carries all three too.
set "SYS=%SystemRoot%\System32"
set "CURL=%SYS%\curl.exe"
set "TAR=%SYS%\tar.exe"
set "HASH=%SYS%\certutil.exe"

rem  Idempotent, and cheap enough to call on every launch. Callers decide their
rem  own Node precedence and only reach here having exhausted it, so this is
rem  deliberately not a second PATH search.
if exist "%DEST%\node.exe" exit /b 0

rem  Windows 10 1803 shipped all three. Checking is cheaper than three separate
rem  cryptic failures further down on whatever older build turns up.
for %%T in ("%CURL%" "%TAR%" "%HASH%") do if not exist "%%~T" (
  echo.
  echo   Node is not installed, and this copy cannot fetch it: %%~nxT is missing
  echo   from %SYS%. That is expected only on Windows builds older than 10 1803.
  echo.
  echo   Install Node yourself from https://nodejs.org, or ask for the portable
  echo   zip instead — it carries Node inside it and needs none of this.
  goto :fail
)

if not exist "%JSON%" (
  echo.
  echo   Node is not installed, and this copy cannot fetch it: runtime.json is
  echo   missing from
  echo     %HUB%
  echo.
  echo   Re-download the folder from GitHub rather than copying files out of it,
  echo   or install Node yourself from https://nodejs.org.
  goto :fail
)

call :jsonget version VER
call :jsonget sha256  SHA
call :jsonget url     URL
call :jsonget size    SIZE

if not defined URL goto :badjson
if not defined SHA goto :badjson

rem  Quoting the real figure rather than a remembered one, so the estimate does
rem  not quietly drift the next time Node grows.
set "SIZETEXT=a few tens of MB"
if defined SIZE set /a SIZEMB=%SIZE%/1048576 >nul 2>&1
if defined SIZEMB if not "%SIZEMB%"=="0" set "SIZETEXT=about %SIZEMB% MB"

echo.
echo   Node is not installed on this machine, so the estate will fetch its own
echo   copy — Node %VER%, %SIZETEXT%, once. Nothing is installed and no admin
echo   rights are needed; it lands in the runtime folder beside this file.
echo.

rem  %RANDOM% rather than a fixed name: two launchers double-clicked together
rem  would otherwise write the same temp file and each unpack half of it.
set "TMPZIP=%TEMP%\zo-node-%RANDOM%%RANDOM%.zip"

echo   Downloading...
rem  -f so an HTML error page is a failure rather than a 4 KB "zip"; -L because
rem  the release URL redirects to objects.githubusercontent.com.
"%CURL%" -fL --retry 2 --retry-delay 2 --progress-bar -o "%TMPZIP%" "%URL%"
if errorlevel 1 (
  echo.
  echo   The download failed.
  echo.
  echo   Check that you can reach github.com in a browser. If you are on the
  echo   Tesla network this may need the VPN, or a proxy your account can use.
  del "%TMPZIP%" >nul 2>&1
  goto :fail
)

echo   Checking...
rem  Through a temp file rather than `for /f ('...')`. That form hands the
rem  command to `cmd /c`, which mangles a quoted full path to the executable —
rem  it fails identically whether the quotes are caret-escaped or usebackq'd.
rem  The launchers already read the port this way for the same reason.
rem  In %TEMP%, not beside the estate: nothing to add to the publish drop-list.
set "TMPSUM=%TEMP%\zo-node-%RANDOM%%RANDOM%.sum"
"%HASH%" -hashfile "%TMPZIP%" SHA256 > "%TMPSUM%" 2>nul
set "GOT="
for /f "skip=1 tokens=1 delims= " %%H in ('type "%TMPSUM%"') do (
  if not defined GOT set "GOT=%%H"
)
del "%TMPSUM%" >nul 2>&1
if /i not "%GOT%"=="%SHA%" (
  echo.
  echo   REFUSING TO USE THE DOWNLOAD — it does not match the published hash.
  echo.
  echo     expected  %SHA%
  echo     got       %GOT%
  echo.
  echo   Usually this means the download was truncated or something on the
  echo   network rewrote it. Try again. If it keeps failing, say so rather than
  echo   working around it — this check is the only thing vouching for a binary
  echo   that is about to be run.
  del "%TMPZIP%" >nul 2>&1
  goto :fail
)

echo   Unpacking...
if not exist "%DEST%" md "%DEST%"
rem  The zip's root holds node.exe directly, so there is no leading directory
rem  to strip. System32's tar.exe is bsdtar and reads zips; Git's does not.
"%TAR%" -xf "%TMPZIP%" -C "%DEST%"
if errorlevel 1 (
  echo.
  echo   Unpacking failed. The download is at
  echo     %TMPZIP%
  echo   if you want to open it by hand — node.exe goes in
  echo     %DEST%
  goto :fail
)
del "%TMPZIP%" >nul 2>&1

if not exist "%DEST%\node.exe" (
  echo.
  echo   The archive unpacked but contained no node.exe. Report this — the
  echo   published asset is wrong, and no amount of retrying will fix it.
  goto :fail
)

rem  Prove it runs before claiming success: an unpacked binary that the machine
rem  refuses to execute fails here with a clear message, rather than three lines
rem  later as an unexplained launcher error.
"%DEST%\node.exe" -v >nul 2>&1
if errorlevel 1 (
  echo.
  echo   node.exe unpacked but will not run on this machine. If Windows blocked
  echo   it, right-click %DEST%\node.exe, Properties, and tick Unblock.
  goto :fail
)

echo.
echo   Node %VER% is ready. This happens once — later launches use this copy.
echo.
if not defined QUIET pause
exit /b 0

rem ── helpers ────────────────────────────────────────────────────────────────

:badjson
echo.
echo   runtime.json is present but unreadable, so there is no verified URL to
echo   fetch. Re-download the folder from GitHub.
goto :fail

:fail
echo.
if not defined QUIET pause
exit /b 1

rem  Pull one string value out of runtime.json.
rem    %1 = key, %2 = variable to set
rem
rem  cmd has no JSON parser and this has to run before any Node exists, so the
rem  file is generated one key per line specifically to be readable this way
rem  (see release-runtime.js). delims=: with tokens=1,* splits at the FIRST
rem  colon only, which leaves the "https://" in the value intact.
:jsonget
set "_v="
for /f "usebackq tokens=1,* delims=:" %%A in (`findstr /r /c:"\"%~1\"[ ]*:" "%JSON%"`) do set "_v=%%B"
if not defined _v goto :eof
set "_v=%_v:"=%"
if "%_v:~-1%"=="," set "_v=%_v:~0,-1%"
for /f "tokens=* delims= " %%C in ("%_v%") do set "_v=%%C"
set "%~2=%_v%"
goto :eof
