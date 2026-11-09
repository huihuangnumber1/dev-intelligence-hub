import assert from "node:assert/strict";
import { execFile as execFileCallback } from "node:child_process";
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import test from "node:test";

import { createApplication } from "../src/composition-root.js";
import { digestValue } from "../src/domain/code-executor-contract.js";
import { StateStore } from "../src/lib/state-store.js";
import { createWorkProposalRuntime } from "../src/work-proposal-runtime.js";
import { beginCodeExecutionSession, isCodeExecutionContext } from "../src/lib/code-execution-context.js";

const execFile = promisify(execFileCallback);
const PROFILE_IMAGE =
  "node:22-alpine@sha256:c610fcdfb1d5b4740dd70c284ed3cb16bb857e0f7166196e36a5501df7a3aa32";
const PROFILE = Object.freeze({
  kind: "node-test",
  image: PROFILE_IMAGE,
  timeoutMs: 30_000,
});
const ORIGINAL_SOURCE = "export const value = 1;\n";
const UPDATED_SOURCE = "export const value = 2;\n";

class TestGuard {
  async acquire() {}

  run(operation) {
    return operation();
  }

  async close() {}
}

class FastSandbox {
  constructor() {
    this.runs = [];
  }

  getProfileFingerprint(profileId) {
    return profileId === "node-tests" ? digestValue(PROFILE) : null;
  }

  async run(request) {
    this.runs.push(structuredClone({
      profileId: request.profileId,
      executionId: request.executionId,
      actionId: request.actionId,
    }));
    return {
      exitCode: 0,
      signal: null,
      stdout: "TAP version 13\nok 1 - test\n1..1\n# tests 1\n# pass 1\n# fail 0\n# cancelled 0\n# skipped 0\n# todo 0",
      stderr: "",
      durationMs: 1,
      imageId: `sha256:${"a".repeat(64)}`,
      profileFingerprint: digestValue(PROFILE),
      timedOut: false,
    };
  }

  async cleanup() {}
}

function guardFactory() {
  return new TestGuard();
}

function fixedBrain({ continuous = false } = {}) {
  const decisions = [
    { type: "read_text", path: "src/app.js" },
    { type: "write_text", path: "src/app.js", content: UPDATED_SOURCE },
    { type: "run_profile" },
    { type: "complete", outcome: "fixed", evidence: ["node-tests"] },
  ];
  return {
    calls: [],
    ...(continuous ? { describe: () => ({ supportsCodeExecution: true, supportsCodeReading: true }) } : {}),
    async decide(input, authorization) {
      await authorization.beforeGenerate();
      this.calls.push(structuredClone(input));
      if (continuous) {
        assert.equal(isCodeExecutionContext(input.codeExecutionContext), true);
        const tools = beginCodeExecutionSession(input.codeExecutionContext);
        const page = await tools.invoke("read_source", { path: "src/app.js", offset: 0 });
        assert.equal(page.text, ORIGINAL_SOURCE);
        assert.equal(page.nextOffset, null);
        const decide = (action) => ({ schemaVersion: 1, confidence: 100, summary: "Fix exported value", reason: "Requested behavior", action });
        await tools.invoke("perform_action", { decision: decide(decisions[1]) });
        const state = await tools.invoke("get_state", {});
        assert.equal(state.capabilities.requiredProfilesRemaining, 1);
        await tools.invoke("perform_action", { decision: decide(decisions[2]) });
        assert.equal((await tools.invoke("get_state", {})).capabilities.requiredProfilesRemaining, 0);
        await tools.close();
        return decide(decisions[3]);
      }
      const action = decisions.shift();
      assert.ok(action, "the code job requested an unexpected extra brain turn");
      return { action };
    },
  };
}

function approvalRequest(item, requestId) {
  return {
    requestId,
    expectedQueueRevision: item.queueRevision,
    expectedItemRevision: item.itemRevision,
    displayedPayloadDigest: item.displayedPayloadDigest,
    approvalBindingDigest: item.approvalBindingDigest,
  };
}

function fixedDeveloperWorker() {
  return {
    roleId: "developer",
    workerId: "fixed-u4-developer",
    async view() {
      return { enabled: true, paused: false };
    },
    async decide() {
      return {
        schemaVersion: 1,
        confidence: 100,
        summary: "A controlled local code change is required.",
        intent: {
          schemaVersion: 1,
          type: "propose_code_action",
          summary: "Update the exported value safely.",
          reason: "The requested behavior requires value two.",
          operation: "modify",
          objective: "Change the exported value from one to two.",
          acceptanceCriteria: ["The fixed node test profile passes."],
          evidence: ["src/app.js still exports one."],
        },
      };
    },
  };
}

