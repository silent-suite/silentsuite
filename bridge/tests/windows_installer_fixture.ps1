param([Parameter(Mandatory=$true)][string]$Installer,
      [Parameter(Mandatory=$true)][string]$Root,
      [Parameter(Mandatory=$true)][string]$Mode)

$ErrorActionPreference = 'Stop'
$StepLog = Join-Path $Root 'steps.log'
$TraceClock = [Diagnostics.Stopwatch]::StartNew()
function Write-FixtureStep([string]$Message) {
    $Line = '{0} +{1}ms {2}' -f [DateTime]::UtcNow.ToString('o'), $TraceClock.ElapsedMilliseconds, $Message
    [IO.File]::AppendAllText($StepLog, $Line + [Environment]::NewLine, [Text.Encoding]::UTF8)
}
Write-FixtureStep 'fixture.begin'
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
$env:SS_INSTALL_TRACE_DIR = $Root

$Program = @'
using System;
using System.Diagnostics;
using System.IO;
using System.Reflection;
using System.Threading;
namespace NAMESPACE {
  public class Program {
    private static readonly string Version = "VERSION";
    private static void Trace(string message) {
      string file = Path.Combine(Environment.GetEnvironmentVariable("SS_INSTALL_TRACE_DIR"),
                                 "process-" + Process.GetCurrentProcess().Id + ".log");
      File.AppendAllText(file, DateTime.UtcNow.ToString("o") + " " + Version + " " + message + Environment.NewLine);
    }
    public static int Main(string[] args) {
      string arg = args.Length == 0 ? "--serve" : args[0];
      Trace("enter " + arg + " image=" + Assembly.GetExecutingAssembly().Location);
      if (arg == "--version") { Console.WriteLine(Version); Trace("exit 0 " + arg); return 0; }
      if (arg == "--login" || arg == "--install-autostart") { Trace("exit 0 " + arg); return 0; }
      if (arg == "--background") {
        if (Version == "new" && Environment.GetEnvironmentVariable("SS_FAIL_NEW_START") == "1") {
          Trace("exit 1 --background"); return 1;
        }
        var start = new ProcessStartInfo(Assembly.GetExecutingAssembly().Location, "--serve");
        start.UseShellExecute = false; start.CreateNoWindow = true;
        // The server must not retain PowerShell's captured native-command pipes.
        start.RedirectStandardInput = true;
        start.RedirectStandardOutput = true;
        start.RedirectStandardError = true;
        Trace("child.start.begin");
        var child = Process.Start(start);
        Trace("child.start.return pid=" + child.Id);
        Trace("exit 0 --background"); return 0;
      }
      using (var ready = EventWaitHandle.OpenExisting(Environment.GetEnvironmentVariable("SS_INSTALL_READY")))
      using (var stop = EventWaitHandle.OpenExisting(Environment.GetEnvironmentVariable("SS_INSTALL_STOP"))) {
        ready.Set(); Trace("server.ready");
        Trace(stop.WaitOne(60000) ? "server.stop-signaled" : "server.lifetime-expired");
      }
      return 0;
    }
  }
}
'@
Write-FixtureStep 'compile.begin'
Add-Type -TypeDefinition ($Program.Replace('NAMESPACE','PreviousBridge').Replace('VERSION','old')) `
    -OutputAssembly $OldImage -OutputType ConsoleApplication
Add-Type -TypeDefinition ($Program.Replace('NAMESPACE','CandidateBridge').Replace('VERSION','new')) `
    -OutputAssembly $Candidate -OutputType ConsoleApplication
Write-FixtureStep 'compile.end'
if ($Mode -ne 'fresh-slow') { Copy-Item $OldImage $ExePath }
Copy-Item $OldImage $OtherExe
$OldHash = (Get-FileHash $OldImage -Algorithm SHA256).Hash
$NewHash = (Get-FileHash $Candidate -Algorithm SHA256).Hash
$Old = $null
$Other = $null
$Failed = $false
$InstallerError = $null
$script:Injected = $false
$script:RestoreFailures = 0
$script:ReadinessTargetPids = @()

