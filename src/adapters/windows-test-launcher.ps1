param([Parameter(Mandatory=$true)][string]$ConfigurationPath, [switch]$PrepareWorkspace)
$ErrorActionPreference = 'Stop'
$configuration = Get-Content -LiteralPath $ConfigurationPath -Raw | ConvertFrom-Json
function Save-Lease($lease) {
  $temporaryPath = $configuration.leasePath + '.tmp'
  [System.IO.File]::WriteAllText($temporaryPath, ($lease | ConvertTo-Json -Depth 8 -Compress), [System.Text.UTF8Encoding]::new($false))
  Move-Item -LiteralPath $temporaryPath -Destination $configuration.leasePath -Force
}
$launcher = Get-Process -Id $PID
$lease = @{ schemaVersion = 1; state = 'starting'; executionId = $configuration.executionId; actionId = $configuration.actionId; appContainerName = $configuration.appContainerName;
  launcher = @{ pid = $PID; processStartTimeUtcTicks = [string]$launcher.StartTime.ToUniversalTime().Ticks;
    executableSha256 = (Get-FileHash -LiteralPath $launcher.Path -Algorithm SHA256).Hash.ToLowerInvariant() } }
Save-Lease $lease
# The job remains owned by this launcher. Windows closes its handle on a crash,
# killing every descendant even if an asset detached a child process.
Add-Type -TypeDefinition @'
using System;
using System.ComponentModel;
using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
public sealed class FixedTestJob : IDisposable {
  [StructLayout(LayoutKind.Sequential)] struct SecurityAttributes { public int Size; public IntPtr Descriptor; public int Inherit; }
  [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)] static extern bool CreateDirectory(string path,ref SecurityAttributes attributes);
  public static void CreateLowDirectory(string path) {
    IntPtr descriptor;uint size;
    if(!ConvertStringSecurityDescriptorToSecurityDescriptor("S:(ML;OICI;NW;;;LW)",1,out descriptor,out size))throw new Win32Exception();
    try {var attributes=new SecurityAttributes();attributes.Size=Marshal.SizeOf(typeof(SecurityAttributes));attributes.Descriptor=descriptor;if(!CreateDirectory(path,ref attributes))throw new Win32Exception();}
    finally {LocalFree(descriptor);}
  }
  [StructLayout(LayoutKind.Sequential)] struct BasicLimit {
    public long ProcessTime, JobTime; public uint Flags; public UIntPtr MinWorkingSet, MaxWorkingSet;
    public uint ActiveLimit; public UIntPtr Affinity; public uint Priority, Scheduling;
  }
  [StructLayout(LayoutKind.Sequential)] struct IoCounters { public ulong A,B,C,D,E,F; }
  [StructLayout(LayoutKind.Sequential)] struct ExtendedLimit {
    public BasicLimit Basic; public IoCounters Io; public UIntPtr ProcessMemory, JobMemory, PeakProcessMemory, PeakJobMemory;
  }
  [StructLayout(LayoutKind.Sequential)] struct Accounting {
    public long UserTime, KernelTime, UserPeriod, KernelPeriod;
    public uint PageFaults, TotalProcesses, ActiveProcesses, TerminatedProcesses;
  }
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern IntPtr CreateJobObject(IntPtr a, string n);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool SetInformationJobObject(IntPtr h, int c, ref ExtendedLimit v, uint s);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool QueryInformationJobObject(IntPtr h, int c, out Accounting v, uint s, IntPtr r);
  [StructLayout(LayoutKind.Sequential, CharSet=CharSet.Unicode)] struct StartupInfo {
    public int cb; public string Reserved, Desktop, Title;
    public uint X,Y,XSize,YSize,XChars,YChars,Fill,Flags;
    public short Show, ReservedBytes; public IntPtr ReservedPointer, Input, Output, Error;
  }
  [StructLayout(LayoutKind.Sequential)] struct StartupInfoEx { public StartupInfo StartupInfo; public IntPtr Attributes; }
  [StructLayout(LayoutKind.Sequential)] struct ProcessInfo { public IntPtr Process, Thread; public uint Pid, Tid; }
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool InitializeProcThreadAttributeList(IntPtr p,int count,int flags,ref IntPtr size);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool UpdateProcThreadAttribute(IntPtr p,uint flags,IntPtr attribute,IntPtr value,IntPtr size,IntPtr previous,IntPtr returned);
  [DllImport("kernel32.dll")] static extern void DeleteProcThreadAttributeList(IntPtr p);
  [DllImport("kernel32.dll")] static extern IntPtr GetCurrentProcess();
  [DllImport("kernel32.dll")] static extern IntPtr GetStdHandle(int n);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool DuplicateHandle(IntPtr source,IntPtr handle,IntPtr target,out IntPtr duplicate,uint access,bool inherit,uint options);
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern bool CreateProcess(string application,StringBuilder command,IntPtr pa,IntPtr ta,bool inherit,uint flags,IntPtr environment,string directory,ref StartupInfoEx startup,out ProcessInfo process);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool TerminateJobObject(IntPtr j, uint e);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool GetExitCodeProcess(IntPtr p, out uint code);
  [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr h);

  [StructLayout(LayoutKind.Sequential)] struct SecurityCapabilities { public IntPtr Sid, Capabilities; public uint Count, Reserved; }
  [DllImport("userenv.dll",CharSet=CharSet.Unicode)] static extern int CreateAppContainerProfile(string name,string display,string description,IntPtr caps,uint count,out IntPtr sid);
  [DllImport("userenv.dll",CharSet=CharSet.Unicode)] static extern int GetAppContainerFolderPath(string sid,out IntPtr folder);
  [DllImport("advapi32.dll",CharSet=CharSet.Unicode,SetLastError=true)] static extern bool ConvertSidToStringSid(IntPtr sid,out IntPtr text);
  [DllImport("advapi32.dll")] static extern IntPtr FreeSid(IntPtr sid);
  [DllImport("kernel32.dll")] static extern IntPtr LocalFree(IntPtr memory);
  [DllImport("advapi32.dll",SetLastError=true)] static extern bool OpenProcessToken(IntPtr process,uint access,out IntPtr token);
  [DllImport("advapi32.dll",SetLastError=true)] static extern bool GetTokenInformation(IntPtr token,int kind,IntPtr data,uint length,out uint returned);
  [DllImport("kernel32.dll",SetLastError=true)] static extern uint ResumeThread(IntPtr thread);
  [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)] static extern bool QueryFullProcessImageName(IntPtr process,uint flags,StringBuilder path,ref uint size);
  [DllImport("kernelbase.dll",CharSet=CharSet.Unicode,SetLastError=true)] static extern bool DeriveCapabilitySidsFromName(string name,out IntPtr groups,out uint groupCount,out IntPtr caps,out uint capCount);
  [StructLayout(LayoutKind.Sequential)] struct UnicodeString {public ushort Length,MaximumLength;public IntPtr Buffer;}
  [StructLayout(LayoutKind.Sequential)] struct SecurityAttribute {public UnicodeString Name;public ushort Type,Reserved;public uint Flags,Count;public IntPtr Values;}
  [StructLayout(LayoutKind.Sequential)] struct GenericMapping {public uint Read,Write,Execute,All;}
  [DllImport("advapi32.dll",SetLastError=true)]static extern bool DuplicateToken(IntPtr token,int level,out IntPtr duplicate);
  [DllImport("advapi32.dll",CharSet=CharSet.Unicode,SetLastError=true)]static extern bool ConvertStringSecurityDescriptorToSecurityDescriptor(string text,uint revision,out IntPtr descriptor,out uint size);
  [DllImport("advapi32.dll",SetLastError=true)]static extern bool AccessCheck(IntPtr descriptor,IntPtr token,uint desired,ref GenericMapping mapping,IntPtr privileges,ref uint privilegeSize,out uint granted,out bool allowed);
  public void Resume(){if(ResumeThread(childThread)==uint.MaxValue)throw new Win32Exception();CloseHandle(childThread);childThread=IntPtr.Zero;}
  public string ImagePath(){uint size=32768;var path=new StringBuilder((int)size);if(!QueryFullProcessImageName(childHandle,0,path,ref size))throw new Win32Exception();return path.ToString();}
  static string SidText(IntPtr sid) {IntPtr text;if(!ConvertSidToStringSid(sid,out text))throw new Win32Exception();try{return Marshal.PtrToStringUni(text);}finally{LocalFree(text);}}
  public string CreateContainer(string name) {int hr=CreateAppContainerProfile(name,name,"Fixed isolated Windows test",IntPtr.Zero,0,out appSid);if(hr<0)Marshal.ThrowExceptionForHR(hr);return SidText(appSid);}
  public string ContainerFolder(){IntPtr folder;int hr=GetAppContainerFolderPath(SidText(appSid),out folder);if(hr<0)Marshal.ThrowExceptionForHR(hr);try{return Marshal.PtrToStringUni(folder);}finally{Marshal.FreeCoTaskMem(folder);}}
  static string NoAllApplicationPackages(IntPtr token){IntPtr data=TokenData(token,39);try{int count=Marshal.ReadInt32(data,4);IntPtr attrs=Marshal.ReadIntPtr(data,8);for(int i=0;i<count;i++){var attr=(SecurityAttribute)Marshal.PtrToStructure(new IntPtr(attrs.ToInt64()+i*Marshal.SizeOf(typeof(SecurityAttribute))),typeof(SecurityAttribute));string name=Marshal.PtrToStringUni(attr.Name.Buffer,attr.Name.Length/2);if(name=="WIN://NOALLAPPPKG")return attr.Type+":"+attr.Count+":"+Marshal.ReadInt64(attr.Values);}return "absent";}finally{Marshal.FreeHGlobal(data);}}
  static bool AapAccessCheck(IntPtr token){IntPtr user=TokenData(token,1),descriptor=IntPtr.Zero,duplicate=IntPtr.Zero,privileges=IntPtr.Zero;try{string userSid=SidText(Marshal.ReadIntPtr(user));uint sdSize;if(!ConvertStringSecurityDescriptorToSecurityDescriptor("O:"+userSid+"G:"+userSid+"D:(A;;0x1;;;"+userSid+")(A;;0x1;;;S-1-15-2-1)",1,out descriptor,out sdSize))throw new Win32Exception();if(!DuplicateToken(token,2,out duplicate))throw new Win32Exception();var mapping=new GenericMapping();mapping.Read=1;mapping.Write=2;mapping.Execute=4;mapping.All=7;uint privilegeSize=4096,granted;bool allowed;privileges=Marshal.AllocHGlobal((int)privilegeSize);if(!AccessCheck(descriptor,duplicate,1,ref mapping,privileges,ref privilegeSize,out granted,out allowed))throw new Win32Exception();return allowed;}finally{Marshal.FreeHGlobal(user);if(privileges!=IntPtr.Zero)Marshal.FreeHGlobal(privileges);if(descriptor!=IntPtr.Zero)LocalFree(descriptor);if(duplicate!=IntPtr.Zero)CloseHandle(duplicate);}}
  public string[] AdditionalTokenEvidence(Process process){IntPtr token;if(!OpenProcessToken(process.Handle,10,out token))throw new Win32Exception();try{return new[]{NoAllApplicationPackages(token),AapAccessCheck(token).ToString()};}finally{CloseHandle(token);}}
  static IntPtr TokenData(IntPtr token,int kind) {
    uint size; GetTokenInformation(token,kind,IntPtr.Zero,0,out size);
    if(size==0) throw new Win32Exception();
    IntPtr data=Marshal.AllocHGlobal((int)size);
    if(!GetTokenInformation(token,kind,data,size,out size)) {int error=Marshal.GetLastWin32Error();Marshal.FreeHGlobal(data);throw new Win32Exception(error);}
    return data;
  }
  public string[] TokenIdentity(Process process) {
    IntPtr token;if(!OpenProcessToken(process.Handle,8,out token))throw new Win32Exception();
    IntPtr isApp=IntPtr.Zero,sid=IntPtr.Zero,integrity=IntPtr.Zero,caps=IntPtr.Zero;
    try {
      isApp=TokenData(token,29);sid=TokenData(token,31);integrity=TokenData(token,25);caps=TokenData(token,30);
      int count=Marshal.ReadInt32(caps);var names=new string[count];
      for(int i=0;i<count;i++) names[i]=SidText(Marshal.ReadIntPtr(caps,IntPtr.Size+i*(IntPtr.Size==8?16:8)));
      Array.Sort(names,StringComparer.Ordinal);
      return new[]{Marshal.ReadInt32(isApp).ToString(),SidText(Marshal.ReadIntPtr(sid)),SidText(Marshal.ReadIntPtr(integrity)),String.Join(",",names)};
    } finally {foreach(var memory in new[]{isApp,sid,integrity,caps})if(memory!=IntPtr.Zero)Marshal.FreeHGlobal(memory);CloseHandle(token);}
  }
  public static string RegistryCapabilitySid() {
    IntPtr groups,caps;uint groupCount,capCount;
    if(!DeriveCapabilitySidsFromName("registryRead",out groups,out groupCount,out caps,out capCount))throw new Win32Exception();
    try {if(capCount!=1)throw new Exception("Unexpected registry capability");return SidText(Marshal.ReadIntPtr(caps));}
    finally {for(int i=0;i<groupCount;i++)LocalFree(Marshal.ReadIntPtr(groups,i*IntPtr.Size));for(int i=0;i<capCount;i++)LocalFree(Marshal.ReadIntPtr(caps,i*IntPtr.Size));LocalFree(groups);LocalFree(caps);}
  }

  IntPtr handle, childHandle, childThread, appSid;
  public FixedTestJob() {
    handle=CreateJobObject(IntPtr.Zero,null);
    if(handle==IntPtr.Zero) throw new Win32Exception();
    var limits=new ExtendedLimit(); limits.Basic.Flags=0x2000; // KILL_ON_JOB_CLOSE
    if(!SetInformationJobObject(handle,9,ref limits,(uint)Marshal.SizeOf(limits))) throw new Win32Exception();
  }
  public Process Start(string executable, string bootstrap, string directory) {
    IntPtr size=IntPtr.Zero, attributes=IntPtr.Zero, jobList=IntPtr.Zero;
    IntPtr input=IntPtr.Zero, output=IntPtr.Zero, error=IntPtr.Zero, security=IntPtr.Zero, inherited=IntPtr.Zero, lpacPolicy=IntPtr.Zero;
    IntPtr capabilityGroups=IntPtr.Zero, capabilitySids=IntPtr.Zero, capabilityEntries=IntPtr.Zero;
    uint capabilityGroupCount=0, capabilityCount=0;
    bool initialized=false; ProcessInfo created=new ProcessInfo();
    try {
      InitializeProcThreadAttributeList(IntPtr.Zero,4,0,ref size);
      if(size==IntPtr.Zero) throw new Win32Exception();
      attributes=Marshal.AllocHGlobal(size);
      if(!InitializeProcThreadAttributeList(attributes,4,0,ref size)) throw new Win32Exception();
      initialized=true; jobList=Marshal.AllocHGlobal(IntPtr.Size); Marshal.WriteIntPtr(jobList,handle);
      if(!UpdateProcThreadAttribute(attributes,0,new IntPtr(0x0002000d),jobList,new IntPtr(IntPtr.Size),IntPtr.Zero,IntPtr.Zero)) throw new Win32Exception();
      input=InheritedHandle(-10); output=InheritedHandle(-11); error=InheritedHandle(-12);
      lpacPolicy=Marshal.AllocHGlobal(4);Marshal.WriteInt32(lpacPolicy,1);
      if(!UpdateProcThreadAttribute(attributes,0,new IntPtr(0x0002000f),lpacPolicy,new IntPtr(4),IntPtr.Zero,IntPtr.Zero))throw new Win32Exception();
      var capabilities=new SecurityCapabilities(); capabilities.Sid=appSid;
      if(!DeriveCapabilitySidsFromName("registryRead",out capabilityGroups,out capabilityGroupCount,out capabilitySids,out capabilityCount) || capabilityCount!=1)throw new Win32Exception();
      capabilityEntries=Marshal.AllocHGlobal(IntPtr.Size==8?16:8);
      Marshal.WriteIntPtr(capabilityEntries,Marshal.ReadIntPtr(capabilitySids));Marshal.WriteInt32(capabilityEntries,IntPtr.Size,4);
      capabilities.Capabilities=capabilityEntries;capabilities.Count=1;
      security=Marshal.AllocHGlobal(Marshal.SizeOf(typeof(SecurityCapabilities)));Marshal.StructureToPtr(capabilities,security,false);
      if(!UpdateProcThreadAttribute(attributes,0,new IntPtr(0x00020009),security,new IntPtr(Marshal.SizeOf(typeof(SecurityCapabilities))),IntPtr.Zero,IntPtr.Zero))throw new Win32Exception();
      inherited=Marshal.AllocHGlobal(IntPtr.Size*3);Marshal.WriteIntPtr(inherited,0,input);Marshal.WriteIntPtr(inherited,IntPtr.Size,output);Marshal.WriteIntPtr(inherited,IntPtr.Size*2,error);
      if(!UpdateProcThreadAttribute(attributes,0,new IntPtr(0x00020002),inherited,new IntPtr(IntPtr.Size*3),IntPtr.Zero,IntPtr.Zero))throw new Win32Exception();
      var startup=new StartupInfoEx(); startup.StartupInfo.cb=Marshal.SizeOf(typeof(StartupInfoEx));
      startup.StartupInfo.Flags=0x100; startup.StartupInfo.Input=input; startup.StartupInfo.Output=output; startup.StartupInfo.Error=error; startup.Attributes=attributes;
      var command=new StringBuilder("\""+executable+"\" --no-warnings --preserve-symlinks --preserve-symlinks-main \""+bootstrap+"\"");
      // JOB_LIST makes containment atomic with creation. There is no process
      // which a killed launcher can leave between creation and assignment.
      if(!CreateProcess(executable,command,IntPtr.Zero,IntPtr.Zero,true,0x08080004,IntPtr.Zero,directory,ref startup,out created)) throw new Win32Exception();
      childHandle=created.Process; created.Process=IntPtr.Zero; childThread=created.Thread; created.Thread=IntPtr.Zero;
      return Process.GetProcessById((int)created.Pid);
    } finally {
      if(initialized) DeleteProcThreadAttributeList(attributes);
      if(attributes!=IntPtr.Zero) Marshal.FreeHGlobal(attributes);
      if(jobList!=IntPtr.Zero) Marshal.FreeHGlobal(jobList); if(security!=IntPtr.Zero)Marshal.FreeHGlobal(security); if(inherited!=IntPtr.Zero)Marshal.FreeHGlobal(inherited);if(lpacPolicy!=IntPtr.Zero)Marshal.FreeHGlobal(lpacPolicy);
      if(capabilityEntries!=IntPtr.Zero)Marshal.FreeHGlobal(capabilityEntries);
      for(int i=0;i<capabilityGroupCount;i++)LocalFree(Marshal.ReadIntPtr(capabilityGroups,i*IntPtr.Size));
      for(int i=0;i<capabilityCount;i++)LocalFree(Marshal.ReadIntPtr(capabilitySids,i*IntPtr.Size));
      if(capabilityGroups!=IntPtr.Zero)LocalFree(capabilityGroups);if(capabilitySids!=IntPtr.Zero)LocalFree(capabilitySids);
      foreach(var owned in new[]{input,output,error,created.Process,created.Thread}) if(owned!=IntPtr.Zero) CloseHandle(owned);
    }
  }
  public int ExitCode() {
    uint code; if(!GetExitCodeProcess(childHandle,out code)) throw new Win32Exception();
    return unchecked((int)code);
  }
  static IntPtr InheritedHandle(int standard) {
    IntPtr duplicate; var current=GetCurrentProcess();
    if(!DuplicateHandle(current,GetStdHandle(standard),current,out duplicate,0,true,2)) throw new Win32Exception();
    return duplicate;
  }
  public void Stop() {
    if(!TerminateJobObject(handle,1)) throw new Win32Exception();
    for(int i=0;i<100;i++) {
      Accounting accounting;
      if(!QueryInformationJobObject(handle,1,out accounting,(uint)Marshal.SizeOf(typeof(Accounting)),IntPtr.Zero)) throw new Win32Exception();
      if(accounting.ActiveProcesses==0) return;
      Thread.Sleep(50);
    }
    throw new Exception("Windows test job did not become empty");
  }
  public void Dispose() {
    if(handle!=IntPtr.Zero) {CloseHandle(handle);handle=IntPtr.Zero;}
    if(childHandle!=IntPtr.Zero) {CloseHandle(childHandle);childHandle=IntPtr.Zero;}
    if(childThread!=IntPtr.Zero) {CloseHandle(childThread);childThread=IntPtr.Zero;}
    if(appSid!=IntPtr.Zero) {FreeSid(appSid);appSid=IntPtr.Zero;}
  }
}
'@
if ($PrepareWorkspace) { [FixedTestJob]::CreateLowDirectory($configuration.workspacePath); exit 0 }
$job = [FixedTestJob]::new()
try {
  $sid = $job.CreateContainer($configuration.appContainerName)
  $lease.appContainerName=$configuration.appContainerName
  $lease.appContainerSid=$sid
  $lease.appContainerFolder=$job.ContainerFolder()
  Save-Lease $lease
  [System.IO.Directory]::CreateDirectory((Join-Path $configuration.workspacePath ('Packages\'+$configuration.appContainerName+'\AC\Temp'))) | Out-Null
  & "$env:SystemRoot\System32\icacls.exe" $configuration.actionRoot '/grant' ("*" + $sid + ":(OI)(CI)(RX)") '/T' | Out-Null
  if($LASTEXITCODE -ne 0){throw 'Action read ACL failed'}
  & "$env:SystemRoot\System32\icacls.exe" $configuration.workspacePath '/grant' ("*" + $sid + ":(OI)(CI)(M)") '/T' | Out-Null
  if($LASTEXITCODE -ne 0){throw 'Workspace write ACL failed'}
  $env:TEMP=$configuration.workspacePath
  $env:TMP=$configuration.workspacePath
  $env:USERPROFILE=$configuration.workspacePath
  $env:APPDATA=$configuration.workspacePath
  $env:LOCALAPPDATA=$configuration.workspacePath
  $env:CONTROLLED_TEST_RESOURCES=$configuration.resourcesPath
  $env:NODE_OPTIONS='--preserve-symlinks --preserve-symlinks-main'
  $child = $job.Start($configuration.nodeExecutable, $configuration.bootstrapPath, $configuration.workspacePath)
  $actualExecutable = $job.ImagePath()
  $actualExecutableHash = (Get-FileHash -LiteralPath $actualExecutable -Algorithm SHA256).Hash.ToLowerInvariant()
  if ($actualExecutableHash -ne $configuration.nodeSha256) { throw 'Pinned Node executable changed before launch' }
  $lease.runtimeIdentity = @{ schemaVersion = 2; kind = 'windows-process'; executionId = $configuration.executionId; actionId = $configuration.actionId;
    pid = $child.Id; processStartTimeUtcTicks = [string]$child.StartTime.ToUniversalTime().Ticks; executableSha256 = $actualExecutableHash }
  $token=$job.TokenIdentity($child)
  $additional=$job.AdditionalTokenEvidence($child)
  if ($token[0] -ne '1' -or $token[1] -ne $sid -or $token[2] -ne 'S-1-16-4096' -or $token[3] -ne [FixedTestJob]::RegistryCapabilitySid() -or $additional[0] -ne '2:1:1' -or [bool]::Parse($additional[1])) { throw 'Actual process token did not establish LPAC isolation' }
  $lease.runtimeIdentity.isolation=@{kind='windows-lpac';appContainerSid=$token[1];integritySid=$token[2];noAllApplicationPackages=1;capabilitySids=@($token[3] -split ',');allApplicationPackagesAccessGranted=$false}
  Save-Lease $lease
  $job.Resume()
  $lease.state = 'running'
  Save-Lease $lease
  [System.IO.File]::WriteAllText($configuration.gatePath, 'run')
  while (!$child.WaitForExit(100)) { }
  $exitCode = $job.ExitCode()
  $job.Stop()
  $child.WaitForExit()
  $lease.state = 'completed'
  Save-Lease $lease
} finally {
  try { $job.Stop(); $lease.stopConfirmed=$true; Save-Lease $lease } finally { $job.Dispose() }
}
exit $exitCode
