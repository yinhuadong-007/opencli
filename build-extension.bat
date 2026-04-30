@echo off
setlocal EnableExtensions EnableDelayedExpansion

set "ROOT=%~dp0"
if "%ROOT:~-1%"=="\" set "ROOT=%ROOT:~0,-1%"
set "EXT_DIR=%ROOT%\extension"
set "MANIFEST=%EXT_DIR%\manifest.json"

if not exist "%MANIFEST%" (
  echo [ERROR] manifest not found: %MANIFEST%
  exit /b 1
)

where npm >nul 2>&1
if errorlevel 1 (
  echo [ERROR] npm not found in PATH
  exit /b 1
)

echo [1/4] Building extension...
call npm --prefix "%EXT_DIR%" run build
if errorlevel 1 (
  echo [ERROR] Extension build failed.
  exit /b 1
)

for /f "usebackq delims=" %%v in (`powershell -NoProfile -Command "(Get-Content '%MANIFEST%' | ConvertFrom-Json).version"`) do set "EXT_VER=%%v"

if "%EXT_VER%"=="" (
  echo [ERROR] Failed to read extension version from manifest.
  exit /b 1
)

set "OUT_DIR=%ROOT%\opencli-extension-v%EXT_VER%"

echo [2/4] Preparing output folder: %OUT_DIR%
if exist "%OUT_DIR%" rmdir /s /q "%OUT_DIR%"
mkdir "%OUT_DIR%"
if errorlevel 1 (
  echo [ERROR] Failed to create output folder.
  exit /b 1
)

echo [3/4] Copying extension files...
copy /y "%EXT_DIR%\manifest.json" "%OUT_DIR%\" >nul
copy /y "%EXT_DIR%\popup.html" "%OUT_DIR%\" >nul
copy /y "%EXT_DIR%\popup.js" "%OUT_DIR%\" >nul
xcopy "%EXT_DIR%\dist" "%OUT_DIR%\dist\" /E /I /Y >nul
xcopy "%EXT_DIR%\icons" "%OUT_DIR%\icons\" /E /I /Y >nul

echo [4/4] Done.
echo Output: %OUT_DIR%

endlocal
