import assert from "node:assert/strict";
import { execFile as execFileCallback } from "node:child_process";
import { createHash } from "node:crypto";
import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import test from "node:test";

import { createApplication } from "../src/composition-root.js";
import { digestValue } from "../src/domain/code-executor-contract.js";
import { OperationQueue } from "../src/lib/operation-queue.js";
import { StateStore } from "../src/lib/state-store.js";
import {
  CODE_JOB_STATE_KEY,
  CodeJobStore,
} from "../src/services/code-job-store.js";
import { LocalMemoryJournal } from "../src/services/local-memory-journal.js";

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
  #operations = new OperationQueue();

  async acquire() {}

  run(operation) {
    return this.#operations.enqueue(operation);
  }

  async close() {}
}

async function workingTreeSnapshot(root) {
  const snapshot = [];
  async function visit(relativeDirectory) {
    const directory = path.join(
      root,
      ...relativeDirectory.split("/").filter(Boolean),
    );
    const entries = await readdir(directory, { withFileTypes: true });
    entries.sort((left, right) => left.name.localeCompare(right.name, "en"));
    for (const entry of entries) {
      if (relativeDirectory === "" && entry.name === ".git") continue;
      const relativePath = relativeDirectory
        ? `${relativeDirectory}/${entry.name}`
        : entry.name;
      const target = path.join(root, ...relativePath.split("/"));
      const stats = await lstat(target);
      if (stats.isDirectory() && !stats.isSymbolicLink()) {
        snapshot.push(`directory:${relativePath}`);
        await visit(relativePath);
      } else {
        assert.equal(stats.isFile(), true, relativePath);
        const digest = createHash("sha256")
          .update(await readFile(target))
          .digest("hex");
        snapshot.push(`file:${relativePath}:${digest}`);
      }
    }
  }
  await visit("");
  return snapshot;
}

async function readMemoryRecords(journal, recordIds) {
  const orderedIds = [...new Set(recordIds)].sort();
  const items = [];
  for (let index = 0; index < orderedIds.length; index += 20) {
    items.push(...journal.readRecords({
      recordIds: orderedIds.slice(index, index + 20),
    }).items);
  }
  return items;
}

function archivedProjection(details) {
  return details.map(({ job, changePackage }) => ({ job, changePackage }))
    .sort((left, right) => left.job.jobId.localeCompare(right.job.jobId, "en"));
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
      stdout: "TAP version 13\nok 1 - trusted profile\n1..1\n# tests 1\n# pass 1\n# fail 0\n# cancelled 0\n# skipped 0\n# todo 0",
      stderr: "",
      durationMs: 1,
      imageId: `sha256:${"a".repeat(64)}`,
      profileFingerprint: digestValue(PROFILE),
      timedOut: false,
    };
  }

  async cleanup() {}
}

class DeterministicCodeBrain {
  constructor() {
    this.calls = [];
  }

  async decide(input, authorization) {
    await authorization.beforeGenerate();
    this.calls.push(structuredClone(input));
    const actions = input.roleId === "developer"
      ? [
          { type: "read_text", path: "src/value.js" },
          { type: "write_text", path: "src/value.js", content: UPDATED_SOURCE },
          { type: "run_profile" },
          { type: "complete", outcome: "implemented", evidence: ["node-tests"] },
        ]
      : [
          { type: "read_text", path: "src/value.js" },
          { type: "run_profile" },
          { type: "complete", outcome: "verified", evidence: ["node-tests"] },
        ];
    assert.equal(input.roleId === "developer" || input.roleId === "tester", true);
    const action = actions[input.turn - 1];
    assert.ok(action, `unexpected ${input.roleId} Code Job turn ${input.turn}`);
    return { action };
  }
}

function guardFactory() {
  return new TestGuard();
}

async function archiveTerminalJobs({ statePath, clock, jobIds, compactionId }) {
  const store = new StateStore(statePath);
  const jobs = new CodeJobStore({
    store,
    exclusiveLease: new TestGuard(),
    operationQueue: new OperationQueue(),
    clock,
  });
  const recovered = await jobs.recover();
  const before = await store.read(CODE_JOB_STATE_KEY, null);
  assert.ok(before);
  assert.equal(recovered.revision, before.revision);
  assert.deepEqual(
    new Set(before.jobs.map(({ jobId }) => jobId)),
    new Set(jobIds),
  );
  assert.equal(before.jobs.every(({ status }) => status === "completed"), true);
  const targetThroughSequence = Math.max(
    ...before.jobs.map(({ sequence }) => sequence),
  );
  const compacted = await jobs.compactTerminalPrefix({
    compactionId,
    expectedRevision: before.revision,
    targetThroughSequence,
    preArchiveDigest: before.archive.digest,
  });
  assert.equal(compacted.status, "applied");
  assert.equal(compacted.receipt.archived, jobIds.length);
  assert.equal(compacted.receipt.targetThroughSequence, targetThroughSequence);
  assert.match(compacted.receipt.postArchiveDigest, /^[a-f0-9]{64}$/u);
  const after = await store.read(CODE_JOB_STATE_KEY, null);
  assert.equal(after.jobs.length, 0);
  assert.equal(after.archive.jobCount, jobIds.length);
  assert.equal(after.archive.digest, compacted.receipt.postArchiveDigest);
  return { compacted, after };
}

