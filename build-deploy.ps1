param(
    [string]$OutputDir = "./deploy"
)

$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $root

Write-Host "=== 1. Rebuilding TypeScript ==="
npx tsc --project tsconfig.build.json
if ($LASTEXITCODE -ne 0) { throw "TypeScript build failed" }

Write-Host "=== 2. Building standalone .exe with pkg ==="
npx pkg dist/index.js --targets node18-win-x64 --output paperless-server.exe
if ($LASTEXITCODE -ne 0) { throw "pkg build failed" }

Write-Host "=== 3. Preparing deploy folder ==="
if (Test-Path $OutputDir) { Remove-Item -Path "$OutputDir\*" -Recurse -Force }
New-Item -ItemType Directory -Path $OutputDir -Force | Out-Null
New-Item -ItemType Directory -Path "$OutputDir\config" -Force | Out-Null

Copy-Item "paperless-server.exe" -Destination "$OutputDir\paperless-server.exe"
Copy-Item ".env" -Destination "$OutputDir\.env"
Copy-Item "config\country-codes.json" -Destination "$OutputDir\config\country-codes.json"

@"
@echo off
title Paperless Backend Server
echo Starting Paperless Backend Server...
echo.
echo Server will listen on port 5300
echo Health check: http://localhost:5300/health
echo.
echo Make sure PostgreSQL is running and .env PG_* settings are correct!
echo.
paperless-server.exe
pause
"@ | Out-File -FilePath "$OutputDir\start.bat" -Encoding ascii

Write-Host "=== 4. Creating deploy zip ==="
$zipPath = "paperless-server-deploy.zip"
Compress-Archive -Path "$OutputDir\*" -DestinationPath $zipPath -Force

$zipSize = [math]::Round((Get-ChildItem $zipPath).Length / 1MB, 2)
Write-Host "=== Done ==="
Write-Host "  Deploy folder: $OutputDir"
Write-Host "  Zip archive:   $zipPath ($zipSize MB)"