function workflowEvent(occurredAt) {
  return {
    schemaVersion: 1,
    eventType: "issue.created",
    occurredAt,
    source: { provider: "github", scopeId: "acme/repo" },
    subject: {
      id: "github:issue:acme/repo#17",
      repository: "acme/repo",
      number: 17,
    },
    payload: {
      number: 17,
      title: "Use the corrected exported value",
    },
  };
}

function workflowRule() {
  return {
    id: "u4-issue-to-developer",
    source: "root",
    enabled: true,
    priority: 100,
    fallback: false,
    condition: {
      op: "equals",
      path: "eventType",
      value: "issue.created",
    },
    targets: [{ type: "role", id: "developer" }],
    onMatch: "stop",
  };
}

function expectedProposalPayload() {
  return {
    operation: "modify",
    objective: "Change the exported value from one to two.",
    acceptanceCriteria: ["The fixed node test profile passes."],
    evidence: ["src/app.js still exports one."],
    summary: "Update the exported value safely.",
    reason: "The requested behavior requires value two.",
  };
}

async function gitExecutable() {
  const locator = process.platform === "win32" ? "where.exe" : "which";
  try {
    const { stdout } = await execFile(locator, ["git"], { windowsHide: true });
    return stdout.split(/\r?\n/u).find(Boolean)?.trim() ?? null;
  } catch (error) {
    if (error?.code === 1 && !error.stdout?.trim()) return null;
    throw error;
  }
}

async function initializeCheckout(git, sourceRoot) {
  const run = (...args) =>
    execFile(git, ["-C", sourceRoot, ...args], { windowsHide: true });
  await run("init");
  await run("config", "user.email", "u4-e2e@example.invalid");
  await run("config", "user.name", "U4 E2E");
  await run("add", ".");
  await run("commit", "-m", "fixture");
}

function applicationConfig(sourceRoot, git) {
  return {
    refreshMinutes: 10,
    trackedRepositories: [],
    prResponsibility: {},
    brain: { enabled: false },
    dingtalk: { enabled: false },
    githubActions: { enabled: false },
    workflowRouting: {
      schemaVersion: 1,
      enabled: true,
      maxHops: 8,
      rules: [workflowRule()],
    },
    workCoordination: {
      enabled: true,
      intakeLimit: 10,
      workLimit: 10,
      dispatchLimit: 10,
      attentionLimit: 10,
      proposalLimit: 10,
      conditionLimit: 10,
      codeJobLimit: 10,
      codeJobMemoryLimit: 10,
      codeJobMaximumTurns: 10,
      codeJobObservationLimit: 10,
      leaseDurationMs: 30_000,
      resolveTimeoutMs: 2_000,
      decisionTimeoutMs: 2_000,
      maxAttempts: 3,
      retryBaseMs: 1_000,
      retryMaxMs: 2_000,
      factMaximumAgeMs: 60_000,
      policy: {
        version: 1,
        capabilityRoles: {},
        githubReviewRoles: [],
        codeActionRoles: ["developer"],
        codeOperationsByRole: { developer: ["modify"] },
        workspaceByRepository: { "acme/repo": "dashboard" },
      },
    },
    memory: {
      enabled: true,
      maximumRecords: 1_000,
      maximumStateBytes: 8 * 1024 * 1024,
    },
    codeExecutor: {
      enabled: true,
      docker: {
        executable: process.execPath,
        host: "npipe:////./pipe/u4-e2e-unused",
      },
      workspaces: [
        {
          id: "dashboard",
          sourceRoot,
          writablePaths: ["src"],
        },
      ],
      profiles: { "node-tests": PROFILE },
      requiredProfilesByWorkspace: { dashboard: ["node-tests"] },
    },
    changePackages: {
      enabled: true,
      gitCommand: git,
      gitTimeoutMs: 10_000,
    },
    brainProviders: {
      ollama: {
        kind: "ollama",
        baseUrl: "http://127.0.0.1:11434",
      },
    },
    employees: {
      prReviewer: { enabled: false },
      roles: {
        developer: {
          brain: {
            provider: "ollama",
            model: "fixed-e2e-brain",
            remoteData: { requirements: false, code: false, memory: false },
          },
          taskBrain: {
            provider: "ollama",
            model: "fixed-e2e-brain",
            remoteData: { requirements: false, code: false, memory: false },
          },
        },
      },
    },
  };
}

