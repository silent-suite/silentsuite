# SilentSuite Bridge — Windows PowerShell installer
#
# Usage:
#   irm https://raw.githubusercontent.com/silent-suite/silentsuite/main/bridge/install.ps1 | iex
#
# Safer diagnostic usage if a one-liner fails:
#   irm https://raw.githubusercontent.com/silent-suite/silentsuite/main/bridge/install.ps1 -OutFile $env:TEMP\silentsuite-bridge-install.ps1
#   powershell -ExecutionPolicy Bypass -File $env:TEMP\silentsuite-bridge-install.ps1
#
# This script:
# 1. Detects architecture (x86_64 only)
# 2. Downloads the correct binary from GitHub Releases
# 3. Installs to %LOCALAPPDATA%\SilentSuite\
# 4. Adds install dir to user PATH
# 5. Sets up auto-start, launches the login flow and starts the bridge in the background
#
# License: AGPL-3.0

$PreviousErrorActionPreference = $ErrorActionPreference
$ErrorActionPreference = "Stop"

# --- Configuration ---
$Repo = "silent-suite/silentsuite"
$BinaryName = "silentsuite-bridge"
$InstallDir = if ($env:SILENTSUITE_INSTALL_DIR) { $env:SILENTSUITE_INSTALL_DIR } else { "$env:LOCALAPPDATA\SilentSuite" }
$ExePath = "$InstallDir\$BinaryName.exe"
$InstallLog = Join-Path $InstallDir "install.log"
# Where `silentsuite-bridge --background` (installer and sign-in start) logs:
# bridge.log in the bridge data directory (platformdirs user_data_dir).
$BridgeLog = Join-Path $env:LOCALAPPDATA "silentsuite\silentsuite-bridge\bridge.log"
$BridgeDashboardUrl = "http://127.0.0.1:37358/"

# --- Helpers ---
function Write-InstallLog($msg) {
    try {
        if (-not (Test-Path $InstallDir)) {
            New-Item -ItemType Directory -Path $InstallDir -Force | Out-Null
        }
        $Timestamp = Get-Date -Format "yyyy-MM-dd HH:mm:ss"
        Add-Content -Path $InstallLog -Value "[$Timestamp] $msg" -Encoding UTF8
    } catch {
        # Logging must never hide the installer error the user needs to see.
    }
}

function Write-Step($msg)  { Write-Host "`n  $msg" -ForegroundColor White; Write-InstallLog "STEP $msg" }
function Write-Ok($msg)    { Write-Host "  ✓ $msg" -ForegroundColor Green; Write-InstallLog "OK $msg" }
function Write-Warn($msg)  { Write-Host "  ! $msg" -ForegroundColor Yellow; Write-InstallLog "WARN $msg" }
function Write-Err($msg)   { Write-Host "  ✗ $msg" -ForegroundColor Red; Write-InstallLog "ERROR $msg"; throw $msg }

function Wait-BeforeCloseIfInteractive {
    if ($env:CI) { return }
    if (-not [Environment]::UserInteractive) { return }

    try {
        Write-Host ""
        Read-Host "Press Enter to close"
    } catch {
        # Some non-interactive hosts still report as interactive. Ignore pause failures.
    }
}

function Get-GitHubErrorHint($errorRecord) {
    $statusCode = $null
    try {
        $statusCode = [int]$errorRecord.Exception.Response.StatusCode
    } catch {
        $statusCode = $null
    }

    if ($statusCode -eq 403) {
        return "GitHub refused the release lookup, possibly because the unauthenticated API rate limit was reached. Download manually from https://github.com/$Repo/releases/latest or retry later."
    }
    if ($statusCode -eq 404) {
        return "GitHub did not return release metadata. Check https://github.com/$Repo/releases/latest for current downloads."
    }
    return "Check https://github.com/$Repo/releases/latest for manual downloads."
}

function Test-BridgeDashboardReady([int]$TimeoutSeconds = 20) {
    $Deadline = (Get-Date).AddSeconds($TimeoutSeconds)
    while ((Get-Date) -lt $Deadline) {
        try {
            $Response = Invoke-WebRequest -Uri $BridgeDashboardUrl -UseBasicParsing -TimeoutSec 2
            if ($Response.StatusCode -ge 200 -and $Response.StatusCode -lt 500) {
                return $true
            }
        } catch {
            # The bridge may still be starting or syncing. Keep polling until the deadline.
        }
        Start-Sleep -Milliseconds 500
    }
    return $false
}

