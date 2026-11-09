import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";

test("atomic Windows test job creation survives a supervisor kill immediately after CreateProcess", { skip: process.platform !== "win32" }, async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "windows-test-job-fault-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const original = await readFile(new URL("../src/adapters/windows-test-launcher.ps1", import.meta.url), "utf8");
  const nodeSha256 = createHash("sha256").update(await readFile(process.execPath)).digest("hex");
  for (const vulnerable of [true, false]) {
    const directory = path.join(root, vulnerable ? "old-window" : "atomic");
    await mkdir(directory);
    const data = path.join(directory, "data");
    const workspace = path.join(data, "workspace");
    const control = path.join(data, "control");
    await mkdir(workspace, { recursive: true }); await mkdir(control);
    await mkdir(path.join(data, "bin")); await mkdir(path.join(data, "resources"));
    const nodeExecutable = path.join(data, "bin", "node.exe"); await cp(process.execPath, nodeExecutable);
    const appContainerName = `dih.test.${randomUUID().replaceAll("-", "")}`;
    const trace = path.join(directory, "created.pid");
    let source = original.replace("childHandle=created.Process; created.Process=IntPtr.Zero;",
      `childHandle=created.Process; created.Process=IntPtr.Zero; System.IO.File.WriteAllText(${JSON.stringify(trace)}, created.Pid.ToString()); Thread.Sleep(30000);`);
    if (vulnerable) source = source.replace("0x08080004", "0x08000004").replace("startup.StartupInfo.cb=Marshal.SizeOf(typeof(StartupInfoEx));", "startup.StartupInfo.cb=Marshal.SizeOf(typeof(StartupInfo));");
    const launcher = path.join(directory, "launcher.ps1");
    const bootstrapPath = path.join(control, "bootstrap.mjs");
    const configuration = path.join(directory, "configuration.json");
    await writeFile(launcher, source);
    await writeFile(bootstrapPath, "setInterval(()=>{},1000);");
    await writeFile(configuration, JSON.stringify({ executionId: "fault-test", actionId: "fault-action", nodeExecutable, nodeSha256,
      bootstrapPath, workspacePath: workspace, actionRoot: data, appContainerName, resourcesPath: path.join(data, "resources"), leasePath: path.join(directory, "lease.json"), gatePath: path.join(control, "gate") }));
    const child = spawn(path.join(process.env.SystemRoot, "System32/WindowsPowerShell/v1.0/powershell.exe"),
      ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", launcher, configuration],
      { windowsHide: true, env: { SystemRoot: process.env.SystemRoot, WINDIR: process.env.SystemRoot, TEMP: directory, TMP: directory, PATH: path.join(process.env.SystemRoot, "System32"), PATHEXT: ".COM;.EXE;.BAT;.CMD" }, stdio: "ignore" });
    const closed = new Promise(resolve => child.once("close", resolve));
    let testedPid = null;
    try {
      for (let attempt = 0; attempt < 200; attempt += 1) {
        try { testedPid = Number(await readFile(trace, "utf8")); break; }
        catch (error) { if (error.code !== "ENOENT") throw error; }
        await delay(50);
      }
      assert.ok(testedPid > 0, "fault injection must observe a genuinely created native child");
      child.kill("SIGKILL"); // deliberately kill only the supervisor, not its tree
      let survived = true;
      for (let attempt = 0; attempt < 40; attempt += 1) {
        try { process.kill(testedPid, 0); }
        catch (error) { if (error.code !== "ESRCH") throw error; survived = false; testedPid = null; break; }
        await delay(50);
      }
      assert.equal(survived, vulnerable, vulnerable ? "the old creation window reproduces an uncontained process" : "JOB_LIST must reap the child when the supervisor disappears");
    } finally {
      child.kill("SIGKILL");
      await closed;
      if (testedPid !== null) { try { process.kill(testedPid, "SIGKILL"); } catch {} }
      await delay(200);
      const cleanup = spawnSync(path.join(process.env.SystemRoot, "System32/WindowsPowerShell/v1.0/powershell.exe"), ["-NoProfile", "-NonInteractive", "-Command",
        `Add-Type -TypeDefinition 'using System.Runtime.InteropServices;public static class FaultProfileCleanup{[DllImport("userenv.dll",CharSet=CharSet.Unicode)]public static extern int DeleteAppContainerProfile(string name);}';if([FaultProfileCleanup]::DeleteAppContainerProfile('${appContainerName}') -lt 0){exit 1}`], { windowsHide: true, stdio: "ignore" });
      assert.equal(cleanup.status, 0, "independent restart cleanup must remove the owned profile");
    }
  }
});