try {
    if ($Mode -ne 'fresh-slow') {
        Write-FixtureStep 'previous.start.begin'
        $Old = Start-Process -FilePath $ExePath -ArgumentList '--serve' -PassThru -WindowStyle Hidden
        if (-not $ReadyEvent.WaitOne(10000)) { throw 'Previous process did not acknowledge startup' }
        $ReadyEvent.Reset() | Out-Null
        Write-FixtureStep "previous.ready pid=$($Old.Id)"
    }
    Write-FixtureStep 'other.start.begin'
    $Other = Start-Process -FilePath $OtherExe -ArgumentList '--serve' -PassThru -WindowStyle Hidden
    if (-not $ReadyEvent.WaitOne(10000)) { throw 'Other process did not acknowledge startup' }
    $ReadyEvent.Reset() | Out-Null
    Write-FixtureStep "other.ready pid=$($Other.Id)"

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
        Write-FixtureStep "release.lookup $Uri"
        return [pscustomobject]@{tag_name='fixture';assets=@(
            [pscustomobject]@{name='silentsuite-bridge-windows-x86_64.exe';browser_download_url='https://fixture.invalid/new.exe'},
            [pscustomobject]@{name='silentsuite-bridge-windows-x86_64.exe.sha256';browser_download_url='https://fixture.invalid/new.exe.sha256'}
        )}
    }
    function Invoke-WebRequest {
        param($Uri,$OutFile,[switch]$UseBasicParsing,$TimeoutSec)
        if ($OutFile) {
            Write-FixtureStep "download.copy.begin $OutFile"
            Copy-Item $Candidate $OutFile
            Write-FixtureStep 'download.copy.end'
            return
        }
        if ($Uri.EndsWith('.sha256')) {
            Write-FixtureStep 'checksum.reply'
            return [pscustomobject]@{Content=($NewHash + '  silentsuite-bridge-windows-x86_64.exe')}
        }
        return [pscustomobject]@{StatusCode=200}
    }
    function Test-BridgeDashboardReady {
        param([int]$TimeoutSeconds=20)
        Write-FixtureStep "readiness.begin timeout=$TimeoutSeconds url=$BridgeDashboardUrl"
        $Ready = $ReadyEvent.WaitOne(5000)
        $script:ReadinessTargetPids = @(Get-InstalledBridgeProcesses $ExePath | ForEach-Object { $_.Id })
        Write-FixtureStep "readiness.target-pids $($script:ReadinessTargetPids -join ',')"
        if ($Mode -in @('fresh-slow','upgrade-slow')) {
            if (-not $Ready) { throw 'Slow-start process did not acknowledge startup' }
            $ReadyEvent.Reset() | Out-Null
            Write-FixtureStep 'readiness.injected-false'
            return $false
        }
        Write-FixtureStep "readiness.end result=$Ready"
        return $Ready
    }
    function Move-Item {
        [CmdletBinding()]
        param($Path,$LiteralPath,$Destination,[switch]$Force)
        $Source = if ($LiteralPath) { $LiteralPath } else { $Path }
        Write-FixtureStep "move.begin $Source -> $Destination"
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
        Write-FixtureStep 'move.end'
    }
    function Stop-Process {
        [CmdletBinding()]
        param([Parameter(ValueFromPipeline=$true)]$InputObject,$Id,[switch]$Force)
        process {
            Write-FixtureStep "stop.begin pid=$($InputObject.Id) image=$($InputObject.Path)"
            if ($Mode -eq 'stop-failed') { throw 'Injected stop failure' }
            Microsoft.PowerShell.Management\Stop-Process @PSBoundParameters
            Write-FixtureStep 'stop.end'
        }
    }
    function Remove-Item {
        [CmdletBinding()]
        param($Path,$LiteralPath,[switch]$Force)
        $Source = if ($LiteralPath) { $LiteralPath } else { $Path }
        Write-FixtureStep "remove.begin $Source"
        if ($Mode -eq 'cleanup-failed' -and $Source -like '*.previous.exe') {
            $script:Injected = $true
            throw 'Injected backup cleanup failure'
        }
        Microsoft.PowerShell.Management\Remove-Item @PSBoundParameters
        Write-FixtureStep 'remove.end'
    }

    Write-FixtureStep 'installer.invoke.begin'
    try {
        Invoke-SilentSuiteBridgeInstall
        Write-FixtureStep 'installer.invoke.return'
    } catch {
        $Failed = $true
        $InstallerError = [pscustomobject]@{
            Message=$_.Exception.Message; Type=$_.Exception.GetType().FullName
            Position=$_.InvocationInfo.PositionMessage; Stack=$_.ScriptStackTrace
            Record=($_ | Out-String)
        }
        Write-FixtureStep "installer.invoke.throw $($InstallerError.Message)"
    }
    if ($Mode -in @('swap-failed','backup-failed','start-failed','upgrade-slow')) {
        if (-not $ReadyEvent.WaitOne(10000)) { throw 'Restored process did not acknowledge startup' }
    }
    Write-FixtureStep 'receipt.begin'
    if ($Old) { $Old.Refresh() }
    $Other.Refresh()
    $InstalledHash = if (Test-Path $ExePath) { (Get-FileHash $ExePath -Algorithm SHA256).Hash } else { '' }
    $AtTarget = @(Get-Process | Where-Object {
        try { $_.Path -eq $ExePath } catch { $false }
    })
    $OldBackups = @(Get-ChildItem -Path $InstallDir -File | Where-Object {
        $_.FullName -ne $ExePath -and (Get-FileHash $_.FullName -Algorithm SHA256).Hash -eq $OldHash
    })
    [pscustomobject]@{
        Failed=$Failed; HadOld=($null -ne $Old)
        OldExited=($null -ne $Old -and $Old.HasExited); OtherAlive=(-not $Other.HasExited)
        InstalledNew=($InstalledHash -eq $NewHash); InstalledOld=($InstalledHash -eq $OldHash)
        InstalledHash=$InstalledHash; ExpectedHash=$NewHash; PreviousHash=$OldHash
        TargetRunning=($AtTarget.Count -gt 0); Injected=$script:Injected
        OldBackupRetained=($OldBackups.Count -gt 0); RestoreFailures=$script:RestoreFailures
        InstallerError=$InstallerError
        OtherExitCode=$(if ($Other.HasExited) { $Other.ExitCode } else { $null })
        TargetPids=@($AtTarget | ForEach-Object { $_.Id })
        ReadinessTargetPids=$script:ReadinessTargetPids
        ElapsedMilliseconds=$TraceClock.ElapsedMilliseconds
    } | ConvertTo-Json -Depth 5 | Set-Content (Join-Path $Root 'result.json') -Encoding UTF8
    Write-FixtureStep 'receipt.end'
} finally {
    Write-FixtureStep 'cleanup.begin'
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
    Write-FixtureStep 'cleanup.end'
}