function textResponse(value) {
  return {
    ok: true,
    status: 200,
    body: new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(JSON.stringify(value)));
        controller.close();
      },
    }),
  };
}

function decision(intent, summary = intent.summary) {
  return {
    schemaVersion: 1,
    confidence: 100,
    summary,
    intent,
  };
}

function actionBase(context, source, type, reason) {
  return {
    schemaVersion: 1,
    type,
    sourceTaskId: source.taskId,
    sourceTaskRevision: source.taskRevision ?? source.revision,
    expectedGraphRevision: context.requirements.graph.revision,
    reason,
  };
}

function orchestrate(context, action, summary) {
  return decision({
    schemaVersion: 1,
    type: "orchestrate",
    summary,
    reason: action.reason,
    action,
  }, summary);
}

function acceptanceContract(deliverableId, kind, description) {
  return {
    revision: 1,
    acceptanceCriteria: [{
      criterionId: "verified",
      description: "Trusted production evidence satisfies the assigned task.",
    }],
    expectedDeliverables: [{
      deliverableId,
      kind,
      description,
      required: true,
    }],
  };
}

function childByTitle(context, title) {
  return context.requirements.coordination.directChildren.find(
    ({ work }) => work.title === title,
  );
}

function decompose(context, {
  childKey,
  title,
  capability,
  dependsOn = [],
  contract,
}) {
  const root = context.requirements.currentTask;
  const reason = `Create the ${title} task in the shared Issue graph.`;
  return orchestrate(context, {
    ...actionBase(context, root, "decompose", reason),
    childKey,
    work: {
      title,
      description: `${title} contributes trusted evidence to the same Issue graph.`,
    },
    capability,
    dependsOn: dependsOn.map(({ taskId, taskRevision, revision }) => ({
      taskId,
      revision: taskRevision ?? revision,
    })),
    acceptanceContract: contract,
  }, reason);
}

function decideDelivery(context, child, type) {
  const submitted = child.deliverables.find(({ state }) => state === "submitted");
  const reason = type === "accept_delivery"
    ? `Accept the evidence-bound ${child.work.title} delivery.`
    : `Return the first ${child.work.title} delivery for a repaired verification run.`;
  return orchestrate(context, {
    ...actionBase(context, child, type, reason),
    submittedDeliveryRevision: submitted.submittedDeliveryRevision,
  }, reason);
}

function completeRoot() {
  return decision({
    schemaVersion: 1,
    type: "complete",
    summary: "The Issue closed with accepted requirements, code, and repaired tests.",
    reason: "Every required child has an accepted, production-verified delivery.",
    outcome: "done",
    evidence: [],
  });
}

function orchestrationDecision(context, state) {
  const requirements = childByTitle(context, "Requirements");
  const development = childByTitle(context, "Development");
  const testing = childByTitle(context, "Testing");

  if (!requirements) {
    return decompose(context, {
      childKey: "requirements",
      title: "Requirements",
      capability: "requirements",
      contract: acceptanceContract(
        "requirement-spec",
        "requirement-spec",
        "A versioned requirement specification.",
      ),
    });
  }
  if (requirements.deliverables[0].state === "submitted") {
    return decideDelivery(context, requirements, "accept_delivery");
  }
  if (requirements.status === "completed" && !development) {
    return decompose(context, {
      childKey: "development",
      title: "Development",
      capability: "development",
      dependsOn: [requirements],
      contract: acceptanceContract(
        "implementation",
        "change-package",
        "A content-addressed Code Job change package.",
      ),
    });
  }
  if (development?.deliverables[0].state === "submitted") {
    return decideDelivery(context, development, "accept_delivery");
  }
  if (development?.status === "completed" && !testing) {
    return decompose(context, {
      childKey: "testing",
      title: "Testing",
      capability: "testing",
      dependsOn: [development],
      contract: acceptanceContract(
        "verification",
        "test-report",
        "A Code Job test report bound to the accepted implementation.",
      ),
    });
  }
  if (testing?.deliverables[0].state === "submitted") {
    state.testingReviews += 1;
    if (state.testingReviews === 1) state.testingReworkPending = true;
    return decideDelivery(
      context,
      testing,
      state.testingReviews === 1 ? "return_delivery" : "accept_delivery",
    );
  }
  if (
    [requirements, development, testing].every(
      ({ status }) => status === "completed",
    )
  ) {
    return completeRoot();
  }
  throw new Error("orchestrator was invoked before a specialist handoff was ready");
}

function requirementDraft() {
  return {
    title: "Production Issue acceptance",
    problem: "A real Code Job must back development and verification evidence.",
    requirements: [
      "The source checkout stays unchanged before package-application confirmation.",
      "Development submits only evidence discovered from the production evidence catalog.",
      "A returned test delivery is rerun and replaced before closure.",
    ],
    acceptanceCriteria: [
      "The shared graph reaches one completed terminal outcome.",
      "The terminal work and code records remain locally searchable.",
    ],
    openQuestions: [],
  };
}

