param(
    [Parameter(Mandatory = $true)][string]$ProjectDirectory,
    [Parameter(Mandatory = $true)][string]$PowerShellPath,
    [Parameter(Mandatory = $true)][string]$ResultPath,
    [switch]$DenyBreakaway
)

$ErrorActionPreference = "Stop"
Add-Type -TypeDefinition @'
using System;
using System.ComponentModel;
using System.Runtime.InteropServices;

public static class ManagedLaunchTestJob {
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern IntPtr CreateJobObject(IntPtr attributes, string name);
    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool SetInformationJobObject(
        IntPtr job, int informationClass, IntPtr information, uint size);
    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);
    [DllImport("kernel32.dll")]
    private static extern IntPtr GetCurrentProcess();

    public static IntPtr Join(bool allowBreakaway) {
        IntPtr job = CreateJobObject(IntPtr.Zero, null);
        if (job == IntPtr.Zero) throw new Win32Exception();
        // JOBOBJECT_EXTENDED_LIMIT_INFORMATION has architecture-dependent padding.
        int size = IntPtr.Size == 8 ? 144 : 112;
        IntPtr limits = Marshal.AllocHGlobal(size);
        try {
            for (int index = 0; index < size; index++) Marshal.WriteByte(limits, index, 0);
            // KILL_ON_JOB_CLOSE, with optional BREAKAWAY_OK.
            Marshal.WriteInt32(limits, 16, allowBreakaway ? 0x2800 : 0x2000);
            if (!SetInformationJobObject(job, 9, limits, (uint)size))
                throw new Win32Exception();
            if (!AssignProcessToJobObject(job, GetCurrentProcess()))
                throw new Win32Exception();
            return job;
        } finally {
            Marshal.FreeHGlobal(limits);
        }
    }
}
'@

# Only this disposable test host joins the job. Its exit closes the job handle
# and reproduces command-host cleanup after the manager has reported success.
$jobHandle = [ManagedLaunchTestJob]::Join(-not $DenyBreakaway)
& $PowerShellPath -NoProfile -ExecutionPolicy Bypass -File (
    Join-Path $ProjectDirectory "scripts/Manage-MyDashboard.ps1"
) -Action Start -TimeoutSeconds 10
@{ managerExitCode = $LASTEXITCODE } | ConvertTo-Json | Set-Content -LiteralPath $ResultPath
exit 0
