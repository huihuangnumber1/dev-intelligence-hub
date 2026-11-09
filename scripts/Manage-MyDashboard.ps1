[CmdletBinding()]
param(
    [ValidateSet(
        "Start",
        "Stop",
        "Restart",
        "Status",
        "Restore",
        "PrepareFailedShutdownRecovery",
        "RecoverFailedShutdown"
    )]
    [string]$Action = "Status",
    [string]$BackupId,
    [string]$RecoverySnapshotId,
    [switch]$OpenBrowser,
    [ValidateRange(5, 3600)]
    [int]$TimeoutSeconds = 120
)

$ErrorActionPreference = "Stop"
$livenessRequestTimeoutSeconds = [int][Math]::Min($TimeoutSeconds, 15)
$convertFromJsonPreservesDates = (Get-Command ConvertFrom-Json).Parameters.ContainsKey(
    "DateKind"
)

function ConvertFrom-ExactJson {
    param([Parameter(Mandatory = $true)][string]$Json)
    if ($convertFromJsonPreservesDates) {
        return $Json | ConvertFrom-Json -DateKind String
    }
    return $Json | ConvertFrom-Json
}

$isWindowsRuntime = $env:OS -eq "Windows_NT"
$pathComparer = if ($isWindowsRuntime) {
    [StringComparer]::OrdinalIgnoreCase
} else {
    [StringComparer]::Ordinal
}
$lexicalProjectDirectory = [System.IO.Path]::GetFullPath(
    (Split-Path -Parent $PSScriptRoot)
)
$lexicalLauncherScript = [System.IO.Path]::GetFullPath(
    (Join-Path $lexicalProjectDirectory "scripts/launch-mydashboard-process.mjs")
)
$nodeCommand = Get-Command node -CommandType Application -ErrorAction Stop
$nodePath = [System.IO.Path]::GetFullPath($nodeCommand.Source)
$runtimeInfoText = & $nodePath $lexicalLauncherScript --runtime-info | Out-String
if ($LASTEXITCODE -ne 0) {
    throw "Unable to resolve the MyDashboard private runtime identity."
}
$runtimeInfo = ConvertFrom-ExactJson -Json $runtimeInfoText
$runtimeProperties = @($runtimeInfo.PSObject.Properties.Name | Sort-Object)
if (
    (Compare-Object `
        -ReferenceObject @(
            "projectDigest",
            "projectDirectory",
            "runtimeDirectory",
            "schemaVersion"
        ) `
        -DifferenceObject $runtimeProperties) -or
    $runtimeInfo.schemaVersion -ne 1 -or
    [string]$runtimeInfo.projectDigest -notmatch '^[a-f0-9]{64}$' -or
    -not [System.IO.Path]::IsPathRooted([string]$runtimeInfo.projectDirectory) -or
    -not [System.IO.Path]::IsPathRooted([string]$runtimeInfo.runtimeDirectory)
) {
    throw "The runtime identity helper returned invalid data."
}

$projectDirectory = [System.IO.Path]::GetFullPath(
    [string]$runtimeInfo.projectDirectory
)
$projectDigest = [string]$runtimeInfo.projectDigest
$runtimeDirectory = [System.IO.Path]::GetFullPath(
    [string]$runtimeInfo.runtimeDirectory
)
$serverScript = [System.IO.Path]::GetFullPath(
    (Join-Path $projectDirectory "src/server.js")
)
$launcherScript = [System.IO.Path]::GetFullPath(
    (Join-Path $projectDirectory "scripts/launch-mydashboard-process.mjs")
)
$managedEntryScript = [System.IO.Path]::GetFullPath(
    (Join-Path $projectDirectory "scripts/run-managed-dashboard.mjs")
)
$offlineRestoreScript = [System.IO.Path]::GetFullPath(
    (Join-Path $projectDirectory "scripts/manage-offline-restore.mjs")
)
$dataDirectory = [System.IO.Path]::GetFullPath(
    (Join-Path $projectDirectory "data")
)
$restoreControlDirectory = [System.IO.Path]::GetFullPath(
    (Join-Path $projectDirectory "restore-control")
)
$controlFile = [System.IO.Path]::GetFullPath(
    (Join-Path $runtimeDirectory "mydashboard-server-process.json")
)
$baseConfigFile = [System.IO.Path]::GetFullPath(
    (Join-Path $projectDirectory "config.json")
)
$exampleConfigFile = [System.IO.Path]::GetFullPath(
    (Join-Path $projectDirectory "config.example.json")
)
$configurationStateFile = [System.IO.Path]::GetFullPath(
    (Join-Path $dataDirectory "configuration-state.json")
)
$runtimeLogDirectory = [System.IO.Path]::GetFullPath(
    (Join-Path $runtimeDirectory "logs")
)
$recoverySnapshotsDirectory = [System.IO.Path]::GetFullPath(
    (Join-Path $runtimeDirectory "recovery-snapshots")
)
$incidentsDirectory = [System.IO.Path]::GetFullPath(
    (Join-Path $runtimeDirectory "incidents")
)
$writerLeaseProbeScript = [System.IO.Path]::GetFullPath(
    (Join-Path $projectDirectory "scripts/probe-application-writer-lease.mjs")
)
$shutdownFailureRecoveryReason = "managed_shutdown_lifecycle_failure"
$unexpectedExitRecoveryReason = "managed_process_exit_without_receipt"
$shutdownFailureEvidenceKind = "shutdown_failure"
$unexpectedExitEvidenceKind = "unexpected_exit"
$interruptedShutdownRecoveryReason = "managed_shutdown_exit_without_terminal"
$interruptedShutdownEvidenceKind = "interrupted_shutdown"
$unexpectedExitAuthorityInvalidatedMessage = (
    "Unexpected-exit recovery authority was permanently invalidated " +
    "by a late shutdown receipt."
)

if (
    -not $pathComparer.Equals(
        [System.IO.Path]::GetFileName($runtimeDirectory),
        $projectDigest
    ) -or
    -not (Test-Path -LiteralPath $launcherScript -PathType Leaf) -or
    -not (Test-Path -LiteralPath $managedEntryScript -PathType Leaf) -or
    -not (Test-Path -LiteralPath $serverScript -PathType Leaf) -or
    -not (Test-Path -LiteralPath $writerLeaseProbeScript -PathType Leaf)
) {
    throw "The resolved project runtime identity is inconsistent."
}
if ($isWindowsRuntime) {
    if ([string]::IsNullOrWhiteSpace($env:LOCALAPPDATA)) {
        throw "LOCALAPPDATA is required for the private runtime directory."
    }
    $expectedRuntimeRoot = [System.IO.Path]::GetFullPath(
        (Join-Path $env:LOCALAPPDATA "MyDashboard\runtime")
    )
    if (-not $pathComparer.Equals(
        [System.IO.Path]::GetDirectoryName($runtimeDirectory),
        $expectedRuntimeRoot
    )) {
        throw "The private runtime directory is outside LOCALAPPDATA."
    }
}

$mutexName = if ($isWindowsRuntime) {
    "Local\MyDashboard.ProcessManager.$($projectDigest.Substring(0, 32))"
} else {
    "MyDashboard.ProcessManager.$($projectDigest.Substring(0, 32))"
}

function Assert-DirectChildPath {
    param(
        [Parameter(Mandatory = $true)][string]$Parent,
        [Parameter(Mandatory = $true)][string]$Child
    )
    $resolvedParent = [System.IO.Path]::GetFullPath($Parent)
    $resolvedChild = [System.IO.Path]::GetFullPath($Child)
    if (-not $pathComparer.Equals(
        [System.IO.Path]::GetDirectoryName($resolvedChild),
        $resolvedParent
    )) {
        throw "Managed path is outside its configured parent."
    }
    return $resolvedChild
}

function Assert-NotReparseDirectory {
    param([Parameter(Mandatory = $true)][string]$Path)
    $item = Get-Item -LiteralPath $Path -Force
    if (
        -not $item.PSIsContainer -or
        (($item.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0)
    ) {
        throw "Private runtime path is not a regular directory: $Path"
    }
}

function Assert-RegularManagedFile {
    param(
        [Parameter(Mandatory = $true)][string]$Path,
        [Parameter(Mandatory = $true)][string]$Description,
        [ValidateRange(1, 536870912)][long]$MaximumBytes = 16384
    )
    if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) {
        throw "$Description is not a regular file."
    }
    $item = Get-Item -LiteralPath $Path -Force
    if (($item.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) {
        throw "$Description cannot be a symbolic link or reparse point."
    }
    if ($item.Length -gt $MaximumBytes) {
        throw "$Description exceeds its size limit."
    }
}

function Get-DirectorySecurityDescriptor {
    param([Parameter(Mandatory = $true)][string]$Path)
    $directory = New-Object System.IO.DirectoryInfo($Path)
    $extensions = [Type]::GetType(
        "System.IO.FileSystemAclExtensions, System.IO.FileSystem.AccessControl",
        $false
    )
    if ($null -ne $extensions) {
        return [System.IO.FileSystemAclExtensions]::GetAccessControl($directory)
    }
    return [System.IO.Directory]::GetAccessControl($Path)
}

function Set-DirectorySecurityDescriptor {
    param(
        [Parameter(Mandatory = $true)][string]$Path,
        [Parameter(Mandatory = $true)]$Security
    )
    $directory = New-Object System.IO.DirectoryInfo($Path)
    $extensions = [Type]::GetType(
        "System.IO.FileSystemAclExtensions, System.IO.FileSystem.AccessControl",
        $false
    )
    if ($null -ne $extensions) {
        [System.IO.FileSystemAclExtensions]::SetAccessControl(
            $directory,
            $Security
        )
        return
    }
    [System.IO.Directory]::SetAccessControl($Path, $Security)
}

function Set-NewWindowsRuntimeAcl {
    param([Parameter(Mandatory = $true)][string]$Path)
    $currentSid = [System.Security.Principal.WindowsIdentity]::GetCurrent().User
    $systemSid = New-Object System.Security.Principal.SecurityIdentifier(
        "S-1-5-18"
    )
    $administratorsSid = New-Object System.Security.Principal.SecurityIdentifier(
        "S-1-5-32-544"
    )
    $security = New-Object System.Security.AccessControl.DirectorySecurity
    $security.SetOwner($currentSid)
    $security.SetAccessRuleProtection($true, $false)
    $inheritance = [System.Security.AccessControl.InheritanceFlags]::ContainerInherit -bor `
        [System.Security.AccessControl.InheritanceFlags]::ObjectInherit
    foreach ($sid in @($currentSid, $systemSid, $administratorsSid)) {
        $rule = New-Object System.Security.AccessControl.FileSystemAccessRule(
            $sid,
            [System.Security.AccessControl.FileSystemRights]::FullControl,
            $inheritance,
            [System.Security.AccessControl.PropagationFlags]::None,
            [System.Security.AccessControl.AccessControlType]::Allow
        )
        [void]$security.AddAccessRule($rule)
    }
    Set-DirectorySecurityDescriptor -Path $Path -Security $security
}

function Assert-WindowsRuntimeAcl {
    param([Parameter(Mandatory = $true)][string]$Path)
    $currentSid = [System.Security.Principal.WindowsIdentity]::GetCurrent().User
    $allowedSids = @{
        $currentSid.Value = $true
        "S-1-5-18" = $true
        "S-1-5-32-544" = $true
    }
    $security = Get-DirectorySecurityDescriptor -Path $Path
    $ownerSid = $security.GetOwner(
        [System.Security.Principal.SecurityIdentifier]
    )
    if ($ownerSid.Value -ne $currentSid.Value) {
        throw "Private runtime directory is not owned by the current user."
    }
    if (-not $security.AreAccessRulesProtected) {
        throw "Private runtime directory inherits access rules; refusing it."
    }
    $rules = $security.GetAccessRules(
        $true,
        $true,
        [System.Security.Principal.SecurityIdentifier]
    )
    $broadWriteMask = [int][System.Security.AccessControl.FileSystemRights]::Write -bor `
        [int][System.Security.AccessControl.FileSystemRights]::Delete -bor `
        [int][System.Security.AccessControl.FileSystemRights]::DeleteSubdirectoriesAndFiles -bor `
        [int][System.Security.AccessControl.FileSystemRights]::ChangePermissions -bor `
        [int][System.Security.AccessControl.FileSystemRights]::TakeOwnership
    foreach ($rule in $rules) {
        if (
            $rule.AccessControlType -eq `
                [System.Security.AccessControl.AccessControlType]::Allow -and
            (([int]$rule.FileSystemRights -band $broadWriteMask) -ne 0) -and
            -not $allowedSids.ContainsKey($rule.IdentityReference.Value)
        ) {
            throw "Private runtime directory grants broad write access to another identity."
        }
    }
}

function Initialize-PrivateRuntimeDirectory {
    $runtimeRoot = [System.IO.Path]::GetDirectoryName($runtimeDirectory)
    $applicationRoot = [System.IO.Path]::GetDirectoryName($runtimeRoot)
    New-Item -ItemType Directory -Path $applicationRoot -Force | Out-Null
    New-Item -ItemType Directory -Path $runtimeRoot -Force | Out-Null
    Assert-NotReparseDirectory -Path $applicationRoot
    Assert-NotReparseDirectory -Path $runtimeRoot
    $alreadyExists = Test-Path -LiteralPath $runtimeDirectory
    if ($alreadyExists -and -not (Test-Path -LiteralPath $runtimeDirectory -PathType Container)) {
        throw "Private runtime path already exists and is not a directory."
    }
    if (-not $alreadyExists) {
        New-Item -ItemType Directory -Path $runtimeDirectory | Out-Null
        if ($isWindowsRuntime) {
            Set-NewWindowsRuntimeAcl -Path $runtimeDirectory
        } else {
            & chmod 700 -- $runtimeDirectory
            if ($LASTEXITCODE -ne 0) {
                throw "Unable to set private runtime directory permissions."
            }
        }
    }
    Assert-NotReparseDirectory -Path $runtimeDirectory
    if ($isWindowsRuntime) {
        Assert-WindowsRuntimeAcl -Path $runtimeDirectory
    } else {
        & $nodePath $launcherScript --verify-runtime
        if ($LASTEXITCODE -ne 0) {
            throw "Private runtime directory verification failed."
        }
    }
}

function Get-ConfiguredPort {
    $configSource = if (Test-Path -LiteralPath $baseConfigFile -PathType Leaf) {
        $baseConfigFile
    } elseif (Test-Path -LiteralPath $exampleConfigFile -PathType Leaf) {
        $exampleConfigFile
    } else {
        throw "Neither private nor example configuration is available."
    }
    $base = ConvertFrom-ExactJson -Json (
        Get-Content -LiteralPath $configSource -Raw
    )
    $port = $base.port
    if (Test-Path -LiteralPath $configurationStateFile -PathType Leaf) {
        $state = ConvertFrom-ExactJson -Json (
            Get-Content -LiteralPath $configurationStateFile -Raw
        )
        if ($null -ne $state.activeVersion) {
            $activeVersions = @($state.versions | Where-Object {
                $_.version -eq $state.activeVersion
            })
            if ($activeVersions.Count -ne 1) {
                throw "Active configuration state is inconsistent."
            }
            $port = $activeVersions[0].configuration.port
        }
    }
    if ($port -isnot [int] -and $port -isnot [long]) {
        throw "Configured port is not an integer."
    }
    $port = [int]$port
    if ($port -lt 1 -or $port -gt 65535) {
        throw "Configured port is outside the supported range."
    }
    return $port
}

function New-ControlToken {
    $bytes = New-Object byte[] 32
    $generator = [System.Security.Cryptography.RandomNumberGenerator]::Create()
    try {
        $generator.GetBytes($bytes)
    } finally {
        $generator.Dispose()
    }
    return [Convert]::ToBase64String($bytes)
}

function Get-HmacBase64 {
    param(
        [Parameter(Mandatory = $true)][string]$Token,
        [Parameter(Mandatory = $true)][string]$Payload
    )
    try {
        $key = [Convert]::FromBase64String($Token)
    } catch {
        throw "Managed control token is not valid base64."
    }
    if (
        $key.Length -ne 32 -or
        [Convert]::ToBase64String($key) -ne $Token
    ) {
        throw "Managed control token is not 256 bits."
    }
    $hmac = New-Object System.Security.Cryptography.HMACSHA256(,$key)
    try {
        $digest = $hmac.ComputeHash(
            [System.Text.Encoding]::UTF8.GetBytes($Payload)
        )
        return [Convert]::ToBase64String($digest)
    } finally {
        $hmac.Dispose()
    }
}