function submitDelivery(context, {
  deliverableId,
  summary,
  evidence = [],
  artifact = null,
}) {
  const current = context.requirements.currentTask;
  return decision({
    schemaVersion: 1,
    type: "submit_delivery",
    taskId: current.taskId,
    expectedTaskRevision: current.revision,
    expectedGraphRevision: context.requirements.graph.revision,
    contractRevision: current.acceptanceContract.revision,
    deliverableId,
    summary,
    reason: "The specialist completed the bounded deliverable.",
    evidence,
    artifact,
  });
}

function codeProposal({ operation, objective, evidence, deliverableId }) {
  return decision({
    schemaVersion: 1,
    type: "propose_code_action",
    summary: objective,
    reason: "The specialist requires a controlled local Code Job.",
    operation,
    objective,
    acceptanceCriteria: ["The fixed trusted node profile passes."],
    evidence,
    deliverableId,
  });
}

function authoritativeEvidence(context, kind, state) {
  const records = context.code?.authoritativeEvidence ?? [];
  const currentJobId = context.code?.decisionContext?.value?.evidence
    ?.find((entry) => entry.startsWith("code-job:"))
    ?.slice("code-job:".length);
  const matching = records.filter(({ evidence }) =>
    evidence.kind === kind &&
    (kind !== "test-report" || evidence.referenceId === currentJobId)
  );
  assert.equal(matching.length, 1);
  state.push(structuredClone(matching[0]));
  return matching[0].evidence;
}

function roleDecision(model, context, state) {
  if (model === "command-orchestrator") {
    return orchestrationDecision(context, state);
  }
  if (model === "requirements-brain") {
    return submitDelivery(context, {
      deliverableId: "requirement-spec",
      summary: "The traceable requirement specification is ready.",
      artifact: requirementDraft(),
    });
  }
  if (["development-brain", "development-brain-code-job"].includes(model)) {
    if (context.code?.decisionContext?.source !== "proposal") {
      return codeProposal({
        operation: "modify",
        objective: "Change the exported value from one to two.",
        evidence: ["src/value.js exports one."],
        deliverableId: "implementation",
      });
    }
    return submitDelivery(context, {
      deliverableId: "implementation",
      summary: "The production Code Job change package is ready.",
      evidence: [
        authoritativeEvidence(
          context,
          "change-package",
          state.developmentEvidence,
        ),
      ],
    });
  }
  assert.equal(
    ["testing-brain", "testing-brain-code-job"].includes(model),
    true,
  );
  if (
    context.code?.decisionContext?.source !== "proposal" ||
    state.testingReworkPending
  ) {
    state.testingProposals += 1;
    const rework = context.code?.currentTaskRejection !== undefined;
    assert.equal(rework, state.testingProposals > 1);
    state.testingReworkPending = false;
    return codeProposal({
      operation: "verify",
      objective: rework
        ? "Rerun the repaired acceptance profile after the returned delivery."
        : "Run the initial acceptance profile against the implementation evidence.",
      evidence: [
        rework
          ? "The first verification delivery was returned for rework."
          : "The accepted development dependency requires independent verification.",
      ],
      deliverableId: "verification",
    });
  }
  return submitDelivery(context, {
    deliverableId: "verification",
    summary: state.testingProposals === 1
      ? "The first production test report is ready for review."
      : "The repaired production test report is ready for acceptance.",
    evidence: [
      authoritativeEvidence(context, "test-report", state.testingEvidence),
    ],
  });
}

function issueMemoryDecision(context) {
  return {
    schemaVersion: 1,
    status: "answered",
    claims: context.records
      .filter(({ recordId, labels }) =>
        labels.authority === "raw" &&
        labels.lifecycle === "current" &&
        context.citableRecordIds.includes(recordId)
      )
      .map(({ recordId, title }) => ({
        statement: `${title} is authoritative Issue lifecycle evidence.`,
        citationIds: [recordId],
      })),
  };
}

function createBrainFetch(state) {
  return async (url, options) => {
    const body = JSON.parse(options.body);
    const context = JSON.parse(body.messages[1].content);
    state.brainCalls.push({
      url,
      model: body.model,
      context: structuredClone(context),
    });
    const result = body.model === "issue-memory"
      ? issueMemoryDecision(context)
      : roleDecision(body.model, context, state);
    return textResponse({
      message: { content: JSON.stringify(result) },
    });
  };
}

function role(name, model, allowedIntents, workerId = undefined) {
  return {
    name,
    mission: `${name} advances one bounded part of the shared Issue graph.`,
    enabled: true,
    scheduleMinutes: 0,
    initialPaused: false,
    ...(workerId === undefined ? {} : { workerId }),
    permissions: { allowedIntents },
    brain: {
      provider: "fixture-local",
      model,
      remoteData: { requirements: false, code: false, memory: false },
    },
    ...(allowedIntents.includes("propose_code_action")
      ? {
          taskBrain: {
            provider: "fixture-local",
            model: `${model}-code-job`,
            remoteData: { requirements: false, code: false, memory: false },
          },
        }
      : {}),
  };
}

