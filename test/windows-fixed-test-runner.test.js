import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { link, lstat, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import net from "node:net";
import { spawnSync } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import { WindowsFixedTestRunner, WindowsTestRunnerError } from "../src/adapters/windows-fixed-test-runner.js";

async function fixture(t, { source, kind = "windows-test", timeoutMs = 10_000 } = {}) {
  const root = await mkdtemp(path.join(tmpdir(), "windows-fixed-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const workspacePath = path.join(root, "workspaces", "one");
  await mkdir(path.join(workspacePath, "test"), { recursive: true });
  await writeFile(path.join(workspacePath, "test", "value.test.mjs"),
    'import test from "node:test"; import assert from "node:assert/strict"; test("value",()=>assert.equal(2+2,4));');
  const profile = {
    kind, nodeExecutable: process.execPath,
    nodeSha256: createHash("sha256").update(await readFile(process.execPath)).digest("hex"),
    timeoutMs,
    asset: { schemaVersion: 1, title: "Native assertion", description: "Runs real Node assertions.", version: 1,
      source: source ?? 'import { spawnSync } from "node:child_process"; const r=spawnSync(process.execPath,["--test","--test-isolation=none","--test-reporter=tap","test/value.test.mjs"],{stdio:"inherit",env:process.env}); process.exitCode=r.status ?? 1;' },
  };
  const options = { allowedWorkspaceRoot: path.join(root, "workspaces"), runRoot: path.join(root, "runs"), profiles: { native: profile },
    sourceEnvironment: { SystemRoot: process.env.SystemRoot, WINDIR: process.env.WINDIR, GH_TOKEN: "must-not-leak", NODE_OPTIONS: "--require evil.mjs" } };
  return { root, workspacePath, profile, options, runner: new WindowsFixedTestRunner(options),
    request: { profileId: "native", executionId: "run-one", actionId: "action-one", workspacePath, workspaceRevision: "a".repeat(64) } };
}

async function assertDataRemoved(setup) {
  const directory = setup.runner.executionDirectory("run-one", "action-one");
  await assert.rejects(readFile(path.join(directory, "data", "workspace", "child.pid")), { code: "ENOENT" });
  const cleanup = JSON.parse(await readFile(path.join(directory, "cleanup.json"), "utf8"));
  assert.equal(cleanup.stopConfirmed, true); assert.equal(cleanup.dataRemoved, true); assert.equal(cleanup.profileRemoved, true);
  await readFile(path.join(directory, "result.json"), "utf8");
}

test('settled interrupted Windows preparation exposes only a matching cleanup proof', { skip: process.platform !== 'win32' }, async t => {
  const setup = await fixture(t);
  const { executionId, actionId, profileId } = setup.request;
  const directory = setup.runner.executionDirectory(executionId, actionId);
  await mkdir(directory, { recursive: true });
  const appContainerName = `dih.test.${'a'.repeat(32)}`;
  const documents = {
    'lease.json': { schemaVersion: 1, executionId, actionId, state: 'starting', appContainerName,
      launcher: { pid: 42, processStartTimeUtcTicks: '123456', executableSha256: 'b'.repeat(64) } },
    'pending.json': { executionId, actionId, appContainerName },
    'cleanup.json': { executionId, actionId, stopConfirmed: true, dataRemoved: true, profileRemoved: true },
    'result.json': { error: { code: 'SANDBOX_START_FAILED', message: 'Windows test preparation was interrupted' }, stdout: '', stderr: '' },
  };
  for (const [name, value] of Object.entries(documents)) await writeFile(path.join(directory, name), JSON.stringify(value));
  const request = { executionId, actionId, profileId };
  const proof = await setup.runner.readSettledPreparationFailure(request);
  assert.deepEqual(proof, { executionId, actionId, profileId,
    profileConfigDigest: setup.runner.getProfileFingerprint(profileId), reason: 'preparation_interrupted_cleanup_confirmed' });
  for (const scenario of ['wrong-action', 'not-stopped', 'data-not-removed', 'profile-not-removed', 'completed', 'other-error', 'data-present', 'oversized']) {
    await t.test(scenario, async () => {
      const changed = structuredClone(documents);
      if (scenario === 'wrong-action') changed['cleanup.json'].actionId = 'another-action';
      if (scenario === 'not-stopped') changed['cleanup.json'].stopConfirmed = false;
      if (scenario === 'data-not-removed') changed['cleanup.json'].dataRemoved = false;
      if (scenario === 'profile-not-removed') changed['cleanup.json'].profileRemoved = false;
      if (scenario === 'completed') changed['lease.json'].state = 'completed';
      if (scenario === 'other-error') changed['result.json'].error.code = 'SANDBOX_ABORTED';
      if (scenario === 'oversized') changed['result.json'].stdout = 'x'.repeat(70_000);
      if (scenario === 'data-present') await mkdir(path.join(directory, 'data'));
      for (const [name, value] of Object.entries(changed)) await writeFile(path.join(directory, name), JSON.stringify(value));
      assert.equal(await setup.runner.readSettledPreparationFailure(request), null);
      if (scenario === 'data-present') await rm(path.join(directory, 'data'), { recursive: true });
      for (const [name, value] of Object.entries(documents)) await writeFile(path.join(directory, name), JSON.stringify(value));
    });
  }
  for (const [name, value] of Object.entries(documents)) assert.deepEqual(JSON.parse(await readFile(path.join(directory, name), 'utf8')), value);
  const metadata = path.join(directory, 'cleanup.json'), alias = path.join(setup.root, 'cleanup-alias.json');
  await link(metadata, alias);
  assert.equal(await setup.runner.readSettledPreparationFailure(request), null, 'aliased control metadata is not a cleanup proof');
  await rm(alias);
  assert.deepEqual(await setup.runner.readSettledPreparationFailure(request), proof);
});

test("Windows fixed assets execute real tests in an isolated copy with native identity", { skip: process.platform !== "win32" }, async (t) => {
  const setup = await fixture(t, { source: 'import { writeFileSync } from "node:fs"; if(process.env.GH_TOKEN||process.env.NODE_OPTIONS!=="--preserve-symlinks --preserve-symlinks-main") throw Error("credential leak"); writeFileSync("generated.txt","build output"); import { spawnSync } from "node:child_process"; const r=spawnSync(process.execPath,["--test","--test-isolation=none","--test-reporter=tap","test/value.test.mjs"],{stdio:"inherit",env:process.env}); process.exitCode=r.status??1;' });
  const result = await setup.runner.run(setup.request);
  assert.equal(result.exitCode, 0);
  assert.match(result.stdout, /# pass 1/);
  assert.equal(Object.hasOwn(result, "imageId"), false);
  assert.equal(result.runtimeIdentity.kind, "windows-process");
  assert.equal(result.runtimeIdentity.schemaVersion, 2);
  assert.equal(result.runtimeIdentity.isolation.kind, "windows-lpac");
  assert.equal(result.runtimeIdentity.isolation.noAllApplicationPackages, 1);
  assert.equal(result.runtimeIdentity.isolation.allApplicationPackagesAccessGranted, false);
  assert.ok(result.runtimeIdentity.pid > 0);
  assert.match(result.runtimeIdentity.processStartTimeUtcTicks, /^\d+$/);
  assert.equal(result.runtimeIdentity.executableSha256, setup.profile.nodeSha256);
  assert.equal(result.workspaceRevision, setup.request.workspaceRevision);
  assert.equal(result.assetVersion, 1);
  assert.equal(result.verificationKind, "test");
  await assert.rejects(readFile(path.join(setup.workspacePath, "generated.txt")), { code: "ENOENT" });
  const directory = setup.runner.executionDirectory("run-one", "action-one");
  await assert.rejects(readFile(path.join(directory, "data", "control", "asset.mjs")), { code: "ENOENT" });
  assert.equal(JSON.parse(await readFile(path.join(directory, "cleanup.json"), "utf8")).dataRemoved, true);
  assert.equal(JSON.parse(await readFile(path.join(directory, "result.json"), "utf8")).runtimeIdentity.schemaVersion, 2);
  await new WindowsFixedTestRunner(setup.options).cleanup({ executionId: "run-one", actionId: "action-one" });
});

for (const mode of ["failed-test", "persistent-cleanup", "cancelled-cleanup", "unclassified-cleanup"]) {
  test(`completed Windows profile cleanup preserves the recorded outcome (${mode})`, { skip: process.platform !== "win32" }, async t => {
    const setup = await fixture(t, { source: `console.log("fixed asset finished"); process.exitCode=${mode === "failed-test" ? 7 : 0};` });
    const cleanup = setup.runner.cleanup.bind(setup.runner), controller = new AbortController();
    const cleanupError = new WindowsTestRunnerError("SANDBOX_CLEANUP_FAILED", "Completed profile data remains busy", { cleanupPending: true });
    const unclassifiedError = new Error("unexpected cleanup failure");
    let attempts = 0, cleanupRequest, abortTimer;
    setup.runner.cleanup = async request => {
      cleanupRequest = request;
      attempts += 1;
      const evidence = JSON.parse(await readFile(path.join(setup.runner.executionDirectory(request.executionId, request.actionId), "result.json"), "utf8"));
      assert.equal(evidence.exitCode, mode === "failed-test" ? 7 : 0);
      if (mode === "failed-test" && attempts === 3) return cleanup(request);
      if (mode === "cancelled-cleanup") abortTimer = setTimeout(() => controller.abort(), 25);
      throw mode === "unclassified-cleanup" ? unclassifiedError : cleanupError;
    };
    try {
      const execution = setup.runner.run({ ...setup.request, signal: controller.signal });
      if (mode === "failed-test") {
        const result = await execution;
        assert.equal(result.exitCode, 7);
        assert.equal(attempts, 3);
        await assertDataRemoved(setup);
      } else {
        await assert.rejects(execution, error => error === (mode === "unclassified-cleanup" ? unclassifiedError : cleanupError));
        assert.equal(attempts, mode === "persistent-cleanup" ? 3 : 1);
        await assert.rejects(readFile(path.join(setup.runner.executionDirectory("run-one", "action-one"), "cleanup.json")), { code: "ENOENT" });
      }
    } finally {
      clearTimeout(abortTimer);
      if (cleanupRequest) await cleanup(cleanupRequest);
    }
  });
}

test("actual LPAC blocks imported code, descendants, AAP files, control changes and local network", { skip: process.platform !== "win32" }, async t => {
  const setup = await fixture(t);
  const outside = path.join(setup.root, "private-sentinel.txt");
  const aap = path.join(setup.root, "all-app-packages.txt");
  await writeFile(outside, "private synthetic sentinel"); await writeFile(aap, "AAP synthetic sentinel");
  assert.equal(spawnSync(path.join(process.env.SystemRoot, "System32/icacls.exe"), [aap, "/grant", "*S-1-15-2-1:RX"], { windowsHide: true, stdio: "ignore" }).status, 0);
  let connections = 0;
  const listener = net.createServer(socket => { connections++; socket.end(); });
  await new Promise(resolve => listener.listen(0, "127.0.0.1", resolve));
  t.after(() => listener.close());
  await new Promise((resolve, reject) => { const socket = net.connect(listener.address().port, "127.0.0.1"); socket.resume(); socket.once("end", resolve); socket.once("error", reject); });
  const childScript = `import fs from 'node:fs';let read=false,write=false;try{fs.readFileSync(${JSON.stringify(outside)});read=true;}catch{}try{fs.writeFileSync(${JSON.stringify(outside)},'corrupt');write=true;}catch{}console.log('descendant-boundary:'+JSON.stringify({read,write}));`;
  await writeFile(path.join(setup.workspacePath, "untrusted.mjs"), `import fs from 'node:fs';export function probe(files){return files.map(file=>{let read=false,write=false;try{fs.readFileSync(file);read=true;}catch{}try{fs.writeFileSync(file,'corrupt');write=true;}catch{}return {read,write};});}`);
  await writeFile(path.join(setup.workspacePath, "descendant.mjs"), childScript);
  setup.profile.asset.source = `import fs from 'node:fs';import path from 'node:path';import {pathToFileURL,fileURLToPath} from 'node:url';import {spawnSync} from 'node:child_process';import net from 'node:net';const imported=await import(pathToFileURL(path.join(process.cwd(),'untrusted.mjs')));const files=imported.probe(${JSON.stringify([outside, aap])});const control=fileURLToPath(import.meta.url);const hostConfig=path.resolve(path.dirname(control),'../../configuration.json');const protectedFiles=imported.probe([control,hostConfig]);const acl=spawnSync(path.join(process.env.SystemRoot,'System32/icacls.exe'),[control,'/grant','*S-1-15-2-2:M'],{stdio:'ignore'});const afterAcl=imported.probe([control]);const child=spawnSync(process.execPath,['descendant.mjs'],{stdio:'inherit',env:process.env});const network=await new Promise(resolve=>{const s=net.connect(${listener.address().port},'127.0.0.1',()=>{s.destroy();resolve(true);});s.on('error',()=>resolve(false));s.setTimeout(1000,()=>{s.destroy();resolve(false);});});console.log('boundary:'+JSON.stringify({files,protectedFiles,afterAcl,aclStatus:acl.status,childStatus:child.status,network}));`;
  const runner = new WindowsFixedTestRunner(setup.options);
  const result = await runner.run(setup.request);
  assert.equal(result.exitCode, 0);
  const observed = JSON.parse(result.stdout.match(/\nboundary:([^\n]+)/)?.[1] ?? result.stdout.match(/^boundary:([^\n]+)/)[1]);
  assert.deepEqual(observed.files, [{ read: false, write: false }, { read: false, write: false }]);
  assert.deepEqual(observed.protectedFiles.map(value => value.write), [false, false]);
  assert.equal(observed.protectedFiles[1].read, false);
  assert.equal(observed.afterAcl[0].write, false);
  assert.notEqual(observed.aclStatus, 0);
  assert.equal(observed.childStatus, 0); assert.equal(observed.network, false);
  assert.match(result.stdout, /descendant-boundary:\{"read":false,"write":false\}/);
  assert.equal(connections, 1);
  assert.equal(await readFile(outside, "utf8"), "private synthetic sentinel");
  assert.equal(await readFile(aap, "utf8"), "AAP synthetic sentinel");
});

test("Windows runner rejects commands supplied by a request and changed executable digests", { skip: process.platform !== "win32" }, async (t) => {
  const setup = await fixture(t);
  await assert.rejects(setup.runner.run({ ...setup.request, command: "cmd.exe" }), { code: "INVALID_SANDBOX_REQUEST" });
  const linkedDirectory = path.join(setup.root, "node-installation-link");
  await symlink(path.dirname(process.execPath), linkedDirectory, "junction");
  const linkedRunner = new WindowsFixedTestRunner({ ...setup.options, profiles: { native: { ...setup.profile, nodeExecutable: path.join(linkedDirectory, "node.exe") } } });
  await assert.rejects(linkedRunner.run(setup.request), { code: "SANDBOX_UNAVAILABLE" });
  setup.options.profiles.native.nodeSha256 = "0".repeat(64);
  const runner = new WindowsFixedTestRunner(setup.options);
  await assert.rejects(runner.run(setup.request), { code: "SANDBOX_UNAVAILABLE" });
});

test("Windows runner preserves product failure and kills descendants at normal exit", { skip: process.platform !== "win32" }, async (t) => {
  const setup = await fixture(t, { source: 'import { spawn } from "node:child_process"; const p=spawn(process.execPath,["-e","setInterval(()=>{},1000)"],{stdio:"ignore"}); console.log("child-pid:"+p.pid); p.unref(); console.error("product failed"); process.exitCode=7;' });
  const result = await setup.runner.run(setup.request);
  assert.equal(result.exitCode, 7);
  assert.match(result.stderr, /product failed/);
  const pid = Number(result.stdout.match(/child-pid:(\d+)/)[1]);
  assert.throws(() => process.kill(pid, 0), { code: "ESRCH" });
  await assertDataRemoved(setup);
});

test("fixed asset environment-unavailable exit is distinct from an ordinary product failure", { skip: process.platform !== "win32" }, async (t) => {
  const setup = await fixture(t, { source: 'console.error("fixed compiler dependency missing"); process.exitCode=69;' });
  await assert.rejects(setup.runner.run(setup.request), (error) => error.code === "SANDBOX_UNAVAILABLE" && error.details.stderr.includes("fixed compiler dependency missing"));
  await assertDataRemoved(setup);
});

test("Windows timeout and cancellation return only after supervised process cleanup", { skip: process.platform !== "win32" }, async (t) => {
  for (const cancelled of [false, true]) {
    const setup = await fixture(t, { source: 'import { spawn } from "node:child_process"; import { writeFileSync } from "node:fs"; const child=spawn(process.execPath,["-e","setInterval(()=>{},1000)"],{stdio:"ignore"}); writeFileSync("child.pid",String(child.pid)); setInterval(()=>{},1000);', timeoutMs: cancelled ? 20_000 : 8_000 });
    const controller = new AbortController();
    const pending = setup.runner.run({ ...setup.request, signal: controller.signal });
    pending.catch(() => {});
    const pid = await waitForChild(setup);
    if (cancelled) controller.abort();
    await assert.rejects(pending, { code: cancelled ? "SANDBOX_ABORTED" : "SANDBOX_TIMEOUT" });
    await new WindowsFixedTestRunner(setup.options).cleanup({ executionId: "run-one", actionId: "action-one" });
    assert.throws(() => process.kill(pid, 0), { code: "ESRCH" });
    await assertDataRemoved(setup);
  }
});

async function waitForChild(setup) {
  const file = path.join(setup.runner.executionDirectory("run-one", "action-one"), "data", "workspace", "child.pid");
  for (let attempt = 0; attempt < 150; attempt += 1) {
    try { return Number(await readFile(file, "utf8")); }
    catch (error) { if (error.code !== "ENOENT") throw error; }
    await delay(50);
  }
  assert.fail("The fixed asset never started its real child process");
}

test("Windows pre-aborted execution leaves no cleanup fence", { skip: process.platform !== "win32" }, async (t) => {
  const setup = await fixture(t);
  const controller = new AbortController(); controller.abort();
  await assert.rejects(setup.runner.run({ ...setup.request, signal: controller.signal }), error => {
    assert.equal(error.code, "SANDBOX_ABORTED");
    assert.deepEqual(error.details, { origin: "windows_fixed_prelaunch", notExecuted: true, cleanupPending: false });
    return true;
  });
  await assert.rejects(lstat(setup.runner.executionDirectory("run-one", "action-one")), { code: "ENOENT" });
  await new WindowsFixedTestRunner(setup.options).cleanup({ executionId: "run-one", actionId: "action-one" });
});

test("unknown startup evidence retains action data and fences cleanup", { skip: process.platform !== "win32" }, async t => {
  const setup = await fixture(t);
  const directory = setup.runner.executionDirectory("run-one", "action-one");
  await mkdir(path.join(directory, "data"), { recursive: true });
  await writeFile(path.join(directory, "data", "retained.txt"), "unknown supervisor");
  await writeFile(path.join(directory, "pending.json"), JSON.stringify({ executionId: "run-one", actionId: "action-one", appContainerName: "dih.test." + "a".repeat(32) }));
  await assert.rejects(setup.runner.cleanup({ executionId: "run-one", actionId: "action-one" }), { code: "SANDBOX_CLEANUP_FAILED" });
  assert.equal(await readFile(path.join(directory, "data", "retained.txt"), "utf8"), "unknown supervisor");
});

test("stopped cleanup rejects a replaced data root and never follows descendant junctions", { skip: process.platform !== "win32" }, async t => {
  const setup = await fixture(t, { source: "console.log('finished');" });
  assert.equal((await setup.runner.run(setup.request)).exitCode, 0);
  const data = path.join(setup.runner.executionDirectory("run-one", "action-one"), "data");
  const outside = path.join(setup.root, "outside-cleanup"); await mkdir(outside);
  await writeFile(path.join(outside, "sentinel.txt"), "retain outside data");
  await symlink(outside, data, "junction");
  await assert.rejects(setup.runner.cleanup({ executionId: "run-one", actionId: "action-one" }), { code: "SANDBOX_CLEANUP_FAILED" });
  await rm(data, { recursive: true });
  await mkdir(data); await symlink(outside, path.join(data, "nested-junction"), "junction");
  await setup.runner.cleanup({ executionId: "run-one", actionId: "action-one" });
  assert.equal(await readFile(path.join(outside, "sentinel.txt"), "utf8"), "retain outside data");
});

test("Windows restart cleanup stops only the persisted process tree", { skip: process.platform !== "win32" }, async (t) => {
  const setup = await fixture(t, { source: 'import { spawn } from "node:child_process"; import { writeFileSync } from "node:fs"; const child=spawn(process.execPath,["-e","setInterval(()=>{},1000)"],{stdio:"ignore"}); writeFileSync("child.pid",String(child.pid)); setInterval(()=>{},1000);', timeoutMs: 20_000 });
  const pending = setup.runner.run(setup.request); pending.catch(() => {});
  const pid = await waitForChild(setup);
  const restarted = new WindowsFixedTestRunner(setup.options);
  await restarted.cleanup({ executionId: "run-one", actionId: "action-one" });
  await assert.rejects(pending, { code: "SANDBOX_START_FAILED" });
  assert.throws(() => process.kill(pid, 0), { code: "ESRCH" });
  await assertDataRemoved(setup);
});

test("Windows cleanup fences a reused live PID and never terminates the unrelated process", { skip: process.platform !== "win32" }, async (t) => {
  const setup = await fixture(t);
  const calls = [];
  const runner = new WindowsFixedTestRunner({ ...setup.options, processRunner: { run: async (request) => {
    calls.push(request);
    return { exitCode: 0, stdout: JSON.stringify({ pid: 4321, processStartTimeUtcTicks: String(639013000000000001n), executableSha256: "a".repeat(64) }) };
  } } });
  const directory = runner.executionDirectory("run-one", "action-one");
  await mkdir(directory, { recursive: true });
  const lease = { schemaVersion: 1, state: "running", executionId: "run-one", actionId: "action-one",
    launcher: { pid: 4321, processStartTimeUtcTicks: String(639013000000000000n), executableSha256: "a".repeat(64) } };
  await writeFile(path.join(directory, "lease.json"), JSON.stringify(lease));
  await assert.rejects(runner.cleanup({ executionId: "run-one", actionId: "action-one" }), { code: "SANDBOX_CLEANUP_FAILED" });
  assert.equal(calls.some((request) => request.command.endsWith("taskkill.exe")), false);
  lease.state = "completed";
  await writeFile(path.join(directory, "lease.json"), JSON.stringify(lease));
  await runner.cleanup({ executionId: "run-one", actionId: "action-one" });
  assert.equal(calls.some((request) => request.command.endsWith("taskkill.exe")), false);
});
