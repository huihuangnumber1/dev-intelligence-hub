import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import {
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
  utimes,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import { setTimeout as wait } from "node:timers/promises";

const execFileAsync = promisify(execFile);

async function detachedFailureFixture(t, prepareLogs = async () => {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), "mydashboard-native-stderr-"));
  t.after(() => rm(root, { force: true, recursive: true, maxRetries: 10, retryDelay: 50 }));
  await mkdir(path.join(root, "scripts"), { recursive: true });
  await copyFile(path.resolve(import.meta.dirname, "../scripts/launch-mydashboard-process.mjs"),
    path.join(root, "scripts/launch-mydashboard-process.mjs"));
  const gate = path.join(root, "launcher-exited");
  const exitStatus = path.join(root, "child-exit.json");
  await writeFile(path.join(root, "scripts/run-managed-dashboard.mjs"), [
    "import { existsSync, writeFileSync } from 'node:fs';",
    "import { setTimeout as wait } from 'node:timers/promises';",
    `process.on('exit', code => writeFileSync(${JSON.stringify(exitStatus)}, JSON.stringify({code})));`,
    `const deadline = Date.now() + 10000; while (!existsSync(${JSON.stringify(gate)}) && Date.now() < deadline) await wait(20);`,
    "throw new Error('NATIVE_STDERR_AFTER_LAUNCHER_EXIT');",
  ].join("\n"));
  const environment = { ...process.env, LOCALAPPDATA: path.join(root, "local"), XDG_RUNTIME_DIR: path.join(root, "runtime") };
  const { stdout } = await execFileAsync(process.execPath,
    ["scripts/launch-mydashboard-process.mjs", "--runtime-info"], { cwd: root, env: environment, windowsHide: true });
  const runtime = JSON.parse(stdout);
  await mkdir(runtime.runtimeDirectory, { recursive: true, mode: 0o700 });
  const logDirectory = path.join(runtime.runtimeDirectory, "logs");
  await prepareLogs(logDirectory);
  const token = randomBytes(32).toString("base64");
  const resultPath = path.join(runtime.runtimeDirectory, `mydashboard-launch-result-${process.pid}-${"a".repeat(32)}.json`);
  await execFileAsync(process.execPath, ["scripts/launch-mydashboard-process.mjs", resultPath], {
    cwd: root, windowsHide: true, env: { ...environment,
      MYDASHBOARD_MANAGED_TOKEN: token,
      MYDASHBOARD_MANAGED_RUNTIME_DIRECTORY: runtime.runtimeDirectory,
      MYDASHBOARD_MANAGED_PROJECT_DIGEST: runtime.projectDigest,
      MYDASHBOARD_MANAGED_CLAIM_TIMEOUT_MS: "10000",
    },
  });
  const launch = JSON.parse(await readFile(resultPath, "utf8"));
  await writeFile(gate, "launcher exited");
  let stopped = false;
  for (let attempt = 0; attempt < 200; attempt += 1) {
    try { process.kill(launch.processId, 0); }
    catch (error) { if (error.code !== "ESRCH") throw error; stopped = true; }
    if (stopped) break;
    await wait(20);
  }
  assert.equal(stopped, true, "wait for the owned child to exit before removing its working directory");
  assert.deepEqual(JSON.parse(await readFile(exitStatus, "utf8")), { code: 1 });
  return { launch, logDirectory, token };
}

test("detached launcher retains fatal stderr after the launcher exits and keeps seven older instances", async (t) => {
  const previous = Array.from({ length: 9 }, () => `node-stderr-${randomUUID()}.log`);
  const { launch, logDirectory, token } = await detachedFailureFixture(t, async directory => {
    await mkdir(directory);
    for (const [index, name] of previous.entries()) {
      const file = path.join(directory, name);
      await writeFile(file, `old instance ${index}`);
      await utimes(file, index + 1, index + 1);
    }
    await writeFile(path.join(directory, "owner.log"), "owner data");
  });
  assert.deepEqual((await readdir(logDirectory)).sort(),
    [...previous.slice(2), `node-stderr-${launch.instanceId}.log`, "owner.log"].sort());
  assert.equal(await readFile(path.join(logDirectory, "owner.log"), "utf8"), "owner data");
  const stderr = await readFile(path.join(logDirectory, `node-stderr-${launch.instanceId}.log`), "utf8");
  assert.match(stderr, /NATIVE_STDERR_AFTER_LAUNCHER_EXIT/);
  assert.equal(stderr.includes(token), false);
});

test("unavailable native diagnostics do not prevent launching or change the child exit", async (t) => {
  const { logDirectory } = await detachedFailureFixture(t, directory => writeFile(directory, "occupied"));
  assert.equal(await readFile(logDirectory, "utf8"), "occupied");
});

async function git(root, ...arguments_) {
  const { stdout } = await execFileAsync("git", arguments_, {
    cwd: root,
    encoding: "utf8",
    windowsHide: true,
  });
  return stdout.trim();
}