function applicationConfig(sourceRoot, git) {
  return {
    port: 4173,
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
      rules: [{
        id: "u12-issue-to-command-orchestrator",
        source: "root",
        enabled: true,
        priority: 100,
        fallback: false,
        condition: { op: "equals", path: "eventType", value: "issue.created" },
        targets: [{ type: "role", id: "orchestrator" }],
        onMatch: "stop",
      }],
    },
    workCoordination: {
      enabled: true,
      intakeLimit: 20,
      workLimit: 20,
      dispatchLimit: 20,
      attentionLimit: 20,
      proposalLimit: 20,
      conditionLimit: 20,
      codeJobLimit: 20,
      codeJobMemoryLimit: 20,
      codeJobMaximumTurns: 10,
      codeJobObservationLimit: 10,
      leaseDurationMs: 60_000,
      resolveTimeoutMs: 5_000,
      decisionTimeoutMs: 5_000,
      maxAttempts: 3,
      retryBaseMs: 1_000,
      retryMaxMs: 2_000,
      factMaximumAgeMs: 60_000,
      policy: {
        version: 2,
        capabilityRoles: {
          requirements: "requirements-analyst",
          development: "developer",
          testing: "tester",
        },
        githubReviewRoles: [],
        codeActionRoles: ["developer", "tester"],
        codeOperationsByRole: {
          developer: ["modify"],
          tester: ["verify"],
        },
        workspaceByRepository: { "acme/command-center": "dashboard" },
      },
    },
    memory: {
      enabled: true,
      maximumRecords: 2_000,
      maximumStateBytes: 16 * 1024 * 1024,
      answering: {
        enabled: true,
        brain: {
          provider: "fixture-local",
          model: "issue-memory",
          remoteData: { requirements: false, code: false, memory: false },
        },
        localBrain: {
          provider: "fixture-local",
          model: "issue-memory",
          remoteData: { requirements: false, code: false, memory: false },
        },
        maximumRecords: 20,
        maximumContextBytes: 112 * 1024,
        maximumConcurrent: 1,
      },
    },
    codeExecutor: {
      enabled: true,
      docker: {
        executable: process.execPath,
        host: "npipe:////./pipe/u12-e2e-unused",
      },
      workspaces: [{
        id: "dashboard",
        sourceRoot,
        writablePaths: ["src"],
      }],
      profiles: { "node-tests": PROFILE },
      requiredProfilesByWorkspace: { dashboard: ["node-tests"] },
    },
    changePackages: {
      enabled: true,
      gitCommand: git,
      gitTimeoutMs: 10_000,
    },
    brainProviders: {
      "fixture-local": {
        kind: "ollama",
        baseUrl: "http://127.0.0.1:11434",
      },
    },
    employees: {
      prReviewer: { enabled: false },
      roles: {
        orchestrator: role(
          "Command orchestrator",
          "command-orchestrator",
          ["orchestrate", "complete"],
          "employee-orchestrator",
        ),
        "requirements-analyst": role(
          "Requirements analyst",
          "requirements-brain",
          ["submit_delivery"],
        ),
        developer: role(
          "Developer",
          "development-brain",
          ["propose_code_action", "submit_delivery"],
        ),
        tester: role(
          "Tester",
          "testing-brain",
          ["propose_code_action", "submit_delivery"],
        ),
      },
    },
  };
}

