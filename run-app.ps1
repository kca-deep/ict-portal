#Requires -Version 5.1
<#
.SYNOPSIS
    Production startup script for the ICT Portal (Next.js) app on Windows.

.DESCRIPTION
    Runs the full production flow from the project root:
      1. Verifies Node.js and pnpm are available.
      2. Verifies the .env.local file exists.
      3. Installs dependencies (pnpm install --frozen-lockfile).
      4. Builds the production bundle (pnpm build).
      5. Starts the Next.js production server (pnpm start).

.PARAMETER Port
    TCP port the production server listens on. Default: 3000.

.PARAMETER SkipInstall
    Skip the dependency install step.

.PARAMETER SkipBuild
    Skip the build step and reuse the existing .next output.

.PARAMETER NoStart
    Run install/build only and exit without starting the server.
    Useful for CI or for validating the build.

.EXAMPLE
    .\run-app.ps1

.EXAMPLE
    .\run-app.ps1 -Port 8080 -SkipInstall

.EXAMPLE
    .\run-app.ps1 -NoStart
#>

[CmdletBinding()]
param(
    [int]$Port = 3000,
    [switch]$SkipInstall,
    [switch]$SkipBuild,
    [switch]$NoStart
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

function Write-Step { param([string]$Message) Write-Host "==> $Message" -ForegroundColor Cyan }
function Write-Ok   { param([string]$Message) Write-Host "[OK]  $Message" -ForegroundColor Green }
function Write-Fail { param([string]$Message) Write-Host "[ERR] $Message" -ForegroundColor Red }

# Always operate from this script's folder (the project root).
$Root = $PSScriptRoot
Set-Location -LiteralPath $Root

try {
    Write-Step "Project root: $Root"

    # 1. Node.js
    $node = Get-Command node -ErrorAction SilentlyContinue
    if (-not $node) {
        throw "Node.js was not found on PATH. Install Node.js 20+ and retry."
    }
    Write-Ok "Node.js $(& node -v)"

    # 2. pnpm
    $pnpm = Get-Command pnpm -ErrorAction SilentlyContinue
    if (-not $pnpm) {
        throw "pnpm was not found on PATH. Run 'npm install -g pnpm' and retry."
    }
    Write-Ok "pnpm $(& pnpm -v)"

    # 3. Environment file
    $envFile = Join-Path $Root '.env.local'
    if (-not (Test-Path -LiteralPath $envFile)) {
        throw ".env.local was not found. Copy .env.example to .env.local and fill in the values."
    }
    Write-Ok ".env.local found"

    # 4. Install dependencies
    if ($SkipInstall) {
        Write-Step "Skipping dependency install (-SkipInstall)"
    }
    else {
        Write-Step "Installing dependencies (pnpm install --frozen-lockfile)"
        & pnpm install --frozen-lockfile
        if ($LASTEXITCODE -ne 0) { throw "pnpm install failed (exit code $LASTEXITCODE)." }
        Write-Ok "Dependencies installed"
    }

    # 5. Build
    if ($SkipBuild) {
        Write-Step "Skipping build (-SkipBuild)"
        if (-not (Test-Path -LiteralPath (Join-Path $Root '.next'))) {
            throw "No existing .next build output found. Run without -SkipBuild first."
        }
    }
    else {
        Write-Step "Building production bundle (pnpm build)"
        & pnpm build
        if ($LASTEXITCODE -ne 0) { throw "pnpm build failed (exit code $LASTEXITCODE)." }
        Write-Ok "Build complete"
    }

    # 6. Start
    if ($NoStart) {
        Write-Ok "Install/build finished. Server start skipped (-NoStart)."
        exit 0
    }

    $env:NODE_ENV = 'production'
    $env:PORT = "$Port"
    Write-Step "Starting production server on http://localhost:$Port  (press Ctrl+C to stop)"
    & pnpm start --port $Port
    if ($LASTEXITCODE -ne 0) { throw "pnpm start exited with code $LASTEXITCODE." }
}
catch {
    Write-Fail $_.Exception.Message
    exit 1
}
