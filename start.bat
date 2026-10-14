@echo off
rem PhoneBoxSound: double-click this file. It gets everything it needs by itself, then starts.
rem
rem   start.bat            set up whatever is missing, then start
rem   start.bat --check    only say what is there and what is missing; installs nothing, starts nothing
rem   start.bat --yes      accept the first-run terms without the question (for scripted installs)
rem   start.bat --demo     (or any other option) is passed on to PhoneBoxSound
rem
rem The first time, it explains what it will download and whose terms apply, and waits for your yes.
setlocal EnableExtensions
cd /d "%~dp0"
title PhoneBoxSound

set "CHECK="
set "YES="
:args
if /i "%~1"=="--check" set "CHECK=1" & shift & goto args
if /i "%~1"=="--yes" set "YES=1" & shift & goto args

set "PYVER=3.13.7"
set "NODEVER=22.18.0"
set "NODESHA=c95d8a7e1c99e669cc08c9f1176e068c1f50847c37908fcb8c35b62482366511"
set "TERMS=1"

rem ---------------------------------------------------------------- first start: what happens, and your yes
if defined CHECK goto terms_done
if not exist data mkdir data
findstr /x /c:"%TERMS%" data\.terms-accepted >nul 2>&1 && goto terms_done
if defined YES goto terms_yes
cls
echo.
echo   ==========================================================================
echo     PhoneBoxSound - first start
echo   ==========================================================================
echo.
echo   PhoneBoxSound turns phones on your network into speakers and remotes for
echo   this PC. Phones can be given control of this PC (mouse, keyboard, screen,
echo   files, power) - all of that stays OFF until you switch it on per phone.
echo.
echo   WHAT THIS WINDOW MAY DOWNLOAD AND INSTALL, ONCE (only what is missing):
echo     - Python %PYVER%   from winget (Microsoft's package installer) or python.org
echo                        licence: Python Software Foundation License
echo     - Python packages from pypi.org, listed in requirements.txt, for your user
echo                        only; each under its own open-source licence
echo     - Node.js %NODEVER% from nodejs.org, kept inside this folder (tools\node),
echo                        only if the web app is not built yet; MIT licence
echo     - JavaScript packages from npmjs.com, listed in package.json
echo.
echo   If winget is used, this window answers its questions for you: it passes
echo   --accept-source-agreements and --accept-package-agreements, which accepts
echo   the winget source agreement and the Python licence on your behalf.
echo.
echo   YOUR RESPONSIBILITY (full text: DISCLAIMER.md in this folder):
echo     - Use it only on computers, networks and devices you own or may use.
echo     - You decide who connects and what they may do; misuse to harm, spy on
echo       or get into other people's devices or accounts is forbidden.
echo     - It is free software by Pritom Barua under the GNU GPL v3, provided AS IS, without any
echo       warranty. The authors and contributors are not liable for any damage
echo       or loss, or for how anyone uses it or a copy of it.
echo     - Nothing is sent to the authors. No account, no cloud, no tracking.
echo.
set "ANSWER="
set /p "ANSWER=  Type Y and press Enter to agree and continue (anything else quits): "
if /i not "%ANSWER%"=="Y" (
  echo.
  echo   Nothing was downloaded or changed. Run start.bat again whenever you like.
  goto fail
)
:terms_yes
> data\.terms-accepted echo %TERMS%
echo.
:terms_done

rem ---------------------------------------------------------------- Python
set "PY="
call :find_python
if defined PY goto have_python
if defined CHECK echo [missing] Python 3.10 or newer & goto check_packages
echo Python is not installed yet. Installing Python %PYVER% (this happens once)...
where winget >nul 2>&1
if not errorlevel 1 (
  winget install -e --id Python.Python.3.13 --scope user --accept-source-agreements --accept-package-agreements
  call :find_python
)
if not defined PY call :python_direct
if not defined PY (
  echo.
  echo Python could not be installed automatically. Get it from https://www.python.org/downloads/
  echo ^(tick "Add python.exe to PATH"^), then run start.bat again.
  goto fail
)
:have_python
if defined CHECK for /f "delims=" %%v in ('%PY% --version 2^>^&1') do echo [ok]      %%v

rem ---------------------------------------------------------------- Python packages
rem Installed once, and again only when requirements.txt changes (so a normal start does not wait for pip).
:check_packages
if not defined PY goto check_node
if not exist data mkdir data
fc /b requirements.txt data\.requirements-installed >nul 2>&1
if not errorlevel 1 (
  if defined CHECK echo [ok]      Python packages
  goto check_node
)
if defined CHECK echo [missing] Python packages ^(requirements.txt^) & goto check_node
echo Getting the Python packages (this happens once, and takes a minute)...
%PY% -m pip install --user --disable-pip-version-check -q -r requirements.txt
if errorlevel 1 (
  echo.
  echo The Python packages could not be installed. Check the internet connection and run start.bat again.
  goto fail
)
copy /y requirements.txt data\.requirements-installed >nul

rem ---------------------------------------------------------------- the web app
rem A downloaded release already has it built (web\dist). A copy of the source code builds it once, with Node.js.
:check_node
if exist web\dist\index.html (
  if defined CHECK echo [ok]      Web app is built
  goto ready
)
set "NPM="
call :find_npm
if defined CHECK (
  if defined NPM (echo [ok]      Node.js) else (echo [missing] Node.js - a portable copy goes into tools\node)
  echo [missing] Web app build ^(web\dist^)
  goto ready
)
if defined NPM goto build
echo Getting Node.js %NODEVER% from nodejs.org into tools\node (this happens once)...
call :node_direct
call :find_npm
if not defined NPM (
  echo.
  echo Node.js could not be downloaded. Check the internet connection and run start.bat again.
  goto fail
)
:build
echo Building the web app (this happens once)...
call %NPM% install --no-fund --no-audit
if errorlevel 1 goto build_failed
call %NPM% run build
if errorlevel 1 goto build_failed
if exist web\dist\index.html goto ready
:build_failed
echo.
echo The web app could not be built. Check the internet connection and run start.bat again.
goto fail

rem ---------------------------------------------------------------- start
:ready
if defined CHECK (
  echo.
  if exist data\.terms-accepted (echo [ok]      First-run terms accepted) else (echo [missing] First-run terms: start.bat asks once)
  echo.
  echo Nothing was changed. Run start.bat without --check to set up what is missing and start.
  exit /b 0
)
%PY% -m phoneboxsound --terms-accepted %1 %2 %3 %4 %5 %6 %7 %8 %9
if errorlevel 1 pause
exit /b %errorlevel%

:fail
echo.
pause
exit /b 1

rem ---------------------------------------------------------------- helpers
:find_python
rem "python" on a fresh Windows is a shortcut to the Store that prints nothing useful, so each one is really tried.
for %%c in ("py -3" "python" "python3") do (
  if not defined PY (
    %%~c -c "import sys; sys.exit(0 if sys.version_info >= (3, 10) else 1)" >nul 2>&1 && set "PY=%%~c"
  )
)
if defined PY exit /b 0
for %%d in ("%LocalAppData%\Programs\Python\Python313" "%LocalAppData%\Programs\Python\Python312" "%ProgramFiles%\Python313" "%ProgramFiles%\Python312") do (
  if not defined PY if exist "%%~d\python.exe" set PY="%%~d\python.exe"
)
exit /b 0

:python_direct
rem Without winget: the official installer from python.org, checked to be signed by the Python Software Foundation,
rem installed for this user only (no administrator rights needed). Any failed check stops before anything runs.
rem (PSModulePath is cleared so that Windows PowerShell finds its own commands even when started from PowerShell 7.)
echo Downloading the Python installer from python.org...
set "PSModulePath="
powershell -NoProfile -ExecutionPolicy Bypass -Command ^
  "$ErrorActionPreference='Stop'; [Net.ServicePointManager]::SecurityProtocol=[Net.SecurityProtocolType]::Tls12; $f=Join-Path $env:TEMP 'python-%PYVER%-amd64.exe';" ^
  "(New-Object Net.WebClient).DownloadFile('https://www.python.org/ftp/python/%PYVER%/python-%PYVER%-amd64.exe', $f);" ^
  "$s=Get-AuthenticodeSignature -FilePath $f; if (-not ($s.Status -eq 'Valid' -and $s.SignerCertificate.Subject -match 'Python Software Foundation')) { Remove-Item $f; throw 'The download is not signed by the Python Software Foundation' };" ^
  "$p=Start-Process -FilePath $f -ArgumentList '/quiet','InstallAllUsers=0','PrependPath=1','Include_launcher=1','Include_test=0' -Wait -PassThru; Remove-Item $f; exit $p.ExitCode"
call :find_python
exit /b 0

:find_npm
if exist "tools\node\npm.cmd" (
  set "PATH=%CD%\tools\node;%PATH%"
  set "NPM=npm"
  exit /b 0
)
where npm >nul 2>&1 && set "NPM=npm" && exit /b 0
if exist "%ProgramFiles%\nodejs\npm.cmd" (
  set "PATH=%ProgramFiles%\nodejs;%PATH%"
  set "NPM=npm"
)
exit /b 0

:node_direct
rem The portable Node.js from nodejs.org, checked against its published checksum, unpacked into tools\node.
rem Nothing is installed in Windows; deleting the folder removes it. A wrong checksum stops before unpacking.
set "PSModulePath="
powershell -NoProfile -ExecutionPolicy Bypass -Command ^
  "$ErrorActionPreference='Stop'; [Net.ServicePointManager]::SecurityProtocol=[Net.SecurityProtocolType]::Tls12; $z=Join-Path $env:TEMP 'node-v%NODEVER%-win-x64.zip';" ^
  "(New-Object Net.WebClient).DownloadFile('https://nodejs.org/dist/v%NODEVER%/node-v%NODEVER%-win-x64.zip', $z);" ^
  "$sha=[Security.Cryptography.SHA256]::Create(); $st=[IO.File]::OpenRead($z); $h=([BitConverter]::ToString($sha.ComputeHash($st))).Replace('-',''); $st.Close();" ^
  "if ($h -ne '%NODESHA%') { Remove-Item $z; throw 'The Node.js download does not match its published checksum' };" ^
  "Add-Type -AssemblyName System.IO.Compression.FileSystem; $t=Join-Path $env:TEMP ('pbs-node-' + [guid]::NewGuid()); [IO.Compression.ZipFile]::ExtractToDirectory($z, $t);" ^
  "New-Item -ItemType Directory -Force tools | Out-Null; if (Test-Path tools\node) { Remove-Item -Recurse -Force tools\node }; Move-Item (Join-Path $t 'node-v%NODEVER%-win-x64') tools\node; Remove-Item -Recurse $t, $z"
exit /b 0
