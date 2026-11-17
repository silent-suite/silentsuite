param([Parameter(Mandatory=$true)][string]$Installer,
      [Parameter(Mandatory=$true)][string]$Root,
      [Parameter(Mandatory=$true)][string]$Mode)

$ErrorActionPreference = 'Stop'
$InstallDir = Join-Path $Root 'installed'
$OtherDir = Join-Path $Root 'other'
New-Item -ItemType Directory -Path $InstallDir,$OtherDir -Force | Out-Null
$ExePath = Join-Path $InstallDir 'silentsuite-bridge.exe'
$OtherExe = Join-Path $OtherDir 'silentsuite-bridge.exe'
$Candidate = Join-Path $Root 'candidate.exe'
$OldImage = Join-Path $Root 'previous.exe'
$ReadyName = 'Local\ss-ready-' + [Guid]::NewGuid().ToString('N')
$StopName = 'Local\ss-stop-' + [Guid]::NewGuid().ToString('N')
$ReadyEvent = [System.Threading.EventWaitHandle]::new($false, 'ManualReset', $ReadyName)
$StopEvent = [System.Threading.EventWaitHandle]::new($false, 'ManualReset', $StopName)
$env:SS_INSTALL_READY = $ReadyName
$env:SS_INSTALL_STOP = $StopName
$env:SS_FAIL_NEW_START = if ($Mode -eq 'start-failed') { '1' } else { '0' }

$Program = @'
using System;
using System.Diagnostics;
using System.Reflection;
using System.Threading;
namespace NAMESPACE {
  public class Program {
    private static readonly string Version = "VERSION";
    public static int Main(string[] args) {
      string arg = args.Length == 0 ? "--serve" : args[0];
      if (arg == "--version") { Console.WriteLine(Version); return 0; }
      if (arg == "--login" || arg == "--install-autostart") return 0;
      if (arg == "--background") {
        if (Version == "new" && Environment.GetEnvironmentVariable("SS_FAIL_NEW_START") == "1") return 1;
        var start = new ProcessStartInfo(Assembly.GetExecutingAssembly().Location, "--serve");
        start.UseShellExecute = false; start.CreateNoWindow = true;
        Process.Start(start); return 0;
      }
      using (var ready = EventWaitHandle.OpenExisting(Environment.GetEnvironmentVariable("SS_INSTALL_READY")))
      using (var stop = EventWaitHandle.OpenExisting(Environment.GetEnvironmentVariable("SS_INSTALL_STOP"))) {
        ready.Set(); stop.WaitOne(60000);
      }
      return 0;
    }
  }
}
'@
Add-Type -TypeDefinition ($Program.Replace('NAMESPACE','PreviousBridge').Replace('VERSION','old')) `
    -OutputAssembly $OldImage -OutputType ConsoleApplication
Add-Type -TypeDefinition ($Program.Replace('NAMESPACE','CandidateBridge').Replace('VERSION','new')) `
    -OutputAssembly $Candidate -OutputType ConsoleApplication
Copy-Item $OldImage $ExePath
Copy-Item $OldImage $OtherExe
$OldHash = (Get-FileHash $OldImage -Algorithm SHA256).Hash
$NewHash = (Get-FileHash $Candidate -Algorithm SHA256).Hash
$Old = $null
$Other = $null
$Failed = $false
$script:Injected = $false
$script:RestoreFailures = 0