function Get-InstalledBridgeProcesses([string]$Target) {
    $FullTarget = [IO.Path]::GetFullPath($Target)
    $Name = [IO.Path]::GetFileNameWithoutExtension($FullTarget)
    foreach ($Process in @(Get-Process -Name $Name -ErrorAction SilentlyContinue)) {
        if ($Process.HasExited) { continue }
        $Image = $Process.Path
        if (-not $Image) { throw 'Could not identify a running bridge executable; quit it before upgrading.' }
        if ([StringComparer]::OrdinalIgnoreCase.Equals([IO.Path]::GetFullPath($Image), $FullTarget)) {
            $null = $Process.Handle
            $Process
        }
    }
}

function Stop-InstalledBridgeProcesses($Processes) {
    foreach ($Process in $Processes) {
        $Process.Refresh()
        if (-not $Process.HasExited) {
            Stop-Process -InputObject $Process -Force -ErrorAction Stop
        }
    }
    foreach ($Process in $Processes) {
        if (-not $Process.WaitForExit(10000)) { throw 'The previous bridge did not exit; replacement was refused.' }
    }
}

function Restore-BridgeBinary($State) {
    if ($State.BackedUp) {
        Stop-InstalledBridgeProcesses @(Get-InstalledBridgeProcesses $State.Target)
        if (Test-Path -LiteralPath $State.Target) {
            Remove-Item -LiteralPath $State.Target -Force -ErrorAction Stop
        }
        Move-Item -LiteralPath $State.Backup -Destination $State.Target -Force -ErrorAction Stop
        $State.BackedUp = $false
    } elseif (-not $State.HadTarget -and $State.Installed) {
        Stop-InstalledBridgeProcesses @(Get-InstalledBridgeProcesses $State.Target)
    }
    if ($State.WasRunning -and (Test-Path -LiteralPath $State.Target)) {
        if (@(Get-InstalledBridgeProcesses $State.Target).Count -eq 0) {
            # Earlier releases may not implement the detached-start flag.
            Start-Process -FilePath $State.Target -ArgumentList '--no-tray' -WindowStyle Hidden -ErrorAction Stop
        }
    }
}

function Install-BridgeBinary([string]$Source, [string]$Target, [string]$ExpectedHash) {
    $Directory = Split-Path -Parent $Target
    $Previous = @(Get-InstalledBridgeProcesses $Target)
    $State = [pscustomobject]@{
        Target=$Target; HadTarget=(Test-Path -LiteralPath $Target)
        Backup=(Join-Path $Directory ([Guid]::NewGuid().ToString('N') + '.previous.exe'))
        Staged=(Join-Path $Directory ([Guid]::NewGuid().ToString('N') + '.update-staged'))
        Previous=$Previous; WasRunning=($Previous.Count -gt 0); BackedUp=$false; Installed=$false
    }
    try {
        Move-Item -LiteralPath $Source -Destination $State.Staged -Force -ErrorAction Stop
        if ((Get-FileHash -LiteralPath $State.Staged -Algorithm SHA256).Hash -ne $ExpectedHash) {
            throw 'Staged bridge did not match the verified download.'
        }
        Stop-InstalledBridgeProcesses $Previous
        if (@(Get-InstalledBridgeProcesses $Target).Count -ne 0) {
            throw 'Another bridge process appeared; replacement was refused.'
        }
        if ($State.HadTarget) {
            Move-Item -LiteralPath $Target -Destination $State.Backup -Force -ErrorAction Stop
            $State.BackedUp = $true
        }
        Move-Item -LiteralPath $State.Staged -Destination $Target -Force -ErrorAction Stop
        $State.Installed = $true
        return $State
    } catch {
        try { Restore-BridgeBinary $State } catch {
            Write-Warn "Previous bridge recovery was not confirmed. Retained backup, if present: $($State.Backup)"
        }
        throw
    } finally {
        Remove-Item -LiteralPath $State.Staged -Force -ErrorAction SilentlyContinue
    }
}

function Get-OSArchitecture {
    # RuntimeInformation can come back empty in Windows PowerShell 5.1, so fall
    # back to the variables Windows sets for every process. A 32-bit PowerShell
    # on 64-bit Windows reports the OS architecture in PROCESSOR_ARCHITEW6432.
    $Arch = ""
    try { $Arch = "$([System.Runtime.InteropServices.RuntimeInformation]::OSArchitecture)" } catch { $Arch = "" }
    if (-not $Arch) {
        $Arch = if ($env:PROCESSOR_ARCHITEW6432) { $env:PROCESSOR_ARCHITEW6432 } else { $env:PROCESSOR_ARCHITECTURE }
    }
    if ($Arch -eq "AMD64") { $Arch = "X64" }
    return $Arch
}

