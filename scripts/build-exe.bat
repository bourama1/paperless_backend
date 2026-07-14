@echo off
setlocal enabledelayedexpansion

set REPO=%~dp0..
set OUT=%REPO%\publish

echo === Step 1: Compile TypeScript ===
cd /d "%REPO%"
call npm run build
if %ERRORLEVEL% neq 0 (
    echo BUILD FAILED
    exit /b 1
)

echo === Step 2: Bundle into .exe ===
if exist "%OUT%" rmdir /s /q "%OUT%"
mkdir "%OUT%\config" 2>nul

call npx pkg dist/index.js --target node24-win-x64 --output "%OUT%\paperless-backend.exe" --no-bytecode --public-packages "*" --public
set PKG_EXIT=%ERRORLEVEL%
echo pkg exit code: %PKG_EXIT%
if %PKG_EXIT% neq 0 (
    echo WARNING: pkg returned exit code %PKG_EXIT% — exe may be incomplete
)

echo === Step 3: Copy config files ===
xcopy /e /i /q "%REPO%\config" "%OUT%\config"
if %ERRORLEVEL% neq 0 (
    echo WARNING: xcopy config returned %ERRORLEVEL%
)
powershell -Command "Copy-Item -LiteralPath '%REPO%\.env' -Destination '%OUT%\.env.example' -Force"
if %ERRORLEVEL% neq 0 (
    echo WARNING: .env copy returned %ERRORLEVEL%
)

echo === Step 4: Create zip archive ===
for /f "delims=" %%i in ('powershell -NoProfile -Command "Get-Date -Format 'yyyyMMdd'"') do set ZIPDATE=%%i
set ZIPNAME=paperless-backend-%ZIPDATE%.zip
if exist "%OUT%\%ZIPNAME%" del "%OUT%\%ZIPNAME%"
powershell -Command "Compress-Archive -Path '%OUT%\*' -DestinationPath '%OUT%\%ZIPNAME%' -Force"

echo.
echo === Verification ===
if exist "%OUT%\paperless-backend.exe" (
    echo   [OK] paperless-backend.exe
) else (
    echo   [MISSING] paperless-backend.exe
)
if exist "%OUT%\.env.example" (
    echo   [OK] .env.example
) else (
    echo   [MISSING] .env.example
)
if exist "%OUT%\config\country-codes.json" (
    echo   [OK] config\country-codes.json
) else (
    echo   [MISSING] config\country-codes.json
)
if exist "%OUT%\config\label-type-config.json" (
    echo   [OK] config\label-type-config.json
) else (
    echo   [MISSING] config\label-type-config.json
)
if exist "%OUT%\%ZIPNAME%" (
    echo   [OK] %ZIPNAME%
) else (
    echo   [MISSING] %ZIPNAME%
)

echo.
echo === Done ===
echo Output folder: %OUT%
echo Zip archive: %OUT%\%ZIPNAME%
echo.
echo To deploy:
echo   1. Copy %OUT%\%ZIPNAME% to target server and unzip
echo   2. Rename .env.example to .env and edit settings
echo   3. Run paperless-backend.exe
echo.
echo Size:
for %%f in ("%OUT%\paperless-backend.exe") do echo   exe: %%~zf bytes
for %%f in ("%OUT%\%ZIPNAME%") do echo   zip: %%~zf bytes