async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), "mydashboard-startup-identity-"));
  t.after(() => rm(root, { force: true, recursive: true }));
  await mkdir(path.join(root, "src"), { recursive: true });
  await writeFile(path.join(root, "src/app.js"), "export const version = 1;\n");
  await writeFile(path.join(root, "package.json"), `${JSON.stringify({
    name: "runtime-startup-fixture",
    private: true,
    type: "module",
    files: ["src/"],
  }, null, 2)}\n`);
  await git(root, "init", "--quiet");
  await git(root, "config", "core.autocrlf", "false");
  await git(root, "config", "user.email", "startup@example.invalid");
  await git(root, "config", "user.name", "Startup Fixture");
  await git(root, "add", ".");
  await git(root, "commit", "--quiet", "-m", "startup fixture");
  return root;
}

async function loadStartupIdentity() {
  try {
    return await import("../src/lib/runtime-startup-identity.js");
  } catch (error) {
    assert.fail(`runtime startup identity module is unavailable: ${error.message}`);
  }
}

test("startup identity remains stable across application module loading", async (t) => {
  const root = await fixture(t);
  const {
    captureRuntimeStartupIdentity,
    verifyRuntimeStartupIdentity,
  } = await loadStartupIdentity();

  const captured = await captureRuntimeStartupIdentity(root);

  assert.deepEqual(
    await verifyRuntimeStartupIdentity(root, captured),
    captured,
  );
});

test("startup identity rejects source changed while application modules load", async (t) => {
  const root = await fixture(t);
  const {
    captureRuntimeStartupIdentity,
    verifyRuntimeStartupIdentity,
  } = await loadStartupIdentity();
  const captured = await captureRuntimeStartupIdentity(root);
  await writeFile(path.join(root, "src/app.js"), "export const version = 2;\n");
  await git(root, "add", "src/app.js");
  await git(root, "commit", "--quiet", "-m", "replace application source");

  await assert.rejects(
    verifyRuntimeStartupIdentity(root, captured),
    /runtime source changed while application modules loaded/u,
  );
});

test("startup identity rejects an A-to-B-to-A HEAD transition while modules load", async (t) => {
  const root = await fixture(t);
  const {
    captureRuntimeStartupIdentity,
    verifyRuntimeStartupIdentity,
  } = await loadStartupIdentity();
  const originalHead = await git(root, "rev-parse", "--verify", "HEAD^{commit}");
  const captured = await captureRuntimeStartupIdentity(root);
  await writeFile(path.join(root, "src/app.js"), "export const version = 2;\n");
  await git(root, "add", "src/app.js");
  await git(root, "commit", "--quiet", "-m", "temporary application source");
  await git(root, "reset", "--hard", "--quiet", originalHead);
  assert.equal(
    await git(root, "status", "--porcelain=v1", "--untracked-files=all"),
    "",
  );
  const restored = await captureRuntimeStartupIdentity(root);

  assert.deepEqual(restored, captured);

  await assert.rejects(
    verifyRuntimeStartupIdentity(root, captured),
    /repository history changed while application modules loaded/u,
  );
});

test("managed bootstrap erases control secrets before importing project code", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "mydashboard-managed-bootstrap-"));
  t.after(() => rm(root, { force: true, recursive: true }));
  await mkdir(path.join(root, "scripts"), { recursive: true });
  await mkdir(path.join(root, "src/lib"), { recursive: true });
  await copyFile(
    path.resolve(import.meta.dirname, "../scripts/run-managed-dashboard.mjs"),
    path.join(root, "scripts/run-managed-dashboard.mjs"),
  );
  await writeFile(
    path.join(root, "package.json"),
    `${JSON.stringify({ type: "module" })}\n`,
  );
  const observationPath = path.join(root, "observed-environment.json");
  const managedNames = [
    "MYDASHBOARD_MANAGED_TOKEN",
    "MYDASHBOARD_MANAGED_RUNTIME_DIRECTORY",
    "MYDASHBOARD_MANAGED_PROJECT_DIGEST",
    "MYDASHBOARD_MANAGED_CLAIM_TIMEOUT_MS",
    "MYDASHBOARD_MANAGED_LOG_DIRECTORY",
    "MYDASHBOARD_MANAGED_INSTANCE_ID",
    "MYDASHBOARD_MANAGED_START_IDENTITY",
  ];
  await writeFile(
    path.join(root, "src/lib/runtime-startup-identity.js"),
    [
      "import { writeFile } from 'node:fs/promises';",
      `const names = ${JSON.stringify(managedNames)};`,
      "await writeFile(process.env.MYDASHBOARD_TEST_OBSERVATION, JSON.stringify(Object.fromEntries(names.map((name) => [name, process.env[name] ?? null]))));",
      "export async function captureRuntimeStartupIdentity() { throw new Error('fixture stop'); }",
      "export async function verifyRuntimeStartupIdentity() { throw new Error('unexpected verify'); }",
      "",
    ].join("\n"),
  );

  await assert.rejects(
    execFileAsync(process.execPath, ["scripts/run-managed-dashboard.mjs"], {
      cwd: root,
      env: {
        ...process.env,
        MYDASHBOARD_TEST_OBSERVATION: observationPath,
        ...Object.fromEntries(managedNames.map((name) => [name, `${name}-value`])),
      },
      windowsHide: true,
    }),
    /fixture stop/u,
  );

  assert.deepEqual(
    JSON.parse(await readFile(observationPath, "utf8")),
    Object.fromEntries(managedNames.map((name) => [name, null])),
  );
});
