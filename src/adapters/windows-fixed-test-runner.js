import { randomUUID } from "node:crypto";
import { cp, lstat, mkdir, open, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import { digestValue } from "../domain/code-executor-contract.js";
import { CodeExecutionPolicy } from "../domain/code-execution-policy.js";
import { isWindowsRuntimeIdentity } from "../domain/test-runtime-identity.js";
import { normalizeWindowsTestProfile } from "../domain/windows-test-profile.js";
import { ManagedProcessError, ManagedProcessRunner } from "../lib/managed-process.js";
import { copyWindowsTestResources, windowsTestFileDigest } from "./windows-test-resources.js";

const SAFE_ID = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/u;
const LAUNCHER = fileURLToPath(new URL("./windows-test-launcher.ps1", import.meta.url));
const COMPLETED_CLEANUP_ATTEMPTS = 3;
const COMPLETED_CLEANUP_RETRY_MS = 250;

export class WindowsTestRunnerError extends Error {
  constructor(code, message, details) {
    super(message);
    this.name = "WindowsTestRunnerError";
    this.code = code;
    if (details) this.details = details;
  }
}
function failure(code, message, details) { return new WindowsTestRunnerError(code, message, details); }
function assertRequest(value, required, optional = []) {
  if (!value || Object.getPrototypeOf(value) !== Object.prototype ||
    Reflect.ownKeys(value).some((key) => ![...required, ...optional].includes(key) || !Object.hasOwn(Object.getOwnPropertyDescriptor(value, key), "value")) ||
    required.some((key) => !Object.hasOwn(value, key)) ||
    ["executionId", "actionId"].some((key) => typeof value[key] !== "string" || !SAFE_ID.test(value[key]))) {
    throw failure("INVALID_SANDBOX_REQUEST", "Windows test request is invalid");
  }
}
function descendant(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative !== "" && relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}
function sameRecoveryPath(left, right) {
  const normalize = value => process.platform === 'win32' ? path.resolve(value).toLowerCase() : path.resolve(value);
  return normalize(left) === normalize(right);
}
function sameRecoveryIdentity(left, right) {
  return ['dev', 'ino', 'mode', 'nlink'].every(key => left[key] === right[key]);
}
async function readRecoveryJson(directory, name) {
  const target = path.join(directory, name);
  const initial = await lstat(target);
  if (!initial.isFile() || initial.isSymbolicLink() || initial.nlink !== 1 || initial.size > 65_536 ||
      !sameRecoveryPath(await realpath(target), target)) throw new Error('Untrusted recovery metadata');
  const stable = stats => sameRecoveryIdentity(initial, stats) &&
    ['size', 'mtimeMs', 'ctimeMs'].every(key => initial[key] === stats[key]);
  const handle = await open(target, 'r');
  try {
    if (!stable(await handle.stat())) throw new Error('Changed recovery metadata');
    const buffer = Buffer.alloc(65_537);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    if (bytesRead !== initial.size || !stable(await handle.stat()) || !stable(await lstat(target)) ||
        !sameRecoveryPath(await realpath(target), target)) throw new Error('Changed recovery metadata');
    return JSON.parse(buffer.subarray(0, bytesRead).toString('utf8'));
  } finally {
    await handle.close();
  }
}
async function noLinks(directory) {
  if ((await lstat(directory)).isSymbolicLink()) throw failure("INVALID_SANDBOX_REQUEST", "Windows test paths cannot contain links");
  for (const item of await readdir(directory, { withFileTypes: true })) {
    if (item.isSymbolicLink()) throw failure("INVALID_SANDBOX_REQUEST", "Windows test workspace cannot contain links");
    if (item.isDirectory()) await noLinks(path.join(directory, item.name));
    else if (!item.isFile()) throw failure("INVALID_SANDBOX_REQUEST", "Windows test workspace contains an unsupported entry");
  }
}
function sanitizer(values) {
  const variants = [...new Set(values.flatMap((value) => [value, value.replaceAll("\\", "/"), value.replaceAll("\\", "\\\\")]))].sort((a,b) => b.length-a.length);
  return (value) => {
    let result = String(value ?? "").replace(/\x1b\[[0-?]*[ -/]*[@-~]/gu, "");
    for (const variant of variants) result = result.replace(new RegExp(variant.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&"), "giu"), "[test-path]");
    return result;
  };
}

export class WindowsFixedTestRunner {
  #profiles = new Map();
  #active = new Set();
  constructor({ allowedWorkspaceRoot, runRoot, profiles, sourceEnvironment = process.env, processRunner = new ManagedProcessRunner() }) {
    if (![allowedWorkspaceRoot, runRoot].every((value) => typeof value === "string" && path.isAbsolute(value) && !/["\p{Cc}]/u.test(value)) ||
      descendant(path.resolve(allowedWorkspaceRoot), path.resolve(runRoot)) || path.resolve(allowedWorkspaceRoot) === path.resolve(runRoot)) throw failure("INVALID_SANDBOX_CONFIG", "Windows test directories are invalid");
    try {
      for (const [id, profile] of Object.entries(profiles)) {
        if (!SAFE_ID.test(id)) throw new TypeError();
        const definition = normalizeWindowsTestProfile(profile);
        this.#profiles.set(id, { definition, fingerprint: digestValue(definition) });
      }
    } catch { throw failure("INVALID_SANDBOX_CONFIG", "Windows fixed test profiles are invalid"); }
    this.allowedWorkspaceRoot = path.resolve(allowedWorkspaceRoot);
    this.runRoot = path.resolve(runRoot);
    this.processRunner = processRunner;
    this.systemRoot = sourceEnvironment.SystemRoot || sourceEnvironment.SYSTEMROOT || "C:\\Windows";
    this.powershell = path.join(this.systemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
  }
  getProfileFingerprint(id) {
    const profile = this.#profiles.get(id);
    if (!profile) throw failure("SANDBOX_PROFILE_NOT_FOUND", "Windows test profile was not found");
    return profile.fingerprint;
  }
  executionDirectory(executionId, actionId) {
    if (![executionId, actionId].every((value) => typeof value === "string" && SAFE_ID.test(value))) {
      throw failure("INVALID_SANDBOX_REQUEST", "Windows execution identity is invalid");
    }
    return path.join(this.runRoot, digestValue({ executionId, actionId }));
  }
  async readSettledPreparationFailure(request) {
    assertRequest(request, ['profileId', 'executionId', 'actionId']);
    const profile = this.#profiles.get(request.profileId);
    if (process.platform !== 'win32' || profile?.definition.kind !== 'windows-test') return null;
    const directory = this.executionDirectory(request.executionId, request.actionId);
    if (this.#active.has(directory)) return null;
    try {
      const rootStats = await lstat(this.runRoot), directoryStats = await lstat(directory);
      if (!rootStats.isDirectory() || rootStats.isSymbolicLink() || !directoryStats.isDirectory() || directoryStats.isSymbolicLink() ||
          !sameRecoveryPath(await realpath(this.runRoot), this.runRoot) || !sameRecoveryPath(await realpath(directory), directory)) return null;
      const reads = await Promise.allSettled(['lease.json', 'pending.json', 'cleanup.json', 'result.json'].map(name => readRecoveryJson(directory, name)));
      if (reads.some(result => result.status !== 'fulfilled')) return null;
      const [lease, pending, cleanup, result] = reads.map(read => read.value);
      const matches = value => value?.executionId === request.executionId && value.actionId === request.actionId;
      if (!matches(lease) || lease.schemaVersion !== 1 || lease.state !== 'starting' || lease.runtimeIdentity != null ||
          !Number.isSafeInteger(lease.launcher?.pid) || lease.launcher.pid < 1 ||
          !/^\d+$/u.test(lease.launcher.processStartTimeUtcTicks ?? '') || !/^[a-f0-9]{64}$/u.test(lease.launcher.executableSha256 ?? '') ||
          !/^dih\.test\.[a-f0-9]{32}$/u.test(lease.appContainerName ?? '') ||
          !matches(pending) || pending.appContainerName !== lease.appContainerName || !matches(cleanup) ||
          cleanup.stopConfirmed !== true || cleanup.dataRemoved !== true || cleanup.profileRemoved !== true ||
          result?.error?.code !== 'SANDBOX_START_FAILED' || result.error.message !== 'Windows test preparation was interrupted' ||
          Object.hasOwn(result, 'runtimeIdentity') || Object.hasOwn(result, 'exitCode')) return null;
      try { await lstat(path.join(directory, 'data')); return null; }
      catch (error) { if (error.code !== 'ENOENT') return null; }
      if (this.#active.has(directory) || !sameRecoveryIdentity(rootStats, await lstat(this.runRoot)) ||
          !sameRecoveryIdentity(directoryStats, await lstat(directory)) ||
          !sameRecoveryPath(await realpath(directory), directory)) return null;
      return Object.freeze({ executionId: request.executionId, actionId: request.actionId, profileId: request.profileId,
        profileConfigDigest: profile.fingerprint, reason: 'preparation_interrupted_cleanup_confirmed' });
    } catch {
      return null;
    }
  }
  #environment(directory) {
    return { SystemRoot: this.systemRoot, WINDIR: this.systemRoot, PATH: path.join(this.systemRoot, "System32"),
      TEMP: directory, TMP: directory, NO_COLOR: "1", PATHEXT: ".COM;.EXE;.BAT;.CMD", COMSPEC: path.join(this.systemRoot, "System32/cmd.exe") };
  }
  async run(request) {
    assertRequest(request, ["profileId", "workspacePath", "workspaceRevision", "executionId", "actionId"], ["signal"]);
    if (process.platform !== "win32") throw failure("SANDBOX_UNAVAILABLE", "Windows fixed tests require Windows");
    if (typeof request.workspaceRevision !== "string" || !/^[a-f0-9]{64}$/u.test(request.workspaceRevision) ||
      typeof request.workspacePath !== "string" || !path.isAbsolute(request.workspacePath) ||
      (request.signal != null && (typeof request.signal.addEventListener !== "function" || typeof request.signal.aborted !== "boolean"))) throw failure("INVALID_SANDBOX_REQUEST", "Windows test request is invalid");
    if (request.signal?.aborted) throw failure("SANDBOX_ABORTED", "Windows fixed test was cancelled before launch",
      { origin: "windows_fixed_prelaunch", notExecuted: true, cleanupPending: false });
    const profile = this.#profiles.get(request.profileId);
    if (!profile) throw failure("SANDBOX_PROFILE_NOT_FOUND", "Windows test profile was not found");
    const definition = profile.definition;
    let sourceRoot;
    try {
      sourceRoot = await realpath(request.workspacePath);
      const allowed = await realpath(this.allowedWorkspaceRoot);
      if (!descendant(this.allowedWorkspaceRoot, path.resolve(request.workspacePath)) || !descendant(allowed, sourceRoot)) throw new Error();
      await noLinks(sourceRoot);
    } catch { throw failure("INVALID_SANDBOX_REQUEST", "Windows test workspace is outside its allowed root or contains links"); }
    try {
      const executableStats = await lstat(definition.nodeExecutable);
      if (!executableStats.isFile() || executableStats.isSymbolicLink() || (await realpath(definition.nodeExecutable)).toLowerCase() !== path.resolve(definition.nodeExecutable).toLowerCase()) throw new Error();
      if (await windowsTestFileDigest(definition.nodeExecutable) !== definition.nodeSha256) throw new Error();
      await lstat(this.powershell);
    } catch { throw failure("SANDBOX_UNAVAILABLE", "Pinned Windows Node executable or Windows PowerShell is unavailable"); }
    const directory = this.executionDirectory(request.executionId, request.actionId);
    if (this.#active.has(directory)) throw failure("SANDBOX_CLEANUP_FAILED", "Windows execution is already running", { cleanupPending: true });
    this.#active.add(directory);
    let launched = false;
    let supervisorStarted = false;
    let created = false;
    let completedEvidenceWritten = false;
    const dataPath = path.join(directory, "data");
    const workspacePath = path.join(dataPath, "workspace");
    const leasePath = path.join(directory, "lease.json");
    const redact = sanitizer([sourceRoot, this.allowedWorkspaceRoot, this.runRoot, directory, definition.nodeExecutable, this.powershell, LAUNCHER]);
    try {
      await mkdir(this.runRoot, { recursive: true });
      if (await realpath(this.runRoot) !== this.runRoot) throw failure("INVALID_SANDBOX_CONFIG", "Windows run root cannot contain links");
      try { await mkdir(directory); }
      catch { throw failure("SANDBOX_CLEANUP_FAILED", "Windows execution already has durable evidence", { cleanupPending: true }); }
      created = true;
      const appContainerName = `dih.test.${randomUUID().replaceAll("-", "")}`;
      await writeFile(path.join(directory, "pending.json"), JSON.stringify({ executionId: request.executionId, actionId: request.actionId, appContainerName }));
      await mkdir(path.join(dataPath, "control"), { recursive: true });
      await mkdir(path.join(dataPath, "bin"));
      const nodeExecutable = path.join(dataPath, "bin", "node.exe");
      await cp(definition.nodeExecutable, nodeExecutable, { errorOnExist: true, force: false });
      if (await windowsTestFileDigest(nodeExecutable) !== definition.nodeSha256) throw failure("SANDBOX_UNAVAILABLE", "Copied Windows Node executable digest changed");
      const resourcesPath = path.join(dataPath, "resources");
      try { await copyWindowsTestResources(definition.resources ?? [], resourcesPath); }
      catch { throw failure("SANDBOX_UNAVAILABLE", "Pinned Windows test resources are unavailable or changed"); }
      const assetPath = path.join(dataPath, "control", "asset.mjs");
      const bootstrapPath = path.join(dataPath, "control", "bootstrap.mjs");
      const gatePath = path.join(dataPath, "control", "start.gate");
      const configPath = path.join(directory, "configuration.json");
      await writeFile(configPath, JSON.stringify({ executionId: request.executionId, actionId: request.actionId, nodeExecutable,
        nodeSha256: definition.nodeSha256, workspacePath, leasePath, bootstrapPath, gatePath, resourcesPath, actionRoot: dataPath, appContainerName }), { flag: "wx" });
      // Set Low IL while creating the empty directory. Relabeling copied files
      // later requires WRITE_OWNER, which ordinary deployment directories may
      // deliberately withhold. Every copied file inherits this scoped label.
      supervisorStarted = true;
      let prepared;
      try {
        prepared = await this.processRunner.run({ command: this.powershell, args: ["-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", LAUNCHER, configPath, "-PrepareWorkspace"],
          cwd: directory, env: this.#environment(directory), timeoutMs: 10_000, signal: request.signal ?? null });
      } catch (error) {
        if (error instanceof ManagedProcessError && error.code !== "PROCESS_STOP_FAILED") await writeFile(path.join(directory, "supervisor-stopped.json"), JSON.stringify({ executionId: request.executionId, actionId: request.actionId, stopped: true }));
        throw error;
      }
      if (prepared.exitCode !== 0) throw failure("SANDBOX_UNAVAILABLE", "Low integrity workspace creation failed", { stdout: redact(prepared.stdout), stderr: redact(prepared.stderr) });
      const policy = new CodeExecutionPolicy();
      await cp(sourceRoot, workspacePath, { recursive: true, errorOnExist: true, force: false,
        filter: (candidate) => !policy.isExcluded(path.relative(sourceRoot, candidate).replaceAll("\\", "/")) });
      // Recursive ACL application must never reach a link introduced during a
      // copy, including a configured executable link to a host installation.
      await noLinks(dataPath);
      await writeFile(assetPath, definition.asset.source, { flag: "wx" });
      await writeFile(bootstrapPath, `import { existsSync } from 'node:fs'; import { setTimeout } from 'node:timers/promises';\nwhile(!existsSync(${JSON.stringify(gatePath)})) await setTimeout(25);\nawait import(${JSON.stringify(pathToFileURL(assetPath).href)});\n`, { flag: "wx" });
      // A preparation lease must never be mistaken for the next supervisor.
      await rm(leasePath, { force: true });
      await rm(path.join(directory, "supervisor-stopped.json"), { force: true });
      launched = true;
      let result;
      try {
        result = await this.processRunner.run({ command: this.powershell, args: ["-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", LAUNCHER, configPath],
          cwd: directory, env: this.#environment(directory), timeoutMs: definition.timeoutMs, signal: request.signal ?? null });
        await writeFile(path.join(directory, "supervisor-stopped.json"), JSON.stringify({ executionId: request.executionId, actionId: request.actionId, stopped: true }));
      } catch (error) {
        // ManagedProcessRunner reports these only after its process tree stop and
        // close completed. Without a launcher lease the asset cannot have run.
        if (error instanceof ManagedProcessError && error.code !== "PROCESS_STOP_FAILED") {
          await writeFile(path.join(directory, "supervisor-stopped.json"), JSON.stringify({ executionId: request.executionId, actionId: request.actionId, stopped: true }));
        }
        await this.cleanup({ executionId: request.executionId, actionId: request.actionId });
        const code = { PROCESS_TIMEOUT: "SANDBOX_TIMEOUT", PROCESS_ABORTED: "SANDBOX_ABORTED", PROCESS_OUTPUT_LIMIT: "SANDBOX_OUTPUT_LIMIT" }[error.code] ?? "SANDBOX_START_FAILED";
        throw failure(code, "Windows fixed test execution was interrupted", error instanceof ManagedProcessError ? {
          ...error.details, stdout: redact(error.details?.stdout), stderr: redact(error.details?.stderr), cleanupPending: false } : undefined);
      }
      const lease = JSON.parse(await readFile(leasePath, "utf8"));
      if (lease.state !== "completed" || lease.stopConfirmed !== true || !isWindowsRuntimeIdentity(lease.runtimeIdentity) || lease.runtimeIdentity.schemaVersion !== 2 || lease.runtimeIdentity.executableSha256 !== definition.nodeSha256 ||
        lease.runtimeIdentity.executionId !== request.executionId || lease.runtimeIdentity.actionId !== request.actionId) {
        await this.cleanup({ executionId: request.executionId, actionId: request.actionId });
        throw failure("SANDBOX_START_FAILED", "Windows launcher did not persist a completed process identity", { stdout: redact(result.stdout), stderr: redact(result.stderr) });
      }
      if (result.exitCode === 69) {
        throw failure("SANDBOX_UNAVAILABLE", "Fixed Windows test dependencies are unavailable", {
          exitCode: 69, stdout: redact(result.stdout), stderr: redact(result.stderr), durationMs: result.durationMs, cleanupPending: false });
      }
      const evidence = { ...result, stdout: redact(result.stdout), stderr: redact(result.stderr), timedOut: false,
        runtimeIdentity: lease.runtimeIdentity, profileFingerprint: profile.fingerprint, workspaceRevision: request.workspaceRevision,
        assetVersion: definition.asset.version, verificationKind: definition.kind === "windows-test" ? "test" : "build" };
      await writeFile(path.join(directory, "result.json"), JSON.stringify(evidence));
      completedEvidenceWritten = true;
      return evidence;
    } catch (error) {
      let reported = error;
      if (error instanceof ManagedProcessError) {
        const code = { PROCESS_TIMEOUT: "SANDBOX_TIMEOUT", PROCESS_ABORTED: "SANDBOX_ABORTED", PROCESS_OUTPUT_LIMIT: "SANDBOX_OUTPUT_LIMIT" }[error.code] ?? "SANDBOX_START_FAILED";
        reported = failure(code, "Windows test preparation was interrupted", { ...error.details, stdout: redact(error.details?.stdout), stderr: redact(error.details?.stderr) });
      } else if (!(error instanceof WindowsTestRunnerError)) reported = failure("SANDBOX_START_FAILED", "Windows fixed test preparation or evidence failed", { cleanupPending: launched });
      if (created) await writeFile(path.join(directory, "result.json"), JSON.stringify({ error: { code: reported.code, message: reported.message },
        stdout: redact(reported.details?.stdout).slice(-1024 * 1024), stderr: redact(reported.details?.stderr).slice(-1024 * 1024) }));
      throw reported;
    } finally {
      this.#active.delete(directory);
      if (created) {
        if (!supervisorStarted) await writeFile(path.join(directory, "supervisor-stopped.json"), JSON.stringify({ executionId: request.executionId, actionId: request.actionId, stopped: true }));
        await this.#cleanupAfterRun(request, completedEvidenceWritten);
      }
    }
  }
  async #cleanupAfterRun(request, completedEvidenceWritten) {
    const attempts = completedEvidenceWritten ? COMPLETED_CLEANUP_ATTEMPTS : 1;
    for (let attempt = 0; attempt < attempts; attempt++) {
      try {
        await this.cleanup({ executionId: request.executionId, actionId: request.actionId });
        return;
      } catch (error) {
        if (!(error instanceof WindowsTestRunnerError) || error.code !== "SANDBOX_CLEANUP_FAILED" ||
            error.details?.cleanupPending !== true || attempt + 1 === attempts || request.signal?.aborted) throw error;
        try { await delay(COMPLETED_CLEANUP_RETRY_MS, undefined, { signal: request.signal ?? undefined }); }
        catch { throw error; }
      }
    }
  }
  async #inspect(pid) {
    if (!Number.isSafeInteger(pid) || pid < 1) throw new Error("Invalid process identity");
    const command = `$ErrorActionPreference='Stop';$p=Get-Process -Id ${pid} -ErrorAction SilentlyContinue;if($null -ne $p){@{pid=$p.Id;processStartTimeUtcTicks=[string]$p.StartTime.ToUniversalTime().Ticks;executableSha256=(Get-FileHash -LiteralPath $p.Path -Algorithm SHA256).Hash.ToLowerInvariant()}|ConvertTo-Json -Compress};exit 0`;
    const result = await this.processRunner.run({ command: this.powershell, args: ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", command], env: this.#environment(this.runRoot), timeoutMs: 10_000 });
    if (result.exitCode !== 0) throw new Error("Process inspection failed");
    return result.stdout.trim() ? JSON.parse(result.stdout) : null;
  }
  async cleanup(request) {
    assertRequest(request, ["executionId", "actionId"]);
    const directory = this.executionDirectory(request.executionId, request.actionId);
    try {
      const stats = await lstat(directory);
      if (!stats.isDirectory() || stats.isSymbolicLink() || (await realpath(directory)).toLowerCase() !== directory.toLowerCase()) throw new Error();
    } catch (error) { if (error.code === "ENOENT") return; throw failure("SANDBOX_CLEANUP_FAILED", "Windows evidence directory boundary changed", { cleanupPending: true }); }
    let lease;
    try { lease = JSON.parse(await readFile(path.join(directory, "lease.json"), "utf8")); }
    catch (error) {
      if (error.code === "ENOENT") {
        try { await lstat(directory); } catch (missing) { if (missing.code === "ENOENT") return; }
        try {
          const stopped = JSON.parse(await readFile(path.join(directory, "supervisor-stopped.json"), "utf8"));
          if (stopped.executionId === request.executionId && stopped.actionId === request.actionId && stopped.stopped === true) {
            await this.#removeStoppedData(directory, request);
            return;
          }
        } catch {}
      }
      throw failure("SANDBOX_CLEANUP_FAILED", "Windows process lease is unavailable; cleanup cannot be confirmed", { cleanupPending: true });
    }
    try {
      if (lease.schemaVersion !== 1 || lease.executionId !== request.executionId || lease.actionId !== request.actionId || !lease.launcher) throw new Error();
      for (const identity of [lease.launcher, lease.runtimeIdentity].filter(Boolean)) {
        const live = await this.#inspect(identity.pid);
        if (!live) continue;
        // Reused PIDs never authorize terminating an unrelated process.
        if (live.processStartTimeUtcTicks !== identity.processStartTimeUtcTicks || live.executableSha256 !== identity.executableSha256) {
          if (lease.state === "completed") continue;
          throw new Error("Process identity changed");
        }
        const result = await this.processRunner.run({ command: path.join(this.systemRoot, "System32", "taskkill.exe"), args: ["/PID", String(identity.pid), "/T", "/F"], env: this.#environment(directory), timeoutMs: 10_000 });
        if (result.exitCode !== 0 && await this.#inspect(identity.pid)) throw new Error("Process tree termination failed");
        const remaining = await this.#inspect(identity.pid);
        if (remaining && remaining.processStartTimeUtcTicks === identity.processStartTimeUtcTicks) throw new Error("Process has not exited");
      }
    } catch { throw failure("SANDBOX_CLEANUP_FAILED", "Windows process cleanup could not be confirmed", { cleanupPending: true }); }
    await this.#removeStoppedData(directory, request, lease);
  }
  async #removeStoppedData(directory, request, lease) {
    try {
      let pending;
      try { pending = JSON.parse(await readFile(path.join(directory, "pending.json"), "utf8")); }
      catch (error) { if (error.code !== "ENOENT" || lease?.appContainerName) throw error; }
      if (pending) {
        if (pending.executionId !== request.executionId || pending.actionId !== request.actionId || !/^dih\.test\.[a-f0-9]{32}$/u.test(pending.appContainerName) ||
          (lease?.appContainerName && lease.appContainerName !== pending.appContainerName)) throw new Error("Profile ownership changed");
        const command = `Add-Type -TypeDefinition 'using System.Runtime.InteropServices;public static class FixedProfileCleanup{[DllImport("userenv.dll",CharSet=CharSet.Unicode)]public static extern int DeleteAppContainerProfile(string name);}';$hr=[FixedProfileCleanup]::DeleteAppContainerProfile('${pending.appContainerName}');if($hr -lt 0 -and $hr -ne -2147024894 -and $hr -ne -2147023728){exit 1};exit 0`;
        const removed = await this.processRunner.run({ command: this.powershell, args: ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", command], env: this.#environment(directory), timeoutMs: 10_000 });
        if (removed.exitCode !== 0) throw new Error("AppContainer profile removal failed");
      }
      const data = path.join(directory, "data");
      try {
        const stats = await lstat(data);
        if (!stats.isDirectory() || stats.isSymbolicLink() || (await realpath(data)).toLowerCase() !== data.toLowerCase()) throw new Error("Action data boundary changed");
        // fs.rm unlinks descendant junctions; it never follows them into host
        // files. The data root itself must remain our original plain directory.
        await rm(data, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
      } catch (error) { if (error.code !== "ENOENT") throw error; }
      await writeFile(path.join(directory, "cleanup.json"), JSON.stringify({ executionId: request.executionId, actionId: request.actionId, stopConfirmed: true, dataRemoved: true, profileRemoved: true }));
    } catch (error) { throw failure("SANDBOX_CLEANUP_FAILED", "Windows stopped action data or profile cleanup remains pending", { cleanupPending: true, reasonCode: error.code ?? "PROFILE_OR_PATH_CLEANUP" }); }
  }
}