for (const continuous of [false, true]) test(`${continuous ? "continuous native turn" : "code action confirmation"} reaches memory and an exactly-once package application`, async (t) => {
  const git = await gitExecutable();
  if (!git) {
    t.skip("git is required for the disposable checkout application boundary");
    return;
  }

  const root = await mkdtemp(path.join(tmpdir(), "code-job-e2e-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const sourceRoot = path.join(root, "checkout");
  await mkdir(path.join(sourceRoot, "src"), { recursive: true });
  await writeFile(path.join(sourceRoot, "src", "app.js"), ORIGINAL_SOURCE);
  await initializeCheckout(git, sourceRoot);

  const store = new StateStore(path.join(root, "state"));
  const sandbox = new FastSandbox();
  const brain = fixedBrain({ continuous });
  const developerWorker = fixedDeveloperWorker();
  let proposalRuntime;
  let now = Date.now();
  const clock = () => new Date(now);
  const application = await createApplication({
    config: applicationConfig(sourceRoot, git),
    store,
    codeExecutorDependencies: {
      runtimeRoot: path.join(root, "code-executor"),
      sourceBaseRoot: root,
      sandbox,
    },
    changePackageRuntimeDependencies: {
      dataDirectory: path.join(root, "change-package-state"),
      packageRoot: path.join(root, "change-packages"),
      createGuard: guardFactory,
      clock,
    },
    codeJobRuntimeDependencies: {
      dataDirectory: path.join(root, "code-job-state"),
      createGuard: guardFactory,
      clock,
    },
    confirmationRuntimeDependencies: {
      dataDirectory: path.join(root, "confirmation-state"),
      createGuard: guardFactory,
      clock,
    },
    workflowRoutingDependencies: { createGuard: guardFactory, clock },
    workLedgerDependencies: { createGuard: guardFactory, clock },
    attentionInboxDependencies: { createGuard: guardFactory, clock },
    workProposalDependencies: {
      createGuard: guardFactory,
      clock,
      idFactory: () => `lease-${now}`,
    },
    memoryRuntimeDependencies: { createGuard: guardFactory },
    workCoordinationDependencies: { clock, workers: [developerWorker] },
    prEngineerExclusiveGuardFactory: guardFactory,
    configuredWorkforceFactory: () => ({ employees: [], workers: [] }),
    codeJobBrainDirectoryFactory: () => brain,
    workProposalRuntimeFactory: async (options) => {
      proposalRuntime = await createWorkProposalRuntime(options);
      return proposalRuntime;
    },
  });
  t.after(() => application.close());

  const runCycle = async ({ includeWork = false } = {}) => {
    const result = await application.workCoordination.runCycle({
      trigger: "u4:e2e",
      includeWork,
      ...(includeWork ? { roleId: "developer" } : {}),
    });
    now += 60_000;
    return result;
  };

  const routed = await application.workflowRouting.ingest({
    event: workflowEvent(clock().toISOString()),
  });
  assert.deepEqual(routed.assignments.map(({ target }) => target), [
    { type: "role", id: "developer" },
  ]);
  const staged = await runCycle({ includeWork: true });
  assert.equal(staged.stages.work.result.staged, 1);
  assert.equal(staged.stages.dispatch.result.delivered, 1);
  let ledgerItem = (await application.workLedgerView.listItems()).items[0];
  assert.equal(ledgerItem.status, "waiting_external");
  assert.equal(ledgerItem.currentTarget.id, "developer");
  const workItemId = ledgerItem.itemId;

  await runCycle();
  const createQueue = await application.confirmationQueue.next();
  assert.equal(createQueue.pendingCount, 1);
  assert.equal(createQueue.item.kind, "local.code-job-create");
  const displayedGrant = createQueue.item.display.payload.action.grant;
  assert.deepEqual(
    Object.fromEntries(
      Object.keys(expectedProposalPayload()).map((key) => [
        key,
        displayedGrant[key],
      ]),
    ),
    expectedProposalPayload(),
  );
  const created = await application.confirmationQueue.approve(
    createQueue.item.id,
    approvalRequest(createQueue.item, "approve-code-job-u4-e2e"),
  );
  assert.equal(created.status, "completed");
  const jobId = created.receipt.id;
  assert.equal(
    await readFile(path.join(sourceRoot, "src", "app.js"), "utf8"),
    ORIGINAL_SOURCE,
  );

  let job = await application.codeJobReader.get(jobId);
  for (let cycle = 0; cycle < 8 && job.status !== "completed"; cycle += 1) {
    await runCycle();
    job = await application.codeJobReader.get(jobId);
  }
  assert.equal(job.status, "completed");
  assert.equal(job.requestedBy.workItemId, workItemId);
  assert.ok(job.memoryProjection);
  assert.equal(brain.calls.length, continuous ? 1 : 4);
  assert.equal(sandbox.runs.length, 1);
  assert.equal(
    await readFile(path.join(sourceRoot, "src", "app.js"), "utf8"),
    ORIGINAL_SOURCE,
  );

  const detail = await application.codeJobReader.getDetail({ jobId });
  assert.deepEqual(
    detail.observations.map(({ actionType }) => actionType),
    ["read_text", "write_text", "run_profile", "complete"],
  );
  assert.equal(detail.changePackage.status, "ready");
  const packageId = detail.changePackage.receipt.packageId;
  await application.memoryProjector.runCycle();
  const memory = await application.memorySearch.search({ q: "代码任务已完成" });
  const completedMemory = memory.items.find(
    ({ source }) => source.kind === "code_job",
  );
  assert.notEqual(completedMemory, undefined);
  assert.equal(completedMemory.repository, "acme/repo");
  // Proposal execution precedes code completion and memory projection within a
  // cycle, so delivery is reconciled on the following cycle.
  await runCycle();
  const proposalResults = await proposalRuntime.consumer.readResultBatch();
  assert.equal(proposalResults.items.length, 1);
  assert.equal(proposalResults.items[0].outcome, "succeeded");
  assert.ok(
    proposalResults.items[0].evidence.includes(
      `memory:${job.memoryProjection.recordId}`,
    ),
  );
  ledgerItem = (await application.workLedgerView.listItems()).items[0];
  assert.equal(ledgerItem.itemId, workItemId);
  assert.equal(ledgerItem.status, "completed");
  assert.equal(ledgerItem.statusReason, "proposal_succeeded");
  assert.equal(ledgerItem.decisionContext.source, "proposal");
  assert.equal(ledgerItem.decisionContext.outcome, "succeeded");

  const applyQueued = await application.changePackageApplicationRequester.request({
    packageId,
    requestedBy: { roleId: "developer", workItemId },
  });
  assert.equal(applyQueued.status, "pending");
  assert.equal(
    await readFile(path.join(sourceRoot, "src", "app.js"), "utf8"),
    ORIGINAL_SOURCE,
  );
  const applyRequest = approvalRequest(
    applyQueued,
    "approve-change-package-u4-e2e",
  );
  const applied = await application.confirmationQueue.approve(
    applyQueued.id,
    applyRequest,
  );
  assert.equal(applied.status, "completed");
  assert.equal(
    await readFile(path.join(sourceRoot, "src", "app.js"), "utf8"),
    UPDATED_SOURCE,
  );
  const repeated = await application.confirmationQueue.approve(
    applyQueued.id,
    applyRequest,
  );
  assert.deepEqual(repeated.receipt, applied.receipt);
  assert.equal(repeated.queueRevision, applied.queueRevision);
  assert.equal(repeated.itemRevision, applied.itemRevision);
  assert.equal(
    await readFile(path.join(sourceRoot, "src", "app.js"), "utf8"),
    UPDATED_SOURCE,
  );
  const durableApplications = await store.read(
    "change-package-applications",
    null,
  );
  assert.equal(durableApplications.applications.length, 1);
  assert.equal(durableApplications.applications[0].status, "applied");
  assert.deepEqual(
    await application.changePackageApplicationReader.getResult(applyQueued.id),
    {
      confirmationId: applyQueued.id,
      status: "applied",
      packageId,
      workspaceId: "dashboard",
      receipt: applied.receipt,
    },
  );

  await runCycle();
  const applicationProjection =
    await application.changePackageApplicationStatusReader.getForJob(jobId);
  assert.equal(applicationProjection.status, "applied");
  assert.deepEqual(applicationProjection.receipt, applied.receipt);
});
