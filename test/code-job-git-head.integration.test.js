import assert from "node:assert/strict";
import { execFile as execFileCallback, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import { windowsGitImplementationCandidates } from "../src/lib/windows-git-implementation.js";

import { GitObjectSnapshotter } from "../src/adapters/git-object-snapshotter.js";
import {
  CODE_JOB_ACTIONS_BY_OPERATION,
  createCodeJobGrant,
} from "../src/domain/code-job-contract.js";
import { digestValue } from "../src/domain/code-executor-contract.js";
import { OperationQueue } from "../src/lib/operation-queue.js";
import { StateStore } from "../src/lib/state-store.js";
import { CodeExecutionJournal } from "../src/services/code-execution-journal.js";
import { CodeJobStore } from "../src/services/code-job-store.js";
import { CodeJobWorkerService } from "../src/services/code-job-worker-service.js";
import { CodeWorkspaceBroker } from "../src/services/code-workspace-broker.js";
import { ControlledCodeExecutor } from "../src/services/controlled-code-executor.js";
import { LocalMemoryJournal } from "../src/services/local-memory-journal.js";

const execFile = promisify(execFileCallback);
const WORKSPACE_ID = "dashboard";
const PROFILE_ID = "node-tests";
const PROFILE = Object.freeze({ kind: "git-head-integration" });
const PROFILE_DIGEST = digestValue(PROFILE);

const exclusiveLease = Object.freeze({
  run(operation) {
    return operation();
  },
});

function locateGit() {
  const result = process.platform === "win32"
    ? spawnSync("where.exe", ["git"], { encoding: "utf8", windowsHide: true })
    : spawnSync("which", ["git"], { encoding: "utf8" });
  if (result.status !== 0) return null;
  const candidate = result.stdout.split(/\r?\n/u).find(Boolean);
  if (!candidate || !path.isAbsolute(candidate)) return null;
  if (process.platform !== "win32") return path.resolve(candidate);
  return windowsGitImplementationCandidates(candidate).find(existsSync) ?? null;
}

async function git(gitCommand, cwd, args) {
  return execFile(gitCommand, args, {
    cwd,
    encoding: "utf8",
    env: process.env,
    timeout: 30_000,
    windowsHide: true,
  });
}

function inputBinding(headRefOid) {
  return {
    schemaVersion: 2,
    kind: "pull_request",
    repository: "acme/dashboard",
    pullRequestNumber: 42,
    rootItemId: "github:pr:acme/dashboard#42",
    workKey: "pr:acme/dashboard#42",
    inputRevision: 3,
    headRevision: 2,
    headRefOid,
    eventId: "github-event-pr-42",
    eventDigest: "2".repeat(64),
    inputDigest: "3".repeat(64),
    gitTarget: {
      schemaVersion: 1,
      provider: "github",
      sourceAccountId: "runtime-user",
      baseRepository: "acme/dashboard",
      baseRefName: "main",
      baseRefOid: headRefOid,
      headRepository: "contributor/dashboard",
      headRefName: "fix/conflict",
      headRefOid,
    },
  };
}

function approval(headRefOid) {
  const binding = inputBinding(headRefOid);
  const grant = createCodeJobGrant({
    schemaVersion: 2,
    proposalId: "proposal-git-head-integration",
    contentDigest: "a".repeat(64),
    policyVersion: 1,
    requestedBy: {
      roleId: "developer",
      workItemId: "work-git-head-integration",
    },
    source: {
      assignmentId: "assignment-git-head-integration",
      eventId: binding.eventId,
    },
    subject: {
      id: "github:pr:acme/dashboard#42",
      repository: binding.repository,
      number: binding.pullRequestNumber,
    },
    repository: binding.repository,
    workspaceId: WORKSPACE_ID,
    workspaceAuthorityDigest: "b".repeat(64),
    operation: "modify",
    objective: "Read the exact sealed PR Head before changing code.",
    acceptanceCriteria: ["The worker observes only the sealed commit."],
    evidence: ["The local checkout has moved to another Head."],
    summary: "Inspect the fixed PR source.",
    reason: "PR work must not use the mutable checkout.",
    allowedActions: [...CODE_JOB_ACTIONS_BY_OPERATION.modify],
    writablePaths: ["src"],
    requiredProfiles: [{ id: PROFILE_ID, configDigest: PROFILE_DIGEST }],
    brainDigest: "c".repeat(64),
    inputBinding: binding,
  });
  return {
    confirmationId: "confirmation-git-head-integration",
    requestId: "request-git-head-integration",
    displayedPayloadDigest: "d".repeat(64),
    approvalBindingDigest: "e".repeat(64),
    grant,
  };
}

function attemptExecutionId(sessionId, number) {
  return `attempt-${digestValue({ number, sessionId }).slice(0, 24)}`;
}

class NoopSandbox {
  getProfileFingerprint(profileId) {
    return profileId === PROFILE_ID ? PROFILE_DIGEST : null;
  }

  async run() {
    throw new Error("The fixed-Head read scenario must not run a profile");
  }

  async cleanup() {}
}

const gitCommand = locateGit();

test(
  "sealed grant flows through worker and executor to a real fixed Git Head snapshot",
  { skip: gitCommand === null ? "Git is unavailable" : false },
  async (t) => {
    const root = await mkdtemp(path.join(tmpdir(), "code-job-git-head-"));
    t.after(() => rm(root, { recursive: true, force: true }));
    const sourceRoot = path.join(root, "repository");
    const scratchRoot = path.join(root, "scratch");
    const sourceFile = path.join(sourceRoot, "src", "app.js");
    await mkdir(path.dirname(sourceFile), { recursive: true });
    await writeFile(sourceFile, "sealed PR Head\n");
    await git(gitCommand, sourceRoot, ["init"]);
    await git(gitCommand, sourceRoot, ["config", "user.name", "MyDashboard Test"]);
    await git(gitCommand, sourceRoot, [
      "config",
      "user.email",
      "mydashboard@example.invalid",
    ]);
    await git(gitCommand, sourceRoot, ["add", "--all"]);
    await git(gitCommand, sourceRoot, ["commit", "-m", "sealed PR Head"]);
    const sealedHead = (await git(gitCommand, sourceRoot, ["rev-parse", "HEAD"]))
      .stdout.trim();
    await writeFile(sourceFile, "new checkout Head\n");
    await git(gitCommand, sourceRoot, ["add", "--all"]);
    await git(gitCommand, sourceRoot, ["commit", "-m", "new checkout Head"]);
    await writeFile(sourceFile, "dirty checkout content\n");
    await writeFile(path.join(sourceRoot, "untracked.txt"), "untracked\n");

    const snapshotter = new GitObjectSnapshotter({ gitCommand });
    const boundary = await snapshotter.preflight({ sourceRoot });
    const broker = new CodeWorkspaceBroker({
      scratchRoot,
      gitSnapshotter: snapshotter,
      workspaces: [{
        id: WORKSPACE_ID,
        sourceRoot,
        writablePaths: ["src"],
        gitBoundaryDigest: boundary.boundaryDigest,
        gitExecutableIdentity: {
          gitCommand: boundary.gitCommand,
          gitExecutableSha256: boundary.gitExecutableSha256,
          gitExecutableBytes: boundary.gitExecutableBytes,
          gitExecutableMode: boundary.gitExecutableMode,
          gitExecutableUid: boundary.gitExecutableUid,
          gitExecutableGid: boundary.gitExecutableGid,
        },
      }],
    });
    const store = new StateStore(path.join(root, "state"));
    const memory = new LocalMemoryJournal({
      store,
      exclusiveLease,
      operationQueue: new OperationQueue(),
    });
    await memory.recover();
    const jobs = new CodeJobStore({
      store,
      exclusiveLease,
      operationQueue: new OperationQueue(),
      memoryReceiptVerifier: { verify: memory.verifyReceipt.bind(memory) },
    });
    await jobs.recover();
    const executor = new ControlledCodeExecutor({
      broker,
      sandbox: new NoopSandbox(),
      store,
      journal: new CodeExecutionJournal({
        root: path.join(root, "execution-artifacts"),
      }),
      profileDefinitions: { [PROFILE_ID]: PROFILE },
      requiredProfilesByWorkspace: { [WORKSPACE_ID]: [PROFILE_ID] },
    });
    await executor.recover();
    const verifierCalls = [];
    const brainCalls = [];
    const worker = new CodeJobWorkerService({
      jobStore: jobs,
      executor,
      brainDirectory: {
        async decide(value) {
          brainCalls.push(structuredClone(value));
          return { action: { type: "read_text", path: "src/app.js" } };
        },
      },
      grantVerifier: {
        async verify(grant) {
          verifierCalls.push(structuredClone(grant));
          return structuredClone(grant);
        },
      },
    });
    const created = await jobs.createApprovedJob(approval(sealedHead));

    const cycle = await worker.runCycle({ limit: 1, roleId: "developer" });

    assert.equal(cycle.outcomes.length, 1);
    assert.equal(cycle.outcomes[0].status, "active");
    assert.equal(verifierCalls.length >= 2, true);
    assert.equal(brainCalls.length, 1);
    const session = await executor.view({ sessionId: created.job.jobId });
    assert.deepEqual(session.inputBinding, inputBinding(sealedHead));
    assert.equal(session.actions.length, 1);
    const read = await executor.getActionResult({
      sessionId: session.id,
      actionId: session.actions[0].id,
    });
    assert.equal(read.result.content, "sealed PR Head\n");
    assert.equal(
      await readFile(
        path.join(
          scratchRoot,
          WORKSPACE_ID,
          attemptExecutionId(session.id, session.attempt.number),
          "src",
          "app.js",
        ),
        "utf8",
      ),
      "sealed PR Head\n",
    );
    assert.equal(await readFile(sourceFile, "utf8"), "dirty checkout content\n");
  },
);