function Test-FixedTimeString {
    param(
        [AllowEmptyString()][Parameter(Mandatory = $true)][string]$Left,
        [AllowEmptyString()][Parameter(Mandatory = $true)][string]$Right
    )
    $leftBytes = [System.Text.Encoding]::UTF8.GetBytes($Left)
    $rightBytes = [System.Text.Encoding]::UTF8.GetBytes($Right)
    $difference = $leftBytes.Length -bxor $rightBytes.Length
    $maximum = [Math]::Max($leftBytes.Length, $rightBytes.Length)
    for ($index = 0; $index -lt $maximum; $index += 1) {
        $leftByte = if ($index -lt $leftBytes.Length) { $leftBytes[$index] } else { 0 }
        $rightByte = if ($index -lt $rightBytes.Length) { $rightBytes[$index] } else { 0 }
        $difference = $difference -bor ($leftByte -bxor $rightByte)
    }
    return $difference -eq 0
}

function Get-LaunchPayload {
    param([Parameter(Mandatory = $true)]$Launch)
    return @(
        "launch-v1",
        [string]$Launch.processId,
        [string]$Launch.instanceId,
        [string]$Launch.startIdentity,
        [string]$Launch.projectDigest
    ) -join "`n"
}

function Get-ControlPayload {
    param([Parameter(Mandatory = $true)]$State)
    return @(
        "control-v1",
        [string]$State.processId,
        [string]$State.instanceId,
        [string]$State.startIdentity,
        [string]$State.processStartTimeUtcTicks,
        [string]$State.port,
        [string]$State.projectDigest
    ) -join "`n"
}

function Get-ReceiptPayload {
    param([Parameter(Mandatory = $true)]$Receipt)
    $errorCode = if ($null -eq $Receipt.errorCode) {
        ""
    } else {
        [string]$Receipt.errorCode
    }
    return @(
        "receipt-v1",
        [string]$Receipt.phase,
        [string]$Receipt.status,
        [string]$Receipt.processId,
        [string]$Receipt.instanceId,
        [string]$Receipt.startIdentity,
        [string]$Receipt.atUnixMilliseconds,
        $errorCode
    ) -join "`n"
}

function Assert-ControlState {
    param([Parameter(Mandatory = $true)]$Value)
    $properties = @($Value.PSObject.Properties.Name | Sort-Object)
    $expected = @(
        "controlHmac",
        "controlToken",
        "instanceId",
        "nodePath",
        "port",
        "processId",
        "processStartTimeUtcTicks",
        "projectDigest",
        "projectDirectory",
        "schemaVersion",
        "serverScript",
        "startIdentity"
    )
    if (Compare-Object -ReferenceObject $expected -DifferenceObject $properties) {
        throw "Process control state has an invalid shape."
    }
    if (
        $Value.schemaVersion -ne 2 -or
        ($Value.processId -isnot [int] -and $Value.processId -isnot [long]) -or
        [int]$Value.processId -lt 1 -or
        ($Value.port -isnot [int] -and $Value.port -isnot [long]) -or
        [int]$Value.port -lt 1 -or
        [int]$Value.port -gt 65535 -or
        [string]$Value.instanceId -notmatch `
            '^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$' -or
        [string]$Value.startIdentity -notmatch '^[a-f0-9]{64}$' -or
        [string]$Value.controlHmac -notmatch '^[A-Za-z0-9+/]{43}=$' -or
        [string]$Value.projectDigest -ne $projectDigest -or
        -not $pathComparer.Equals(
            [System.IO.Path]::GetFullPath([string]$Value.projectDirectory),
            $projectDirectory
        ) -or
        -not $pathComparer.Equals(
            [System.IO.Path]::GetFullPath([string]$Value.serverScript),
            $serverScript
        ) -or
        -not $pathComparer.Equals(
            [System.IO.Path]::GetFullPath([string]$Value.nodePath),
            $nodePath
        )
    ) {
        throw "Process control state is invalid."
    }
    if ([string]$Value.processStartTimeUtcTicks -notmatch '^[1-9][0-9]{16,18}$') {
        throw "Process control start time is invalid."
    }
    $expectedHmac = Get-HmacBase64 `
        -Token ([string]$Value.controlToken) `
        -Payload (Get-ControlPayload -State $Value)
    if (-not (Test-FixedTimeString `
        -Left $expectedHmac `
        -Right ([string]$Value.controlHmac))) {
        throw "Process control authentication failed."
    }
}

function Read-ControlStateFromPath {
    param([Parameter(Mandatory = $true)][string]$Path)
    Assert-RegularManagedFile `
        -Path $Path `
        -Description "Process control state"
    $value = ConvertFrom-ExactJson -Json (
        Get-Content -LiteralPath $Path -Raw
    )
    Assert-ControlState -Value $value
    return $value
}

function Read-ControlState {
    if (-not (Test-Path -LiteralPath $controlFile)) {
        return $null
    }
    return Read-ControlStateFromPath -Path $controlFile
}

function Test-SameControlIdentity {
    param(
        [Parameter(Mandatory = $true)]$Left,
        [Parameter(Mandatory = $true)]$Right
    )
    return (
        [int]$Left.processId -eq [int]$Right.processId -and
        [string]$Left.instanceId -eq [string]$Right.instanceId -and
        [string]$Left.startIdentity -eq [string]$Right.startIdentity -and
        [string]$Left.processStartTimeUtcTicks -eq `
            [string]$Right.processStartTimeUtcTicks -and
        (Test-FixedTimeString `
            -Left ([string]$Left.controlHmac) `
            -Right ([string]$Right.controlHmac))
    )
}

function Write-ControlState {
    param([Parameter(Mandatory = $true)]$State)
    Assert-ControlState -Value ([pscustomobject]$State)
    $safeControlFile = Assert-DirectChildPath `
        -Parent $runtimeDirectory `
        -Child $controlFile
    if (Test-Path -LiteralPath $safeControlFile) {
        throw "Process control state already exists; refusing to replace it."
    }
    $temporary = Assert-DirectChildPath `
        -Parent $runtimeDirectory `
        -Child (Join-Path $runtimeDirectory "control-$PID-$([guid]::NewGuid().ToString('N')).tmp")
    $json = ([pscustomobject]$State) | ConvertTo-Json -Depth 3 -Compress
    $bytes = (New-Object System.Text.UTF8Encoding($false)).GetBytes($json)
    $stream = $null
    try {
        $stream = New-Object System.IO.FileStream(
            $temporary,
            [System.IO.FileMode]::CreateNew,
            [System.IO.FileAccess]::Write,
            [System.IO.FileShare]::None,
            4096,
            [System.IO.FileOptions]::WriteThrough
        )
        $stream.Write($bytes, 0, $bytes.Length)
        $stream.Flush($true)
        $stream.Dispose()
        $stream = $null
        [System.IO.File]::Move($temporary, $safeControlFile)
        $readback = Get-Content -LiteralPath $safeControlFile -Raw
        if ($readback -ne $json) {
            throw "Process control durable readback did not match."
        }
        $verified = Read-ControlState
        if (-not (Test-SameControlIdentity -Left $verified -Right ([pscustomobject]$State))) {
            throw "Process control identity changed during durable publication."
        }
    } finally {
        if ($null -ne $stream) {
            $stream.Dispose()
        }
        Remove-Item -LiteralPath $temporary -Force -ErrorAction SilentlyContinue
    }
}

function Remove-ControlState {
    param([Parameter(Mandatory = $true)]$ExpectedState)
    if (-not (Test-Path -LiteralPath $controlFile)) {
        return
    }
    $tombstone = Assert-DirectChildPath `
        -Parent $runtimeDirectory `
        -Child (Join-Path $runtimeDirectory "control-remove-$PID-$([guid]::NewGuid().ToString('N')).tmp")
    [System.IO.File]::Move($controlFile, $tombstone)
    try {
        $removed = Read-ControlStateFromPath -Path $tombstone
        if (-not (Test-SameControlIdentity -Left $removed -Right $ExpectedState)) {
            if (-not (Test-Path -LiteralPath $controlFile)) {
                [System.IO.File]::Move($tombstone, $controlFile)
            }
            throw "Process control identity changed; refusing to remove it."
        }
        Remove-Item -LiteralPath $tombstone -Force
    } catch {
        if (
            (Test-Path -LiteralPath $tombstone -PathType Leaf) -and
            -not (Test-Path -LiteralPath $controlFile)
        ) {
            [System.IO.File]::Move($tombstone, $controlFile)
        }
        throw
    }
}

function Get-ManagedProcess {
    param([Parameter(Mandatory = $true)]$State)
    $process = Get-Process -Id ([int]$State.processId) -ErrorAction SilentlyContinue
    if ($null -eq $process) {
        return $null
    }
    if ([int]$process.Id -eq [int]$PID) {
        return $null
    }
    if (
        [string]::IsNullOrWhiteSpace($process.Path) -or
        -not $pathComparer.Equals(
            [System.IO.Path]::GetFullPath($process.Path),
            [System.IO.Path]::GetFullPath([string]$State.nodePath)
        ) -or
        [string]($process.StartTime.ToUniversalTime().Ticks) -ne `
            [string]$State.processStartTimeUtcTicks
    ) {
        throw "Recorded PID belongs to a different process; refusing to control it."
    }
    return $process
}

function Test-LoopbackTcpListener {
    param([Parameter(Mandatory = $true)][int]$Port)
    $probeSource = @'
const net = require("node:net");
const port = Number(process.argv[2]);
function proveAddressUnused(host) {
  return new Promise((resolve) => {
    let settled = false;
    let verifier;
    const client = net.createConnection({ host, port });
    const timer = setTimeout(() => finish(false), 500);
    function finish(unused) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      client.destroy();
      if (verifier) verifier.close(() => resolve(unused));
      else resolve(unused);
    }
    client.once("connect", () => finish(false));
    client.once("error", (error) => {
      if (error?.code !== "ECONNREFUSED") return finish(false);
      verifier = net.createServer();
      verifier.once("error", () => finish(false));
      verifier.listen({
        host,
        port,
        exclusive: true,
        ...(host === "::1" ? { ipv6Only: true } : {}),
      }, () => finish(true));
    });
  });
}
(async () => {
  const ipv4Unused = await proveAddressUnused("127.0.0.1");
  const ipv6Unused = ipv4Unused && await proveAddressUnused("::1");
  process.exit(ipv4Unused && ipv6Unused ? 61 : 2);
})().catch(() => process.exit(2));
'@
    $probe = $null
    try {
        $startInfo = New-Object System.Diagnostics.ProcessStartInfo
        $startInfo.FileName = $nodePath
        $startInfo.UseShellExecute = $false
        $startInfo.CreateNoWindow = $true
        $startInfo.RedirectStandardOutput = $true
        $startInfo.RedirectStandardError = $true
        $startInfo.EnvironmentVariables.Remove("NODE_OPTIONS")
        $encodedProbe = [Convert]::ToBase64String(
            [System.Text.Encoding]::UTF8.GetBytes($probeSource)
        )
        $startInfo.Arguments = '-e "eval(Buffer.from(process.argv[1],''base64'').toString(''utf8''))" "' + `
            $encodedProbe + '" "' + [string]$Port + '"'
        $probe = [System.Diagnostics.Process]::Start($startInfo)
        if ($null -eq $probe -or -not $probe.WaitForExit(2000)) {
            if ($null -ne $probe -and -not $probe.HasExited) {
                $probe.Kill()
                [void]$probe.WaitForExit(500)
            }
            return $true
        }
        return $probe.ExitCode -ne 61
    } catch {
        return $true
    } finally {
        if ($null -ne $probe) {
            $probe.Dispose()
        }
    }
}

function Wait-ForBoundedAsyncOperation {
    param(
        [Parameter(Mandatory = $true)][System.IAsyncResult]$Operation,
        [Parameter(Mandatory = $true)][DateTime]$Deadline
    )
    $remaining = [int][Math]::Ceiling(
        ($Deadline - [DateTime]::UtcNow).TotalMilliseconds
    )
    if ($remaining -le 0 -or -not $Operation.AsyncWaitHandle.WaitOne($remaining)) {
        throw "The loopback HTTP request exceeded its fixed deadline."
    }
}

function Invoke-BoundedLoopbackJsonGet {
    param(
        [Parameter(Mandatory = $true)][int]$Port,
        [Parameter(Mandatory = $true)][string]$Path,
        [ValidateRange(100, 10000)][int]$TimeoutMilliseconds,
        [ValidateRange(1, 1048576)][int]$MaximumBytes
    )
    if ($Path -notmatch '^/[a-z0-9/-]+$') {
        throw "The loopback HTTP path is invalid."
    }
    $deadline = [DateTime]::UtcNow.AddMilliseconds($TimeoutMilliseconds)
    $uri = New-Object System.Uri("http://127.0.0.1:$Port$Path")
    $request = [System.Net.HttpWebRequest]::CreateHttp($uri)
    $request.Method = "GET"
    $request.Accept = "application/json"
    $request.AllowAutoRedirect = $false
    $request.AutomaticDecompression = [System.Net.DecompressionMethods]::None
    $request.Credentials = $null
    $request.KeepAlive = $false
    $request.MaximumResponseHeadersLength = 16
    $request.PreAuthenticate = $false
    $request.Proxy = $null
    $request.ReadWriteTimeout = $TimeoutMilliseconds
    $request.Timeout = $TimeoutMilliseconds
    $response = $null
    $stream = $null
    try {
        $responseOperation = $request.BeginGetResponse($null, $null)
        try {
            Wait-ForBoundedAsyncOperation `
                -Operation $responseOperation `
                -Deadline $deadline
            $response = $request.EndGetResponse($responseOperation)
        } finally {
            $responseOperation.AsyncWaitHandle.Dispose()
        }
        if (
            [int]$response.StatusCode -ne 200 -or
            [string]$response.ContentType -notmatch `
                '^\s*application/json(?:\s*;|\s*$)' -or
            $response.ContentLength -gt $MaximumBytes
        ) {
            throw "The loopback HTTP response is not an accepted bounded JSON response."
        }
        $stream = $response.GetResponseStream()
        $bytes = New-Object byte[] ($MaximumBytes + 1)
        $total = 0
        while ($true) {
            $readOperation = $stream.BeginRead(
                $bytes,
                $total,
                $bytes.Length - $total,
                $null,
                $null
            )
            try {
                Wait-ForBoundedAsyncOperation `
                    -Operation $readOperation `
                    -Deadline $deadline
                $read = $stream.EndRead($readOperation)
            } finally {
                $readOperation.AsyncWaitHandle.Dispose()
            }
            if ($read -eq 0) {
                break
            }
            $total += $read
            if ($total -gt $MaximumBytes) {
                throw "The loopback HTTP response exceeded its size limit."
            }
        }
        $utf8 = New-Object System.Text.UTF8Encoding($false, $true)
        return ConvertFrom-ExactJson -Json $utf8.GetString($bytes, 0, $total)
    } catch {
        $request.Abort()
        throw
    } finally {
        if ($null -ne $stream) {
            $stream.Dispose()
        }
        if ($null -ne $response) {
            $response.Dispose()
        }
    }
}

function Get-Liveness {
    param([Parameter(Mandatory = $true)][int]$Port)
    try {
        # Liveness shares the application event loop, so allow bounded workload stalls.
        return Invoke-RestMethod `
            -Uri "http://127.0.0.1:$Port/api/live" `
            -TimeoutSec $livenessRequestTimeoutSeconds
    } catch {
        return $null
    }
}

function Test-MatchingLiveness {
    param(
        [AllowNull()][Parameter(Mandatory = $true)]$Liveness,
        [Parameter(Mandatory = $true)]$State,
        [AllowNull()][string]$LifecycleState = $null
    )
    if (
        $null -eq $Liveness -or
        $Liveness.live -ne $true -or
        $Liveness.service -ne "mydashboard" -or
        $Liveness.managed -ne $true -or
        [int]$Liveness.processId -ne [int]$State.processId -or
        [string]$Liveness.instanceId -ne [string]$State.instanceId -or
        [string]$Liveness.startIdentity -ne [string]$State.startIdentity
    ) {
        return $false
    }
    return (
        [string]::IsNullOrEmpty($LifecycleState) -or
        [string]$Liveness.lifecycleState -eq $LifecycleState
    )
}

function Test-ReadySystemStatus {
    param([AllowNull()][Parameter(Mandatory = $true)]$Value)
    if ($null -eq $Value -or $Value -isnot [pscustomobject]) {
        return $false
    }
    $schemaVersion = $Value.PSObject.Properties["schemaVersion"]
    $readiness = $Value.PSObject.Properties["readiness"]
    if (
        $null -eq $schemaVersion -or
        (
            $schemaVersion.Value -isnot [int] -and
            $schemaVersion.Value -isnot [long]
        ) -or
        [long]$schemaVersion.Value -ne 1 -or
        $null -eq $readiness -or
        $readiness.Value -isnot [pscustomobject]
    ) {
        return $false
    }
    $ready = $readiness.Value.PSObject.Properties["ready"]
    return (
        $null -ne $ready -and
        $ready.Value -is [bool] -and
        $ready.Value -eq $true
    )
}

function Test-ManagedReadiness {
    param([Parameter(Mandatory = $true)]$State)
    try {
        $status = Invoke-BoundedLoopbackJsonGet `
            -Port ([int]$State.port) `
            -Path "/api/system/status" `
            -TimeoutMilliseconds 3000 `
            -MaximumBytes 65536
        if (-not (Test-ReadySystemStatus -Value $status)) {
            return $false
        }
        if ($null -eq (Get-ManagedProcess -State $State)) {
            return $false
        }
        $liveness = Get-Liveness -Port ([int]$State.port)
        return Test-MatchingLiveness -Liveness $liveness -State $State
    } catch {
        return $false
    }
}

function Wait-ForMatchingLiveness {
    param(
        [Parameter(Mandatory = $true)]$State,
        [Parameter(Mandatory = $true)][string]$LifecycleState
    )
    $deadline = [DateTime]::UtcNow.AddSeconds($TimeoutSeconds)
    while ([DateTime]::UtcNow -lt $deadline) {
        if ($null -eq (Get-ManagedProcess -State $State)) {
            throw "MyDashboard exited before becoming live."
        }
        $liveness = Get-Liveness -Port ([int]$State.port)
        if (Test-MatchingLiveness `
            -Liveness $liveness `
            -State $State `
            -LifecycleState $LifecycleState) {
            return $liveness
        }
        Start-Sleep -Milliseconds 200
    }
    throw "MyDashboard did not reach $LifecycleState before the timeout."
}

