[CmdletBinding()]
param([switch]$Interactive)

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

$nativeSource = @'
using System;
using System.Collections.Generic;
using System.ComponentModel;
using System.Diagnostics;
using System.IO;
using System.Runtime.InteropServices;
using System.Security.Cryptography;
using System.Text;
using System.Threading;

namespace MyDashboard
{
    public static class SupervisedWindowsProcess
    {
        private const uint CREATE_SUSPENDED = 0x00000004;
        private const uint CREATE_UNICODE_ENVIRONMENT = 0x00000400;
        private const uint CREATE_NO_WINDOW = 0x08000000;
        private const uint EXTENDED_STARTUPINFO_PRESENT = 0x00080000;
        private const int PROC_THREAD_ATTRIBUTE_JOB_LIST = 0x0002000d;
        private const uint STARTF_USESTDHANDLES = 0x00000100;
        private const uint JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE = 0x00002000;
        private const uint DUPLICATE_SAME_ACCESS = 0x00000002;
        private const uint GENERIC_READ = 0x80000000;
        private const uint FILE_SHARE_READ = 0x00000001;
        private const uint OPEN_EXISTING = 3;
        private const uint FILE_ATTRIBUTE_NORMAL = 0x00000080;
        private const uint WAIT_OBJECT_0 = 0;
        private const uint INFINITE = 0xffffffff;
        private const int STD_OUTPUT_HANDLE = -11;
        private const int STD_INPUT_HANDLE = -10;
        private const int STD_ERROR_HANDLE = -12;
        private static readonly IntPtr InvalidHandle = new IntPtr(-1);

        private enum JOBOBJECTINFOCLASS
        {
            JobObjectBasicAccountingInformation = 1,
            JobObjectExtendedLimitInformation = 9
        }

        [StructLayout(LayoutKind.Sequential)]
        private struct SECURITY_ATTRIBUTES
        {
            public int nLength;
            public IntPtr lpSecurityDescriptor;
            [MarshalAs(UnmanagedType.Bool)]
            public bool bInheritHandle;
        }

