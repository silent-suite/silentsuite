# SilentSuite Bridge — Windows PowerShell installer
#
# Usage:
#   irm silentsuite.io/bridge/install.ps1 | iex
#
# This script:
# 1. Detects architecture (x86_64 only)
# 2. Downloads the correct binary from GitHub Releases
# 3. Installs to %LOCALAPPDATA%\SilentSuite\
# 4. Adds install dir to user PATH
# 5. Sets up auto-start and launches login flow
#
# License: AGPL-3.0

$ErrorActionPreference = "Stop"

# --- Configuration ---
$Repo = "silent-suite/silentsuite"
$BinaryName = "silentsuite-bridge"
$InstallDir = if ($env:SILENTSUITE_INSTALL_DIR) { $env:SILENTSUITE_INSTALL_DIR } else { "$env:LOCALAPPDATA\SilentSuite" }
$ExePath = "$InstallDir\$BinaryName.exe"

# --- Helpers ---
function Write-Step($msg)  { Write-Host "`n  $msg" -ForegroundColor White }
function Write-Ok($msg)    { Write-Host "  ✓ $msg" -ForegroundColor Green }
function Write-Warn($msg)  { Write-Host "  ! $msg" -ForegroundColor Yellow }
function Write-Err($msg)   { Write-Host "  ✗ $msg" -ForegroundColor Red; exit 1 }

# --- Detect architecture ---
$Arch = [System.Runtime.InteropServices.RuntimeInformation]::OSArchitecture
if ($Arch -ne "X64") {
    Write-Err "Unsupported architecture: $Arch. Only x86_64 is supported."
}

# --- Banner ---
Write-Host ""
Write-Host "  SilentSuite Bridge" -ForegroundColor White
Write-Host "  E2EE CalDAV/CardDAV sync for your desktop apps"

# --- Check for existing installation ---
if (Test-Path $ExePath) {
    try {
        $CurrentVersion = & $ExePath --version 2>&1 | Select-Object -First 1
        Write-Step "Existing installation detected"
        Write-Ok "Current version: $CurrentVersion"
        Write-Ok "Upgrading..."
    } catch {
        Write-Warn "Existing binary found but could not read version"
    }
}

# --- Download latest release ---
Write-Step "Downloading latest release..."
$AssetName = "$BinaryName-windows-x86_64.exe"
$ReleaseUrl = "https://api.github.com/repos/$Repo/releases/latest"

try {
    $Release = Invoke-RestMethod -Uri $ReleaseUrl -Headers @{ "User-Agent" = "SilentSuite-Installer" }
} catch {
    Write-Err "Failed to fetch release info from GitHub: $_"
}

$Asset = $Release.assets | Where-Object { $_.name -eq $AssetName } | Select-Object -First 1
if (-not $Asset) {
    Write-Err "No asset found matching $AssetName. Check https://github.com/$Repo/releases"
}

# Create install directory
if (-not (Test-Path $InstallDir)) {
    New-Item -ItemType Directory -Path $InstallDir -Force | Out-Null
}

$TmpFile = Join-Path $env:TEMP "silentsuite-bridge-download.exe"
try {
    Invoke-WebRequest -Uri $Asset.browser_download_url -OutFile $TmpFile -UseBasicParsing
    Write-Ok "Downloaded $AssetName"
} catch {
    Write-Err "Download failed: $_"
}

# --- Verify SHA256 checksum ---
$ChecksumAsset = $Release.assets | Where-Object { $_.name -eq "$AssetName.sha256" } | Select-Object -First 1
if ($ChecksumAsset) {
    try {
        $ExpectedLine = (Invoke-WebRequest -Uri $ChecksumAsset.browser_download_url -UseBasicParsing).Content.Trim()
        $ExpectedHash = ($ExpectedLine -split '\s+')[0].ToUpper()
        $ActualHash = (Get-FileHash -Path $TmpFile -Algorithm SHA256).Hash.ToUpper()
        if ($ExpectedHash -ne $ActualHash) {
            Remove-Item $TmpFile -Force -ErrorAction SilentlyContinue
            Write-Err "Checksum mismatch! Expected $ExpectedHash, got $ActualHash"
        }
        Write-Ok "Checksum verified"
    } catch {
        Write-Warn "Could not verify checksum: $_"
    }
}

# --- Install binary ---
Move-Item -Path $TmpFile -Destination $ExePath -Force
Write-Ok "Installed to $ExePath"

# --- Add to user PATH ---
$UserPath = [Environment]::GetEnvironmentVariable("PATH", "User")
if ($UserPath -notlike "*$InstallDir*") {
    [Environment]::SetEnvironmentVariable("PATH", "$InstallDir;$UserPath", "User")
    Write-Ok "Added $InstallDir to user PATH"
} else {
    Write-Ok "$InstallDir already in PATH"
}
$env:PATH = "$InstallDir;$env:PATH"

# --- Auto-start ---
Write-Step "Setting up auto-start..."
try {
    & $ExePath --install-autostart 2>&1 | Out-Null
    Write-Ok "Auto-start configured"
} catch {
    Write-Warn "Could not set up auto-start (run later: $BinaryName --install-autostart)"
}

# --- Login ---
Write-Step "Launching login..."
Write-Host "  Opening your browser to sign in."
Write-Host "  After login, the bridge runs in the background.`n"
try {
    & $ExePath --login
    Start-Process -FilePath $ExePath -ArgumentList "--no-tray" -WindowStyle Hidden
    Start-Sleep -Seconds 2
    Write-Ok "Bridge is running! Dashboard: http://localhost:37358/.web/"
} catch {
    Write-Warn "Login did not complete. Run later: $BinaryName --login"
}

# --- Done ---
Write-Step "Setup complete!"
Write-Host ""
Write-Host "  Bridge installed." -ForegroundColor Green
Write-Host "  Dashboard: " -NoNewline; Write-Host "http://localhost:37358/.web/" -ForegroundColor Cyan
Write-Host "  Log in:    " -NoNewline; Write-Host "$BinaryName --login" -ForegroundColor Cyan
Write-Host "  Full docs: " -NoNewline; Write-Host "https://docs.silentsuite.io/bridge" -ForegroundColor Cyan
Write-Host ""
