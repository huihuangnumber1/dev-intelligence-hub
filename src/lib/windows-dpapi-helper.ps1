$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
$utf8 = [Text.UTF8Encoding]::new($false, $true)
[Console]::InputEncoding = $utf8
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
$data = $null
$output = $null
try {
    $stream = [Console]::OpenStandardInput()
    $buffer = [byte[]]::new(4096)
    $memory = [IO.MemoryStream]::new()
    try {
        while (($count = $stream.Read($buffer, 0, $buffer.Length)) -gt 0) {
            if ($memory.Length + $count -gt 131072) { throw 'packet limit' }
            $memory.Write($buffer, 0, $count)
        }
        $packet = $utf8.GetString($memory.ToArray()) | ConvertFrom-Json
    } finally { $memory.Dispose() }
    $keys = @($packet.PSObject.Properties.Name | Sort-Object)
    if (($keys -join ',') -cne 'data,entropy,operation' -or $packet.operation -notin @('protect', 'unprotect')) { throw 'packet shape' }
    $data = [Convert]::FromBase64String([string]$packet.data)
    $entropy = [Convert]::FromBase64String([string]$packet.entropy)
    if ($data.Length -lt 1 -or $data.Length -gt 65536 -or $entropy.Length -lt 1 -or $entropy.Length -gt 1024) { throw 'data limit' }
    Add-Type -AssemblyName System.Security
    if ($packet.operation -ceq 'protect') {
        $output = [Security.Cryptography.ProtectedData]::Protect($data, $entropy, [Security.Cryptography.DataProtectionScope]::CurrentUser)
    } else {
        $output = [Security.Cryptography.ProtectedData]::Unprotect($data, $entropy, [Security.Cryptography.DataProtectionScope]::CurrentUser)
    }
    [Console]::Out.Write('{"ok":true,"data":"' + [Convert]::ToBase64String($output) + '"}')
} catch {
    [Console]::Out.Write('{"ok":false,"code":"DPAPI_OPERATION_FAILED"}')
    exit 1
} finally {
    if ($null -ne $data) { [Array]::Clear($data, 0, $data.Length) }
    if ($null -ne $output) { [Array]::Clear($output, 0, $output.Length) }
}