function issueEvent(occurredAt) {
  return {
    schemaVersion: 1,
    eventType: "issue.created",
    occurredAt,
    source: { provider: "github", scopeId: "u12-production-local-fixture" },
    subject: {
      id: "github:issue:acme/command-center#1201",
      repository: "acme/command-center",
      number: 1201,
    },
    payload: {
      number: 1201,
      title: "Production Issue Code Job acceptance",
      description: "Coordinate requirements, controlled implementation, failed verification, and rework.",
      state: "OPEN",
      labels: ["command-center", "acceptance"],
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
  await run("config", "user.email", "u12-e2e@example.invalid");
  await run("config", "user.name", "U12 E2E");
  await run("add", ".");
  await run("commit", "-m", "fixture");
}

function graphTaskByTitle(snapshot, title) {
  const taskState = snapshot.taskStates.find(({ work }) => work.title === title);
  return taskState === undefined
    ? null
    : snapshot.graph.tasks.find(({ taskId }) => taskId === taskState.taskId);
}

test("a production-composed Issue survives confirmation restart and closes on real Code Job evidence", async (t) => {
  const git = await gitExecutable();
  if (!git) {
    t.skip("git is required for the disposable production Issue fixture");
    return;
  }

  const root = await mkdtemp(path.join(tmpdir(), "u12-production-issue-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const sourceRoot = path.join(root, "checkout");
  await mkdir(path.join(sourceRoot, "src"), { recursive: true });
  await writeFile(path.join(sourceRoot, "src", "value.js"), ORIGINAL_SOURCE);
  await initializeCheckout(git, sourceRoot);

  const paths = {
    state: path.join(root, "state"),
    executor: path.join(root, "code-executor"),
    packages: path.join(root, "change-packages"),
    packageState: path.join(root, "change-package-state"),
    jobs: path.join(root, "code-job-state"),
    confirmations: path.join(root, "confirmation-state"),
  };
  const sandbox = new FastSandbox();
  const codeBrain = new DeterministicCodeBrain();
  const state = {
    brainCalls: [],
    developmentEvidence: [],
    testingEvidence: [],
    testingProposals: 0,
    testingReviews: 0,
    testingReworkPending: false,
  };
  let now = Date.parse("2026-08-08T02:00:00.000Z");
  const clock = () => new Date(now);
  const tick = () => {
    now += 60_000;
  };
  let application = null;

  const create = () => createApplication({
    config: applicationConfig(sourceRoot, git),
    versionedConfiguration: false,
    externalActions: true,
    store: new StateStore(paths.state),
    operationsRuntimeFactory: () => Object.freeze({}),
    codeExecutorDependencies: {
      runtimeRoot: paths.executor,
      sourceBaseRoot: root,
      sandbox,
    },
    changePackageRuntimeDependencies: {
      dataDirectory: paths.packageState,
      packageRoot: paths.packages,
      createGuard: guardFactory,
      clock,
    },
    codeJobRuntimeDependencies: {
      dataDirectory: paths.jobs,
      createGuard: guardFactory,
      clock,
    },
    confirmationRuntimeDependencies: {
      dataDirectory: paths.confirmations,
      createGuard: guardFactory,
      clock,
    },
    workflowRoutingDependencies: { createGuard: guardFactory, clock },
    workLedgerDependencies: { createGuard: guardFactory, clock },
    attentionInboxDependencies: { createGuard: guardFactory, clock },
    workProposalDependencies: { createGuard: guardFactory, clock },
    memoryRuntimeDependencies: { createGuard: guardFactory },
    memoryAnswerDependencies: {
      brainDependencies: { fetch: createBrainFetch(state) },
    },
    workCoordinationDependencies: {
      clock,
      brainDependencies: { fetch: createBrainFetch(state) },
    },
    prEngineerExclusiveGuardFactory: guardFactory,
    codeJobBrainDirectoryFactory: () => codeBrain,
  });
  t.after(async () => application?.close());
  application = await create();

  const runRole = async (roleId) => {
    const result = await application.workCoordination.runCycle({
      trigger: `u12:${roleId}`,
      includeWork: true,
      roleId,
    });
    tick();
    return result;
  };
  const runHousekeeping = async () => {
    const result = await application.workCoordination.runCycle({
      trigger: "u12:housekeeping",
      includeWork: false,
    });
    tick();
    return result;
  };
  const sourceText = () => readFile(
    path.join(sourceRoot, "src", "value.js"),
    "utf8",
  );
  const waitForProposalEvidence = async (title) => {
    for (let cycle = 0; cycle < 15; cycle += 1) {
      await runHousekeeping();
      const snapshot = await application.workGraphView.getSnapshot();
      const taskId = snapshot.taskStates.find(
        ({ work }) => work.title === title,
      )?.taskId;
      const ledger = await application.workLedgerView.listItems({ limit: 20 });
      const item = ledger.items.find((candidate) => candidate.itemId === taskId);
      if (
        item?.status === "queued" &&
        item.statusReason === "proposal_evidence_ready"
      ) {
        return item;
      }
    }
    assert.fail(`${title} did not recover authoritative Code Job evidence`);
  };
  const queueCodeJob = async (requestId) => {
    await runHousekeeping();
    const next = await application.confirmationQueue.next();
    assert.equal(next.pendingCount, 1);
    assert.equal(next.item.kind, "local.code-job-create");
    assert.equal(await sourceText(), ORIGINAL_SOURCE);
    const before = await application.codeJobReader.list({ limit: 20 });
    const request = approvalRequest(next.item, requestId);
    const approved = await application.confirmationQueue.approve(
      next.item.id,
      request,
    );
    assert.equal(approved.status, "completed");
    assert.equal(await sourceText(), ORIGINAL_SOURCE);
    return { next, request, approved, jobCountBefore: before.total };
  };

  const event = issueEvent(clock().toISOString());
  const routed = await application.workflowRouting.ingest({ event });
  assert.deepEqual(routed.assignments.map(({ target }) => target), [
    { type: "role", id: "orchestrator" },
  ]);

  await runRole("orchestrator");
  await runRole("requirements-analyst");
  await runRole("orchestrator");
  await runRole("orchestrator");
  await runRole("developer");

  const developerConfirmation = await queueCodeJob("approve-u12-development");
  assert.equal(developerConfirmation.jobCountBefore, 0);
  assert.equal(sandbox.runs.length, 0);
  const developerJobId = developerConfirmation.approved.receipt.id;
  assert.equal(
    (await application.codeJobReader.get(developerJobId)).status,
    "queued",
  );

  await application.close();
  application = await create();
  const routedReplay = await application.workflowRouting.ingest({ event });
  assert.equal(routedReplay.deduplicated, true);
  assert.deepEqual(routedReplay.event, routed.event);
  assert.deepEqual(routedReplay.assignments, routed.assignments);
  const confirmationReplay = await application.confirmationQueue.approve(
    developerConfirmation.next.item.id,
    developerConfirmation.request,
  );
  assert.deepEqual(confirmationReplay.receipt, developerConfirmation.approved.receipt);
  assert.equal(confirmationReplay.queueRevision, developerConfirmation.approved.queueRevision);
  assert.equal(confirmationReplay.itemRevision, developerConfirmation.approved.itemRevision);
  assert.equal((await application.codeJobReader.list({ limit: 20 })).total, 1);
  assert.equal(sandbox.runs.length, 0);
  assert.equal(await sourceText(), ORIGINAL_SOURCE);

  await waitForProposalEvidence("Development");
  assert.equal(await sourceText(), ORIGINAL_SOURCE);
  await runRole("developer");
  await runRole("orchestrator");
  await runRole("orchestrator");
  await runRole("tester");

  const firstTestConfirmation = await queueCodeJob("approve-u12-test-first");
  assert.equal(firstTestConfirmation.jobCountBefore, 1);
  const firstTestReplay = await application.confirmationQueue.approve(
    firstTestConfirmation.next.item.id,
    firstTestConfirmation.request,
  );
  assert.deepEqual(firstTestReplay.receipt, firstTestConfirmation.approved.receipt);
  await waitForProposalEvidence("Testing");
  await runRole("tester");
  await runRole("orchestrator");
  await runRole("tester");

  const secondTestConfirmation = await queueCodeJob("approve-u12-test-rework");
  assert.equal(secondTestConfirmation.jobCountBefore, 2);
  const secondTestReplay = await application.confirmationQueue.approve(
    secondTestConfirmation.next.item.id,
    secondTestConfirmation.request,
  );
  assert.deepEqual(secondTestReplay.receipt, secondTestConfirmation.approved.receipt);
  await waitForProposalEvidence("Testing");
  await runRole("tester");
  await runRole("orchestrator");
  await runRole("orchestrator");

  assert.equal(await sourceText(), ORIGINAL_SOURCE);
  const jobs = await application.codeJobReader.list({ limit: 20 });
  assert.equal(jobs.total, 3);
  assert.equal(jobs.items.every(({ status }) => status === "completed"), true);
  const developerJob = jobs.items.find(({ jobId }) => jobId === developerJobId);
  assert.equal(developerJob.operation, "modify");
  assert.equal(
    jobs.items.filter(({ operation }) => operation === "verify").length,
    2,
  );
  assert.equal(codeBrain.calls.filter(({ roleId }) => roleId === "developer").length, 4);
  assert.equal(codeBrain.calls.filter(({ roleId }) => roleId === "tester").length, 6);
  assert.equal(sandbox.runs.length, 3);

  const developerDetail = await application.codeJobReader.getDetail({
    jobId: developerJobId,
  });
  assert.deepEqual(
    developerDetail.observations.map(({ actionType }) => actionType),
    ["read_text", "write_text", "run_profile", "complete"],
  );
  assert.equal(developerDetail.changePackage.status, "ready");
  const packageReceipt = developerDetail.changePackage.receipt;
  const manifest = await application.changePackageReader.get(
    packageReceipt.packageId,
  );
  assert.equal(manifest.packageDigest, packageReceipt.packageDigest);
  assert.deepEqual(
    manifest.changes.modified.map(({ path: changedPath }) => changedPath),
    ["src/value.js"],
  );
  assert.deepEqual(
    manifest.passedProfiles.map(({ id }) => id),
    ["node-tests"],
  );
  assert.deepEqual(state.developmentEvidence, [{
    deliverableId: "implementation",
    evidence: {
      kind: "change-package",
      referenceId: packageReceipt.packageId,
      contentDigest: packageReceipt.packageDigest,
    },
  }]);
  assert.equal(state.testingEvidence.length, 2);
  assert.equal(
    state.testingEvidence.every(
      ({ deliverableId, evidence }) =>
        deliverableId === "verification" &&
        evidence.kind === "test-report" &&
        jobs.items.some(({ jobId }) => jobId === evidence.referenceId),
    ),
    true,
  );
  assert.notEqual(
    state.testingEvidence[0].evidence.referenceId,
    state.testingEvidence[1].evidence.referenceId,
  );

  const snapshot = await application.workGraphView.getSnapshot();
  assert.equal(snapshot.graph.tasks.length, 4);
  assert.equal(snapshot.graph.tasks.every(({ status }) => status === "completed"), true);
  const requirements = graphTaskByTitle(snapshot, "Requirements");
  const development = graphTaskByTitle(snapshot, "Development");
  const testing = graphTaskByTitle(snapshot, "Testing");
  assert.deepEqual(development.dependsOn, [requirements.taskId]);
  assert.deepEqual(testing.dependsOn, [development.taskId]);
  assert.deepEqual(
    testing.deliveries.map(({ status }) => status),
    ["submitted", "rejected", "submitted", "accepted"],
  );
  assert.deepEqual(
    testing.deliveries
      .filter(({ status }) => status === "submitted")
      .map(({ evidence }) => evidence[0]),
    state.testingEvidence.map(({ evidence }) => evidence),
  );

  await application.memoryProjector.runCycle();
  const workMemory = await application.memorySearch.search({
    q: "Production Issue Code Job acceptance",
    limit: 50,
  });
  assert.equal(
    workMemory.items.some(
      ({ source, event: eventType }) =>
        source.kind === "work-item" && eventType === "work.completed",
    ),
    true,
  );
  const deliveryMemory = await application.memorySearch.search({
    q: "Testing",
    eventType: "work.delivery_accepted",
    limit: 20,
  });
  assert.equal(
    deliveryMemory.items.some(({ source }) => source.kind === "work-delivery"),
    true,
  );
  const codeMemory = await application.memorySearch.search({
    q: "代码任务已完成",
    limit: 20,
  });
  assert.equal(
    codeMemory.items.filter(({ source }) => source.kind === "code_job").length,
    3,
  );

  const applyQueued = await application.changePackageApplicationRequester.request({
    packageId: packageReceipt.packageId,
    requestedBy: { roleId: "developer", workItemId: development.taskId },
  });
  assert.equal(applyQueued.status, "pending");
  assert.equal(await sourceText(), ORIGINAL_SOURCE);
  const applyRequest = approvalRequest(applyQueued, "approve-u12-package-apply");
  const applied = await application.confirmationQueue.approve(
    applyQueued.id,
    applyRequest,
  );
  assert.equal(applied.status, "completed");
  assert.equal(await sourceText(), UPDATED_SOURCE);
  const appliedReplay = await application.confirmationQueue.approve(
    applyQueued.id,
    applyRequest,
  );
  assert.deepEqual(appliedReplay.receipt, applied.receipt);
  assert.equal(appliedReplay.queueRevision, applied.queueRevision);
  assert.equal(appliedReplay.itemRevision, applied.itemRevision);
  const durableApplications = await application.store.read(
    "change-package-applications",
    null,
  );
  assert.equal(durableApplications.applications.length, 1);
  assert.equal(durableApplications.applications[0].status, "applied");

  const assignments = await application.workflowRouting.listAssignments({
    limit: 20,
  });
  assert.equal(assignments.items.length, 1);
  const ledger = await application.workLedgerView.listItems({ limit: 20 });
  assert.equal(ledger.items.length, 4);
  assert.equal(ledger.items.every(({ status }) => status === "completed"), true);

  const finalCodeJobIds = (await application.codeJobReader.list({
    limit: 20,
  })).items.map(({ jobId }) => jobId);
  assert.equal(finalCodeJobIds.length, 3);
  const finalCodeJobDetails = await Promise.all(finalCodeJobIds.map((jobId) =>
    application.codeJobReader.getDetail({ jobId })
  ));
  const finalMemoryJournal = new LocalMemoryJournal({
    store: application.store,
    exclusiveLease: new TestGuard(),
  });
  await finalMemoryJournal.recover();
  const memoryRecordIds = [
    ...workMemory.items,
    ...deliveryMemory.items,
    ...codeMemory.items,
  ].map(({ id }) => id);
  const stateBeforeFinalArchive = {
    routed: structuredClone(routed),
    assignments: structuredClone(assignments),
    graph: await application.workGraphView.getSnapshot(),
    ledger: structuredClone(ledger),
    memoryRecords: await readMemoryRecords(finalMemoryJournal, memoryRecordIds),
    confirmationHistory: await application.confirmationQueue.historyReader.list({
      limit: 50,
    }),
    packageManifest: await application.changePackageReader.get(
      packageReceipt.packageId,
    ),
    codeJobs: archivedProjection(finalCodeJobDetails),
    brainCalls: structuredClone(state.brainCalls),
    codeBrainCalls: structuredClone(codeBrain.calls),
    sandboxRuns: structuredClone(sandbox.runs),
    sourceTree: await workingTreeSnapshot(sourceRoot),
    applications: structuredClone(durableApplications.applications),
  };
  await application.close();
  const finalCompaction = await archiveTerminalJobs({
    statePath: paths.state,
    clock,
    jobIds: finalCodeJobIds,
    compactionId: "u12-final-terminal-prefix",
  });
  assert.equal(finalCompaction.after.archive.throughSequence, 3);
  application = await create();
  const archivedDetails = await Promise.all(finalCodeJobIds.map((jobId) =>
    application.codeJobReader.getDetail({ jobId })
  ));
  assert.equal(
    archivedDetails.every(({ archived }) => archived === true),
    true,
  );
  assert.equal(
    archivedDetails.every(({ historyAvailable, observations }) =>
      historyAvailable === false && observations.length === 0
    ),
    true,
  );
  assert.ok(finalCodeJobDetails.some(({ terminalDetail }) => terminalDetail?.completionReport));
  for (const { job, terminalDetail } of archivedDetails) {
    const original = finalCodeJobDetails.find(({ job: before }) => before.jobId === job.jobId);
    const report = original.terminalDetail?.completionReport;
    assert.deepEqual(terminalDetail, report ? {
      schemaVersion: 1,
      outcome: original.terminalDetail.outcome,
      completedActionId: original.terminalDetail.completedActionId,
      workspaceRevision: original.terminalDetail.workspaceRevision,
      evidence: original.terminalDetail.evidence,
      completionReport: report,
    } : null);
  }
  const archivedDeveloper = archivedDetails.find(
    ({ job }) => job.jobId === developerJobId,
  );
  assert.equal(archivedDeveloper.changePackage.status, "ready");
  assert.deepEqual(archivedDeveloper.changePackage.receipt, packageReceipt);
  assert.deepEqual(
    archivedProjection(archivedDetails),
    stateBeforeFinalArchive.codeJobs,
  );
  const liveJobsAfterArchive = await application.codeJobReader.list({ limit: 20 });
  assert.equal(liveJobsAfterArchive.total, 0);
  assert.deepEqual(liveJobsAfterArchive.items, []);

  const replayAfterArchive = await application.workflowRouting.ingest({ event });
  assert.equal(replayAfterArchive.deduplicated, true);
  assert.deepEqual(replayAfterArchive.event, stateBeforeFinalArchive.routed.event);
  assert.deepEqual(
    replayAfterArchive.assignments,
    stateBeforeFinalArchive.routed.assignments,
  );
  const recoveredSnapshot = await application.workGraphView.getSnapshot();
  assert.deepEqual(recoveredSnapshot, stateBeforeFinalArchive.graph);
  assert.deepEqual(
    await application.workflowRouting.listAssignments({ limit: 20 }),
    stateBeforeFinalArchive.assignments,
  );
  const recoveredLedger = await application.workLedgerView.listItems({ limit: 20 });
  assert.deepEqual(recoveredLedger, stateBeforeFinalArchive.ledger);
  const recoveredApplications = await application.store.read(
    "change-package-applications",
    null,
  );
  assert.deepEqual(
    recoveredApplications.applications,
    stateBeforeFinalArchive.applications,
  );
  const recoveredManifest = await application.changePackageReader.get(
    packageReceipt.packageId,
  );
  assert.deepEqual(recoveredManifest, stateBeforeFinalArchive.packageManifest);
  assert.deepEqual(
    await application.confirmationQueue.historyReader.list({ limit: 50 }),
    stateBeforeFinalArchive.confirmationHistory,
  );
  const recoveredWorkMemory = await application.memorySearch.search({
    q: "Production Issue Code Job acceptance",
    limit: 50,
  });
  assert.deepEqual(recoveredWorkMemory, workMemory);
  const recoveredDeliveryMemory = await application.memorySearch.search({
    q: "Testing",
    eventType: "work.delivery_accepted",
    limit: 20,
  });
  assert.deepEqual(recoveredDeliveryMemory, deliveryMemory);
  const recoveredCodeMemory = await application.memorySearch.search({
    q: "代码任务已完成",
    limit: 20,
  });
  assert.deepEqual(recoveredCodeMemory, codeMemory);
  const recoveredMemoryJournal = new LocalMemoryJournal({
    store: application.store,
    exclusiveLease: new TestGuard(),
  });
  await recoveredMemoryJournal.recover();
  const recoveredCodeJobMemory = await readMemoryRecords(
    recoveredMemoryJournal,
    memoryRecordIds,
  );
  assert.deepEqual(
    recoveredCodeJobMemory,
    stateBeforeFinalArchive.memoryRecords,
  );
  assert.deepEqual(state.brainCalls, stateBeforeFinalArchive.brainCalls);
  assert.deepEqual(codeBrain.calls, stateBeforeFinalArchive.codeBrainCalls);
  assert.deepEqual(sandbox.runs, stateBeforeFinalArchive.sandboxRuns);
  assert.deepEqual(
    await workingTreeSnapshot(sourceRoot),
    stateBeforeFinalArchive.sourceTree,
  );
  assert.deepEqual(
    await application.store.read("change-package-applications", null)
      .then(({ applications }) => applications),
    stateBeforeFinalArchive.applications,
  );
  const answerFilters = {
    query: "Production Issue Code Job acceptance",
    eventType: "work.completed",
  };
  const expectedAnswerSearch = await application.memorySearch.search({
    q: answerFilters.query,
    eventType: answerFilters.eventType,
    limit: 20,
  });
  assert.equal(expectedAnswerSearch.items.length > 0, true);
  const expectedAnswerContext = recoveredMemoryJournal.readRecords({
    recordIds: expectedAnswerSearch.items.map(({ id }) => id),
  });
  const expectedRecordIds = expectedAnswerContext.items.map(
    ({ record }) => record.recordId,
  );
  const expectedCitableIds = expectedAnswerContext.items
    .filter(({ labels }) =>
      labels.authority === "raw" && labels.lifecycle === "current"
    )
    .map(({ record }) => record.recordId);
  assert.equal(expectedCitableIds.length > 0, true);
  assert.deepEqual(expectedCitableIds, expectedRecordIds);
  const recoveredAnswer = await application.memoryAnswer.answer({
    schemaVersion: 1,
    question: "What evidence completed the production Issue lifecycle?",
    mode: "local",
    retrieval: {
      kind: "query",
      filters: answerFilters,
    },
  });
  assert.equal(recoveredAnswer.status, "answered");
  const actualCitationIds = recoveredAnswer.citations.map(
    ({ recordId }) => recordId,
  );
  assert.equal(actualCitationIds.length, expectedCitableIds.length);
  assert.equal(new Set(actualCitationIds).size, actualCitationIds.length);
  assert.deepEqual(
    new Set(actualCitationIds),
    new Set(expectedCitableIds),
  );
  assert.equal(
    recoveredAnswer.citations.every(({ labels }) =>
      labels.authority === "raw" && labels.lifecycle === "current"
    ),
    true,
  );
  assert.deepEqual(recoveredAnswer.context.recordIds, expectedRecordIds);
  assert.deepEqual(
    recoveredAnswer.context.citableRecordIds,
    expectedCitableIds,
  );
  assert.equal(
    state.brainCalls.length,
    stateBeforeFinalArchive.brainCalls.length + 1,
  );
  const memoryCall = state.brainCalls.at(-1);
  assert.equal(memoryCall.model, "issue-memory");
  assert.deepEqual(memoryCall.context.citableRecordIds, expectedCitableIds);
  assert.deepEqual(
    memoryCall.context.records.map(({ recordId, labels }) => ({ recordId, labels })),
    expectedAnswerContext.items.map(({ record, labels }) => ({
      recordId: record.recordId,
      labels,
    })),
  );
});