try {
    $Old = Start-Process -FilePath $ExePath -ArgumentList '--serve' -PassThru -WindowStyle Hidden
    if (-not $ReadyEvent.WaitOne(10000)) { throw 'Previous process did not acknowledge startup' }
    $ReadyEvent.Reset() | Out-Null
    $Other = Start-Process -FilePath $OtherExe -ArgumentList '--serve' -PassThru -WindowStyle Hidden
    if (-not $ReadyEvent.WaitOne(10000)) { throw 'Other process did not acknowledge startup' }
    $ReadyEvent.Reset() | Out-Null

    $Tokens = $null
    $Errors = $null
    $InstallerText = [IO.File]::ReadAllText($Installer, [Text.Encoding]::UTF8)
    $Ast = [System.Management.Automation.Language.Parser]::ParseInput($InstallerText,[ref]$Tokens,[ref]$Errors)
    if ($Errors.Count -ne 0) { throw 'Installer did not parse' }
    foreach ($Statement in $Ast.EndBlock.Statements) {
        if ($Statement -is [System.Management.Automation.Language.FunctionDefinitionAst]) {
            $Definition = $Statement.Extent.Text
            # Keep the existing user-PATH branch out of this isolated process test.
            $Definition = $Definition.Replace(
                '[Environment]::GetEnvironmentVariable("PATH", "User")', '$InstallDir')
            $Definition = $Definition.Replace(
                '[Environment]::SetEnvironmentVariable("PATH", "$InstallDir;$UserPath", "User")',
                "throw 'Unexpected user-PATH write in process fixture'")
            if ($Definition.Contains('[Environment]::SetEnvironmentVariable')) {
                throw 'Environment write was not isolated by the fixture'
            }
            . ([ScriptBlock]::Create($Definition))
        }
    }
    $Repo = 'fixture/repository'
    $BinaryName = 'silentsuite-bridge'
    $InstallLog = Join-Path $Root 'install.log'
    $BridgeLog = Join-Path $Root 'bridge.log'
    $BridgeDashboardUrl = 'http://127.0.0.1:37358/'

    function Invoke-RestMethod {
        param($Uri,$Headers)
        return [pscustomobject]@{tag_name='fixture';assets=@(
            [pscustomobject]@{name='silentsuite-bridge-windows-x86_64.exe';browser_download_url='https://fixture.invalid/new.exe'},
            [pscustomobject]@{name='silentsuite-bridge-windows-x86_64.exe.sha256';browser_download_url='https://fixture.invalid/new.exe.sha256'}
        )}
    }
    function Invoke-WebRequest {
        param($Uri,$OutFile,[switch]$UseBasicParsing,$TimeoutSec)
        if ($OutFile) { Copy-Item $Candidate $OutFile; return }
        if ($Uri.EndsWith('.sha256')) {
            return [pscustomobject]@{Content=($NewHash + '  silentsuite-bridge-windows-x86_64.exe')}
        }
        return [pscustomobject]@{StatusCode=200}
    }
    function Test-BridgeDashboardReady {
        param([int]$TimeoutSeconds=20)
        return $ReadyEvent.WaitOne(5000)
    }
    function Move-Item {
        [CmdletBinding()]
        param($Path,$LiteralPath,$Destination,[switch]$Force)
        $Source = if ($LiteralPath) { $LiteralPath } else { $Path }
        if ($Mode -eq 'restore-failed' -and $Destination -eq $ExePath) {
            $script:RestoreFailures += 1
            throw 'Injected swap or restore failure'
        }
        $Swap = $Mode -eq 'swap-failed' -and $Destination -eq $ExePath
        $Backup = $Mode -eq 'backup-failed' -and $Source -eq $ExePath -and $Destination -ne $ExePath
        if (-not $script:Injected -and ($Swap -or $Backup)) {
            $script:Injected = $true
            throw 'Injected replacement failure'
        }
        Microsoft.PowerShell.Management\Move-Item @PSBoundParameters
    }
    function Stop-Process {
        [CmdletBinding()]
        param([Parameter(ValueFromPipeline=$true)]$InputObject,$Id,[switch]$Force)
        process {
            if ($Mode -eq 'stop-failed') { throw 'Injected stop failure' }
            Microsoft.PowerShell.Management\Stop-Process @PSBoundParameters
        }
    }

    try { Invoke-SilentSuiteBridgeInstall } catch { $Failed = $true }
    if ($Mode -in @('swap-failed','backup-failed','start-failed')) {
        if (-not $ReadyEvent.WaitOne(10000)) { throw 'Restored process did not acknowledge startup' }
    }
    $Old.Refresh()
    $Other.Refresh()
    $InstalledHash = if (Test-Path $ExePath) { (Get-FileHash $ExePath -Algorithm SHA256).Hash } else { '' }
    $AtTarget = @(Get-Process | Where-Object {
        try { $_.Path -eq $ExePath } catch { $false }
    })
    $OldBackups = @(Get-ChildItem -Path $InstallDir -File | Where-Object {
        $_.FullName -ne $ExePath -and (Get-FileHash $_.FullName -Algorithm SHA256).Hash -eq $OldHash
    })
    [pscustomobject]@{
        Failed=$Failed; OldExited=$Old.HasExited; OtherAlive=(-not $Other.HasExited)
        InstalledNew=($InstalledHash -eq $NewHash); InstalledOld=($InstalledHash -eq $OldHash)
        TargetRunning=($AtTarget.Count -gt 0); Injected=$script:Injected
        OldBackupRetained=($OldBackups.Count -gt 0); RestoreFailures=$script:RestoreFailures
    } | ConvertTo-Json -Compress | Set-Content (Join-Path $Root 'result.json') -Encoding UTF8
} finally {
    $StopEvent.Set() | Out-Null
    $Owned = @(Get-Process | Where-Object {
        try { $_.Path -eq $ExePath -or $_.Path -eq $OtherExe } catch { $false }
    })
    foreach ($Process in $Owned) {
        if (-not $Process.WaitForExit(5000)) {
            Microsoft.PowerShell.Management\Stop-Process -InputObject $Process -Force -ErrorAction SilentlyContinue
            if (-not $Process.WaitForExit(5000)) { throw 'Owned process did not exit' }
        }
    }
    $ReadyEvent.Dispose()
    $StopEvent.Dispose()
}
