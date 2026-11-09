import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  cp,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { createOperationsRuntime } from "../src/operations-runtime.js";
import {
  applicationWriterGuardName,
  ProcessExclusiveGuard,
} from "../src/lib/process-exclusive-guard.js";

const root = path.resolve(import.meta.dirname, "..");

test("offline restore CLI accepts only manager-authorized fixed project paths", async () => {
  const source = await readFile(
    path.join(root, "scripts", "manage-offline-restore.mjs"),
    "utf8",
  );
  assert.match(source, /MYDASHBOARD_OFFLINE_RESTORE_PROJECT_DIGEST/u);
  assert.match(source, /MYDASHBOARD_OFFLINE_RESTORE_AUTHORITY/u);
  assert.match(source, /requestFromArguments\(process\.argv\.slice\(2\)\)/u);
  assert.match(source, /path\.join\(projectDirectory, "data"\)/u);
  assert.match(source, /path\.join\(projectDirectory, "backups"\)/u);
  assert.match(source, /path\.join\(projectDirectory, "restore-control"\)/u);
  assert.doesNotMatch(source, /process\.env\.(?:HOME|CODEX_HOME)\s*=/u);
  assert.doesNotMatch(source, /child_process|fetch\(|https?:\/\//u);
});

test("offline restore CLI rejects direct invocation before touching data", async () => {
  const environment = { ...process.env };
  delete environment.MYDASHBOARD_OFFLINE_RESTORE_PROJECT_DIGEST;
  delete environment.MYDASHBOARD_OFFLINE_RESTORE_AUTHORITY;
  const result = spawnSync(
    process.execPath,
    [path.join(root, "scripts", "manage-offline-restore.mjs"), "--recover"],
    {
      cwd: root,
      encoding: "utf8",
      env: environment,
      windowsHide: true,
    },
  );
  assert.equal(result.status, 1);
  assert.deepEqual(JSON.parse(result.stdout), {
    schemaVersion: 1,
    ok: false,
    error: { code: "OFFLINE_RESTORE_FAILED" },
  });
});

function digest(value) {
  return createHash("sha256").update(value).digest("hex");
}

test("manager-authorized CLI restores a real backup and is idempotent", async (t) => {
  const fixture = await mkdtemp(path.join(tmpdir(), "offline-restore-cli-"));
  t.after(() => rm(fixture, { recursive: true, force: true }));
  await Promise.all([
    cp(path.join(root, "src"), path.join(fixture, "src"), { recursive: true }),
    mkdir(path.join(fixture, "scripts"), { recursive: true }),
    mkdir(path.join(fixture, "data"), { recursive: true }),
    mkdir(path.join(fixture, "backups"), { recursive: true }),
  ]);
  await Promise.all([
    cp(
      path.join(root, "scripts", "manage-offline-restore.mjs"),
      path.join(fixture, "scripts", "manage-offline-restore.mjs"),
    ),
    writeFile(
      path.join(fixture, "package.json"),
      `${JSON.stringify({ type: "module" })}\n`,
      "utf8",
    ),
  ]);
  const state = Buffer.from('{"schemaVersion":1,"revision":7,"items":[]}\n');
  const artifact = Buffer.from("original artifact\n");
  const statePath = path.join(fixture, "data", "work-ledger.json");
  const executorStatePath = path.join(
    fixture,
    "data",
    "code-executor-state.json",
  );
  const artifactPath = path.join(
    fixture,
    "data",
    "code-executor",
    "artifacts",
    "proof.txt",
  );
  await mkdir(path.dirname(artifactPath), { recursive: true });
  await Promise.all([
    writeFile(statePath, state),
    writeFile(
      executorStatePath,
      `${JSON.stringify({ schemaVersion: 1, revision: 0, sessions: {} })}\n`,
      "utf8",
    ),
    writeFile(artifactPath, artifact),
  ]);
  const operations = createOperationsRuntime({
    dataDirectory: path.join(fixture, "data"),
    backupDirectory: path.join(fixture, "backups"),
  });
  const created = await operations.browser.createBackup();
  await Promise.all([
    writeFile(statePath, '{"revision":8}\n', "utf8"),
    writeFile(
      executorStatePath,
      `${JSON.stringify({ schemaVersion: 2, revision: 9, sessions: {} })}\n`,
      "utf8",
    ),
    writeFile(artifactPath, "newer but unwanted\n", "utf8"),
  ]);
  const canonicalFixture = await realpath(fixture);
  const identity = process.platform === "win32"
    ? canonicalFixture.toUpperCase()
    : canonicalFixture;
  const environment = {
    ...process.env,
    MYDASHBOARD_OFFLINE_RESTORE_PROJECT_DIGEST: digest(identity),
    MYDASHBOARD_OFFLINE_RESTORE_AUTHORITY: "manager-v1",
  };
  const invoke = () => spawnSync(
    process.execPath,
    [
      path.join(fixture, "scripts", "manage-offline-restore.mjs"),
      "--activate",
      created.backupId,
    ],
    { cwd: fixture, encoding: "utf8", env: environment, windowsHide: true },
  );

  const writerLease = new ProcessExclusiveGuard({
    name: applicationWriterGuardName(digest(identity)),
  });
  await writerLease.acquire();
  const blocked = invoke();
  await writerLease.close();
  assert.equal(blocked.status, 1, `${blocked.stderr}\n${blocked.stdout}`);
  assert.deepEqual(JSON.parse(blocked.stdout), {
    schemaVersion: 1,
    ok: false,
    error: { code: "PROCESS_GUARD_HELD" },
  });
  assert.equal(await readFile(statePath, "utf8"), '{"revision":8}\n');
  assert.equal(
    JSON.parse(await readFile(executorStatePath, "utf8")).schemaVersion,
    2,
  );
  assert.equal(await readFile(artifactPath, "utf8"), "newer but unwanted\n");

  const controlDirectory = path.join(fixture, "restore-control");
  await mkdir(controlDirectory, { recursive: true });
  const staleLockPayload = {
    schemaVersion: 1,
    pid: process.pid,
    nonce: "00000000-0000-4000-8000-000000000099",
    acquiredAt: "2026-08-08T00:00:00.000Z",
  };
  await writeFile(
    path.join(controlDirectory, "restore-activation.lock"),
    `${JSON.stringify({
      ...staleLockPayload,
      lockDigest: digest(JSON.stringify(staleLockPayload)),
    })}\n`,
    "utf8",
  );

  const first = invoke();
  assert.equal(first.status, 0, `${first.stderr}\n${first.stdout}`);
  const firstResult = JSON.parse(first.stdout);
  assert.equal(firstResult.ok, true);
  assert.equal(firstResult.result.status, "activated");
  assert.equal(await readFile(statePath, "utf8"), state.toString("utf8"));
  assert.deepEqual(
    JSON.parse(await readFile(executorStatePath, "utf8")),
    { schemaVersion: 3, revision: 0, sessions: {} },
  );
  assert.equal(await readFile(artifactPath, "utf8"), artifact.toString("utf8"));

  const second = invoke();
  assert.equal(second.status, 0, `${second.stderr}\n${second.stdout}`);
  assert.deepEqual(JSON.parse(second.stdout).result, firstResult.result);
});
