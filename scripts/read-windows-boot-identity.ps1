$ErrorActionPreference = 'Stop'
try {
    $event = Get-WinEvent -FilterHashtable @{
        LogName = 'System'; ProviderName = 'Microsoft-Windows-Kernel-General'; Id = 12
    } -MaxEvents 1 -ErrorAction Stop
    $xml = [xml]$event.ToXml()
    $start = @($xml.Event.EventData.Data | Where-Object { $_.Name -eq 'StartTime' })
    if ($start.Count -ne 1) { throw 'Missing kernel boot time' }
    $started = [DateTimeOffset]::Parse($start[0].'#text').ToUniversalTime()
    $os = Get-CimInstance Win32_OperatingSystem -ErrorAction Stop
    if ([Math]::Abs(($os.LastBootUpTime.ToUniversalTime() - $started.UtcDateTime).TotalSeconds) -gt 2) {
        throw 'Boot records disagree'
    }
    $machine = [Guid](Get-ItemPropertyValue -LiteralPath 'HKLM:\SOFTWARE\Microsoft\Cryptography' -Name MachineGuid)
    $hardware = [Guid](Get-CimInstance Win32_ComputerSystemProduct -ErrorAction Stop).UUID
    if ($machine -eq [Guid]::Empty -or $hardware -eq [Guid]::Empty) { throw 'Missing machine identity' }
    $hash = [Security.Cryptography.SHA256]::Create()
    try {
        $bytes = [Text.Encoding]::UTF8.GetBytes($machine.ToString('D') + "`n" + $hardware.ToString('D'))
        $digest = ([BitConverter]::ToString($hash.ComputeHash($bytes))).Replace('-', '').ToLowerInvariant()
    } finally { $hash.Dispose() }
    [pscustomobject]@{
        schemaVersion = 1
        machineDigest = $digest
        startedAt = $started.UtcDateTime.ToString('yyyy-MM-ddTHH:mm:ss.fffZ')
        recordId = [long]$event.RecordId
    } | ConvertTo-Json -Compress
} catch {
    [Console]::Error.WriteLine('WINDOWS_BOOT_IDENTITY_UNAVAILABLE')
    exit 1
}