        [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
        private struct STARTUPINFO
        {
            public int cb;
            public string lpReserved;
            public string lpDesktop;
            public string lpTitle;
            public uint dwX;
            public uint dwY;
            public uint dwXSize;
            public uint dwYSize;
            public uint dwXCountChars;
            public uint dwYCountChars;
            public uint dwFillAttribute;
            public uint dwFlags;
            public short wShowWindow;
            public short cbReserved2;
            public IntPtr lpReserved2;
            public IntPtr hStdInput;
            public IntPtr hStdOutput;
            public IntPtr hStdError;
        }

        [StructLayout(LayoutKind.Sequential)]
        private struct PROCESS_INFORMATION
        {
            public IntPtr hProcess;
            public IntPtr hThread;
            public uint dwProcessId;
            public uint dwThreadId;
        }

        [StructLayout(LayoutKind.Sequential)]
        private struct STARTUPINFOEX
        {
            public STARTUPINFO StartupInfo;
            public IntPtr lpAttributeList;
        }

        [StructLayout(LayoutKind.Sequential)]
        private struct JOBOBJECT_BASIC_LIMIT_INFORMATION
        {
            public long PerProcessUserTimeLimit;
            public long PerJobUserTimeLimit;
            public uint LimitFlags;
            public UIntPtr MinimumWorkingSetSize;
            public UIntPtr MaximumWorkingSetSize;
            public uint ActiveProcessLimit;
            public UIntPtr Affinity;
            public uint PriorityClass;
            public uint SchedulingClass;
        }

        [StructLayout(LayoutKind.Sequential)]
        private struct IO_COUNTERS
        {
            public ulong ReadOperationCount;
            public ulong WriteOperationCount;
            public ulong OtherOperationCount;
            public ulong ReadTransferCount;
            public ulong WriteTransferCount;
            public ulong OtherTransferCount;
        }

        [StructLayout(LayoutKind.Sequential)]
        private struct JOBOBJECT_EXTENDED_LIMIT_INFORMATION
        {
            public JOBOBJECT_BASIC_LIMIT_INFORMATION BasicLimitInformation;
            public IO_COUNTERS IoInfo;
            public UIntPtr ProcessMemoryLimit;
            public UIntPtr JobMemoryLimit;
            public UIntPtr PeakProcessMemoryUsed;
            public UIntPtr PeakJobMemoryUsed;
        }

        [StructLayout(LayoutKind.Sequential)]
        private struct JOBOBJECT_BASIC_ACCOUNTING_INFORMATION
        {
            public long TotalUserTime;
            public long TotalKernelTime;
            public long ThisPeriodTotalUserTime;
            public long ThisPeriodTotalKernelTime;
            public uint TotalPageFaultCount;
            public uint TotalProcesses;
            public uint ActiveProcesses;
            public uint TotalTerminatedProcesses;
        }

        [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
        private static extern IntPtr CreateJobObject(IntPtr attributes, string name);

        [DllImport("kernel32.dll", SetLastError = true)]
        [return: MarshalAs(UnmanagedType.Bool)]
        private static extern bool SetInformationJobObject(
            IntPtr job,
            JOBOBJECTINFOCLASS infoClass,
            IntPtr info,
            uint infoLength);

        [DllImport("kernel32.dll", SetLastError = true)]
        [return: MarshalAs(UnmanagedType.Bool)]
        private static extern bool QueryInformationJobObject(
            IntPtr job,
            JOBOBJECTINFOCLASS infoClass,
            IntPtr info,
            uint infoLength,
            IntPtr returnLength);

        [DllImport("kernel32.dll", SetLastError = true)]
        [return: MarshalAs(UnmanagedType.Bool)]
        private static extern bool InitializeProcThreadAttributeList(
            IntPtr attributes, uint count, uint flags, ref IntPtr size);

        [DllImport("kernel32.dll", SetLastError = true)]
        [return: MarshalAs(UnmanagedType.Bool)]
        private static extern bool UpdateProcThreadAttribute(
            IntPtr attributes, uint flags, IntPtr attribute, IntPtr value,
            IntPtr size, IntPtr previousValue, IntPtr returnSize);

        [DllImport("kernel32.dll")]
        private static extern void DeleteProcThreadAttributeList(IntPtr attributes);

        [DllImport("kernel32.dll", SetLastError = true)]
        [return: MarshalAs(UnmanagedType.Bool)]
        private static extern bool TerminateJobObject(IntPtr job, uint exitCode);

        [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
        [return: MarshalAs(UnmanagedType.Bool)]
        private static extern bool CreateProcess(
            string applicationName,
            StringBuilder commandLine,
            IntPtr processAttributes,
            IntPtr threadAttributes,
            [MarshalAs(UnmanagedType.Bool)] bool inheritHandles,
            uint creationFlags,
            IntPtr environment,
            string currentDirectory,
            ref STARTUPINFOEX startupInfo,
            out PROCESS_INFORMATION processInformation);

        [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
        private static extern IntPtr CreateFile(
            string fileName,
            uint desiredAccess,
            uint shareMode,
            ref SECURITY_ATTRIBUTES securityAttributes,
            uint creationDisposition,
            uint flagsAndAttributes,
            IntPtr templateFile);

        [DllImport("kernel32.dll", SetLastError = true)]
        private static extern IntPtr GetCurrentProcess();

        [DllImport("kernel32.dll", SetLastError = true)]
        private static extern IntPtr GetStdHandle(int standardHandle);

        [DllImport("kernel32.dll", SetLastError = true)]
        [return: MarshalAs(UnmanagedType.Bool)]
        private static extern bool DuplicateHandle(
            IntPtr sourceProcess,
            IntPtr sourceHandle,
            IntPtr targetProcess,
            out IntPtr targetHandle,
            uint desiredAccess,
            [MarshalAs(UnmanagedType.Bool)] bool inheritHandle,
            uint options);

        [DllImport("kernel32.dll", SetLastError = true)]
        private static extern uint ResumeThread(IntPtr thread);

        [DllImport("kernel32.dll", SetLastError = true)]
        private static extern uint WaitForSingleObject(IntPtr handle, uint milliseconds);

        [DllImport("kernel32.dll", SetLastError = true)]
        [return: MarshalAs(UnmanagedType.Bool)]
        private static extern bool GetExitCodeProcess(IntPtr process, out uint exitCode);


        [DllImport("kernel32.dll", SetLastError = true)]
        [return: MarshalAs(UnmanagedType.Bool)]
        private static extern bool CloseHandle(IntPtr handle);

        public static int Run(
            string command,
            string expectedSha256,
            string[] arguments,
            string workingDirectory,
            string inputPath,
            string[] environmentNames,
            string[] environmentValues,
            int reapTimeoutMs)
        {
            IntPtr job = IntPtr.Zero;
            IntPtr input = IntPtr.Zero;
            IntPtr output = IntPtr.Zero;
            IntPtr error = IntPtr.Zero;
            IntPtr environment = IntPtr.Zero;
            IntPtr attributes = IntPtr.Zero;
            IntPtr jobList = IntPtr.Zero;
            bool attributesInitialized = false;
            FileStream executableLock = null;
            PROCESS_INFORMATION process = new PROCESS_INFORMATION();
            bool processCreated = false;
            try
            {
                executableLock = LockAndVerifyExecutable(command, expectedSha256);
                job = CreateKillOnCloseJob();
                input = String.IsNullOrEmpty(inputPath)
                    ? DuplicateInheritedStandardHandle(STD_INPUT_HANDLE)
                    : OpenInheritedInput(inputPath);
                output = DuplicateInheritedStandardHandle(STD_OUTPUT_HANDLE);
                error = DuplicateInheritedStandardHandle(STD_ERROR_HANDLE);
                environment = CreateEnvironmentBlock(environmentNames, environmentValues);

                // Assign at process creation. A supervisor killed between a
                // suspended CreateProcess and a later AssignProcessToJobObject
                // otherwise leaves an uncontained suspended orphan.
                IntPtr attributeSize = IntPtr.Zero;
                InitializeProcThreadAttributeList(IntPtr.Zero, 1, 0, ref attributeSize);
                if (attributeSize == IntPtr.Zero) ThrowLastError("attribute-size");
                attributes = Marshal.AllocHGlobal(attributeSize);
                if (!InitializeProcThreadAttributeList(attributes, 1, 0, ref attributeSize))
                    ThrowLastError("attribute-init");
                attributesInitialized = true;
                jobList = Marshal.AllocHGlobal(IntPtr.Size);
                Marshal.WriteIntPtr(jobList, job);
                if (!UpdateProcThreadAttribute(attributes, 0,
                    new IntPtr(PROC_THREAD_ATTRIBUTE_JOB_LIST), jobList,
                    new IntPtr(IntPtr.Size), IntPtr.Zero, IntPtr.Zero))
                    ThrowLastError("attribute-job");
                STARTUPINFOEX startup = new STARTUPINFOEX();
                startup.StartupInfo.cb = Marshal.SizeOf(typeof(STARTUPINFOEX));
                startup.StartupInfo.dwFlags = STARTF_USESTDHANDLES;
                startup.StartupInfo.hStdInput = input;
                startup.StartupInfo.hStdOutput = output;
                startup.StartupInfo.hStdError = error;
                startup.lpAttributeList = attributes;
                StringBuilder commandLine = BuildCommandLine(command, arguments);
                uint flags = CREATE_SUSPENDED | CREATE_UNICODE_ENVIRONMENT | CREATE_NO_WINDOW | EXTENDED_STARTUPINFO_PRESENT;
                if (!CreateProcess(
                    command,
                    commandLine,
                    IntPtr.Zero,
                    IntPtr.Zero,
                    true,
                    flags,
                    environment,
                    workingDirectory,
                    ref startup,
                    out process))
                {
                    ThrowLastError("create");
                }
                processCreated = true;
                if (ResumeThread(process.hThread) == UInt32.MaxValue)
                {
                    ThrowLastError("resume");
                }
                if (WaitForSingleObject(process.hProcess, INFINITE) != WAIT_OBJECT_0)
                {
                    ThrowLastError("wait");
                }
                uint exitCode;
                if (!GetExitCodeProcess(process.hProcess, out exitCode))
                {
                    ThrowLastError("exit");
                }

                if (!TerminateJobObject(job, 1))
                {
                    ThrowLastError("terminate");
                }
                WaitForJobToEmpty(job, reapTimeoutMs);
                return unchecked((int)exitCode);
            }
            finally
            {
                if (processCreated && job != IntPtr.Zero) TerminateJobObject(job, 1);
                CloseIfValid(process.hThread);
                CloseIfValid(process.hProcess);
                if (environment != IntPtr.Zero) Marshal.FreeHGlobal(environment);
                if (executableLock != null) executableLock.Dispose();
                CloseIfValid(error);
                CloseIfValid(output);
                CloseIfValid(input);
                if (attributesInitialized) DeleteProcThreadAttributeList(attributes);
                if (attributes != IntPtr.Zero) Marshal.FreeHGlobal(attributes);
                if (jobList != IntPtr.Zero) Marshal.FreeHGlobal(jobList);
                CloseIfValid(job);
            }
        }

        private static FileStream LockAndVerifyExecutable(
            string command,
            string expectedSha256)
        {
            FileStream stream = new FileStream(
                command,
                FileMode.Open,
                FileAccess.Read,
                FileShare.Read);
            try
            {
                if (!String.IsNullOrEmpty(expectedSha256))
                {
                    string actual;
                    using (SHA256 hash = SHA256.Create())
                    {
                        actual = BitConverter.ToString(hash.ComputeHash(stream))
                            .Replace("-", "")
                            .ToLowerInvariant();
                    }
                    if (!String.Equals(
                        actual,
                        expectedSha256,
                        StringComparison.Ordinal))
                    {
                        throw new InvalidOperationException("identity");
                    }
                    stream.Position = 0;
                }
                return stream;
            }
            catch
            {
                stream.Dispose();
                throw;
            }
        }

        private static IntPtr CreateKillOnCloseJob()
        {
            IntPtr job = CreateJobObject(IntPtr.Zero, null);
            if (job == IntPtr.Zero) ThrowLastError("job");
            JOBOBJECT_EXTENDED_LIMIT_INFORMATION limits =
                new JOBOBJECT_EXTENDED_LIMIT_INFORMATION();
            limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
            int size = Marshal.SizeOf(typeof(JOBOBJECT_EXTENDED_LIMIT_INFORMATION));
            IntPtr pointer = Marshal.AllocHGlobal(size);
            try
            {
                Marshal.StructureToPtr(limits, pointer, false);
                if (!SetInformationJobObject(
                    job,
                    JOBOBJECTINFOCLASS.JobObjectExtendedLimitInformation,
                    pointer,
                    (uint)size))
                {
                    ThrowLastError("job-limit");
                }
            }
            catch
            {
                CloseHandle(job);
                throw;
            }
            finally
            {
                Marshal.FreeHGlobal(pointer);
            }
            return job;
        }

        private static IntPtr OpenInheritedInput(string inputPath)
        {
            SECURITY_ATTRIBUTES security = new SECURITY_ATTRIBUTES();
            security.nLength = Marshal.SizeOf(typeof(SECURITY_ATTRIBUTES));
            security.bInheritHandle = true;
            IntPtr handle = CreateFile(
                inputPath,
                GENERIC_READ,
                FILE_SHARE_READ,
                ref security,
                OPEN_EXISTING,
                FILE_ATTRIBUTE_NORMAL,
                IntPtr.Zero);
            if (handle == InvalidHandle) ThrowLastError("input");
            return handle;
        }

        private static IntPtr DuplicateInheritedStandardHandle(int standardHandle)
        {
            IntPtr source = GetStdHandle(standardHandle);
            if (source == IntPtr.Zero || source == InvalidHandle)
            {
                ThrowLastError("standard-handle");
            }
            IntPtr current = GetCurrentProcess();
            IntPtr duplicate;
            if (!DuplicateHandle(
                current,
                source,
                current,
                out duplicate,
                0,
                true,
                DUPLICATE_SAME_ACCESS))
            {
                ThrowLastError("duplicate-handle");
            }
            return duplicate;
        }

        private static IntPtr CreateEnvironmentBlock(string[] names, string[] values)
        {
            if (names == null || values == null || names.Length != values.Length)
            {
                throw new InvalidOperationException("environment");
            }
            List<string> entries = new List<string>();
            for (int index = 0; index < names.Length; index++)
            {
                entries.Add(names[index] + "=" + values[index]);
            }
            entries.Sort(StringComparer.OrdinalIgnoreCase);
            string block = String.Join("\0", entries.ToArray()) + "\0\0";
            return Marshal.StringToHGlobalUni(block);
        }

        private static StringBuilder BuildCommandLine(string command, string[] arguments)
        {
            StringBuilder result = new StringBuilder(QuoteArgument(command));
            if (arguments != null)
            {
                foreach (string argument in arguments)
                {
                    result.Append(' ');
                    result.Append(QuoteArgument(argument));
                }
            }
            return result;
        }

        private static string QuoteArgument(string value)
        {
            if (value.Length > 0 && value.IndexOfAny(new char[] { ' ', '\t', '\n', '\v', '"' }) < 0)
            {
                return value;
            }
            StringBuilder result = new StringBuilder();
            result.Append('"');
            int backslashes = 0;
            foreach (char character in value)
            {
                if (character == '\\')
                {
                    backslashes++;
                    continue;
                }
                if (character == '"')
                {
                    result.Append('\\', (backslashes * 2) + 1);
                    result.Append('"');
                    backslashes = 0;
                    continue;
                }
                if (backslashes > 0)
                {
                    result.Append('\\', backslashes);
                    backslashes = 0;
                }
                result.Append(character);
            }
            if (backslashes > 0) result.Append('\\', backslashes * 2);
            result.Append('"');
            return result.ToString();
        }

        private static void WaitForJobToEmpty(IntPtr job, int timeoutMs)
        {
            Stopwatch stopwatch = Stopwatch.StartNew();
            int size = Marshal.SizeOf(typeof(JOBOBJECT_BASIC_ACCOUNTING_INFORMATION));
            IntPtr pointer = Marshal.AllocHGlobal(size);
            try
            {
                while (true)
                {
                    if (!QueryInformationJobObject(
                        job,
                        JOBOBJECTINFOCLASS.JobObjectBasicAccountingInformation,
                        pointer,
                        (uint)size,
                        IntPtr.Zero))
                    {
                        ThrowLastError("query");
                    }
                    JOBOBJECT_BASIC_ACCOUNTING_INFORMATION accounting =
                        (JOBOBJECT_BASIC_ACCOUNTING_INFORMATION)Marshal.PtrToStructure(
                            pointer,
                            typeof(JOBOBJECT_BASIC_ACCOUNTING_INFORMATION));
                    if (accounting.ActiveProcesses == 0) return;
                    if (stopwatch.ElapsedMilliseconds >= timeoutMs)
                    {
                        throw new TimeoutException("reap");
                    }
                    Thread.Sleep(10);
                }
            }
            finally
            {
                Marshal.FreeHGlobal(pointer);
            }
        }

        private static void CloseIfValid(IntPtr handle)
        {
            if (handle != IntPtr.Zero && handle != InvalidHandle) CloseHandle(handle);
        }

        private static void ThrowLastError(string operation)
        {
            throw new Win32Exception(Marshal.GetLastWin32Error(), operation);
        }
    }
}
'@

$inputPath = $null
try {
    Add-Type -TypeDefinition $nativeSource -Language CSharp
    if ($Interactive) {
        # Consume only the invocation header. StreamReader.ReadLine can buffer
        # subsequent RPC bytes that belong to the child's inherited stdin.
        $packetStream = [Console]::OpenStandardInput()
        $header = [System.IO.MemoryStream]::new()
        try {
            while ($true) {
                $byte = $packetStream.ReadByte()
                if ($byte -eq -1) { throw "Missing invocation header" }
                if ($byte -eq 10) { break }
                if ($header.Length -ge (3 * 1024 * 1024)) { throw "Invocation packet is too large" }
                $header.WriteByte([byte]$byte)
            }
            $packetText = [System.Text.UTF8Encoding]::new($false, $true).GetString($header.ToArray())
        }
        finally { $header.Dispose() }
    } else {
        $packetText = [Console]::In.ReadToEnd()
    }
    if ([System.Text.Encoding]::UTF8.GetByteCount($packetText) -gt (3 * 1024 * 1024)) {
        throw "Invocation packet is too large"
    }
    $packet = $packetText | ConvertFrom-Json
    if ($null -eq $packet -or
        $packet.schemaVersion -ne 1 -or
        $packet.command -isnot [string] -or
        -not [System.IO.Path]::IsPathRooted($packet.command) -or
        $packet.cwd -isnot [string] -or
        -not [System.IO.Path]::IsPathRooted($packet.cwd) -or
        $packet.args -isnot [array] -or
        $null -eq $packet.environment -or
        $packet.inputBase64 -isnot [string] -or
        -not (
            $null -eq $packet.expectedSha256 -or
            ($packet.expectedSha256 -is [string] -and
                $packet.expectedSha256 -match '^[a-f0-9]{64}$')
        ) -or
        $packet.reapTimeoutMs -isnot [int] -or
        $packet.reapTimeoutMs -lt 1 -or
        $packet.reapTimeoutMs -gt 60000) {
        throw "Invalid invocation packet"
    }

    $inputBytes = [System.Convert]::FromBase64String($packet.inputBase64)
    if ($inputBytes.Length -gt (1024 * 1024)) {
        throw "Child input is too large"
    }
    if ($Interactive -and $inputBytes.Length -ne 0) { throw "Interactive input starts empty" }
    if (-not $Interactive) {
      $inputPath = [System.IO.Path]::Combine(
        $packet.cwd,
        ".supervised-stdin-$([System.Guid]::NewGuid().ToString('N')).bin"
    )
    $inputStream = [System.IO.FileStream]::new(
        $inputPath,
        [System.IO.FileMode]::CreateNew,
        [System.IO.FileAccess]::Write,
        [System.IO.FileShare]::None
    )
    try {
        $inputStream.Write($inputBytes, 0, $inputBytes.Length)
        $inputStream.Flush($true)
    }
      finally {
        $inputStream.Dispose()
      }
    }

    $environment = @{}
    foreach ($name in @("SystemRoot", "WINDIR")) {
        $value = [System.Environment]::GetEnvironmentVariable($name, "Process")
        if (-not [string]::IsNullOrWhiteSpace($value)) {
            $environment[$name] = $value
        }
    }
    foreach ($property in $packet.environment.PSObject.Properties) {
        if ($property.MemberType -ne "NoteProperty" -or
            $property.Name -notmatch '^[A-Za-z_][A-Za-z0-9_]{0,127}$' -or
            $property.Value -isnot [string]) {
            throw "Invalid child environment"
        }
        $environment[$property.Name] = [string]$property.Value
    }
    $environmentNames = [string[]]$environment.Keys
    $environmentValues = [string[]]@(
        $environmentNames | ForEach-Object { [string]$environment[$_] }
    )

    $exitCode = [MyDashboard.SupervisedWindowsProcess]::Run(
        [string]$packet.command,
        $(if ($null -eq $packet.expectedSha256) {
            $null
        } else {
            [string]$packet.expectedSha256
        }),
        [string[]]$packet.args,
        [string]$packet.cwd,
        $inputPath,
        $environmentNames,
        $environmentValues,
        [int]$packet.reapTimeoutMs
    )
    if ($exitCode -eq 0) {
        exit 0
    }
    if ($exitCode -eq 125) {
        # Preserve the target's reserved failure family without exposing its
        # raw exit code. The Node supervisor maps 124 to PROCESS_FAILED.
        exit 124
    }
    # The wrapper reserves 125 for its own control-plane failure. Every target
    # non-zero exit is intentionally collapsed because the caller exposes only
    # a stable failure family, never the target's raw exit code.
    exit 1
}
catch {
    [Console]::Error.WriteLine("Supervised Windows process wrapper failed")
    exit 125
}
finally {
    if ($null -ne $inputPath -and [System.IO.File]::Exists($inputPath)) {
        try {
            [System.IO.File]::Delete($inputPath)
        }
        catch {
            # The invocation owner removes only its isolated directory later.
        }
    }
}