function Get-ControlHeaders {
    param([Parameter(Mandatory = $true)]$State)
    return @{
        Origin = "http://127.0.0.1:$($State.port)"
        "X-MyDashboard-Action" = "1"
        "X-MyDashboard-Control-Token" = [string]$State.controlToken
        "X-MyDashboard-Process-Id" = [string]$State.processId
        "X-MyDashboard-Instance-Id" = [string]$State.instanceId
        "X-MyDashboard-Start-Identity" = [string]$State.startIdentity
    }
}

function Invoke-ManagedClaim {
    param([Parameter(Mandatory = $true)]$State)
    $lastError = $null
    for ($attempt = 0; $attempt -lt 2; $attempt += 1) {
        try {
            $response = Invoke-RestMethod `
                -Method Post `
                -Uri "http://127.0.0.1:$($State.port)/api/system/claim" `
                -Headers (Get-ControlHeaders -State $State) `
                -TimeoutSec 10
            if ($response.claimed -eq $true) {
                return
            }
            $lastError = New-Object System.InvalidOperationException(
                "MyDashboard did not acknowledge the managed claim."
            )
        } catch {
            $lastError = $_.Exception
            $liveness = Get-Liveness -Port ([int]$State.port)
            if (Test-MatchingLiveness `
                -Liveness $liveness `
                -State $State `
                -LifecycleState "running") {
                return
            }
        }
        Start-Sleep -Milliseconds 150
    }
    throw $lastError
}

function Get-ReceiptPath {
    param(
        [Parameter(Mandatory = $true)]$State,
        [ValidateSet("requested", "terminal")][string]$Phase
    )
    return Assert-DirectChildPath `
        -Parent $runtimeDirectory `
        -Child (Join-Path $runtimeDirectory "mydashboard-shutdown-$($State.instanceId)-$Phase.json")
}

function Read-ShutdownReceiptFromPath {
    param(
        [Parameter(Mandatory = $true)]$State,
        [ValidateSet("requested", "terminal")][string]$Phase,
        [Parameter(Mandatory = $true)][string]$Path
    )
    Assert-RegularManagedFile -Path $Path -Description "Shutdown receipt"
    $receipt = ConvertFrom-ExactJson -Json (
        Get-Content -LiteralPath $Path -Raw
    )
    $properties = @($receipt.PSObject.Properties.Name | Sort-Object)
    if (
        (Compare-Object `
            -ReferenceObject @(
                "atUnixMilliseconds",
                "errorCode",
                "hmac",
                "instanceId",
                "phase",
                "processId",
                "schemaVersion",
                "startIdentity",
                "status"
            ) `
            -DifferenceObject $properties) -or
        $receipt.schemaVersion -ne 1 -or
        [string]$receipt.phase -ne $Phase -or
        [int]$receipt.processId -ne [int]$State.processId -or
        [string]$receipt.instanceId -ne [string]$State.instanceId -or
        [string]$receipt.startIdentity -ne [string]$State.startIdentity -or
        [string]$receipt.hmac -notmatch '^[A-Za-z0-9+/]{43}=$' -or
        (
            $Phase -eq "requested" -and
            [string]$receipt.status -ne "unknown"
        ) -or
        (
            $Phase -eq "terminal" -and
            [string]$receipt.status -notin @("success", "failure")
        )
    ) {
        throw "Shutdown receipt identity or shape is invalid."
    }
    if ([string]$receipt.atUnixMilliseconds -notmatch '^[1-9][0-9]{10,15}$') {
        throw "Shutdown receipt timestamp is invalid."
    }
    $expectedHmac = Get-HmacBase64 `
        -Token ([string]$State.controlToken) `
        -Payload (Get-ReceiptPayload -Receipt $receipt)
    if (-not (Test-FixedTimeString `
        -Left $expectedHmac `
        -Right ([string]$receipt.hmac))) {
        throw "Shutdown receipt authentication failed."
    }
    return $receipt
}

function Read-ShutdownReceipt {
    param(
        [Parameter(Mandatory = $true)]$State,
        [ValidateSet("requested", "terminal")][string]$Phase
    )
    $path = Get-ReceiptPath -State $State -Phase $Phase
    if (-not (Test-Path -LiteralPath $path)) {
        return $null
    }
    return Read-ShutdownReceiptFromPath `
        -State $State `
        -Phase $Phase `
        -Path $path
}

function Invoke-ManagedShutdownRequest {
    param([Parameter(Mandatory = $true)]$State)
    $response = Invoke-RestMethod `
        -Method Post `
        -Uri "http://127.0.0.1:$($State.port)/api/system/shutdown" `
        -Headers (Get-ControlHeaders -State $State) `
        -TimeoutSec 10
    if ($response.accepted -ne $true) {
        throw "MyDashboard did not acknowledge graceful shutdown."
    }
    $requested = Read-ShutdownReceipt -State $State -Phase "requested"
    if ($null -eq $requested) {
        throw "MyDashboard acknowledged shutdown without a durable request receipt."
    }
}

function Wait-ForShutdownOutcome {
    param([Parameter(Mandatory = $true)]$State)
    $deadline = [DateTime]::UtcNow.AddSeconds($TimeoutSeconds)
    while ([DateTime]::UtcNow -lt $deadline) {
        $terminal = Read-ShutdownReceipt -State $State -Phase "terminal"
        if ($null -ne $terminal -and $terminal.status -eq "failure") {
            throw "MyDashboard reported a graceful shutdown failure; control state was retained."
        }
        $process = Get-Process `
            -Id ([int]$State.processId) `
            -ErrorAction SilentlyContinue
        if ($null -eq $process -and $null -ne $terminal) {
            if ($terminal.status -ne "success") {
                throw "MyDashboard shutdown did not produce a success receipt."
            }
            return $terminal
        }
        Start-Sleep -Milliseconds 200
    }
    throw "MyDashboard shutdown outcome is unknown; it was not force-killed and control state was retained."
}

function Remove-ShutdownReceipts {
    param([Parameter(Mandatory = $true)]$State)
    foreach ($phase in @("requested", "terminal")) {
        $path = Get-ReceiptPath -State $State -Phase $phase
        Remove-Item -LiteralPath $path -Force -ErrorAction SilentlyContinue
    }
}

function Complete-SuccessfulShutdown {
    param([Parameter(Mandatory = $true)]$State)
    $terminal = Read-ShutdownReceipt -State $State -Phase "terminal"
    if ($null -eq $terminal -or $terminal.status -ne "success") {
        return $false
    }
    if ($null -ne (Get-Process -Id ([int]$State.processId) -ErrorAction SilentlyContinue)) {
        return $false
    }
    Remove-ControlState -ExpectedState $State
    Remove-ShutdownReceipts -State $State
    return $true
}

function Get-BoundedSha256 {
    param(
        [Parameter(Mandatory = $true)][string]$Path,
        [Parameter(Mandatory = $true)][string]$Description,
        [ValidateRange(1, 536870912)][long]$MaximumBytes = 65536
    )
    Assert-RegularManagedFile `
        -Path $Path `
        -Description $Description `
        -MaximumBytes $MaximumBytes
    return ([System.Security.Cryptography.SHA256]::Create().ComputeHash(
        [System.IO.File]::ReadAllBytes($Path)
    ) | ForEach-Object { $_.ToString("x2") }) -join ""
}

function Get-StringSha256 {
    param([Parameter(Mandatory = $true)][string]$Value)
    $algorithm = [System.Security.Cryptography.SHA256]::Create()
    try {
        $bytes = (New-Object System.Text.UTF8Encoding($false)).GetBytes($Value)
        return ($algorithm.ComputeHash($bytes) | ForEach-Object {
            $_.ToString("x2")
        }) -join ""
    } finally {
        $algorithm.Dispose()
    }
}

function Assert-RecoverySnapshotId {
    param([Parameter(Mandatory = $true)][string]$SnapshotId)
    if ($SnapshotId -notmatch '^shutdown-failure-[0-9]{8}-[0-9]{6}-[a-f0-9]{32}$') {
        throw "RecoverySnapshotId is malformed."
    }
}

function Test-RecoveryJsonInteger {
    param([AllowNull()]$Value)
    return $Value -is [int] -or $Value -is [long]
}

function Test-RecoveryTotalBytesValue {
    param([AllowNull()]$Value)
    if (Test-RecoveryJsonInteger -Value $Value) {
        return $true
    }
    if ($Value -is [decimal]) {
        return $Value -eq [decimal]::Truncate([decimal]$Value)
    }
    if ($Value -isnot [double]) {
        return $false
    }
    return (
        -not [double]::IsNaN([double]$Value) -and
        -not [double]::IsInfinity([double]$Value) -and
        $Value -eq [Math]::Truncate([double]$Value)
    )
}

function Test-RecoveryCreatedAt {
    param([AllowNull()]$Value)
    if (
        $Value -isnot [string] -or
        $Value.Length -lt 20 -or
        $Value.Length -gt 35 -or
        $Value -notmatch `
            '^[0-9]{4}-(0[1-9]|1[0-2])-([0-2][0-9]|3[01])T([01][0-9]|2[0-3]):[0-5][0-9]:[0-5][0-9](\.[0-9]{1,7})?Z$'
    ) {
        return $false
    }
    $parsed = [DateTimeOffset]::MinValue
    return [DateTimeOffset]::TryParse(
        $Value,
        [Globalization.CultureInfo]::InvariantCulture,
        [Globalization.DateTimeStyles]::AssumeUniversal,
        [ref]$parsed
    ) -and $parsed.Offset -eq [TimeSpan]::Zero
}

function ConvertTo-RecoveryJsonValue {
    param([AllowNull()]$Value)
    if ($Value -is [System.Collections.IDictionary]) {
        $properties = [ordered]@{}
        foreach ($key in $Value.Keys) {
            $properties[[string]$key] = ConvertTo-RecoveryJsonValue -Value $Value[$key]
        }
        return [pscustomobject]$properties
    }
    if ($Value -is [System.Array]) {
        $items = @($Value | ForEach-Object {
            ConvertTo-RecoveryJsonValue -Value $_
        })
        return ,$items
    }
    return $Value
}

function ConvertFrom-RecoveryManifestJson {
    param([Parameter(Mandatory = $true)][string]$Json)
    if ($convertFromJsonPreservesDates) {
        return ConvertFrom-ExactJson -Json $Json
    }
    Add-Type -AssemblyName System.Web.Extensions
    $serializer = New-Object System.Web.Script.Serialization.JavaScriptSerializer
    $serializer.MaxJsonLength = 1048576
    $serializer.RecursionLimit = 8
    return ConvertTo-RecoveryJsonValue -Value $serializer.DeserializeObject($Json)
}

function Test-RecoveryExcludedActiveDataDirectoryName {
    param([Parameter(Mandatory = $true)][string]$Name)
    return (
        [string]::Equals(
            $Name,
            "playwright-browsers",
            [System.StringComparison]::Ordinal
        ) -or
        [string]::Equals(
            $Name,
            "validation-profile-probe",
            [System.StringComparison]::Ordinal
        ) -or
        [string]::Equals(
            $Name,
            "change-packages",
            [System.StringComparison]::Ordinal
        ) -or
        # Managed executor state is preserved in place, like change-packages.
        [string]::Equals(
            $Name,
            "code-executor",
            [System.StringComparison]::Ordinal
        )
    )
}

function Get-RecoverySnapshotFiles {
    param(
        [Parameter(Mandatory = $true)][string]$Directory,
        [Parameter(Mandatory = $true)]$Manifest,
        [switch]$AllowProductionExcludedCacheDirectories
    )
    Assert-NotReparseDirectory -Path $Directory
    if ($Manifest.files -isnot [System.Array]) {
        throw "Recovery snapshot files must be one JSON array."
    }
    $entries = @($Manifest.files)
    if ($entries.Count -lt 1 -or $entries.Count -gt 4096) {
        throw "Recovery snapshot file count is outside the safe bound."
    }
    if (
        -not (Test-RecoveryJsonInteger -Value $Manifest.fileCount) -or
        [long]$Manifest.fileCount -lt 1 -or
        [long]$Manifest.fileCount -gt 4096 -or
        [long]$Manifest.fileCount -ne $entries.Count -or
        -not (Test-RecoveryTotalBytesValue -Value $Manifest.totalBytes) -or
        [long]$Manifest.totalBytes -lt 0 -or
        [long]$Manifest.totalBytes -gt 536870912
    ) {
        throw "Recovery snapshot manifest totals are invalid."
    }
    $expected = @{}
    [long]$total = 0
    foreach ($entry in $entries) {
        $properties = @($entry.PSObject.Properties.Name | Sort-Object)
        if (
            $entry -isnot [pscustomobject] -or
            (Compare-Object `
                -ReferenceObject @("bytes", "name", "sha256", "sourceStable") `
                -DifferenceObject $properties) -or
            $entry.name -isnot [string] -or
            $entry.name -notmatch '^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$' -or
            -not (Test-RecoveryJsonInteger -Value $entry.bytes) -or
            [long]$entry.bytes -lt 0 -or
            [long]$entry.bytes -gt 536870912 -or
            $entry.sha256 -isnot [string] -or
            $entry.sha256 -notmatch '^[a-f0-9]{64}$' -or
            $entry.sourceStable -isnot [bool] -or
            $entry.sourceStable -ne $true -or
            $expected.ContainsKey([string]$entry.name)
        ) {
            throw "Recovery snapshot manifest file entry is invalid."
        }
        $total += [long]$entry.bytes
        if ($total -gt 536870912) {
            throw "Recovery snapshot total size is outside the safe bound."
        }
        $expected[[string]$entry.name] = $entry
    }
    if ([long]$Manifest.totalBytes -ne $total) {
        throw "Recovery snapshot manifest totals are invalid."
    }
    $actualFiles = @()
    foreach ($item in @(Get-ChildItem -LiteralPath $Directory -Force)) {
        $isReparse = (
            ($item.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0
        )
        if ($item.PSIsContainer) {
            if (
                $isReparse -or
                -not $AllowProductionExcludedCacheDirectories -or
                -not (Test-RecoveryExcludedActiveDataDirectoryName -Name $item.Name)
            ) {
                throw "Recovery snapshot contains an unsafe directory entry."
            }
            continue
        }
        if (
            $isReparse -or
            (Test-RecoveryExcludedActiveDataDirectoryName -Name $item.Name)
        ) {
            throw "Recovery snapshot contains an unsafe file entry."
        }
        $actualFiles += $item
    }
    if ($actualFiles.Count -ne $expected.Count) {
        throw "Recovery snapshot file set does not match its manifest."
    }
    foreach ($item in $actualFiles) {
        if (-not $expected.ContainsKey($item.Name)) {
            throw "Recovery snapshot contains an unsafe file entry."
        }
        $entry = $expected[$item.Name]
        if (
            [long]$item.Length -ne [long]$entry.bytes -or
            (Get-BoundedSha256 `
                -Path $item.FullName `
                -Description "Recovery snapshot data file" `
                -MaximumBytes 536870912) -ne [string]$entry.sha256
        ) {
            throw "Recovery snapshot data file does not match its manifest."
        }
    }
    return $expected
}

function Get-ValidatedRecoverySnapshot {
    param([Parameter(Mandatory = $true)][string]$SnapshotId)
    Assert-RecoverySnapshotId -SnapshotId $SnapshotId
    if (-not (Test-Path -LiteralPath $recoverySnapshotsDirectory -PathType Container)) {
        throw "Recovery snapshots directory is unavailable."
    }
    Assert-NotReparseDirectory -Path $recoverySnapshotsDirectory
    $snapshotDirectory = Assert-DirectChildPath `
        -Parent $recoverySnapshotsDirectory `
        -Child (Join-Path $recoverySnapshotsDirectory $SnapshotId)
    if (-not (Test-Path -LiteralPath $snapshotDirectory -PathType Container)) {
        throw "Recovery snapshot does not exist."
    }
    Assert-NotReparseDirectory -Path $snapshotDirectory
    $snapshotEntries = @(Get-ChildItem -LiteralPath $snapshotDirectory -Force)
    if (
        $snapshotEntries.Count -ne 2 -or
        @($snapshotEntries.Name | Sort-Object) -join "," -ne "data,manifest.json" -or
        @($snapshotEntries | Where-Object {
            ($_.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0
        }).Count -ne 0
    ) {
        throw "Recovery snapshot contains unexpected nesting or entries."
    }
    $manifestPath = Assert-DirectChildPath `
        -Parent $snapshotDirectory `
        -Child (Join-Path $snapshotDirectory "manifest.json")
    $dataPath = Assert-DirectChildPath `
        -Parent $snapshotDirectory `
        -Child (Join-Path $snapshotDirectory "data")
    Assert-RegularManagedFile `
        -Path $manifestPath `
        -Description "Recovery snapshot manifest" `
        -MaximumBytes 1048576
    if (-not (Test-Path -LiteralPath $dataPath -PathType Container)) {
        throw "Recovery snapshot data directory is unavailable."
    }
    Assert-NotReparseDirectory -Path $dataPath
    $manifest = ConvertFrom-RecoveryManifestJson -Json (
        Get-Content -LiteralPath $manifestPath -Raw
    )
    if ($manifest -isnot [pscustomobject]) {
        throw "Recovery snapshot manifest must be one JSON object."
    }
    $properties = @($manifest.PSObject.Properties.Name | Sort-Object)
    if (
        (Compare-Object `
            -ReferenceObject @(
                "consistent", "createdAt", "fileCount", "files", "reason",
                "schemaVersion", "sourceDirectory", "totalBytes"
            ) `
            -DifferenceObject $properties) -or
        -not (Test-RecoveryJsonInteger -Value $manifest.schemaVersion) -or
        [long]$manifest.schemaVersion -ne 1 -or
        -not (Test-RecoveryCreatedAt -Value $manifest.createdAt) -or
        $manifest.reason -isnot [string] -or
        $manifest.reason -notin @(
            $shutdownFailureRecoveryReason,
            $unexpectedExitRecoveryReason,
            $interruptedShutdownRecoveryReason
        ) -or
        $manifest.sourceDirectory -isnot [string] -or
        -not $pathComparer.Equals(
            [System.IO.Path]::GetFullPath($manifest.sourceDirectory),
            $dataDirectory
        ) -or
        $manifest.consistent -isnot [bool] -or
        $manifest.consistent -ne $true
    ) {
        throw "Recovery snapshot manifest has an invalid shape or source."
    }
    $files = Get-RecoverySnapshotFiles -Directory $dataPath -Manifest $manifest
    $activeFiles = Get-RecoverySnapshotFiles `
        -Directory $dataDirectory `
        -Manifest $manifest `
        -AllowProductionExcludedCacheDirectories
    foreach ($name in $files.Keys) {
        if (
            [long]$files[$name].bytes -ne [long]$activeFiles[$name].bytes -or
            [string]$files[$name].sha256 -ne [string]$activeFiles[$name].sha256
        ) {
            throw "Recovery snapshot and active data are not byte-identical."
        }
    }
    return [pscustomobject]@{
        Id = $SnapshotId
        Directory = $snapshotDirectory
        ManifestPath = $manifestPath
        Reason = [string]$manifest.reason
        ManifestSha256 = Get-BoundedSha256 `
            -Path $manifestPath `
            -Description "Recovery snapshot manifest" `
            -MaximumBytes 1048576
    }
}

function Get-AuthenticatedRecoveryEvidence {
    param([Parameter(Mandatory = $true)]$State)
    $requested = Read-ShutdownReceipt -State $State -Phase "requested"
    $terminal = Read-ShutdownReceipt -State $State -Phase "terminal"
    if ($null -eq $requested -or $null -eq $terminal -or $terminal.status -ne "failure") {
        throw "Recovery requires authenticated requested and failure terminal receipts."
    }
    $requestedPath = Get-ReceiptPath -State $State -Phase "requested"
    $terminalPath = Get-ReceiptPath -State $State -Phase "terminal"
    return [pscustomobject]@{
        Kind = $shutdownFailureEvidenceKind
        State = $State
        Requested = $requested
        Terminal = $terminal
        ControlSha256 = Get-BoundedSha256 -Path $controlFile -Description "Process control state"
        RequestedSha256 = Get-BoundedSha256 -Path $requestedPath -Description "Shutdown request receipt"
        TerminalSha256 = Get-BoundedSha256 -Path $terminalPath -Description "Shutdown terminal receipt"
    }
}

function Get-AbsentRecoveryReceiptSha256 {
    param(
        [Parameter(Mandatory = $true)]$State,
        [ValidateSet("requested", "terminal")][string]$Phase
    )
    return (Get-StringSha256 -Value (@(
        "recovery-absent-receipt-v1",
        $projectDigest,
        [string]$State.processId,
        [string]$State.instanceId,
        [string]$State.processStartTimeUtcTicks,
        [string]$State.startIdentity,
        $Phase
    ) -join "`n"))
}

function Assert-RecoveryPathAbsent {
    param(
        [Parameter(Mandatory = $true)][string]$Path,
        [Parameter(Mandatory = $true)][string]$Description
    )
    $parent = [System.IO.Path]::GetDirectoryName($Path)
    if (-not (Test-Path -LiteralPath $parent -PathType Container)) {
        return
    }
    Assert-NotReparseDirectory -Path $parent
    foreach ($entry in @(Get-ChildItem -LiteralPath $parent -Force)) {
        if ($pathComparer.Equals(
            [System.IO.Path]::GetFullPath($entry.FullName),
            [System.IO.Path]::GetFullPath($Path)
        )) {
            throw "$Description must remain absent."
        }
    }
}

function Get-UnexpectedExitRecoveryEvidence {
    param([Parameter(Mandatory = $true)]$State)
    foreach ($phase in @("requested", "terminal")) {
        Assert-RecoveryPathAbsent `
            -Path (Get-ReceiptPath -State $State -Phase $phase) `
            -Description "Unexpected-exit shutdown $phase receipt"
    }
    return [pscustomobject]@{
        Kind = $unexpectedExitEvidenceKind
        State = $State
        Requested = $null
        Terminal = $null
        ControlSha256 = Get-BoundedSha256 -Path $controlFile -Description "Process control state"
        RequestedSha256 = Get-AbsentRecoveryReceiptSha256 `
            -State $State `
            -Phase "requested"
        TerminalSha256 = Get-AbsentRecoveryReceiptSha256 `
            -State $State `
            -Phase "terminal"
    }
}

function Get-InterruptedShutdownRecoveryEvidence {
    param([Parameter(Mandatory = $true)]$State)
    $requested = Read-ShutdownReceipt -State $State -Phase "requested"
    if ($null -eq $requested) { throw "Interrupted shutdown requires an authenticated request receipt." }
    Assert-RecoveryPathAbsent -Path (Get-ReceiptPath -State $State -Phase "terminal") -Description "Interrupted shutdown terminal receipt"
    return [pscustomobject]@{
        Kind = $interruptedShutdownEvidenceKind
        State = $State
        Requested = $requested
        Terminal = $null
        ControlSha256 = Get-BoundedSha256 -Path $controlFile -Description "Process control state"
        RequestedSha256 = Get-BoundedSha256 -Path (Get-ReceiptPath -State $State -Phase "requested") -Description "Shutdown request receipt"
        TerminalSha256 = Get-AbsentRecoveryReceiptSha256 -State $State -Phase "terminal"
    }
}

function Get-DeadProcessRecoveryEvidence {
    param([Parameter(Mandatory = $true)]$State)
    $requested = Read-ShutdownReceipt -State $State -Phase "requested"
    $terminal = Read-ShutdownReceipt -State $State -Phase "terminal"
    if ($null -eq $requested -and $null -eq $terminal) {
        return Get-UnexpectedExitRecoveryEvidence -State $State
    }
    if ($null -ne $requested -and $null -eq $terminal) {
        return Get-InterruptedShutdownRecoveryEvidence -State $State
    }
    if ($null -eq $requested -or $null -eq $terminal) {
        throw "Dead-process recovery has incomplete shutdown receipt evidence."
    }
    return Get-AuthenticatedRecoveryEvidence -State $State
}

function Assert-SameRecoveryEvidence {
    param([Parameter(Mandatory = $true)]$Evidence)
    $currentState = Read-ControlState
    if ($null -eq $currentState -or -not (Test-SameControlIdentity `
        -Left $currentState `
        -Right $Evidence.State)) {
        throw "Authenticated control state changed during recovery preflight."
    }
    $current = if ($Evidence.Kind -eq $shutdownFailureEvidenceKind) {
        Get-AuthenticatedRecoveryEvidence -State $currentState
    } elseif ($Evidence.Kind -eq $interruptedShutdownEvidenceKind) {
        Get-InterruptedShutdownRecoveryEvidence -State $currentState
    } elseif ($Evidence.Kind -in @($unexpectedExitEvidenceKind, $interruptedShutdownEvidenceKind)) {
        Get-UnexpectedExitRecoveryEvidence -State $currentState
    } else {
        throw "Recovery evidence kind is invalid."
    }
    if (
        $current.Kind -ne $Evidence.Kind -or
        $current.ControlSha256 -ne $Evidence.ControlSha256 -or
        $current.RequestedSha256 -ne $Evidence.RequestedSha256 -or
        $current.TerminalSha256 -ne $Evidence.TerminalSha256
    ) {
        throw "Authenticated recovery evidence changed during preflight."
    }
    return $current
}

function Get-StableRecoverySourceFiles {
    Assert-NotReparseDirectory -Path $dataDirectory
    $files = @()
    [long]$totalBytes = 0
    foreach ($item in @(Get-ChildItem -LiteralPath $dataDirectory -Force | Sort-Object Name)) {
        $isReparse = (
            ($item.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0
        )
        if ($item.PSIsContainer) {
            if (
                $isReparse -or
                -not (Test-RecoveryExcludedActiveDataDirectoryName -Name $item.Name)
            ) {
                throw "Active data contains an unsafe directory entry."
            }
            continue
        }
        if (
            $isReparse -or
            (Test-RecoveryExcludedActiveDataDirectoryName -Name $item.Name) -or
            $item.Name -notmatch '^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$' -or
            [long]$item.Length -gt 536870912
        ) {
            throw "Active data contains an unsafe file entry."
        }
        $totalBytes += [long]$item.Length
        if ($files.Count -ge 4096 -or $totalBytes -gt 536870912) {
            throw "Active data is outside the recovery snapshot safe bound."
        }
        $files += $item
    }
    if ($files.Count -lt 1) {
        throw "Active data has no recoverable state files."
    }
    return $files
}

function Copy-StableRecoveryFile {
    param(
        [Parameter(Mandatory = $true)]$Source,
        [Parameter(Mandatory = $true)][string]$Destination
    )
    Assert-RegularManagedFile `
        -Path $Source.FullName `
        -Description "Active recovery data file" `
        -MaximumBytes 536870912
    $expectedBytes = [long]$Source.Length
    $beforeHash = Get-BoundedSha256 `
        -Path $Source.FullName `
        -Description "Active recovery data file" `
        -MaximumBytes 536870912
    $content = [System.IO.File]::ReadAllBytes($Source.FullName)
    if ([long]$content.LongLength -ne $expectedBytes) {
        throw "Active recovery data changed during snapshot capture."
    }
    $stream = New-Object System.IO.FileStream(
        $Destination,
        [System.IO.FileMode]::CreateNew,
        [System.IO.FileAccess]::Write,
        [System.IO.FileShare]::None
    )
    try {
        $stream.Write($content, 0, $content.Length)
        $stream.Flush($true)
    } finally {
        $stream.Dispose()
    }
    $afterHash = Get-BoundedSha256 `
        -Path $Source.FullName `
        -Description "Active recovery data file" `
        -MaximumBytes 536870912
    $copiedHash = Get-BoundedSha256 `
        -Path $Destination `
        -Description "Prepared recovery data file" `
        -MaximumBytes 536870912
    if (
        $beforeHash -ne $afterHash -or
        $beforeHash -ne $copiedHash -or
        [long](Get-Item -LiteralPath $Source.FullName -Force).Length -ne $expectedBytes
    ) {
        throw "Active recovery data changed during snapshot capture."
    }
    return [pscustomobject]@{
        name = [string]$Source.Name
        bytes = $expectedBytes
        sha256 = $beforeHash
        sourceStable = $true
    }
}

function Write-RecoverySnapshotManifest {
    param(
        [Parameter(Mandatory = $true)][string]$Path,
        [Parameter(Mandatory = $true)][System.Array]$Files,
        [Parameter(Mandatory = $true)][string]$CreatedAt,
        [Parameter(Mandatory = $true)]
        [ValidateSet(
            "managed_shutdown_lifecycle_failure",
            "managed_process_exit_without_receipt",
            "managed_shutdown_exit_without_terminal"
        )]
        [string]$Reason
    )
    [long]$totalBytes = 0
    foreach ($entry in $Files) {
        $totalBytes += [long]$entry.bytes
    }
    $manifest = [ordered]@{
        schemaVersion = 1
        createdAt = $CreatedAt
        reason = $Reason
        sourceDirectory = $dataDirectory
        consistent = $true
        fileCount = $Files.Count
        totalBytes = $totalBytes
        files = @($Files)
    }
    $json = ([pscustomobject]$manifest) | ConvertTo-Json -Depth 4 -Compress
    $bytes = (New-Object System.Text.UTF8Encoding($false)).GetBytes("$json`n")
    $stream = New-Object System.IO.FileStream(
        $Path,
        [System.IO.FileMode]::CreateNew,
        [System.IO.FileAccess]::Write,
        [System.IO.FileShare]::None
    )
    try {
        $stream.Write($bytes, 0, $bytes.Length)
        $stream.Flush($true)
    } finally {
        $stream.Dispose()
    }
}

function Prepare-FailedShutdownRecovery {
    $state = Read-ControlState
    if ($null -eq $state) {
        throw "No authenticated failed-shutdown control state is available for preparation."
    }
    if ([int]$state.port -ne (Get-ConfiguredPort)) {
        throw "Authenticated control state does not match the configured port."
    }
    $process = Get-ManagedProcess -State $state
    $processWasPresent = $null -ne $process
    $evidence = if ($processWasPresent) {
        Get-AuthenticatedRecoveryEvidence -State $state
    } else {
        Get-DeadProcessRecoveryEvidence -State $state
    }
    $snapshotReason = if ($evidence.Kind -eq $shutdownFailureEvidenceKind) {
        $shutdownFailureRecoveryReason
    } elseif ($evidence.Kind -eq $interruptedShutdownEvidenceKind) {
        $interruptedShutdownRecoveryReason
    } else {
        $unexpectedExitRecoveryReason
    }
    if (Test-LoopbackTcpListener -Port ([int]$state.port)) {
        throw "The controlled port is occupied or its probe was ambiguous."
    }
    if (-not (Test-NoManagedDescendants -ProcessId ([int]$state.processId))) {
        throw "Managed process has live descendants; refusing recovery preparation."
    }
    if (-not (Test-Path -LiteralPath $recoverySnapshotsDirectory)) {
        New-Item `
            -ItemType Directory `
            -Path $recoverySnapshotsDirectory `
            -ErrorAction Stop | Out-Null
    }
    Assert-NotReparseDirectory -Path $recoverySnapshotsDirectory
    $created = [DateTimeOffset]::UtcNow
    $snapshotId = "shutdown-failure-$($created.ToString('yyyyMMdd-HHmmss'))-$([guid]::NewGuid().ToString('N'))"
    Assert-RecoverySnapshotId -SnapshotId $snapshotId
    $snapshotDirectory = Assert-DirectChildPath `
        -Parent $recoverySnapshotsDirectory `
        -Child (Join-Path $recoverySnapshotsDirectory $snapshotId)
    $temporaryDirectory = Assert-DirectChildPath `
        -Parent $recoverySnapshotsDirectory `
        -Child (Join-Path $recoverySnapshotsDirectory ".prepare-$PID-$([guid]::NewGuid().ToString('N'))")
    if (
        (Test-Path -LiteralPath $snapshotDirectory) -or
        (Test-Path -LiteralPath $temporaryDirectory)
    ) {
        throw "Recovery snapshot destination already exists."
    }
    $snapshotMoved = $false
    $incidentAttempted = $false
    $writerLease = $null
    try {
        if (-not $processWasPresent) {
            $writerLease = Open-ApplicationWriterLease
        }
        New-Item -ItemType Directory -Path $temporaryDirectory -ErrorAction Stop | Out-Null
        Assert-NotReparseDirectory -Path $temporaryDirectory
        $temporaryData = Assert-DirectChildPath `
            -Parent $temporaryDirectory `
            -Child (Join-Path $temporaryDirectory "data")
        New-Item -ItemType Directory -Path $temporaryData -ErrorAction Stop | Out-Null
        Assert-NotReparseDirectory -Path $temporaryData
        $entries = @()
        foreach ($source in @(Get-StableRecoverySourceFiles)) {
            $destination = Assert-DirectChildPath `
                -Parent $temporaryData `
                -Child (Join-Path $temporaryData $source.Name)
            $entries += Copy-StableRecoveryFile `
                -Source $source `
                -Destination $destination
        }
        $manifestPath = Assert-DirectChildPath `
            -Parent $temporaryDirectory `
            -Child (Join-Path $temporaryDirectory "manifest.json")
        Write-RecoverySnapshotManifest `
            -Path $manifestPath `
            -Files $entries `
            -CreatedAt $created.ToUniversalTime().ToString(
                "yyyy-MM-dd'T'HH:mm:ss.fffffff'Z'",
                [Globalization.CultureInfo]::InvariantCulture
            ) `
            -Reason $snapshotReason
        $manifest = ConvertFrom-RecoveryManifestJson -Json (
            Get-Content -LiteralPath $manifestPath -Raw
        )
        $copiedFiles = Get-RecoverySnapshotFiles `
            -Directory $temporaryData `
            -Manifest $manifest
        $activeFiles = Get-RecoverySnapshotFiles `
            -Directory $dataDirectory `
            -Manifest $manifest `
            -AllowProductionExcludedCacheDirectories
        foreach ($name in $copiedFiles.Keys) {
            if (
                [long]$copiedFiles[$name].bytes -ne [long]$activeFiles[$name].bytes -or
                [string]$copiedFiles[$name].sha256 -ne [string]$activeFiles[$name].sha256
            ) {
                throw "Prepared recovery snapshot and active data are not byte-identical."
            }
        }
        $evidence = Assert-SameRecoveryEvidence -Evidence $evidence
        if (Test-LoopbackTcpListener -Port ([int]$evidence.State.port)) {
            throw "Recovery preparation listener verification changed."
        }
        if (-not (Test-NoManagedDescendants -ProcessId ([int]$evidence.State.processId))) {
            throw "Managed process descendants changed during recovery preparation."
        }
        $currentProcess = Get-ManagedProcess -State $evidence.State
        if (
            ($processWasPresent -and $null -eq $currentProcess) -or
            (-not $processWasPresent -and $null -ne $currentProcess)
        ) {
            throw "Recovery preparation process identity changed."
        }
        [System.IO.Directory]::Move($temporaryDirectory, $snapshotDirectory)
        $snapshotMoved = $true
        $snapshot = Get-ValidatedRecoverySnapshot -SnapshotId $snapshotId
        $evidence = Assert-SameRecoveryEvidence -Evidence $evidence
        $incidentAttempted = $true
        $incident = Publish-RecoveryIncident -Evidence $evidence -Snapshot $snapshot
        Write-Output (
            "Prepared failed-shutdown recovery snapshot $($snapshot.Id) " +
            "and authenticated incident $($incident.Id); MyDashboard remains stopped."
        )
    } finally {
        try {
            if (-not $snapshotMoved -and (Test-Path -LiteralPath $temporaryDirectory)) {
                Assert-NotReparseDirectory -Path $temporaryDirectory
                Remove-Item -LiteralPath $temporaryDirectory -Recurse -Force
            }
            if (
                $snapshotMoved -and
                -not $incidentAttempted -and
                (Test-Path -LiteralPath $snapshotDirectory)
            ) {
                Assert-NotReparseDirectory -Path $snapshotDirectory
                Remove-Item -LiteralPath $snapshotDirectory -Recurse -Force
            }
        } finally {
            if ($null -ne $writerLease) {
                Close-ApplicationWriterLease -Holder $writerLease
            }
        }
    }
}

function Test-NoManagedDescendants {
    param([Parameter(Mandatory = $true)][int]$ProcessId)
    try {
        $children = @(Get-CimInstance `
            -ClassName Win32_Process `
            -Filter "ParentProcessId = $ProcessId" `
            -ErrorAction Stop)
        foreach ($candidate in $children) {
            if (
                $null -eq $candidate.ProcessId -or
                $null -eq $candidate.ParentProcessId -or
                [int]$candidate.ProcessId -lt 1 -or
                [int]$candidate.ParentProcessId -ne $ProcessId
            ) {
                throw "Process descendant inspection returned an invalid identity."
            }
            return $false
        }
        return $true
    } catch {
        throw "Unable to inspect managed process descendants safely."
    }
}

function Publish-ExactRecoveryEvidenceCopy {
    param(
        [Parameter(Mandatory = $true)][string]$Source,
        [Parameter(Mandatory = $true)][string]$Destination,
        [Parameter(Mandatory = $true)][string]$ExpectedSha256,
        [Parameter(Mandatory = $true)][string]$Description,
        [ValidateRange(1, 536870912)][long]$MaximumBytes = 1048576
    )
    if ((Get-BoundedSha256 `
        -Path $Source `
        -Description $Description `
        -MaximumBytes $MaximumBytes) -ne $ExpectedSha256) {
        throw "$Description changed before incident archival."
    }
    if (Test-Path -LiteralPath $Destination) {
        if ((Get-BoundedSha256 `
            -Path $Destination `
            -Description "Archived $Description" `
            -MaximumBytes $MaximumBytes) -ne $ExpectedSha256) {
            throw "Archived $Description conflicts with this recovery authority."
        }
        return
    }
    $bytes = [System.IO.File]::ReadAllBytes($Source)
    $stream = New-Object System.IO.FileStream(
        $Destination,
        [System.IO.FileMode]::CreateNew,
        [System.IO.FileAccess]::Write,
        [System.IO.FileShare]::None,
        4096,
        [System.IO.FileOptions]::WriteThrough
    )
    try {
        $stream.Write($bytes, 0, $bytes.Length)
        $stream.Flush($true)
    } finally {
        $stream.Dispose()
    }
    if ((Get-BoundedSha256 `
        -Path $Destination `
        -Description "Archived $Description" `
        -MaximumBytes $MaximumBytes) -ne $ExpectedSha256) {
        throw "Archived $Description did not preserve its exact bytes."
    }
}

function Get-RecoveryIncidentId {
    param(
        [Parameter(Mandatory = $true)]$State,
        [Parameter(Mandatory = $true)]$Snapshot
    )
    $identity = @(
        "recovery-incident-v1",
        $projectDigest,
        [string]$State.processId,
        [string]$State.instanceId,
        [string]$State.processStartTimeUtcTicks,
        [string]$State.startIdentity,
        [string]$Snapshot.Id
    ) -join "`n"
    return "incident-$((Get-StringSha256 -Value $identity).Substring(0, 32))"
}

function Get-RecoveryIncidentLocation {
    param(
        [Parameter(Mandatory = $true)]$State,
        [Parameter(Mandatory = $true)]$Snapshot
    )
    $incidentId = Get-RecoveryIncidentId -State $State -Snapshot $Snapshot
    $incidentDirectory = Assert-DirectChildPath `
        -Parent $incidentsDirectory `
        -Child (Join-Path $incidentsDirectory $incidentId)
    return [pscustomobject]@{
        Id = $incidentId
        Directory = $incidentDirectory
        RecordPath = Assert-DirectChildPath `
            -Parent $incidentDirectory `
            -Child (Join-Path $incidentDirectory "incident.json")
    }
}

function Get-RecoveryIncidentAuthorityPayload {
    param([Parameter(Mandatory = $true)]$Record)
    return @(
        "recovery-incident-authority-v1",
        [string]$Record.schemaVersion,
        [string]$Record.incidentId,
        [string]$Record.state,
        [string]$Record.projectDigest,
        [string]$Record.processId,
        [string]$Record.instanceId,
        [string]$Record.processStartTimeUtcTicks,
        [string]$Record.startIdentity,
        [string]$Record.snapshotId,
        [string]$Record.sourceHashes.control,
        [string]$Record.sourceHashes.requestedReceipt,
        [string]$Record.sourceHashes.terminalReceipt,
        [string]$Record.sourceHashes.manifest
    ) -join "`n"
}

function New-RecoveryIncidentRecord {
    param(
        [Parameter(Mandatory = $true)]$Location,
        [Parameter(Mandatory = $true)]$Evidence,
        [Parameter(Mandatory = $true)]$Snapshot,
        [ValidateSet("pre_termination", "postconditions_verified", "recovered", "invalidated")]
        [string]$State = "pre_termination"
    )
    $record = [ordered]@{
        schemaVersion = 1
        incidentId = [string]$Location.Id
        state = $State
        projectDigest = $projectDigest
        processId = [int]$Evidence.State.processId
        instanceId = [string]$Evidence.State.instanceId
        processStartTimeUtcTicks = [string]$Evidence.State.processStartTimeUtcTicks
        startIdentity = [string]$Evidence.State.startIdentity
        snapshotId = [string]$Snapshot.Id
        sourceHashes = [ordered]@{
            control = [string]$Evidence.ControlSha256
            requestedReceipt = [string]$Evidence.RequestedSha256
            terminalReceipt = [string]$Evidence.TerminalSha256
            manifest = [string]$Snapshot.ManifestSha256
        }
        authorityHmac = ""
    }
    $record.authorityHmac = Get-HmacBase64 `
        -Token ([string]$Evidence.State.controlToken) `
        -Payload (Get-RecoveryIncidentAuthorityPayload -Record ([pscustomobject]$record))
    return [pscustomobject]$record
}

function Assert-RecoveryIncidentRecord {
    param(
        [Parameter(Mandatory = $true)]$Record,
        [Parameter(Mandatory = $true)]$Location,
        [Parameter(Mandatory = $true)]$State,
        [Parameter(Mandatory = $true)]$Snapshot
    )
    $properties = @($Record.PSObject.Properties.Name | Sort-Object)
    $sourceHashProperties = @($Record.sourceHashes.PSObject.Properties.Name | Sort-Object)
    $sourceHashValues = @(
        $Record.sourceHashes.control,
        $Record.sourceHashes.requestedReceipt,
        $Record.sourceHashes.terminalReceipt,
        $Record.sourceHashes.manifest
    )
    $invalidSourceHashCount = @($sourceHashValues | Where-Object {
        $_ -isnot [string] -or $_ -notmatch '^[a-f0-9]{64}$'
    }).Count
    if (
        $Record -isnot [pscustomobject] -or
        (Compare-Object `
            -ReferenceObject @(
                "authorityHmac", "incidentId", "instanceId", "processId",
                "processStartTimeUtcTicks", "projectDigest", "schemaVersion",
                "snapshotId", "sourceHashes", "startIdentity", "state"
            ) `
            -DifferenceObject $properties) -or
        -not (Test-RecoveryJsonInteger -Value $Record.schemaVersion) -or
        [long]$Record.schemaVersion -ne 1 -or
        $Record.incidentId -isnot [string] -or
        $Record.incidentId -notmatch '^incident-[a-f0-9]{32}$' -or
        $Record.incidentId -ne $Location.Id -or
        $Record.state -isnot [string] -or
        $Record.state -notin @(
            "pre_termination",
            "postconditions_verified",
            "recovered",
            "invalidated"
        ) -or
        $Record.projectDigest -isnot [string] -or
        $Record.projectDigest -ne $projectDigest -or
        -not (Test-RecoveryJsonInteger -Value $Record.processId) -or
        [int]$Record.processId -ne [int]$State.processId -or
        $Record.instanceId -isnot [string] -or
        $Record.instanceId -ne [string]$State.instanceId -or
        $Record.processStartTimeUtcTicks -isnot [string] -or
        $Record.processStartTimeUtcTicks -ne [string]$State.processStartTimeUtcTicks -or
        $Record.startIdentity -isnot [string] -or
        $Record.startIdentity -ne [string]$State.startIdentity -or
        $Record.snapshotId -isnot [string] -or
        $Record.snapshotId -ne [string]$Snapshot.Id -or
        $Record.sourceHashes -isnot [pscustomobject] -or
        (Compare-Object `
            -ReferenceObject @("control", "manifest", "requestedReceipt", "terminalReceipt") `
            -DifferenceObject $sourceHashProperties) -or
        $invalidSourceHashCount -ne 0 -or
        $Record.authorityHmac -isnot [string] -or
        $Record.authorityHmac -notmatch '^[A-Za-z0-9+/]{43}=$'
    ) {
        throw "Recovery incident record has an invalid identity or shape."
    }
    $expectedHmac = Get-HmacBase64 `
        -Token ([string]$State.controlToken) `
        -Payload (Get-RecoveryIncidentAuthorityPayload -Record $Record)
    if (-not (Test-FixedTimeString `
        -Left $expectedHmac `
        -Right ([string]$Record.authorityHmac))) {
        throw "Recovery incident authentication failed."
    }
}

function Write-NewRecoveryIncidentRecord {
    param(
        [Parameter(Mandatory = $true)]$Location,
        [Parameter(Mandatory = $true)]$Record
    )
    $json = $Record | ConvertTo-Json -Depth 4 -Compress
    $bytes = (New-Object System.Text.UTF8Encoding($false)).GetBytes($json)
    $stream = New-Object System.IO.FileStream(
        $Location.RecordPath,
        [System.IO.FileMode]::CreateNew,
        [System.IO.FileAccess]::Write,
        [System.IO.FileShare]::None,
        4096,
        [System.IO.FileOptions]::WriteThrough
    )
    try {
        $stream.Write($bytes, 0, $bytes.Length)
        $stream.Flush($true)
    } finally {
        $stream.Dispose()
    }
    if ((Get-Content -LiteralPath $Location.RecordPath -Raw) -ne $json) {
        throw "Recovery incident durable publication did not match."
    }
}

function Write-ReplacementRecoveryIncidentRecord {
    param(
        [Parameter(Mandatory = $true)]$Location,
        [Parameter(Mandatory = $true)]$Record
    )
    $json = $Record | ConvertTo-Json -Depth 4 -Compress
    $temporary = Assert-DirectChildPath `
        -Parent $Location.Directory `
        -Child (Join-Path $Location.Directory "incident-$PID-$([guid]::NewGuid().ToString('N')).tmp")
    $backup = Assert-DirectChildPath `
        -Parent $Location.Directory `
        -Child (Join-Path $Location.Directory "incident-$PID-$([guid]::NewGuid().ToString('N')).bak")
    $bytes = (New-Object System.Text.UTF8Encoding($false)).GetBytes($json)
    $stream = New-Object System.IO.FileStream(
        $temporary,
        [System.IO.FileMode]::CreateNew,
        [System.IO.FileAccess]::Write,
        [System.IO.FileShare]::None,
        4096,
        [System.IO.FileOptions]::WriteThrough
    )
    try {
        $stream.Write($bytes, 0, $bytes.Length)
        $stream.Flush($true)
    } finally {
        $stream.Dispose()
    }
    try {
        [System.IO.File]::Replace($temporary, $Location.RecordPath, $backup, $true)
        Remove-Item -LiteralPath $backup -Force -ErrorAction SilentlyContinue
    } finally {
        Remove-Item -LiteralPath $temporary -Force -ErrorAction SilentlyContinue
    }
}

function Read-RecoveryIncidentAuthority {
    param(
        [Parameter(Mandatory = $true)]$State,
        [Parameter(Mandatory = $true)]$Snapshot
    )
    $location = Get-RecoveryIncidentLocation -State $State -Snapshot $Snapshot
    if (-not (Test-Path -LiteralPath $location.Directory -PathType Container)) {
        throw "No authenticated recovery incident is available for reconciliation."
    }
    Assert-NotReparseDirectory -Path $location.Directory
    Assert-RegularManagedFile `
        -Path $location.RecordPath `
        -Description "Recovery incident record" `
        -MaximumBytes 65536
    $record = ConvertFrom-ExactJson -Json (
        Get-Content -LiteralPath $location.RecordPath -Raw
    )
    Assert-RecoveryIncidentRecord `
        -Record $record `
        -Location $location `
        -State $State `
        -Snapshot $Snapshot
    return [pscustomobject]@{
        Id = $location.Id
        Directory = $location.Directory
        RecordPath = $location.RecordPath
        Record = $record
    }
}

function Invalidate-UnexpectedExitRecoveryAuthority {
    param(
        [Parameter(Mandatory = $true)]$Authority,
        [Parameter(Mandatory = $true)]$State,
        [Parameter(Mandatory = $true)]$Snapshot
    )
    if ($Snapshot.Reason -notin @($unexpectedExitRecoveryReason, $interruptedShutdownRecoveryReason)) {
        throw "Only unexpected-exit recovery authority can be invalidated by receipt presence."
    }
    if ($Authority.Record.state -ne "invalidated") {
        $evidence = [pscustomobject]@{
            State = $State
            ControlSha256 = [string]$Authority.Record.sourceHashes.control
            RequestedSha256 = [string]$Authority.Record.sourceHashes.requestedReceipt
            TerminalSha256 = [string]$Authority.Record.sourceHashes.terminalReceipt
        }
        $record = New-RecoveryIncidentRecord `
            -Location $Authority `
            -Evidence $evidence `
            -Snapshot $Snapshot `
            -State "invalidated"
        Write-ReplacementRecoveryIncidentRecord -Location $Authority -Record $record
        $persisted = Read-RecoveryIncidentAuthority -State $State -Snapshot $Snapshot
        if ($persisted.Record.state -ne "invalidated") {
            throw "Unexpected-exit recovery invalidation did not persist."
        }
    }
    throw $unexpectedExitAuthorityInvalidatedMessage
}

function Assert-OrInvalidateUnexpectedExitRecoveryAuthority {
    param(
        [Parameter(Mandatory = $true)]$Authority,
        [Parameter(Mandatory = $true)]$State,
        [Parameter(Mandatory = $true)]$Snapshot
    )
    if ($Authority.Record.state -eq "invalidated") {
        throw $unexpectedExitAuthorityInvalidatedMessage
    }
    $paths = @(
        [pscustomobject]@{
            Path = Get-ReceiptPath -State $State -Phase "requested"
            Description = "Active unexpected-exit shutdown requested receipt"
        },
        [pscustomobject]@{
            Path = Get-ReceiptPath -State $State -Phase "terminal"
            Description = "Active unexpected-exit shutdown terminal receipt"
        },
        [pscustomobject]@{
            Path = Assert-DirectChildPath `
                -Parent $Authority.Directory `
                -Child (Join-Path $Authority.Directory "requested-receipt.json")
            Description = "Archived unexpected-exit shutdown requested receipt"
        },
        [pscustomobject]@{
            Path = Assert-DirectChildPath `
                -Parent $Authority.Directory `
                -Child (Join-Path $Authority.Directory "terminal-receipt.json")
            Description = "Archived unexpected-exit shutdown terminal receipt"
        },
        [pscustomobject]@{
            Path = Assert-DirectChildPath `
                -Parent $Authority.Directory `
                -Child (Join-Path $Authority.Directory "requested-receipt-removal.tmp")
            Description = "Unexpected-exit shutdown requested receipt tombstone"
        },
        [pscustomobject]@{
            Path = Assert-DirectChildPath `
                -Parent $Authority.Directory `
                -Child (Join-Path $Authority.Directory "terminal-receipt-removal.tmp")
            Description = "Unexpected-exit shutdown terminal receipt tombstone"
        }
    )
    if ($Snapshot.Reason -eq $interruptedShutdownRecoveryReason) {
        $paths = @($paths | Where-Object { $_.Description -notmatch "requested" })
    }
    foreach ($candidate in $paths) {
        try {
            Assert-RecoveryPathAbsent `
                -Path ([string]$candidate.Path) `
                -Description ([string]$candidate.Description)
        } catch {
            Invalidate-UnexpectedExitRecoveryAuthority `
                -Authority $Authority `
                -State $State `
                -Snapshot $Snapshot
        }
    }
}

function Get-ArchivedRecoveryEvidence {
    param(
        [Parameter(Mandatory = $true)]$Location,
        [Parameter(Mandatory = $true)]$Record,
        [Parameter(Mandatory = $true)]$State,
        [Parameter(Mandatory = $true)]$Snapshot
    )
    $controlPath = Assert-DirectChildPath `
        -Parent $Location.Directory `
        -Child (Join-Path $Location.Directory "control-state.json")
    $requestedPath = Assert-DirectChildPath `
        -Parent $Location.Directory `
        -Child (Join-Path $Location.Directory "requested-receipt.json")
    $terminalPath = Assert-DirectChildPath `
        -Parent $Location.Directory `
        -Child (Join-Path $Location.Directory "terminal-receipt.json")
    $manifestPath = Assert-DirectChildPath `
        -Parent $Location.Directory `
        -Child (Join-Path $Location.Directory "recovery-manifest.json")
    $archivedState = Read-ControlStateFromPath -Path $controlPath
    if (-not (Test-SameControlIdentity -Left $archivedState -Right $State)) {
        throw "Archived recovery control identity does not match active authority."
    }
    $controlHash = Get-BoundedSha256 -Path $controlPath -Description "Archived process control state"
    if ($Snapshot.Reason -eq $shutdownFailureRecoveryReason) {
        $kind = $shutdownFailureEvidenceKind
        $requested = Read-ShutdownReceiptFromPath `
            -State $archivedState `
            -Phase "requested" `
            -Path $requestedPath
        $terminal = Read-ShutdownReceiptFromPath `
            -State $archivedState `
            -Phase "terminal" `
            -Path $terminalPath
        if ($terminal.status -ne "failure") {
            throw "Archived recovery evidence does not contain a terminal failure."
        }
        $requestedHash = Get-BoundedSha256 `
            -Path $requestedPath `
            -Description "Archived shutdown request receipt"
        $terminalHash = Get-BoundedSha256 `
            -Path $terminalPath `
            -Description "Archived shutdown terminal receipt"
    } elseif ($Snapshot.Reason -eq $interruptedShutdownRecoveryReason) {
        $kind = $interruptedShutdownEvidenceKind
        $requested = Read-ShutdownReceiptFromPath -State $archivedState -Phase "requested" -Path $requestedPath
        $terminal = $null
        Assert-OrInvalidateUnexpectedExitRecoveryAuthority -Authority ([pscustomobject]@{ Id = $Location.Id; Directory = $Location.Directory; RecordPath = $Location.RecordPath; Record = $Record }) -State $archivedState -Snapshot $Snapshot
        $requestedHash = Get-BoundedSha256 -Path $requestedPath -Description "Archived shutdown request receipt"
        $terminalHash = Get-AbsentRecoveryReceiptSha256 -State $archivedState -Phase "terminal"
    } elseif ($Snapshot.Reason -eq $unexpectedExitRecoveryReason) {
        $kind = $unexpectedExitEvidenceKind
        $requested = $null
        $terminal = $null
        Assert-OrInvalidateUnexpectedExitRecoveryAuthority `
            -Authority ([pscustomobject]@{
                Id = $Location.Id
                Directory = $Location.Directory
                RecordPath = $Location.RecordPath
                Record = $Record
            }) `
            -State $archivedState `
            -Snapshot $Snapshot
        $requestedHash = Get-AbsentRecoveryReceiptSha256 `
            -State $archivedState `
            -Phase "requested"
        $terminalHash = Get-AbsentRecoveryReceiptSha256 `
            -State $archivedState `
            -Phase "terminal"
    } else {
        throw "Recovery snapshot reason is unsupported."
    }
    $manifestHash = Get-BoundedSha256 `
        -Path $manifestPath `
        -Description "Archived recovery snapshot manifest" `
        -MaximumBytes 1048576
    if (
        $controlHash -ne $Record.sourceHashes.control -or
        $requestedHash -ne $Record.sourceHashes.requestedReceipt -or
        $terminalHash -ne $Record.sourceHashes.terminalReceipt -or
        $manifestHash -ne $Record.sourceHashes.manifest -or
        $manifestHash -ne $Snapshot.ManifestSha256 -or
        (Get-BoundedSha256 -Path $controlFile -Description "Process control state") -ne $controlHash
    ) {
        throw "Archived recovery evidence authentication failed."
    }
    return [pscustomobject]@{
        Kind = $kind
        State = $archivedState
        Requested = $requested
        Terminal = $terminal
        ControlSha256 = $controlHash
        RequestedSha256 = $requestedHash
        TerminalSha256 = $terminalHash
    }
}

function Read-AuthenticatedRecoveryIncident {
    param(
        [Parameter(Mandatory = $true)]$State,
        [Parameter(Mandatory = $true)]$Snapshot
    )
    $authority = Read-RecoveryIncidentAuthority -State $State -Snapshot $Snapshot
    if ($authority.Record.state -eq "invalidated") {
        throw $unexpectedExitAuthorityInvalidatedMessage
    }
    $evidence = Get-ArchivedRecoveryEvidence `
        -Location $authority `
        -Record $authority.Record `
        -State $State `
        -Snapshot $Snapshot
    return [pscustomobject]@{
        Id = $authority.Id
        Directory = $authority.Directory
        RecordPath = $authority.RecordPath
        Record = $authority.Record
        Evidence = $evidence
    }
}

function Publish-RecoveryIncident {
    param(
        [Parameter(Mandatory = $true)]$Evidence,
        [Parameter(Mandatory = $true)]$Snapshot
    )
    if (
        (
            $Evidence.Kind -eq $shutdownFailureEvidenceKind -and
            $Snapshot.Reason -ne $shutdownFailureRecoveryReason
        ) -or
        (
            $Evidence.Kind -eq $unexpectedExitEvidenceKind -and
            $Snapshot.Reason -ne $unexpectedExitRecoveryReason
        ) -or
        ($Evidence.Kind -eq $interruptedShutdownEvidenceKind -and $Snapshot.Reason -ne $interruptedShutdownRecoveryReason) -or
        $Evidence.Kind -notin @(
            $interruptedShutdownEvidenceKind,
            $shutdownFailureEvidenceKind,
            $unexpectedExitEvidenceKind
        )
    ) {
        throw "Recovery snapshot reason does not match its evidence kind."
    }
    if (-not (Test-Path -LiteralPath $incidentsDirectory)) {
        New-Item -ItemType Directory -Path $incidentsDirectory -Force | Out-Null
    }
    Assert-NotReparseDirectory -Path $incidentsDirectory
    $location = Get-RecoveryIncidentLocation -State $Evidence.State -Snapshot $Snapshot
    if (-not (Test-Path -LiteralPath $location.Directory)) {
        New-Item -ItemType Directory -Path $location.Directory -ErrorAction Stop | Out-Null
    }
    Assert-NotReparseDirectory -Path $location.Directory
    if (Test-Path -LiteralPath $location.RecordPath) {
        $existing = Read-AuthenticatedRecoveryIncident `
            -State $Evidence.State `
            -Snapshot $Snapshot
        if (
            $existing.Evidence.ControlSha256 -ne $Evidence.ControlSha256 -or
            $existing.Evidence.RequestedSha256 -ne $Evidence.RequestedSha256 -or
            $existing.Evidence.TerminalSha256 -ne $Evidence.TerminalSha256 -or
            $existing.Record.state -ne "pre_termination"
        ) {
            throw "Recovery incident record conflicts with this recovery authority."
        }
        return $existing
    }
    Publish-ExactRecoveryEvidenceCopy `
        -Source $controlFile `
        -Destination (Assert-DirectChildPath `
            -Parent $location.Directory `
            -Child (Join-Path $location.Directory "control-state.json")) `
        -ExpectedSha256 $Evidence.ControlSha256 `
        -Description "Process control state"
    $archivedRequestedPath = Assert-DirectChildPath `
        -Parent $location.Directory `
        -Child (Join-Path $location.Directory "requested-receipt.json")
    $archivedTerminalPath = Assert-DirectChildPath `
        -Parent $location.Directory `
        -Child (Join-Path $location.Directory "terminal-receipt.json")
    if ($Evidence.Kind -eq $shutdownFailureEvidenceKind) {
        Publish-ExactRecoveryEvidenceCopy `
            -Source (Get-ReceiptPath -State $Evidence.State -Phase "requested") `
            -Destination $archivedRequestedPath `
            -ExpectedSha256 $Evidence.RequestedSha256 `
            -Description "Shutdown request receipt"
        Publish-ExactRecoveryEvidenceCopy `
            -Source (Get-ReceiptPath -State $Evidence.State -Phase "terminal") `
            -Destination $archivedTerminalPath `
            -ExpectedSha256 $Evidence.TerminalSha256 `
            -Description "Shutdown terminal receipt"
    } elseif ($Evidence.Kind -eq $interruptedShutdownEvidenceKind) {
        Publish-ExactRecoveryEvidenceCopy -Source (Get-ReceiptPath -State $Evidence.State -Phase "requested") -Destination $archivedRequestedPath -ExpectedSha256 $Evidence.RequestedSha256 -Description "Shutdown request receipt"
        Assert-RecoveryPathAbsent -Path (Get-ReceiptPath -State $Evidence.State -Phase "terminal") -Description "Interrupted shutdown terminal receipt"
        Assert-RecoveryPathAbsent -Path $archivedTerminalPath -Description "Archived interrupted shutdown terminal receipt"
    } else {
        foreach ($phase in @("requested", "terminal")) {
            Assert-RecoveryPathAbsent `
                -Path (Get-ReceiptPath -State $Evidence.State -Phase $phase) `
                -Description "Unexpected-exit shutdown $phase receipt"
        }
        Assert-RecoveryPathAbsent `
            -Path $archivedRequestedPath `
            -Description "Archived unexpected-exit shutdown requested receipt"
        Assert-RecoveryPathAbsent `
            -Path $archivedTerminalPath `
            -Description "Archived unexpected-exit shutdown terminal receipt"
    }
    Publish-ExactRecoveryEvidenceCopy `
        -Source $Snapshot.ManifestPath `
        -Destination (Assert-DirectChildPath `
            -Parent $location.Directory `
            -Child (Join-Path $location.Directory "recovery-manifest.json")) `
        -ExpectedSha256 $Snapshot.ManifestSha256 `
        -Description "Recovery snapshot manifest"
    $record = New-RecoveryIncidentRecord `
        -Location $location `
        -Evidence $Evidence `
        -Snapshot $Snapshot
    Write-NewRecoveryIncidentRecord -Location $location -Record $record
    return Read-AuthenticatedRecoveryIncident -State $Evidence.State -Snapshot $Snapshot
}

function Set-RecoveryIncidentState {
    param(
        [Parameter(Mandatory = $true)]$Incident,
        [Parameter(Mandatory = $true)]$Snapshot,
        [Parameter(Mandatory = $true)][string[]]$ExpectedStates,
        [ValidateSet("postconditions_verified", "recovered")]
        [string]$NewState
    )
    $current = Read-AuthenticatedRecoveryIncident `
        -State $Incident.Evidence.State `
        -Snapshot $Snapshot
    if ($current.Record.state -eq $NewState) {
        return $current
    }
    if ($current.Record.state -notin $ExpectedStates) {
        throw "Recovery incident state is not eligible for transition."
    }
    $record = New-RecoveryIncidentRecord `
        -Location $current `
        -Evidence $current.Evidence `
        -Snapshot $Snapshot `
        -State $NewState
    Write-ReplacementRecoveryIncidentRecord -Location $current -Record $record
    $updated = Read-AuthenticatedRecoveryIncident `
        -State $current.Evidence.State `
        -Snapshot $Snapshot
    if ($updated.Record.state -ne $NewState) {
        throw "Recovery incident state transition did not persist."
    }
    return $updated
}

function Wait-ForExactProcessExit {
    param([Parameter(Mandatory = $true)]$State)
    $deadline = [DateTime]::UtcNow.AddSeconds([Math]::Min($TimeoutSeconds, 30))
    while ([DateTime]::UtcNow -lt $deadline) {
        $process = Get-Process -Id ([int]$State.processId) -ErrorAction SilentlyContinue
        if ($null -eq $process) {
            return
        }
        [void](Get-ManagedProcess -State $State)
        Start-Sleep -Milliseconds 100
    }
    throw "Managed process did not exit after exact PID termination."
}

function New-ApplicationWriterLeaseHolderStartInfo {
    $startInfo = New-Object System.Diagnostics.ProcessStartInfo
    $startInfo.FileName = $nodePath
    $startInfo.Arguments = ('"' + $writerLeaseProbeScript + '"')
    $startInfo.WorkingDirectory = $projectDirectory
    $startInfo.UseShellExecute = $false
    $startInfo.CreateNoWindow = $true
    $startInfo.RedirectStandardInput = $true
    $startInfo.RedirectStandardOutput = $true
    $startInfo.RedirectStandardError = $true
    $startInfo.EnvironmentVariables.Clear()
    $startInfo.EnvironmentVariables["MYDASHBOARD_WRITER_LEASE_PROJECT_DIGEST"] = $projectDigest
    $startInfo.EnvironmentVariables["MYDASHBOARD_WRITER_LEASE_HOLD"] = "1"
    foreach ($name in @("SystemRoot", "WINDIR")) {
        $value = [Environment]::GetEnvironmentVariable($name, [EnvironmentVariableTarget]::Process)
        if (-not [string]::IsNullOrWhiteSpace($value)) {
            $startInfo.EnvironmentVariables[$name] = $value
        }
    }
    return $startInfo
}

function Open-ApplicationWriterLease {
    $holder = [System.Diagnostics.Process]::Start(
        (New-ApplicationWriterLeaseHolderStartInfo)
    )
    try {
        if ($null -eq $holder) {
            throw "Application writer lease holder did not start safely."
        }
        $readTask = $holder.StandardOutput.ReadLineAsync()
        if (-not $readTask.Wait(5000)) {
            throw "Application writer lease holder did not acquire safely."
        }
        $output = [string]$readTask.Result
        if ([string]::IsNullOrWhiteSpace($output) -or $output.Length -gt 1024) {
            throw "Application writer lease holder returned invalid data."
        }
        $result = ConvertFrom-ExactJson -Json $output
        if ($result.ok -ne $true) {
            throw "Application writer lease is not free."
        }
        $properties = @($result.PSObject.Properties.Name | Sort-Object)
        if (
            (Compare-Object `
                -ReferenceObject @("holding", "ok", "schemaVersion") `
                -DifferenceObject $properties) -or
            $result.schemaVersion -ne 1 -or
            $result.holding -ne $true -or
            $holder.HasExited
        ) {
            throw "Application writer lease holder returned invalid data."
        }
        return $holder
    } catch {
        $failure = $_
        if ($null -ne $holder) {
            try {
                if (-not $holder.HasExited) {
                    $holder.StandardInput.Close()
                    if (-not $holder.WaitForExit(500)) {
                        $holder.Kill()
                        [void]$holder.WaitForExit(1000)
                    }
                }
            } catch {
                if (-not $holder.HasExited) {
                    $holder.Kill()
                    [void]$holder.WaitForExit(1000)
                }
            } finally {
                $holder.Dispose()
            }
        }
        throw $failure
    }
}

function Close-ApplicationWriterLease {
    param([Parameter(Mandatory = $true)]$Holder)
    try {
        if (-not $Holder.HasExited) {
            $Holder.StandardInput.Close()
            if (-not $Holder.WaitForExit(5000)) {
                $Holder.Kill()
                if (-not $Holder.WaitForExit(1000)) {
                    throw "Application writer lease holder did not release safely."
                }
                throw "Application writer lease holder required forced release."
            }
        }
        $remainingOutput = $Holder.StandardOutput.ReadToEnd()
        $errorOutput = $Holder.StandardError.ReadToEnd()
        if (
            $remainingOutput.Length -gt 1024 -or
            $errorOutput.Length -gt 1024 -or
            -not [string]::IsNullOrEmpty($remainingOutput) -or
            -not [string]::IsNullOrEmpty($errorOutput) -or
            $Holder.ExitCode -ne 0
        ) {
            throw "Application writer lease holder did not close cleanly."
        }
    } finally {
        $Holder.Dispose()
    }
}

function Remove-ExactShutdownReceipts {
    param(
        [Parameter(Mandatory = $true)]$Evidence,
        [Parameter(Mandatory = $true)]$Incident,
        [Parameter(Mandatory = $true)]$Snapshot
    )
    if ($Evidence.Kind -in @($unexpectedExitEvidenceKind, $interruptedShutdownEvidenceKind)) {
        Assert-OrInvalidateUnexpectedExitRecoveryAuthority `
            -Authority $Incident `
            -State $Evidence.State `
            -Snapshot $Snapshot
    }
    foreach ($phase in @("requested", "terminal")) {
        $path = Get-ReceiptPath -State $Evidence.State -Phase $phase
        $expectedHash = if ($phase -eq "requested") {
            $Evidence.RequestedSha256
        } else {
            $Evidence.TerminalSha256
        }
        $tombstone = Assert-DirectChildPath `
            -Parent $Incident.Directory `
            -Child (Join-Path $Incident.Directory "$phase-receipt-removal.tmp")
        if ($Evidence.Kind -eq $unexpectedExitEvidenceKind -or
            ($Evidence.Kind -eq $interruptedShutdownEvidenceKind -and $phase -eq "terminal")) {
            Assert-OrInvalidateUnexpectedExitRecoveryAuthority `
                -Authority $Incident `
                -State $Evidence.State `
                -Snapshot $Snapshot
            $expectedAbsentHash = Get-AbsentRecoveryReceiptSha256 `
                -State $Evidence.State `
                -Phase $phase
            if ($expectedHash -ne $expectedAbsentHash) {
                throw "Unexpected-exit receipt absence authority changed."
            }
            continue
        }
        if ($Evidence.Kind -notin @($shutdownFailureEvidenceKind, $interruptedShutdownEvidenceKind)) {
            throw "Recovery evidence kind is invalid during receipt cleanup."
        }
        $pathExists = Test-Path -LiteralPath $path
        $tombstoneExists = Test-Path -LiteralPath $tombstone
        if ($pathExists -and $tombstoneExists) {
            throw "Shutdown receipt removal has conflicting active and tombstone files."
        }
        if ($tombstoneExists) {
            [void](Read-ShutdownReceiptFromPath `
                -State $Evidence.State `
                -Phase $phase `
                -Path $tombstone)
            if ((Get-BoundedSha256 -Path $tombstone -Description "Shutdown receipt tombstone") -ne $expectedHash) {
                throw "Shutdown receipt tombstone changed during identity-bound removal."
            }
            Remove-Item -LiteralPath $tombstone -Force
            continue
        }
        if (-not $pathExists) {
            continue
        }
        [void](Read-ShutdownReceiptFromPath `
            -State $Evidence.State `
            -Phase $phase `
            -Path $path)
        if ((Get-BoundedSha256 -Path $path -Description "Shutdown receipt") -ne $expectedHash) {
            throw "Shutdown receipt changed before identity-bound removal."
        }
        [System.IO.File]::Move($path, $tombstone)
        if ((Get-BoundedSha256 -Path $tombstone -Description "Shutdown receipt tombstone") -ne $expectedHash) {
            throw "Shutdown receipt changed during identity-bound removal."
        }
        Remove-Item -LiteralPath $tombstone -Force
    }
}

function Open-UnexpectedExitReceiptBarriers {
    param(
        [Parameter(Mandatory = $true)]$Incident,
        [Parameter(Mandatory = $true)]$Snapshot
    )
    $state = $Incident.Evidence.State
    Assert-OrInvalidateUnexpectedExitRecoveryAuthority `
        -Authority $Incident `
        -State $state `
        -Snapshot $Snapshot
    $streams = @()
    try {
        foreach ($phase in @("requested", "terminal")) {
            $path = Get-ReceiptPath -State $state -Phase $phase
            $parent = [System.IO.Path]::GetDirectoryName($path)
            Assert-NotReparseDirectory -Path $parent
            $options = (
                [System.IO.FileOptions]::WriteThrough -bor
                [System.IO.FileOptions]::DeleteOnClose
            )
            $stream = New-Object System.IO.FileStream(
                $path,
                [System.IO.FileMode]::CreateNew,
                [System.IO.FileAccess]::Write,
                [System.IO.FileShare]::None,
                4096,
                $options
            )
            $stream.Flush($true)
            $streams += $stream
        }
        return $streams
    } catch {
        foreach ($stream in $streams) {
            $stream.Dispose()
        }
        Invalidate-UnexpectedExitRecoveryAuthority `
            -Authority $Incident `
            -State $state `
            -Snapshot $Snapshot
    }
}

function Close-UnexpectedExitReceiptBarriers {
    param(
        [Parameter(Mandatory = $true)][object[]]$Streams,
        [Parameter(Mandatory = $true)]$State
    )
    $failure = $null
    for ($index = $Streams.Count - 1; $index -ge 0; $index -= 1) {
        try {
            $Streams[$index].Dispose()
        } catch {
            if ($null -eq $failure) {
                $failure = $_
            }
        }
    }
    foreach ($phase in @("requested", "terminal")) {
        try {
            Assert-RecoveryPathAbsent `
                -Path (Get-ReceiptPath -State $State -Phase $phase) `
                -Description "Unexpected-exit shutdown $phase receipt barrier"
        } catch {
            if ($null -eq $failure) {
                $failure = $_
            }
        }
    }
    if ($null -ne $failure) {
        throw $failure
    }
}

function Recover-FailedShutdown {
    param([Parameter(Mandatory = $true)][string]$SnapshotId)
    $state = Read-ControlState
    if ($null -eq $state) {
        throw "No authenticated failed-shutdown control state is available for recovery."
    }
    if ([int]$state.port -ne (Get-ConfiguredPort)) {
        throw "Authenticated control state does not match the configured port."
    }
    $snapshot = Get-ValidatedRecoverySnapshot -SnapshotId $SnapshotId
    $process = Get-ManagedProcess -State $state
    if ($null -ne $process) {
        if ($snapshot.Reason -ne $shutdownFailureRecoveryReason) {
            throw "Unexpected-exit recovery authority cannot terminate a live process."
        }
        $evidence = Get-AuthenticatedRecoveryEvidence -State $state
        if (Test-LoopbackTcpListener -Port ([int]$state.port)) {
            throw "The controlled port is occupied or its probe was ambiguous."
        }
        if (-not (Test-NoManagedDescendants -ProcessId ([int]$state.processId))) {
            throw "Managed process has live descendants; refusing recovery termination."
        }
        $incident = Publish-RecoveryIncident -Evidence $evidence -Snapshot $snapshot
        $snapshot = Get-ValidatedRecoverySnapshot -SnapshotId $SnapshotId
        if (Test-LoopbackTcpListener -Port ([int]$evidence.State.port)) {
            throw "Recovery pre-termination listener verification changed."
        }
        if (-not (Test-NoManagedDescendants -ProcessId ([int]$evidence.State.processId))) {
            throw "Managed process descendants changed during recovery preflight."
        }
        $evidence = Assert-SameRecoveryEvidence -Evidence $evidence
        $process = Get-ManagedProcess -State $evidence.State
        if ($null -eq $process) {
            throw "Recovery pre-termination process identity changed."
        }
        Stop-Process -Id ([int]$evidence.State.processId) -ErrorAction Stop
        Wait-ForExactProcessExit -State $evidence.State
    } else {
        $incident = Read-AuthenticatedRecoveryIncident -State $state -Snapshot $snapshot
        $evidence = $incident.Evidence
    }
    if ($null -ne (Get-ManagedProcess -State $evidence.State)) {
        throw "Managed process remained present after recovery process resolution."
    }
    if (Test-LoopbackTcpListener -Port ([int]$evidence.State.port)) {
        throw "Controlled port remained occupied after recovery termination."
    }
    if (-not (Test-NoManagedDescendants -ProcessId ([int]$evidence.State.processId))) {
        throw "Managed process descendants remained after recovery process resolution."
    }
    $writerLease = $null
    $receiptBarriers = @()
    try {
        $writerLease = Open-ApplicationWriterLease
        $snapshot = Get-ValidatedRecoverySnapshot -SnapshotId $SnapshotId
        if ($incident.Record.state -eq "pre_termination") {
            $incident = Set-RecoveryIncidentState `
                -Incident $incident `
                -Snapshot $snapshot `
                -ExpectedStates @("pre_termination") `
                -NewState "postconditions_verified"
        }
        $evidence = $incident.Evidence
        Remove-ExactShutdownReceipts `
            -Evidence $evidence `
            -Incident $incident `
            -Snapshot $snapshot
        if ($incident.Record.state -eq "postconditions_verified") {
            $incident = Set-RecoveryIncidentState `
                -Incident $incident `
                -Snapshot $snapshot `
                -ExpectedStates @("postconditions_verified") `
                -NewState "recovered"
        }
        $incident = Read-AuthenticatedRecoveryIncident `
            -State $incident.Evidence.State `
            -Snapshot $snapshot
        $evidence = $incident.Evidence
        if ($evidence.Kind -in @($unexpectedExitEvidenceKind, $interruptedShutdownEvidenceKind)) {
            $receiptBarriers = @(
                Open-UnexpectedExitReceiptBarriers `
                    -Incident $incident `
                    -Snapshot $snapshot
            )
        }
        Remove-ControlState -ExpectedState $evidence.State
    } finally {
        try {
            if ($receiptBarriers.Count -gt 0) {
                Close-UnexpectedExitReceiptBarriers `
                    -Streams $receiptBarriers `
                    -State $evidence.State
            }
        } finally {
            if ($null -ne $writerLease) {
                Close-ApplicationWriterLease -Holder $writerLease
            }
        }
    }
    Write-Output "Failed-shutdown incident $($incident.Id) was archived; MyDashboard remains stopped."
}

function Assert-OfflineRestoreAllowed {
    $state = Read-ControlState
    if ($null -ne $state) {
        if ($null -ne (Get-ManagedProcess -State $state)) {
            throw "MyDashboard must be stopped before offline restore."
        }
        if (-not (Complete-SuccessfulShutdown -State $state)) {
            throw "Managed process outcome is not durably successful; refusing offline restore."
        }
    }
    $port = Get-ConfiguredPort
    if (Test-LoopbackTcpListener -Port $port) {
        throw "The configured port has a listener; refusing offline restore."
    }
}

function Invoke-OfflineRestore {
    param(
        [Parameter(Mandatory = $true)]
        [ValidateSet("Recover", "Activate")]
        [string]$Mode,
        [string]$RequestedBackupId
    )
    if (-not (Test-Path -LiteralPath $offlineRestoreScript -PathType Leaf)) {
        throw "The offline restore helper is unavailable."
    }
    Assert-RegularManagedFile `
        -Path $offlineRestoreScript `
        -Description "Offline restore helper"
    if (
        $Mode -eq "Activate" -and
        [string]$RequestedBackupId -notmatch '^backup-[a-f0-9]{64}$'
    ) {
        throw "BackupId must be one content-addressed backup identifier."
    }
    $environment = @{
        MYDASHBOARD_OFFLINE_RESTORE_PROJECT_DIGEST = $projectDigest
        MYDASHBOARD_OFFLINE_RESTORE_AUTHORITY = "manager-v1"
    }
    $previous = @{}
    foreach ($name in $environment.Keys) {
        $previous[$name] = [Environment]::GetEnvironmentVariable(
            $name,
            [EnvironmentVariableTarget]::Process
        )
        [Environment]::SetEnvironmentVariable(
            $name,
            [string]$environment[$name],
            [EnvironmentVariableTarget]::Process
        )
    }
    $output = ""
    $helperExitCode = -1
    try {
        $arguments = if ($Mode -eq "Recover") {
            @($offlineRestoreScript, "--recover")
        } else {
            @($offlineRestoreScript, "--activate", $RequestedBackupId)
        }
        $output = & $nodePath @arguments | Out-String
        $helperExitCode = $LASTEXITCODE
    } finally {
        foreach ($name in $environment.Keys) {
            [Environment]::SetEnvironmentVariable(
                $name,
                $previous[$name],
                [EnvironmentVariableTarget]::Process
            )
        }
    }
    try {
        $result = ConvertFrom-ExactJson -Json $output
    } catch {
        throw "The offline restore helper returned invalid data."
    }
    $properties = @($result.PSObject.Properties.Name | Sort-Object)
    if (
        $result.schemaVersion -ne 1 -or
        $result.ok -ne $true -or
        $helperExitCode -ne 0 -or
        (Compare-Object `
            -ReferenceObject @("action", "ok", "result", "schemaVersion") `
            -DifferenceObject $properties)
    ) {
        $code = if (
            $null -ne $result.error -and
            [string]$result.error.code -match '^[A-Z][A-Z0-9_]{2,63}$'
        ) {
            [string]$result.error.code
        } else {
            "OFFLINE_RESTORE_FAILED"
        }
        throw "Offline restore failed safely ($code)."
    }
    return $result
}

function Invoke-OfflineRestoreRecoveryIfPresent {
    if (-not (Test-Path -LiteralPath $restoreControlDirectory)) {
        return
    }
    Assert-NotReparseDirectory -Path $restoreControlDirectory
    Assert-OfflineRestoreAllowed
    [void](Invoke-OfflineRestore -Mode Recover)
}

function Initialize-WindowsLauncher {
    if (-not ("MyDashboard.DetachedLauncher" -as [type])) {
        Add-Type -TypeDefinition @'
using System;
using System.ComponentModel;
using System.Runtime.InteropServices;
using System.Text;

namespace MyDashboard {
    public static class DetachedLauncher {
        [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
        private struct StartupInfo {
            public uint Size;
            public string Reserved, Desktop, Title;
            public uint X, Y, Width, Height, CharacterWidth, CharacterHeight, Fill, Flags;
            public ushort ShowWindow, ReservedSize;
            public IntPtr ReservedBytes, StandardInput, StandardOutput, StandardError;
        }
        [StructLayout(LayoutKind.Sequential)]
        private struct ProcessInfo {
            public IntPtr Process, Thread;
            public uint ProcessId, ThreadId;
        }
        [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
        private static extern bool CreateProcess(
            string application, StringBuilder command, IntPtr processAttributes,
            IntPtr threadAttributes, bool inheritHandles, uint flags,
            IntPtr environment, string directory, ref StartupInfo startup,
            out ProcessInfo process);
        [DllImport("kernel32.dll", SetLastError = true)]
        private static extern bool IsProcessInJob(IntPtr process, IntPtr job, out bool inJob);
        [DllImport("kernel32.dll", SetLastError = true)]
        private static extern uint ResumeThread(IntPtr thread);
        [DllImport("kernel32.dll", SetLastError = true)]
        private static extern uint WaitForSingleObject(IntPtr handle, uint milliseconds);
        [DllImport("kernel32.dll", SetLastError = true)]
        private static extern bool GetExitCodeProcess(IntPtr process, out uint exitCode);
        [DllImport("kernel32.dll", SetLastError = true)]
        private static extern bool TerminateProcess(IntPtr process, uint exitCode);
        [DllImport("kernel32.dll")]
        private static extern bool CloseHandle(IntPtr handle);

        private static string QuoteFilePath(string value) {
            // These arguments are file paths, never arbitrary command text.
            if (value.IndexOf('"') >= 0 || value.IndexOf('\0') >= 0 || value.EndsWith("\\"))
                throw new ArgumentException("Invalid launcher file path.");
            return "\"" + value + "\"";
        }

        public static void Run(string executable, string script, string result, string directory) {
            var command = new StringBuilder(
                QuoteFilePath(executable) + " " + QuoteFilePath(script) + " " + QuoteFilePath(result));
            var startup = new StartupInfo();
            startup.Size = (uint)Marshal.SizeOf(typeof(StartupInfo));
            ProcessInfo process;
            const uint createSuspended = 0x00000004;
            const uint createNewProcessGroup = 0x00000200;
            const uint createBreakawayFromJob = 0x01000000;
            const uint createNoWindow = 0x08000000;
            // Node's detached:true does not escape KILL_ON_JOB_CLOSE containers.
            // Start the launcher outside the command host's job, with no inherited handles.
            if (!CreateProcess(executable, command, IntPtr.Zero, IntPtr.Zero, false,
                createSuspended | createNewProcessGroup | createBreakawayFromJob | createNoWindow,
                IntPtr.Zero, directory, ref startup, out process)) {
                throw new Win32Exception(Marshal.GetLastWin32Error(),
                    "Unable to detach MyDashboard launcher. Use a standalone terminal that permits job breakaway.");
            }
            try {
                bool inJob;
                if (!IsProcessInJob(process.Process, IntPtr.Zero, out inJob))
                    throw new Win32Exception(Marshal.GetLastWin32Error());
                // Check before executing any application code, including in nested jobs.
                if (inJob) throw new InvalidOperationException(
                    "MyDashboard launcher is still tied to a command job; refusing an unsafe start.");
                if (ResumeThread(process.Thread) == uint.MaxValue)
                    throw new Win32Exception(Marshal.GetLastWin32Error());
                uint wait = WaitForSingleObject(process.Process, 10000);
                if (wait == 258) throw new TimeoutException("The detached MyDashboard process launcher timed out.");
                if (wait != 0) throw new Win32Exception(Marshal.GetLastWin32Error());
                uint exitCode;
                if (!GetExitCodeProcess(process.Process, out exitCode))
                    throw new Win32Exception(Marshal.GetLastWin32Error());
                if (exitCode != 0) throw new InvalidOperationException("The detached MyDashboard process launcher failed.");
            } catch {
                // This handle belongs only to the short launcher created above, never a listener.
                TerminateProcess(process.Process, 1);
                throw;
            } finally {
                CloseHandle(process.Thread);
                CloseHandle(process.Process);
            }
        }
    }
}
'@
    }
}

function Invoke-Launcher {
    param(
        [Parameter(Mandatory = $true)][string]$ResultPath,
        [Parameter(Mandatory = $true)][string]$Token
    )
    if ($isWindowsRuntime) {
        # Compile native interop before placing control credentials in the environment.
        Initialize-WindowsLauncher
    }
    $environment = @{
        MYDASHBOARD_MANAGED_TOKEN = $Token
        MYDASHBOARD_MANAGED_RUNTIME_DIRECTORY = $runtimeDirectory
        MYDASHBOARD_MANAGED_PROJECT_DIGEST = $projectDigest
        # Startup may wait longer for durable state recovery. Once live, the
        # child still requires an authenticated claim within the original cap.
        MYDASHBOARD_MANAGED_CLAIM_TIMEOUT_MS = [string]([Math]::Min(
            120000,
            [Math]::Max(5000, $TimeoutSeconds * 1000)
        ))
        MYDASHBOARD_MANAGED_LOG_DIRECTORY = $runtimeLogDirectory
    }
    $previous = @{}
    foreach ($name in $environment.Keys) {
        $previous[$name] = [Environment]::GetEnvironmentVariable(
            $name,
            [EnvironmentVariableTarget]::Process
        )
        [Environment]::SetEnvironmentVariable(
            $name,
            [string]$environment[$name],
            [EnvironmentVariableTarget]::Process
        )
    }
    try {
        if ($isWindowsRuntime) {
            [MyDashboard.DetachedLauncher]::Run(
                $nodePath, $launcherScript, $ResultPath, $projectDirectory
            )
        } else {
            & $nodePath $launcherScript $ResultPath
            if ($LASTEXITCODE -ne 0) {
                throw "The detached MyDashboard process launcher failed."
            }
        }
    } finally {
        foreach ($name in $environment.Keys) {
            [Environment]::SetEnvironmentVariable(
                $name,
                $previous[$name],
                [EnvironmentVariableTarget]::Process
            )
        }
    }
}

function Start-ManagedServer {
    $port = Get-ConfiguredPort
    $existingState = Read-ControlState
    if ($null -ne $existingState) {
        $managed = Get-ManagedProcess -State $existingState
        if ($null -ne $managed) {
            $liveness = Get-Liveness -Port ([int]$existingState.port)
            if (-not (Test-MatchingLiveness `
                -Liveness $liveness `
                -State $existingState `
                -LifecycleState "running")) {
                throw "The managed process is alive but does not expose matching running liveness."
            }
            return [pscustomobject]@{
                Port = [int]$existingState.port
                Message = "MyDashboard is already running at http://127.0.0.1:$($existingState.port)."
            }
        }
        if (-not (Complete-SuccessfulShutdown -State $existingState)) {
            throw "Recorded MyDashboard is dead without a durable success receipt; refusing a new writer."
        }
    }

    if (Test-LoopbackTcpListener -Port $port) {
        throw "Port $port already has an unmanaged listener; refusing to replace it."
    }

    $token = New-ControlToken
    $launchResult = Assert-DirectChildPath `
        -Parent $runtimeDirectory `
        -Child (Join-Path $runtimeDirectory "mydashboard-launch-result-$PID-$([guid]::NewGuid().ToString('N')).json")
    $state = $null
    $controlWritten = $false
    try {
        try {
            Invoke-Launcher -ResultPath $launchResult -Token $token
            if (-not (Test-Path -LiteralPath $launchResult)) {
                throw "The detached MyDashboard process launcher returned no identity."
            }
            Assert-RegularManagedFile `
                -Path $launchResult `
                -Description "Detached launch identity"
            $launch = ConvertFrom-ExactJson -Json (
                Get-Content -LiteralPath $launchResult -Raw
            )
        } finally {
            Remove-Item -LiteralPath $launchResult -Force -ErrorAction SilentlyContinue
        }
        $launchProperties = @($launch.PSObject.Properties.Name | Sort-Object)
        if (
            (Compare-Object `
                -ReferenceObject @(
                    "hmac",
                    "instanceId",
                    "processId",
                    "projectDigest",
                    "schemaVersion",
                    "startIdentity"
                ) `
                -DifferenceObject $launchProperties) -or
            $launch.schemaVersion -ne 2 -or
            ($launch.processId -isnot [int] -and $launch.processId -isnot [long]) -or
            [int]$launch.processId -lt 1 -or
            [string]$launch.instanceId -notmatch `
                '^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$' -or
            [string]$launch.startIdentity -notmatch '^[a-f0-9]{64}$' -or
            [string]$launch.hmac -notmatch '^[A-Za-z0-9+/]{43}=$' -or
            [string]$launch.projectDigest -ne $projectDigest
        ) {
            throw "The detached MyDashboard process launcher returned invalid identity."
        }
        $expectedLaunchHmac = Get-HmacBase64 `
            -Token $token `
            -Payload (Get-LaunchPayload -Launch $launch)
        if (-not (Test-FixedTimeString `
            -Left $expectedLaunchHmac `
            -Right ([string]$launch.hmac))) {
            throw "The detached MyDashboard process launcher identity was not authenticated."
        }
        $process = Get-Process -Id ([int]$launch.processId) -ErrorAction Stop
        if (
            [string]::IsNullOrWhiteSpace($process.Path) -or
            -not $pathComparer.Equals(
                [System.IO.Path]::GetFullPath($process.Path),
                $nodePath
            )
        ) {
            throw "The detached MyDashboard process has an unexpected executable."
        }
        $state = [ordered]@{
            schemaVersion = 2
            processId = $process.Id
            processStartTimeUtcTicks = [string]($process.StartTime.ToUniversalTime().Ticks)
            nodePath = $nodePath
            projectDirectory = $projectDirectory
            serverScript = $serverScript
            port = $port
            instanceId = [string]$launch.instanceId
            startIdentity = [string]$launch.startIdentity
            projectDigest = $projectDigest
            controlToken = $token
            controlHmac = ""
        }
        $state.controlHmac = Get-HmacBase64 `
            -Token $token `
            -Payload (Get-ControlPayload -State ([pscustomobject]$state))
        Wait-ForMatchingLiveness `
            -State ([pscustomobject]$state) `
            -LifecycleState "pending_claim" | Out-Null
        Write-ControlState -State $state
        $controlWritten = $true
        Invoke-ManagedClaim -State ([pscustomobject]$state)
        Wait-ForMatchingLiveness `
            -State ([pscustomobject]$state) `
            -LifecycleState "running" | Out-Null
    } catch {
        $startError = $_
        if ($null -ne $state) {
            try {
                Invoke-ManagedShutdownRequest -State ([pscustomobject]$state)
                Wait-ForShutdownOutcome -State ([pscustomobject]$state) | Out-Null
                if ($controlWritten) {
                    Remove-ControlState -ExpectedState ([pscustomobject]$state)
                }
                Remove-ShutdownReceipts -State ([pscustomobject]$state)
            } catch {
                # The child owns a pending-claim watchdog. Never force-kill an
                # identity whose authenticated graceful outcome is unknown.
            }
        }
        throw $startError
    }
    return [pscustomobject]@{
        Port = $port
        Message = "MyDashboard started at http://127.0.0.1:$port."
    }
}

function Stop-ManagedServer {
    $state = Read-ControlState
    if ($null -eq $state) {
        throw "No managed MyDashboard process is recorded; refusing to stop an arbitrary listener."
    }
    $process = Get-ManagedProcess -State $state
    if ($null -eq $process) {
        if (Complete-SuccessfulShutdown -State $state) {
            Write-Output "MyDashboard stopped gracefully."
            return
        }
        $terminal = Read-ShutdownReceipt -State $state -Phase "terminal"
        if ($null -ne $terminal -and $terminal.status -eq "failure") {
            throw "MyDashboard previously reported a shutdown failure; control state was retained."
        }
        throw "MyDashboard is dead without a durable success receipt; control state was retained."
    }
    $liveness = Get-Liveness -Port ([int]$state.port)
    if (-not (Test-MatchingLiveness -Liveness $liveness -State $state)) {
        throw "The recorded process does not expose matching MyDashboard identity; refusing to stop it."
    }
    Invoke-ManagedShutdownRequest -State $state
    Wait-ForShutdownOutcome -State $state | Out-Null
    Remove-ControlState -ExpectedState $state
    Remove-ShutdownReceipts -State $state
    Write-Output "MyDashboard stopped gracefully."
}

function Show-ManagedStatus {
    $state = Read-ControlState
    if ($null -eq $state) {
        $port = Get-ConfiguredPort
        if (Test-LoopbackTcpListener -Port $port) {
            return [pscustomobject]@{
                Code = 4
                Message = "MyDashboard has an unmanaged listener at http://127.0.0.1:$port."
            }
        }
        return [pscustomobject]@{ Code = 3; Message = "MyDashboard is stopped." }
    }
    $process = Get-ManagedProcess -State $state
    if ($null -eq $process) {
        $terminal = Read-ShutdownReceipt -State $state -Phase "terminal"
        $outcome = if ($null -eq $terminal) { "unknown" } else { $terminal.status }
        return [pscustomobject]@{
            Code = 6
            Message = "MyDashboard is stopped with retained $outcome control state."
        }
    }
    $liveness = Get-Liveness -Port ([int]$state.port)
    if (-not (Test-MatchingLiveness -Liveness $liveness -State $state)) {
        return [pscustomobject]@{
            Code = 5
            Message = "MyDashboard process exists but its authenticated identity does not match."
        }
    }
    if (-not (Test-ManagedReadiness -State $state)) {
        return [pscustomobject]@{
            Code = 5
            Message = "MyDashboard is running but readiness could not be confirmed safely."
        }
    }
    return [pscustomobject]@{
        Code = 0
        Message = "MyDashboard is running at http://127.0.0.1:$($state.port) (PID $($process.Id))."
    }
}

if ($Action -ne "Restore" -and -not [string]::IsNullOrWhiteSpace($BackupId)) {
    throw "BackupId is valid only for the Restore action."
}
if ($Action -ne "RecoverFailedShutdown" -and $PSBoundParameters.ContainsKey("RecoverySnapshotId")) {
    throw "RecoverySnapshotId is valid only for the RecoverFailedShutdown action."
}
if ($Action -eq "RecoverFailedShutdown" -and [string]::IsNullOrWhiteSpace($RecoverySnapshotId)) {
    throw "RecoverFailedShutdown requires one RecoverySnapshotId."
}
if ($Action -eq "Restore" -and $OpenBrowser) {
    throw "Restore leaves the service stopped and cannot open a browser."
}
if ($Action -eq "RecoverFailedShutdown" -and $OpenBrowser) {
    throw "RecoverFailedShutdown leaves the service stopped and cannot open a browser."
}
if ($Action -eq "PrepareFailedShutdownRecovery" -and $OpenBrowser) {
    throw "PrepareFailedShutdownRecovery leaves the service stopped and cannot open a browser."
}

$managerMutex = New-Object System.Threading.Mutex($false, $mutexName)
$managerMutexHeld = $false
$exitCode = 0
try {
    try {
        $managerMutexHeld = $managerMutex.WaitOne(
            [TimeSpan]::FromSeconds($TimeoutSeconds)
        )
    } catch [System.Threading.AbandonedMutexException] {
        $managerMutexHeld = $true
    }
    if (-not $managerMutexHeld) {
        throw "Another MyDashboard process operation did not finish before the timeout."
    }
    Initialize-PrivateRuntimeDirectory

    switch ($Action) {
        "Start" {
            Invoke-OfflineRestoreRecoveryIfPresent
            $started = Start-ManagedServer
            Write-Output $started.Message
            if ($OpenBrowser) {
                Start-Process "http://127.0.0.1:$($started.Port)"
            }
        }
        "Stop" {
            Stop-ManagedServer
        }
        "Restart" {
            Stop-ManagedServer
            Invoke-OfflineRestoreRecoveryIfPresent
            $started = Start-ManagedServer
            Write-Output $started.Message
            if ($OpenBrowser) {
                Start-Process "http://127.0.0.1:$($started.Port)"
            }
        }
        "Status" {
            $status = Show-ManagedStatus
            Write-Output $status.Message
            $exitCode = $status.Code
        }
        "Restore" {
            Assert-OfflineRestoreAllowed
            $restored = Invoke-OfflineRestore `
                -Mode Activate `
                -RequestedBackupId $BackupId
            Write-Output "MyDashboard restored $($restored.result.backupId); the service remains stopped."
        }
        "PrepareFailedShutdownRecovery" {
            Prepare-FailedShutdownRecovery
        }
        "RecoverFailedShutdown" {
            Recover-FailedShutdown -SnapshotId $RecoverySnapshotId
        }
    }
} finally {
    if ($managerMutexHeld) {
        $managerMutex.ReleaseMutex()
    }
    $managerMutex.Dispose()
}
exit $exitCode
