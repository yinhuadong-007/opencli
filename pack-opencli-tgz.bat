@echo off
setlocal EnableExtensions EnableDelayedExpansion

set "ROOT=%~dp0"
if "%ROOT:~-1%"=="\" set "ROOT=%ROOT:~0,-1%"
set "PKG_JSON=%ROOT%\package.json"

if not exist "%PKG_JSON%" (
  echo [ERROR] package.json not found: %PKG_JSON%
  exit /b 1
)

where npm >nul 2>&1
if errorlevel 1 (
  echo [ERROR] npm not found in PATH
  exit /b 1
)

for /f "usebackq delims=" %%v in (`powershell -NoProfile -Command "(Get-Content '%PKG_JSON%' | ConvertFrom-Json).version"`) do set "PKG_VER=%%v"
if "%PKG_VER%"=="" (
  echo [ERROR] Failed to read version from package.json
  exit /b 1
)

set "TARGET_NAME=jackwener-opencli-%PKG_VER%.tgz"

echo [1/3] Building package...
call npm run build
if errorlevel 1 (
  echo [ERROR] Build failed.
  exit /b 1
)

echo [2/3] Packing npm tarball...
for /f "usebackq delims=" %%f in (`npm pack`) do set "PACK_NAME=%%f"
if "%PACK_NAME%"=="" (
  echo [ERROR] npm pack did not return output filename.
  exit /b 1
)

if /I not "%PACK_NAME%"=="%TARGET_NAME%" (
  if exist "%TARGET_NAME%" del /f /q "%TARGET_NAME%" >nul 2>&1
  ren "%PACK_NAME%" "%TARGET_NAME%"
)

echo [3/3] Done.
echo Output: %ROOT%\%TARGET_NAME%

endlocal