function Invoke-SilentSuiteBridgeInstall {
    # --- Detect architecture ---
    $Arch = Get-OSArchitecture
    if ($Arch -ne "X64") {
        Write-Err "Unsupported architecture: $Arch. Only x86_64 is supported."
    }

    # --- Banner ---
    Write-Host ""
    Write-Host "  SilentSuite Bridge" -ForegroundColor White
    Write-Host "  E2EE CalDAV/CardDAV sync for your desktop apps"
    Write-InstallLog "Installer started"

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
        $Hint = Get-GitHubErrorHint $_
        Write-Err "Failed to fetch latest release info from GitHub: $_. $Hint"
    }

    $Asset = $Release.assets | Where-Object { $_.name -eq $AssetName } | Select-Object -First 1
    if (-not $Asset) {
        # Fallback for the unlikely case where the newest umbrella release has no bridge asset.
        $ReleaseListUrl = "https://api.github.com/repos/$Repo/releases?per_page=25"
        try {
            $Releases = Invoke-RestMethod -Uri $ReleaseListUrl -Headers @{ "User-Agent" = "SilentSuite-Installer" }
        } catch {
            $Hint = Get-GitHubErrorHint $_
            Write-Err "Latest release did not contain $AssetName and fallback release lookup failed: $_. $Hint"
        }

        foreach ($r in $Releases) {
            $candidate = $r.assets | Where-Object { $_.name -eq $AssetName } | Select-Object -First 1
            if ($candidate) {
                $Release = $r
                $Asset = $candidate
                break
            }
        }
    }

    if (-not $Asset) {
        Write-Err "No asset found matching $AssetName across recent releases. Download manually from https://github.com/$Repo/releases/latest"
    }

    # Create install directory
    if (-not (Test-Path $InstallDir)) {
        New-Item -ItemType Directory -Path $InstallDir -Force | Out-Null
    }

    $TmpFile = Join-Path $env:TEMP "silentsuite-bridge-download.exe"
    try {
        Invoke-WebRequest -Uri $Asset.browser_download_url -OutFile $TmpFile -UseBasicParsing
        Write-Ok "Downloaded $AssetName from $($Release.tag_name)"
    } catch {
        Write-Err "Download failed: $_. Try downloading manually from https://github.com/$Repo/releases/latest"
    }

    # --- Verify SHA256 checksum ---
    $ChecksumAsset = $Release.assets | Where-Object { $_.name -eq "$AssetName.sha256" } | Select-Object -First 1
    if (-not $ChecksumAsset) {
        Remove-Item $TmpFile -Force -ErrorAction SilentlyContinue
        Write-Err "No checksum asset found for $AssetName; refusing to install an unverified binary"
    }

    try {
        $ExpectedLine = (Invoke-WebRequest -Uri $ChecksumAsset.browser_download_url -UseBasicParsing).Content.Trim()
        $ExpectedHash = ($ExpectedLine -split '\s+')[0].ToUpper()
        if ($ExpectedHash -notmatch '^[0-9A-F]{64}$') {
            Write-Err "Invalid checksum content for $AssetName.sha256"
        }
        $ActualHash = (Get-FileHash -Path $TmpFile -Algorithm SHA256).Hash.ToUpper()
    } catch {
        Remove-Item $TmpFile -Force -ErrorAction SilentlyContinue
        Write-Err "Could not verify checksum: $_"
    }

    if ($ExpectedHash -ne $ActualHash) {
        Remove-Item $TmpFile -Force -ErrorAction SilentlyContinue
        Write-Err "Checksum mismatch! Expected $ExpectedHash, got $ActualHash"
    } else {
        Write-Ok "Checksum verified"
    }

    # --- Install binary ---
    $Replacement = Install-BridgeBinary -Source $TmpFile -Target $ExePath -ExpectedHash $ExpectedHash
    try {
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
        # The bridge validates and persists explicitly set SILENTSUITE_LISTEN_* /
        # SILENTSUITE_SERVER_HOSTS / SILENTSUITE_ALLOW_REMOTE into settings.json before
        # writing the startup entry. A non-zero exit code means the entry was not
        # confirmed, so do not report success in that case.
        try {
            & $ExePath --install-autostart 2>&1 | Out-Null
            if ($LASTEXITCODE -ne 0) {
                Write-Warn "Auto-start was not confirmed (exit code $LASTEXITCODE). Retry later with: $BinaryName --install-autostart"
            } else {
                Write-Ok "Auto-start configured"
            }
        } catch {
            Write-Warn "Could not set up auto-start (run later: $BinaryName --install-autostart)"
        }

        # --- Login ---
        Write-Step "Launching login..."
        Write-Host "  Opening your browser to sign in."
        Write-Host "  The browser sign-in tab may use a temporary random port. Use the app URL it shows, not the address bar.`n"
        $LoginOk = $false
        try {
            & $ExePath --login
            $LoginOk = ($LASTEXITCODE -eq 0)
        } catch {
            $LoginOk = $false
        }
        if (-not $LoginOk) {
            Write-Warn "Login did not complete. Sign in from the dashboard once the bridge is running, or run later: $BinaryName --login"
        }

        # --background starts the bridge without a window (and outside this
        # terminal where Windows allows it), so closing PowerShell does not
        # stop it. It logs to $BridgeLog and refuses to start a second copy.
        $BackgroundExit = 1
        try {
            $BackgroundOutput = & $ExePath --background 2>&1
            $BackgroundExit = $LASTEXITCODE
            $BackgroundOutput | ForEach-Object { Write-InstallLog "bridge --background: $_" }
        } catch {
            Write-InstallLog "bridge --background failed: $_"
        }

        if ($BackgroundExit -ne 0) {
            throw "The replacement bridge did not start (exit code $BackgroundExit). Check $BridgeLog."
        }
        $DashboardReady = Test-BridgeDashboardReady -TimeoutSeconds 20
        if (-not $DashboardReady -and $Replacement.HadTarget) {
            throw "The replacement bridge dashboard did not respond yet. Check $BridgeLog."
        }
        if ((Get-FileHash -LiteralPath $ExePath -Algorithm SHA256).Hash -ne $ExpectedHash -or
            @(Get-InstalledBridgeProcesses $ExePath).Count -eq 0) {
            throw 'The verified replacement executable was not confirmed running.'
        }
        foreach ($Previous in $Replacement.Previous) {
            if (-not $Previous.HasExited) { throw 'The previous bridge is still running.' }
        }
        if ($Replacement.BackedUp) {
            try {
                Remove-Item -LiteralPath $Replacement.Backup -Force -ErrorAction Stop
                $Replacement.BackedUp = $false
            } catch {
                Write-Warn "The verified bridge is running, but its previous backup could not be removed: $($Replacement.Backup)"
            }
        }
        if ($DashboardReady) {
            Write-Ok "Bridge is running in the background. Closing this window does not stop it. Dashboard: $BridgeDashboardUrl"
        } else {
            Write-Warn "Bridge started in the background but the dashboard did not respond yet. Open $BridgeDashboardUrl or check $BridgeLog before adding the URL to your calendar app."
        }

        # --- Done ---
        Write-Step "Setup complete!"
        Write-Host ""
        Write-Host "  Bridge installed." -ForegroundColor Green
        Write-Host "  Dashboard: " -NoNewline; Write-Host "$BridgeDashboardUrl" -ForegroundColor Cyan
        Write-Host "  Log in:    " -NoNewline; Write-Host "$BinaryName --login" -ForegroundColor Cyan
        Write-Host "  Install log: " -NoNewline; Write-Host "$InstallLog" -ForegroundColor Cyan
        Write-Host "  Bridge log:  " -NoNewline; Write-Host "$BridgeLog" -ForegroundColor Cyan
        Write-Host "  Full docs: " -NoNewline; Write-Host "https://docs.silentsuite.io/bridge" -ForegroundColor Cyan
        Write-Host ""
    } catch {
        try { Restore-BridgeBinary $Replacement } catch {
            Write-Warn "Previous bridge recovery was not confirmed. Retained backup, if present: $($Replacement.Backup)"
        }
        throw
    }
}

try {
    Invoke-SilentSuiteBridgeInstall
} catch {
    Write-Host ""
    Write-Host "  SilentSuite Bridge install failed." -ForegroundColor Red
    Write-Host "  Error: $_" -ForegroundColor Red
    Write-Host "  Log file: $InstallLog" -ForegroundColor Yellow
    Write-Host "  Manual download: https://github.com/$Repo/releases/latest/download/silentsuite-bridge-windows-x86_64.exe" -ForegroundColor Cyan
    Write-InstallLog "Install failed: $_"
    Wait-BeforeCloseIfInteractive
    throw
} finally {
    $ErrorActionPreference = $PreviousErrorActionPreference
}
