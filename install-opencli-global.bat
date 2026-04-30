@echo off
setlocal EnableExtensions EnableDelayedExpansion

set "ROOT=%~dp0"
if "%ROOT:~-1%"=="\" set "ROOT=%ROOT:~0,-1%"

where npm >nul 2>&1
if errorlevel 1 (
  echo [ERROR] npm not found in PATH
  exit /b 1
)

set "PKG_FILE=%~1"
if not "%PKG_FILE%"=="" goto install

set "LATEST_VER="
set "LATEST_FILE="
for %%f in ("%ROOT%\jackwener-opencli-*.tgz") do (
  set "NAME=%%~nf"
  set "VER=!NAME:jackwener-opencli-=!"
  if "!LATEST_VER!"=="" (
    set "LATEST_VER=!VER!"
    set "LATEST_FILE=%%~ff"
  ) else (
    powershell -NoProfile -Command "if ([version]'!VER!' -gt [version]'!LATEST_VER!') { exit 0 } else { exit 1 }"
    if not errorlevel 1 (
      set "LATEST_VER=!VER!"
      set "LATEST_FILE=%%~ff"
    )
  )
)

if "%LATEST_FILE%"=="" (
  echo [ERROR] No package found: %ROOT%\jackwener-opencli-*.tgz
  echo Hint: run pack-opencli-tgz.bat first.
  exit /b 1
)

set "PKG_FILE=%LATEST_FILE%"

:install
if not exist "%PKG_FILE%" (
  echo [ERROR] Package file not found: %PKG_FILE%
  exit /b 1
)

echo Installing globally from: %PKG_FILE%
call npm install -g "%PKG_FILE%"
if errorlevel 1 (
  echo [ERROR] Global installation failed.
  exit /b 1
)

echo [OK] Global install completed.
call npm list -g --depth=0 @jackwener/opencli

endlocal
