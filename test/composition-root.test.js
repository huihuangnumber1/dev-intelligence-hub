import assert from "node:assert/strict";
import {
  access,
  mkdir,
  lstat,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { ownReviewFeedbackDigest } from "../src/adapters/github-own-review-feedback.js";
import { GitHubReviewReader } from "../src/adapters/github-review-reader.js";
import { GitHubAdapter } from "../src/adapters/github-adapter.js";
import { createNativeCodexBrainProvider } from "../src/adapters/native-codex-brain-provider.js";
import { runJson } from "../src/lib/command-runner.js";
import { createPullRequestWorkSource, currentWorkItemExecutionBinding } from "../src/services/work-ledger-pr-source.js";
import { createPullRequestReadFacts, createPullRequestReadIdentity, projectPullRequestReadFactsContext } from "../src/domain/pull-request-read-facts.js";
import { ReviewPublicationAdoptionStore } from "../src/services/published-review-adoption.js";
import { loadNativeReviewSkill } from "../src/lib/native-review-skill.js";
import { createOriginalRepairFeedbackSnapshot } from "../src/domain/original-repair-feedback.js";
import {
  runBoundedValidationCommand,
} from "../scripts/system-validation-command.mjs";
import { OllamaBrain } from "../src/adapters/ollama-brain.js";
import { RoutedDingTalkSummaryBrain } from "../src/adapters/routed-dingtalk-summary-brain.js";
import { OllamaPrEmployeeReviewer } from "../src/adapters/ollama-pr-employee-reviewer.js";
import {
  SupervisedCliBrainProvider,
  createTestSupervisedCliBrainProvider,
} from "../src/adapters/supervised-cli-brain-provider.js";
import {
  createBrain,
  createApplication,
  createApplicationRuntimeLifecycle,
  createConfiguredGitHubCredentialSource,
  createEmployeeRegistry,
  createPrEmployeeReviewer,
  createPrTriageHandoff,
} from "../src/composition-root.js";
import { ActionAdmissionGate } from "../src/lib/action-admission-gate.js";
import {
  CodeActionProposalHandler,
  createCodeActionProposalRunnerService,
} from "../src/services/code-action-proposal-handler.js";
import { normalizeWorkflowEvent } from "../src/domain/workflow-events.js";
import { createWorkLedgerRuntime } from "../src/work-ledger-runtime.js";
import { createWorkflowRoutingRuntime } from "../src/workflow-routing-runtime.js";
import { createLocalWorkLedgerCandidateProcessor } from
  "../src/services/work-ledger-candidate-processor.js";
import {
  KnownCliLocator,
  materializeVerifiedCliDescriptor,
} from "../src/lib/known-cli-locator.js";
import { terminateProcessTree } from "../src/lib/managed-process.js";
import {
  configurationDocumentDigest,
  normalizeConfigurationDocument,
} from "../src/domain/configuration-contract.js";
import { projectIdentityDigest } from "../src/lib/project-identity.js";
import {
  createConfiguredConstructionCleanupOwner,
  createConfiguredWorkforce,
  readConfiguredConstructionCleanup,
  createTestConfiguredBrainRouter,
  createTestConfiguredWorkforce,
} from "../src/services/configured-workforce.js";
import {
  CodeJobBrainDirectory,
} from "../src/services/code-job-brain-directory.js";
import { codeJobBrainDigest } from "../src/services/code-job-grant-factory.js";
import {
  VersionedCodeJobAuthority,
} from "../src/services/versioned-code-job-authority.js";
import {
  createWorkProposalResult,
  normalizeBoundWorkProposal,
} from "../src/domain/work-proposal-contract.js";

const OFFLINE_CODEX_SOURCE = path.join(
  import.meta.dirname,
  "fixtures",
  "offline-bounded-codex.cs",
);
const COMMITTED_CONFIGURATION = JSON.parse(
  await readFile(path.join(import.meta.dirname, "..", "config.example.json"), "utf8"),
);
const OFFLINE_FIXTURE_COMMAND_TIMEOUT_MS = 30_000;
const OFFLINE_FIXTURE_COMMAND_OUTPUT_BYTES = 1024 * 1024;
const POWERSHELL_EXE = path.join(
  process.env.SystemRoot || process.env.WINDIR || "C:\\Windows",
  "System32",
  "WindowsPowerShell",
  "v1.0",
  "powershell.exe",
);

function applicationConfig(codeExecutor = { enabled: false }) {
  return {
    refreshMinutes: 10,
    trackedRepositories: [],
    prResponsibility: {},
    brain: { enabled: false },
    employees: { prReviewer: { enabled: false } },
    dingtalk: { enabled: false },
    githubActions: { enabled: false },
    codeExecutor,
  };
}

test("composition triage handoff creates durable orchestrator-bound PR work", async () => {
  const requests = [];
  const handoff = createPrTriageHandoff(() => ({
    async submit(request) {
      requests.push(request);
      return { workItemId: "work-item-triage" };
    },
  }));

  const result = await handoff.submit({
    requestKey: "pr-work-review",
    targetRoleId: "pr-engineer",
    repository: "acme/repo",
    number: 42,
    nextAction: "review",
    expectedHeadRefOid: "a".repeat(40),
  });

  assert.deepEqual(result, { workItemId: "work-item-triage" });
  assert.equal(requests[0].schemaVersion, 5);
  assert.equal(requests[0].workType, "general");
  assert.match(requests[0].description, /建议能力：pr-review/);
  assert.deepEqual(requests[0].pullRequest, {
    repository: "acme/repo",
    number: 42,
  });
  assert.deepEqual(requests[0].triage, {
    nextAction: "review",
    suggestedCapability: "pr-review",
    expectedHeadRefOid: "a".repeat(40),
  });
  await assert.rejects(
    createPrTriageHandoff(() => null).submit({}),
    (error) => error.code === "PR_TRIAGE_HANDOFF_NOT_READY",
  );
});

test("triage reuses current automatic Review work instead of creating a competing owner root", async () => {
  const reads = [];
  const input = { requestKey: "review-triage", targetRoleId: "pr-engineer", repository: "acme/repo", number: 42,
    nextAction: "review", expectedHeadRefOid: "a".repeat(40), gitTarget: { marker: "trusted-snapshot-target" } };
  const existing = { workItemId: "work-item-existing-review" };
  const handoff = createPrTriageHandoff(() => ({ submit() { assert.fail("must not create another source root"); } }),
    () => ({ async readCurrentAutomaticReviewWork(query) { reads.push(query); return existing; } }));
  assert.deepEqual(await handoff.submit(input), existing);
  assert.deepEqual(reads, [{ repository: input.repository, number: input.number,
    headRefOid: input.expectedHeadRefOid, gitTarget: input.gitTarget }]);
});

test("triage falls back only when no current automatic Review matches and preserves read failures", async () => {
  const input = { requestKey: "review-triage", targetRoleId: "pr-engineer", repository: "acme/repo", number: 42,
    nextAction: "review", expectedHeadRefOid: "a".repeat(40), gitTarget: { marker: "trusted-snapshot-target" } };
  let submissions = 0, reads = 0;
  const owner = { async submit() { submissions++; return { workItemId: "work-item-new-owner" }; } };
  let fail = false;
  const handoff = createPrTriageHandoff(() => owner, () => ({ async readCurrentAutomaticReviewWork() {
    reads++; if (fail) throw Object.assign(new Error("read unavailable"), { code: "EIO" }); return null;
  } }));
  assert.deepEqual(await handoff.submit(input), { workItemId: "work-item-new-owner" });
  fail = true;
  await assert.rejects(handoff.submit(input), { code: "EIO" });
  assert.equal(submissions, 1);
  assert.deepEqual(await handoff.submit({ ...input, targetRoleId: "developer", nextAction: "fix_ci" }),
    { workItemId: "work-item-new-owner" });
  assert.equal(reads, 2, "repair handoffs never reuse a Review task");
});

test("application exposes one operations runtime bound to explicit local directories", async () => {
  const calls = {};
  const marker = Object.freeze({
    admission: Object.freeze({ async run(operation) { return operation(); } }),
  });
  const dependencies = Object.freeze({ marker: true });
  const dataDirectory = path.join(process.cwd(), "test-operations-data");
  const backupDirectory = path.join(process.cwd(), "test-operations-backups");
  const application = await createApplication({
    config: applicationConfig(),
    versionedConfiguration: false,
    externalActions: false,
    operationsOptions: {
      dataDirectory,
      backupDirectory,
      probeTimeoutMs: 1234,
      migration: { async migrate() { throw new Error("must not forward"); } },
    },
    operationsRuntimeDependencies: dependencies,
    operationsRuntimeFactory(options, suppliedDependencies) {
      calls.options = options;
      calls.dependencies = suppliedDependencies;
      return marker;
    },
  });

  assert.strictEqual(application.operations, marker);
  assert.deepEqual(calls.options, {
    dataDirectory,
    backupDirectory,
    probeTimeoutMs: 1234,
    snapshotReader: application.store,
  });
  assert.strictEqual(calls.dependencies, dependencies);
  await application.close();
});

function externalActionConfig(codeExecutor = { enabled: false }) {
  return {
    ...applicationConfig(codeExecutor),
    githubActions: {
      enabled: true,
      actorAccountId: "review-account",
      tokenEnv: "TEST_GITHUB_TOKEN",
      ghCommand: process.execPath,
    },
  };
}

function workCoordinationConfig({ externalActions = true } = {}) {
  return {
    ...applicationConfig(),
    workflowRouting: {
      schemaVersion: 1,
      enabled: true,
      maxHops: 8,
      rules: [],
    },
    githubActions: externalActions
      ? {
          enabled: true,
          actorAccountId: "review-account",
          tokenEnv: "TEST_GITHUB_TOKEN",
          ghCommand: process.execPath,
        }
      : { enabled: false },
    workCoordination: {
      enabled: true,
      intakeLimit: 11,
      workLimit: 12,
      dispatchLimit: 13,
      attentionLimit: 14,
      proposalLimit: 16,
      conditionLimit: 15,
      codeJobLimit: 9,
      codeJobMemoryLimit: 18,
      codeJobMaximumTurns: 64,
      codeJobObservationLimit: 20,
      leaseDurationMs: 16_000,
      resolveTimeoutMs: 2_000,
      decisionTimeoutMs: 3_000,
      maxAttempts: 4,
      retryBaseMs: 5_000,
      retryMaxMs: 6_000,
      factMaximumAgeMs: 7_000,
      policy: {
        version: 2,
        capabilityRoles: { testing: "tester" },
        githubReviewRoles: ["pr-reviewer"],
        codeActionRoles: ["developer"],
        workspaceByRepository: { "acme/repo": "acme-workspace" },
      },
    },
  };
}

function localCodeCoordinationConfig({ githubActions = true } = {}) {
  const base = workCoordinationConfig({ externalActions: githubActions });
  return {
    ...base,
    codeExecutor: { enabled: true },
    memory: { enabled: true },
    githubActions: githubActions
      ? {
          enabled: true,
          actorAccountId: "review-account",
          tokenEnv: "TEST_GITHUB_TOKEN",
          ghCommand: process.execPath,
        }
      : { enabled: false },
    brainProviders: {
      ollama: { kind: "ollama", baseUrl: "http://127.0.0.1:11434" },
    },
    employees: {
      ...base.employees,
      roles: {
        developer: {
          brain: {
            provider: "ollama",
            model: "developer-model",
            remoteData: { requirements: false, code: false, memory: false },
          },
          taskBrain: {
            provider: "ollama",
            model: "developer-task-model",
            remoteData: { requirements: false, code: false, memory: false },
          },
        },
        tester: {
          brain: {
            provider: "ollama",
            model: "tester-model",
            remoteData: { requirements: false, code: false, memory: false },
          },
          taskBrain: {
            provider: "ollama",
            model: "tester-task-model",
            remoteData: { requirements: false, code: false, memory: false },
          },
        },
        "policy-only-role": {
          brain: {
            provider: "ollama",
            model: "policy-only-model",
            remoteData: { requirements: false, code: false, memory: false },
          },
        },
      },
    },
    workCoordination: {
      ...base.workCoordination,
      policy: {
        ...base.workCoordination.policy,
        codeActionRoles: ["developer", "tester", "role-without-policy"],
        codeOperationsByRole: {
          developer: ["inspect", "modify", "verify"],
          tester: ["inspect", "verify"],
          "policy-only-role": ["inspect"],
        },
      },
    },
  };
}

function confirmationQueuePort() {
  return Object.freeze({
    async next() {
      return { queueRevision: 0, pendingCount: 0, item: null };
    },
    async get() {},
    async approve() {},
    async retry() {},
    async reject() {},
  });
}

function confirmationProducerPort(overrides = {}) {
  return Object.freeze({
    async enqueue() {},
    async get() {},
    async invalidate() {},
    ...overrides,
  });
}

function confirmationMemoryProjectionSourcePort() {
  return Object.freeze({
    async readMemoryPage({ cursor }) {
      return {
        highWatermark: 0,
        cursor,
        items: [],
        nextCursor: null,
      };
    },
    async readMemoryStatus() {
      return { highWatermark: 0 };
    },
  });
}

function controlledCodeExecutorPort(overrides = {}) {
  return {
    async start() {},
    async view() {},
    async resume() {},
    async perform() {},
    async getActionResult() {},
    async reconcileAction() {},
    async reconcileCancellation() {},
    ...overrides,
  };
}

function codeJobControlPort() {
  return { async pause() {}, async resume() {}, async cancel() {} };
}

function codeJobWorkerPort() {
  return { async runCycle() {}, async runReady() {} };
}

function codeJobProjectionSourcePort() {
  return {
    async readBatch() {
      return { cursor: 0, highWatermark: 0, items: [] };
    },
    async ack() {},
  };
}

function graphMemoryProjectionSourcePort() {
  return {
    async readBatch() {
      return { cursor: 0, highWatermark: 0, items: [] };
    },
    async ack() {},
    async ackBatch() {},
  };
}

function memoryAuthoritySourcePort() {
  const authorityStateDigest = "4f53cda18c2baa0c0354bb5f9a3ecbe5ed12ab4d8e11ba873c2f11161202b945";
  return {
    async readSnapshot() {
      return {
        ledgerRevision: 0,
        items: [],
        timeline: [],
        graph: {
          cursor: 0,
          highWatermark: 0,
          checkpointDigest: null,
          highWatermarkDigest: null,
          authorityStateDigest,
          items: [],
        },
      };
    },
    async readStatus() {
      return {
        ledgerRevision: 0,
        graph: {
          cursor: 0,
          highWatermark: 0,
          checkpointDigest: null,
          highWatermarkDigest: null,
          authorityStateDigest,
        },
      };
    },
  };
}

function ownerRetryLedgerMethods() {
  return {
    async readItemForReconciliation() {
      return null;
    },
    async transition() {
      throw new Error("unexpected owner retry transition");
    },
  };
}

function workProposalRuntimePort(overrides = {}) {
  const runner = { async claim() {}, async advance() {} };
  return {
    producer: { async create() {} },
    runners: { "github-review-runner": runner },
    consumer: { async readResultBatch() {} },
    async close() {},
    ...overrides,
  };
}

function inProcessExclusiveGuard(onClose = () => {}) {
  return {
    run(operation) {
      return Promise.resolve().then(operation);
    },
    async close() {
      onClose();
    },
  };
}

function workflowFactSourcePort(overrides = {}) {
  const pullRequestContextReader = Object.freeze({ async read() {} });
  return {
    async read() {},
    pullRequestTaskContextReader() {
      return pullRequestContextReader;
    },
    ...overrides,
  };
}

function localCoordinationStubs({ calls, closeCalls, runners }) {
  const workflow = {
    async readAssignmentBatch() {},
    async close() {
      closeCalls.push("workflow");
    },
  };
  const ledger = {
    graphReader: { async getSnapshot() { return { graphRevision: 0 }; } },
    graphBrowserReader: { async getSnapshot() { return { graphRevision: 0 }; } },
    graphMemoryProjectionSource: graphMemoryProjectionSourcePort(),
    memoryAuthoritySource: memoryAuthoritySourcePort(),
    async getSummary() {},
    async listItems() { return { items: [], nextCursor: null }; },
    async listTimeline() { return { items: [], nextCursor: null }; },
    ...ownerRetryLedgerMethods(),
    verifyPullRequestExecutionBinding(binding) {
      return structuredClone(binding);
    },
    verifyPullRequestExecutionBindings(request) {
      return structuredClone({
        ledgerRevision: request.ledgerRevision,
        current: request.bindings.map(() => true),
      });
    },
    async close() {
      closeCalls.push("ledger");
    },
  };
  const attention = {
    producer: { async create() {} },
    consumer: { async readOutbox() {} },
    browser: {
      async next() {},
      async listMaintenance() { return { items: [], total: 0 }; },
      async readStatus() { return null; },
      async answer() {},
      async reject() {},
      async later() {},
    },
    async close() {
      closeCalls.push("attention");
    },
  };
  const proposals = workProposalRuntimePort({
    runners,
    async close() {
      closeCalls.push("proposals");
    },
  });
  const memory = {
    producer: { async append() {}, async appendBatch() {} },
    lifecycleProducer: {
      async appendWorkItems() {},
      async appendGraphEvents() {},
      async appendProjectionRecords() {},
      async appendAuthorityProjection() {},
      async adoptGraphCheckpoint() {},
    },
    authorityReader: {
      async getAuthorityState() {},
      async getAuthorityProjectionState() {},
      requiresAuthorityProjectionCheckpoint() { return false; },
    },
    search: { async search() {}, async getHealth() {} },
    contextReader: { async readRecords() {} },
    receiptVerifier: {
      async verify(value) { return { ...value, persisted: true }; },
    },
    maintenance: { async rebuildIndex() {} },
    async close() {
      closeCalls.push("memory");
    },
  };
  return {
    workflowRoutingRuntimeFactory: async (_config, options) => {
      calls.workflowRuntime = options;
      return workflow;
    },
    workLedgerRuntimeFactory: async (options) => {
      calls.ledgerRuntime = options;
      return ledger;
    },
    attentionInboxRuntimeFactory: async () => attention,
    workProposalRuntimeFactory: async (options) => {
      calls.proposalRuntime = options;
      return proposals;
    },
    memoryRuntimeFactory: async (options) => {
      calls.memoryRuntime = options;
      return memory;
    },
    configuredWorkforceFactory: (options) => {
      calls.workforce = options;
      return { employees: [], workers: [] };
    },
    workIntentPolicyFactory: () => ({ async bind() {} }),
    roleWorkerDirectoryFactory: () => ({ async resolve() {} }),
    prEngineerExclusiveGuardFactory: () => inProcessExclusiveGuard(),
    workflowFactSourceFactory: () => workflowFactSourcePort(),
    roleContextAssemblerFactory: () => ({ async assemble() {} }),
    orchestratorServiceFactory: (options) => {
      calls.orchestratorService = options;
      return { async execute() {} };
    },
    attentionResultReconcilerFactory: () => ({ async runCycle() {} }),
    workProposalResultReconcilerFactory: (options) => {
      calls.proposalResultReconciler = options;
      return { async runCycle() {} };
    },
    workConditionWakerFactory: (options) => {
      calls.waker = options;
      return { async runCycle() {} };
    },
    proactiveWorkLoopFactory: (options) => {
      calls.loop = options;
      return { async runCycle() {} };
    },
    workIntentDispatcherFactory: (options) => {
      calls.dispatcher = options;
      return { async dispatchPending() {} };
    },
    workCoordinationFactory: (options) => {
      calls.coordination = options;
      return { async intake() {}, async runCycle() {} };
    },
    attentionCoordinatorFactory: () => ({ async next() {} }),
  };
}

function memoryStore() {
  return {
    async read(_key, fallback = null) {
      return fallback;
    },
    async write() {},
  };
}

test("versioned automatic composition wires durable continuations to the shared ledger and reconcilers", async () => {
  const config = structuredClone(defaultCodeJobConfiguration());
  config.codeExecutor = { enabled: false };
  config.workCoordination.policy.workspaceByRepository = {};
  config.githubActions = { ...workCoordinationConfig().githubActions, enabledActions: [], automaticReview: true };
  const closeCalls = [], calls = {};
  const stubs = localCoordinationStubs({ calls, closeCalls, runners: {} });
  const ledger = await stubs.workLedgerRuntimeFactory({});
  let scans = 0, reconciled = 0, conditions = 0;
  Object.assign(ledger, {
    async listClaimCandidates() { scans += 1; return { items: [], facts: [], nextCursor: null }; },
    async readItemProgress() { return []; },
  });
  const application = await createApplication({
    ...stubs, config, store: memoryStore(), versionedConfiguration: true,
    codeJobRuntimeDependencies: { createGuard: () => ({ ...inProcessExclusiveGuard(), async acquire() {} }) },
    confirmationRuntimeDependencies: { createGuard: () => ({ ...inProcessExclusiveGuard(), async acquire() {} }) },
    configurationRuntimeFactory: configurationRuntimeFactory(config, closeCalls),
    workLedgerRuntimeFactory: async () => ledger,
    workProposalResultReconcilerFactory: () => ({ async runCycle() { reconciled += 1; } }),
    workConditionWakerFactory: () => ({ async runCycle() { conditions += 1; } }),
  });
  try {
    assert.ok(application.workContinuationScheduler);
    assert.deepEqual(await application.workContinuationScheduler.runCycle({ dispatch: async () => { assert.fail('no ready work'); } }), { started: 0, skipped: null });
    assert.deepEqual([scans, reconciled, conditions], [1, 1, 1]);
  } finally { await application.close(); }
});

test("review handoff admits the configured GitHub and local resolution budgets", async () => {
  const config = workCoordinationConfig();
  config.githubActions.timeoutMs = 60_000;
  const application = await createApplication({
    config, store: memoryStore(),
    ...localCoordinationStubs({
      calls: {}, closeCalls: [],
      runners: { "github-review-runner": { async claim() {}, async advance() {} } },
    }),
    confirmationRuntimeFactory: async () => ({
      queue: confirmationQueuePort(), producerQueue: confirmationProducerPort(),
      reviewHandoffs: { async readReviewHandoffs() { return []; }, async recordReviewHandoff() {} },
      async close() {},
    }),
    githubReviewProposalRunnerFactory: () => ({ async runCycle() {} }),
    workProposalRunnerGroupFactory: () => ({ async runCycle() {} }),
  });
  try {
    const handoff = application.reviewHandoffReconciler;
    assert.ok(handoff.timeoutMs >= 2 * config.githubActions.timeoutMs + config.workCoordination.resolveTimeoutMs);
    assert.ok(handoff.cycleTimeoutMs > handoff.timeoutMs);
  } finally { await application.close(); }
});

test("automatic Review publication and final execution share the trusted ledger admission reader", async () => {
  const calls = {}, closeCalls = [];
  const config = workCoordinationConfig();
  config.githubActions.automaticReview = true;
  const stubs = localCoordinationStubs({ calls, closeCalls,
    runners: { "github-review-runner": { async claim() {}, async advance() {} } } });
  const ledger = await stubs.workLedgerRuntimeFactory({});
  let reads = 0;
  ledger.readAutomaticReviewAdmission = async inputBinding => {
    reads++;
    return { inputBinding, admission: { kind: "owner_requested", admittedAt: "2026-10-09T09:50:00Z" } };
  };
  const application = await createApplication({ config, store: memoryStore(), ...stubs,
    roleContextAssemblerFactory: options => { calls.settlementContext = options; return { async assemble() {} }; },
    workLedgerRuntimeFactory: async () => ledger,
    workCoordinationDependencies: { clock: () => "2026-10-09T10:00:00.000Z" },
    confirmationRuntimeFactory: async (_config, dependencies) => {
      calls.guard = dependencies.automaticReviewGuard;
      return { queue: confirmationQueuePort(), producerQueue: confirmationProducerPort(), async close() {} };
    },
    githubReviewProposalRunnerFactory: options => {
      calls.publisher = options.automaticReviewPublisher;
      return { async runCycle() {} };
    },
    workProposalRunnerGroupFactory: () => ({ async runCycle() {} }),
  });
  try {
    assert.strictEqual(calls.settlementContext.settlementEvidenceVerifier, application.deliveryEvidence);
    assert.equal(typeof calls.settlementContext.settlementInputAuthorityVerifier.verify, "function");
    const head = "a".repeat(40);
    const binding = { schemaVersion: 2, repository: "acme/repo", pullRequestNumber: 42,
      headRefOid: head, gitTarget: { sourceAccountId: "review-account" } };
    const item = { actor: { accountId: "review-account" }, target: { resourceId: "acme/repo#42", version: head },
      action: { inputBinding: binding } };
    const facts = { kind: "pull_request", state: "open", isDraft: false, ciStatus: "FAILURE", author: "developer",
      headRefOid: head, incomingReviewFactsAvailable: true, reviewRecipient: "review-account", reviewReceivedFrom: "developer",
      reviewReceivedAt: "2026-10-01T09:00:00Z", reviewReceivedVia: "assignee", reviewRequestEventId: "AE_42" };
    assert.equal(await calls.publisher.eligible(facts, item), true);
    assert.equal(await calls.guard.eligible(facts, item), true);
    assert.equal(reads, 2);
  } finally { await application.close(); }
});

async function within(milliseconds, promise, phase = "operation") {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(`${phase} exceeded its test bound (${milliseconds} ms)`)),
          milliseconds,
        );
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function waitForCausalOutcome(outcomes, probe, description) {
  let settled = null;
  for (const [name, promise] of outcomes) {
    void Promise.resolve(promise).then(
      (value) => { settled ??= { name, value, error: null }; },
      (error) => { settled ??= { name, value: null, error }; },
    );
  }
  for (let attempt = 0; attempt < 10_000 && settled === null; attempt += 1) {
    await probe();
    await new Promise((resolve) => setImmediate(resolve));
  }
  if (settled === null) {
    throw new Error(`${description} did not occur within its causal poll bound`);
  }
  return settled;
}

async function runOfflineFixtureCommand(command, arguments_, {
  cwd,
  env,
  timeoutMs = OFFLINE_FIXTURE_COMMAND_TIMEOUT_MS,
} = {}) {
  const result = await runBoundedValidationCommand(command, arguments_, {
    cwd,
    env,
    timeoutMs,
    maxStdoutBytes: OFFLINE_FIXTURE_COMMAND_OUTPUT_BYTES,
    maxStderrBytes: OFFLINE_FIXTURE_COMMAND_OUTPUT_BYTES,
  });
  if (result.exitCode !== 0 || result.signal !== null) {
    throw Object.assign(
      new Error("offline fixture command failed"),
      { code: "OFFLINE_FIXTURE_COMMAND_FAILED", ...result },
    );
  }
  return result;
}

async function waitForProcessMarker(marker) {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    try {
      return JSON.parse(await readFile(marker, "utf8"));
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }
  throw new Error("offline fixture helper did not publish its process marker");
}

function processExists(processId) {
  try {
    process.kill(processId, 0);
    return true;
  } catch (error) {
    if (error?.code === "ESRCH") return false;
    throw error;
  }
}

test(
  "offline fixture setup reaps a timed-out descendant before its root is removed",
  { timeout: 15_000 },
  async (t) => {
    const root = await mkdtemp(path.join(tmpdir(), "offline-fixture-setup-bound-"));
    const marker = path.join(root, "processes.json");
    let processIds = [];
    t.after(async () => {
      for (const processId of processIds) {
        if (!processExists(processId)) continue;
        await terminateProcessTree(processId, {
          force: true,
          timeoutMs: 5_000,
        }).catch(() => {});
      }
      await rm(root, { recursive: true, force: true });
    });
    const descendantScript = "setInterval(() => {}, 1000)";
    const parentScript = [
      "const { spawn } = require('node:child_process');",
      "const { writeFileSync } = require('node:fs');",
      `const descendant = spawn(${JSON.stringify(process.execPath)}, ["-e", ${JSON.stringify(descendantScript)}], { stdio: "ignore", windowsHide: true });`,
      `writeFileSync(${JSON.stringify(marker)}, JSON.stringify({ parent: process.pid, descendant: descendant.pid }));`,
      "setInterval(() => {}, 1000);",
    ].join("\n");
    const startedAt = Date.now();
    const running = runOfflineFixtureCommand(
      process.execPath,
      ["-e", parentScript],
      {
        cwd: root,
        env: { ...process.env },
        timeoutMs: 500,
      },
    );
    const markerValue = await waitForProcessMarker(marker);
    processIds = [markerValue.parent, markerValue.descendant];
    const settled = running.then(
      (value) => ({ value, error: null }),
      (error) => ({ value: null, error }),
    );
    const testDeadline = Symbol("fixture setup remained pending");
    const outcome = await Promise.race([
      settled,
      new Promise((resolve) => setTimeout(() => resolve(testDeadline), 2_000)),
    ]);
    if (outcome === testDeadline) {
      await terminateProcessTree(markerValue.parent, {
        force: true,
        timeoutMs: 5_000,
      });
      await settled;
    }

    assert.notStrictEqual(
      outcome,
      testDeadline,
      "offline fixture setup ignored its required timeout bound",
    );
    assert.equal(outcome.error?.code, "VALIDATION_COMMAND_TIMEOUT");
    assert.ok(Date.now() - startedAt < 5_000, "fixture setup timeout was unbounded");
    assert.equal(processExists(markerValue.parent), false);
    assert.equal(processExists(markerValue.descendant), false);
    await rm(root, { recursive: true });
    await assert.rejects(access(root), { code: "ENOENT" });
  },
);

async function createOfflineProductionCliFixture(t, name) {
  const root = await mkdtemp(path.join(tmpdir(), `${name}-`));
  const originalEnvironment = {
    path: process.env.PATH,
    credential: process.env.OPENAI_API_KEY,
    home: process.env.HOME,
    userProfile: process.env.USERPROFILE,
  };
  let environmentChanged = false;
  let runtimeTeardown = null;
  let closeAttempt = null;
  let closeResult = null;
  const restoreEnvironment = () => {
    if (!environmentChanged) return;
    if (originalEnvironment.path === undefined) delete process.env.PATH;
    else process.env.PATH = originalEnvironment.path;
    if (originalEnvironment.credential === undefined) {
      delete process.env.OPENAI_API_KEY;
    } else {
      process.env.OPENAI_API_KEY = originalEnvironment.credential;
    }
    if (originalEnvironment.home === undefined) delete process.env.HOME;
    else process.env.HOME = originalEnvironment.home;
    if (originalEnvironment.userProfile === undefined) {
      delete process.env.USERPROFILE;
    } else {
      process.env.USERPROFILE = originalEnvironment.userProfile;
    }
    environmentChanged = false;
  };
  const close = () => {
    if (closeAttempt) return closeAttempt;
    if (closeResult) return closeResult;
    const attempt = (async () => {
      let teardownFailure = null;
      try {
        await runtimeTeardown?.();
      } catch (error) {
        teardownFailure = error;
      } finally {
        restoreEnvironment();
      }
      if (teardownFailure) throw teardownFailure;
      await rm(root, { recursive: true, force: true });
    })();
    closeAttempt = attempt;
    void attempt.then(
      () => {
        if (closeAttempt !== attempt) return;
        closeResult = attempt;
        closeAttempt = null;
      },
      () => {
        if (closeAttempt === attempt) closeAttempt = null;
      },
    );
    return attempt;
  };
  t.after(close);
  const homeRoot = path.join(root, "home");
  const nodeModulesRoot = path.join(root, "node_modules");
  const packageRoot = path.join(nodeModulesRoot, "@openai", "codex");
  const nativeRoot = path.join(
    packageRoot,
    "node_modules",
    "@openai",
    "codex-win32-x64",
  );
  const executable = path.join(
    nativeRoot,
    "vendor",
    "x86_64-pc-windows-msvc",
    "bin",
    "codex.exe",
  );
  const binarySearchRoot = path.join(nodeModulesRoot, ".bin");
  await mkdir(homeRoot, { recursive: true });
  await mkdir(path.dirname(executable), { recursive: true });
  await mkdir(binarySearchRoot, { recursive: true });
  await runOfflineFixtureCommand(
    POWERSHELL_EXE,
    [
      "-NoLogo",
      "-NoProfile",
      "-NonInteractive",
      "-ExecutionPolicy",
      "Bypass",
      "-Command",
      "Add-Type -Path $env:MYDASHBOARD_FIXTURE_SOURCE -OutputAssembly $env:MYDASHBOARD_FIXTURE_OUTPUT -OutputType ConsoleApplication",
    ],
    {
      env: {
        ...process.env,
        MYDASHBOARD_FIXTURE_SOURCE: OFFLINE_CODEX_SOURCE,
        MYDASHBOARD_FIXTURE_OUTPUT: executable,
      },
    },
  );
  await writeFile(
    path.join(packageRoot, "package.json"),
    JSON.stringify({
      name: "@openai/codex",
      version: "0.147.0",
      bin: { codex: "bin/codex.js" },
      optionalDependencies: {
        "@openai/codex-win32-x64":
          "npm:@openai/codex@0.147.0-win32-x64",
      },
    }),
    "utf8",
  );
  await writeFile(
    path.join(nativeRoot, "package.json"),
    JSON.stringify({
      name: "@openai/codex",
      version: "0.147.0-win32-x64",
      os: ["win32"],
      cpu: ["x64"],
    }),
    "utf8",
  );

  await runOfflineFixtureCommand(
    POWERSHELL_EXE,
    [
      "-NoLogo",
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      [
        "$ErrorActionPreference = 'Stop'",
        "$target = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($env:MYDASHBOARD_FIXTURE_HOME))",
        "$sid = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value",
        "$sddl = ('O:{0}G:{0}D:P' -f $sid) + ('(A;OICI;FA;;;{0})(A;OICI;FA;;;SY)(A;OICI;FA;;;BA)' -f $sid)",
        "$security = [Security.AccessControl.DirectorySecurity]::new()",
        "$sections = [Security.AccessControl.AccessControlSections]::Access -bor [Security.AccessControl.AccessControlSections]::Owner -bor [Security.AccessControl.AccessControlSections]::Group",
        "$security.SetSecurityDescriptorSddlForm($sddl, $sections)",
        "[System.IO.Directory]::SetAccessControl($target, $security)",
      ].join("\n"),
    ],
    {
      env: {
        ...process.env,
        MYDASHBOARD_FIXTURE_HOME:
          Buffer.from(homeRoot, "utf8").toString("base64"),
      },
    },
  );

  process.env.PATH = binarySearchRoot;
  process.env.OPENAI_API_KEY = "fixed-offline-fixture-credential";
  process.env.HOME = homeRoot;
  process.env.USERPROFILE = homeRoot;
  environmentChanged = true;
  const descriptor = await new KnownCliLocator().resolve("codex-cli");
  await materializeVerifiedCliDescriptor(descriptor);

  const runtimeRoot = path.join(
    homedir(),
    ".mydashboard-supervised-cli-v1",
  );
  const invocationNames = async () => {
    try {
      return new Set(
        (await readdir(runtimeRoot, { withFileTypes: true }))
          .filter((entry) =>
            entry.isDirectory() &&
            entry.name.startsWith("invocation-codex-cli-"))
          .map((entry) => entry.name),
      );
    } catch (error) {
      if (error?.code === "ENOENT") return new Set();
      throw error;
    }
  };
  return Object.freeze({
    root,
    close,
    invocationNames,
    registerTeardown(teardown) {
      if (typeof teardown !== "function") {
        throw new TypeError("offline fixture teardown is invalid");
      }
      if (runtimeTeardown !== null) {
        throw new Error("offline fixture teardown is already registered");
      }
      runtimeTeardown = teardown;
    },
    async runningProcessIds() {
      const result = await runOfflineFixtureCommand(
        POWERSHELL_EXE,
        [
          "-NoLogo",
          "-NoProfile",
          "-NonInteractive",
          "-Command",
          [
            "$target = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($env:MYDASHBOARD_FIXTURE_EXECUTABLE))",
            "Get-Process -Name 'codex' -ErrorAction SilentlyContinue | Where-Object { try { [String]::Equals($_.Path, $target, [StringComparison]::OrdinalIgnoreCase) } catch { $false } } | ForEach-Object { [Console]::Out.WriteLine($_.Id) }",
          ].join("\n"),
        ],
        {
          env: {
            ...process.env,
            MYDASHBOARD_FIXTURE_EXECUTABLE:
              Buffer.from(executable, "utf8").toString("base64"),
          },
          timeoutMs: 5_000,
        },
      );
      return result.stdout
        .split(/\r?\n/u)
        .filter(Boolean)
        .map(Number)
        .filter((value) => Number.isSafeInteger(value) && value > 0);
    },
    async waitForStart(previousNames, signal) {
      for (let attempt = 0; attempt < 2_000 && !signal?.aborted; attempt += 1) {
        for (const name of await invocationNames()) {
          if (previousNames.has(name)) continue;
          const invocation = path.join(runtimeRoot, name);
          try {
            await access(path.join(invocation, "offline-cli-started"));
            return invocation;
          } catch (error) {
            if (error?.code !== "ENOENT") throw error;
          }
        }
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      if (signal?.aborted) return null;
      throw new Error("offline CLI did not publish its start marker within its causal poll bound");
    },
    release(invocation) {
      return writeFile(
        path.join(invocation, "offline-cli-release"),
        "release",
        "utf8",
      );
    },
  });
}

function defaultCodeJobConfiguration({ offlineCliTimeoutMs = 30_000 } = {}) {
  const value = structuredClone(COMMITTED_CONFIGURATION);
  value.trackedRepositories = ["acme/repo"];
  value.codeExecutor = {
    enabled: true,
    gitCommand: "C:\\Program Files\\Git\\mingw64\\bin\\git.exe",
    docker: {
      executable: "docker",
      host: "npipe:////./pipe/docker_engine",
    },
    workspaces: [{
      id: "dashboard",
      sourceRoot: ".",
      writablePaths: ["src", "test"],
      excludePaths: [],
    }],
    profiles: {
      "node-tests": {
        kind: "node-test",
        image:
          "node:22-alpine@sha256:c610fcdfb1d5b4740dd70c284ed3cb16bb857e0f7166196e36a5501df7a3aa32",
        timeoutMs: 30_000,
      },
    },
    requiredProfilesByWorkspace: { dashboard: ["node-tests"] },
    brokerLimits: { maxFiles: 1_000, maxWriteBytes: 1_000_000 },
    executorLimits: { maxSessions: 4, maxActionsPerSession: 100 },
    maxArtifactBytes: 16_777_216,
  };
  value.changePackages = { enabled: false };
  value.githubActions = { enabled: false, enabledActions: [] };
  value.memory.enabled = true;
  value.memory.answering = { enabled: false };
  value.brainProviders = {
    ollama: {
      kind: "ollama",
      baseUrl: "http://127.0.0.1:11434",
      remote: false,
    },
    "offline-cli": {
      kind: "codex-cli",
      remote: true,
      timeoutMs: offlineCliTimeoutMs,
      maxResponseBytes: 128 * 1024,
      maxRequestBytes: 256 * 1024,
    },
  };
  for (const role of Object.values(value.employees.roles)) {
    role.taskBrain = structuredClone(role.brain);
  }
  value.employees.roles.developer.taskBrain = {
    provider: "offline-cli",
    model: "fixed-offline-model",
    remoteData: { requirements: true, code: true, memory: false },
  };
  value.workCoordination.enabled = true;
  value.workCoordination.policy = {
    ...value.workCoordination.policy,
    version: 7,
    codeActionRoles: ["developer"],
    codeOperationsByRole: {
      developer: ["inspect", "modify", "verify"],
    },
    workspaceByRepository: { "acme/repo": "dashboard" },
  };
  return normalizeConfigurationDocument(value);
}

function defaultExecutorAuthority() {
  return {
    workspaces: [{
      id: "dashboard",
      capabilities: ["git_head_snapshot"],
      writablePaths: ["src", "test"],
      excludePaths: [],
      requiredProfiles: [
        { id: "node-tests", configDigest: "a".repeat(64) },
      ],
      authorityDigest: "d".repeat(64),
    }],
  };
}

function defaultCodeDecisionInput() {
  return {
    roleId: "developer",
    task: {
      operation: "modify",
      repository: "acme/repo",
      objective: "Prove bounded default Code Job shutdown.",
      acceptanceCriteria: ["The real offline CLI lifecycle is closed."],
      evidence: ["The fixed fixture remains unsettled until released."],
    },
    capabilities: {
      allowedActions: ["read_text"],
      writablePaths: ["src"],
      requiredProfilesRemaining: 1,
    },
    turn: 1,
    observations: [],
  };
}

function configurationRuntimeFactory(config, closeCalls) {
  const configurationDigest = configurationDocumentDigest(config);
  const version = {
    version: 1,
    configurationDigest,
    configuration: config,
  };
  const emptyPort = (names) => Object.fromEntries(
    names.map((name) => [name, async () => {}]),
  );
  return async (_candidate, dependencies) => {
    dependencies.actionAdmissionGate.bindEffective({
      version: 1,
      configurationDigest,
    });
    return {
      startupConfiguration: config,
      status: {
        safeMode: false,
        activeVersion: 1,
        stateRevision: 1,
        migrationError: null,
      },
      reader: {
        async readActive() { return version; },
        async readSnapshot() { return { versions: [version] }; },
        ...emptyPort([
          "readActivationReconciliationSnapshot",
          "readVersion",
          "readDraft",
          "readProjectionBatch",
        ]),
      },
      draftManager: emptyPort([
        "createDraft",
        "createInitializationDraft",
        "reviseDraft",
      ]),
      simulator: emptyPort([
        "prepareInitialization",
        "prepareDraftActivation",
        "prepareRollback",
      ]),
      activationExecutor: emptyPort([
        "activateInitialization",
        "activateDraft",
        "activateRollback",
      ]),
      proposalPort: emptyPort([
        "createDraft",
        "createInitializationDraft",
        "reviseDraft",
      ]),
      async close() { closeCalls.push("configuration"); },
    };
  };
}

function defaultCodeJobApplicationOptions({
  config,
  calls,
  closeCalls,
  lifecycle,
  versioned,
  codeJobRuntimeStarted,
  memoryRuntimeFactory,
  confirmationRuntimeFactory,
}) {
  const runners = {
    "code-action-runner": { async claim() {}, async advance() {} },
  };
  return {
    config,
    versionedConfiguration: versioned,
    externalActions: true,
    store: memoryStore(),
    runtimeLifecycle: lifecycle,
    ...(versioned
      ? { configurationRuntimeFactory: configurationRuntimeFactory(config, closeCalls) }
      : {}),
    codeExecutorRuntimeFactory: async () => ({
      authority: defaultExecutorAuthority(),
      executor: controlledCodeExecutorPort(),
      async close() { closeCalls.push("code-executor"); },
    }),
    ...localCoordinationStubs({ calls, closeCalls, runners }),
    ...(memoryRuntimeFactory === undefined ? {} : { memoryRuntimeFactory }),
    codeJobRuntimeFactory: async (options) => {
      calls.codeJobRuntime = options;
      await codeJobRuntimeStarted?.(options);
      return {
        confirmationExecutor: { async execute() {}, async reconcile() {} },
        reader: {
          async get() {},
          async getDetail() {},
          async list() {},
          async listNewest() {},
        },
        control: codeJobControlPort(),
        worker: codeJobWorkerPort(),
        projectionSource: codeJobProjectionSourcePort(),
        async close() { closeCalls.push("code-job"); },
      };
    },
    codeJobMemoryProjectorFactory: () => ({ async runCycle() {} }),
    codeActionProposalRunnerFactory: () => ({ async runCycle() {} }),
    workProposalRunnerGroupFactory: (runnersToGroup) =>
      runnersToGroup[0] || null,
    confirmationRuntimeFactory: confirmationRuntimeFactory ?? (async () => ({
      queue: confirmationQueuePort(),
      memoryProjectionSource: confirmationMemoryProjectionSourcePort(),
      producerQueue: confirmationProducerPort(),
      async close() { closeCalls.push("confirmation"); },
    })),
    operationsRuntimeFactory: () => Object.freeze({}),
  };
}

function observeClose(t, prototype, label, calls) {
  const original = prototype.close;
  return t.mock.method(prototype, "close", function (...arguments_) {
    calls.push({ label, owner: this });
    return Reflect.apply(original, this, arguments_);
  });
}

function invalidationPendingEmployeeState() {
  const workItemId = "pr-work-startup-invalidation";
  const approvalBindingDigest = "b".repeat(64);
  const confirmationInvalidationIntent = {
    requestedBy: { roleId: "pr-reviewer", workItemId },
    approvalBindingDigest,
    reason: "work_item_superseded",
  };
  return {
    revision: 7,
    paused: false,
    jobs: [
      {
        id: workItemId,
        fingerprint: "startup-invalidation-fingerprint",
        policyVersion: 1,
        subjectId: "github:pr:acme/repo#42",
        repo: "acme/repo",
        number: 42,
        title: "Protect checkout",
        url: "https://github.com/acme/repo/pull/42",
        relation: "review_requested",
        headRefOid: "0123456789abcdef0123456789abcdef01234567",
        nextAction: "review",
        status: "confirmation_invalidation_pending",
        confirmationId: `confirmation-${workItemId}`,
        confirmationBindingDigest: approvalBindingDigest,
        confirmationStatus: "pending",
        confirmationIntent: null,
        confirmationInvalidationIntent,
        summary: "旧 Review 已被新事实替代",
        evidence: ["nextAction changed"],
        reviewVerdict: "comment",
        reviewBody: "旧 Review 不应再发布。",
        createdAt: "2026-08-02T01:00:00.000Z",
        updatedAt: "2026-08-02T01:01:00.000Z",
      },
    ],
    memoryOutbox: [],
    memoryOutboxError: "",
    memoryOutboxDropped: 0,
    lastRun: null,
    lastError: "等待恢复外部动作失效",
  };
}

function storedValues(entries) {
  const values = new Map(
    Object.entries(entries).map(([name, value]) => [
      name,
      structuredClone(value),
    ]),
  );
  return {
    async read(name, fallback = null) {
      return structuredClone(values.has(name) ? values.get(name) : fallback);
    },
    async write(name, value) {
      values.set(name, structuredClone(value));
    },
  };
}

test("brain provider factory keeps the role independent from its model", () => {
  const brain = createBrain({
    enabled: true,
    provider: "ollama",
    model: "qwen3.5:9b",
    baseUrl: "http://localhost:11434/",
    contextTokens: 4096,
  });

  assert.ok(brain instanceof OllamaBrain);
  assert.equal(brain.provider, "ollama");
  assert.equal(brain.model, "qwen3.5:9b");
  assert.equal(brain.baseUrl, "http://localhost:11434");
  assert.equal(createBrain({ enabled: false }), null);
});

test("global brain routes DingTalk summaries to the configured primary and keeps Ollama fallback", () => {
  const brain = createBrain({
    enabled: true,
    provider: "ollama",
    model: "qwen3.5:9b",
    baseUrl: "http://127.0.0.1:11434",
    primaryBrain: {
      provider: "codex-login-cli",
      model: "gpt-6-luna",
      reasoningEffort: "medium",
      remoteData: { requirements: false, code: false, memory: false, dingtalk: true },
    },
    allowRemoteDingTalkSummary: true,
  }, { router: { async generate() { throw new Error("not invoked during construction"); } } });

  assert.ok(brain instanceof RoutedDingTalkSummaryBrain);
  assert.equal(brain.provider, "codex-login-cli");
  assert.equal(brain.model, "gpt-6-luna");
  assert.equal(brain.fallback.provider, "ollama");
  assert.equal(brain.fallback.model, "qwen3.5:9b");
});

test("unknown brain providers fail explicitly", () => {
  assert.throws(
    () => createBrain({ enabled: true, provider: "future-provider" }),
    /Unsupported brain provider: future-provider/,
  );
});

test("the PR employee can use its own model without changing its role", () => {
  const reviewer = createPrEmployeeReviewer(
    {
      enabled: true,
      provider: "ollama",
      model: "qwen3.5:9b",
      contextTokens: 8192,
    },
    { model: "special-review-model", contextTokens: 4096 },
  );

  assert.ok(reviewer instanceof OllamaPrEmployeeReviewer);
  assert.equal(reviewer.provider, "ollama");
  assert.equal(reviewer.model, "special-review-model");
  assert.equal(reviewer.contextTokens, 4096);
});

test("application wires the PR promoter primary router and owns its shutdown", async () => {
  const config = applicationConfig();
  config.brain = { enabled: true, provider: "ollama", model: "qwen3.5:9b" };
  config.employees.prReviewer = { enabled: true, initialPaused: true, allowRemoteCodeContext: true,
    primaryBrain: { provider: "codex-login-cli", model: "gpt-5.6-luna", remoteData: { requirements: true, code: true, memory: false } } };
  let constructions = 0; let closes = 0;
  const application = await createApplication({ config, store: memoryStore(),
    prEmployeeBrainRouterFactory() {
      constructions += 1;
      return { async generate() { throw new Error("No generation during construction"); }, async close() { closes += 1; } };
    },
  });
  assert.equal(constructions, 1);
  assert.equal(application.prEmployee.reviewer.model, "gpt-5.6-luna");
  assert.equal(application.prEmployee.reviewer.fallback.model, "qwen3.5:9b");
  await application.close();
  assert.equal(closes, 1);
});

test("employee registry keeps role instances discoverable by id", () => {
  const employee = (id) => ({
    id,
    async view() {},
    async roleView() {},
    async run() {},
    async control() {},
  });
  const prEmployee = employee("pr-reviewer");
  const analyst = employee("requirements-analyst");

  const registry = createEmployeeRegistry([prEmployee, analyst]);

  assert.strictEqual(registry.get("pr-reviewer"), prEmployee);
  assert.strictEqual(registry.get("requirements-analyst"), analyst);
});

test("application composition keeps the disabled executor absent", async () => {
  const store = memoryStore();
  const calls = [];
  const application = await createApplication({
    config: applicationConfig(),
    store,
    codeExecutorRuntimeFactory: async (config, dependencies) => {
      calls.push({ config, dependencies });
      return null;
    },
  });

  assert.equal(Object.hasOwn(application, "codeExecutorRuntime"), false);
  assert.equal(Object.hasOwn(application, "codeExecutor"), false);
  assert.deepEqual(calls[0].config, { enabled: false });
  assert.strictEqual(calls[0].dependencies.store, store);
});

test("application composes the recovered local workflow router", async () => {
  const store = memoryStore();
  const workflowRouting = { id: "workflow-routing" };
  const calls = [];
  const application = await createApplication({
    config: {
      ...applicationConfig(),
      workflowRouting: {
        schemaVersion: 1,
        enabled: false,
        maxHops: 8,
        rules: [],
      },
    },
    store,
    workflowRoutingRuntimeFactory: async (config, dependencies) => {
      calls.push({ config, dependencies });
      return workflowRouting;
    },
  });

  assert.strictEqual(application.workflowRouting, workflowRouting);
  assert.strictEqual(calls[0].dependencies.store, store);
  assert.equal("actionAdmissionGate" in calls[0].dependencies, false);
  assert.equal(calls[0].config.workflowRouting.enabled, false);
  await application.close();
});

test("enabled work coordination composes private runtimes into frozen application ports", async () => {
  const store = memoryStore();
  const runtimeOrder = [];
  const serviceOrder = [];
  const closeCalls = [];
  const calls = {};
  const workers = [{ roleId: "developer" }];
  const configuredWorker = { roleId: "requirements-analyst" };
  const configuredEmployee = {
    id: "requirements-analyst",
    scheduleMinutes: 3,
    async view() { return { role: await this.roleView() }; },
    async roleView() {
      return {
        id: this.id,
        name: "需求分析师",
        mission: "梳理需求",
        enabled: true,
        state: "paused",
        revision: 0,
        paused: true,
      };
    },
    async run() {},
    async control() {},
  };
  const workflowRouting = {
    async readAssignmentBatch() {},
    async close() {
      closeCalls.push("workflow");
    },
  };
  const ledgerRuntime = {
    graphReader: {
      async getSnapshot() {
        return { graphRevision: 7, tasks: [] };
      },
      async createChild() {
        throw new Error("graph writes must remain private");
      },
    },
    graphBrowserReader: {
      async getSnapshot() {
        return { graphRevision: 8, tasks: [] };
      },
    },
    graphPlanner: {
      async createChild() {
        throw new Error("graph planner must remain private");
      },
      async resumeTask() {
        throw new Error("graph planner must remain private");
      },
    },
    graphMemoryProjectionSource: graphMemoryProjectionSourcePort(),
    async getSummary() {
      return { source: "ledger" };
    },
    async listItems(options) {
      return { items: [options], nextCursor: null };
    },
    async listTimeline(options) {
      return { items: [options], nextCursor: null };
    },
    async readItemForReconciliation(input) {
      return { input };
    },
    async transition(input) {
      return { input };
    },
    async close() {
      closeCalls.push("ledger");
    },
  };
  const attentionProducer = { async create() {} };
  const attentionConsumer = { async readOutbox() {} };
  const attentionBrowser = {
    async listMaintenance() { return { items: [], total: 0 }; },
      async readStatus() { return null; },
    async next() {
      return { id: "attention-1" };
    },
    async answer(value) {
      return value;
    },
    async reject(value) {
      return value;
    },
    async later(value) {
      return value;
    },
  };
  const proposalProducer = { async create() {} };
  const proposalConsumer = { async readResultBatch() {} };
  const confirmationQueue = confirmationQueuePort();
  const policy = { async bind() {} };
  const roleDirectory = { async resolve() {} };
  const factSource = workflowFactSourcePort();
  const roleContextAssembler = { async assemble() {} };
  const orchestratorService = { async execute() {} };
  const reconciler = { async runCycle() {} };
  const proposalReconciler = { async runCycle() {} };
  const conditionWaker = { async runCycle() {} };
  const workLoop = { async runCycle() {} };
  const dispatcher = { async dispatchPending() {} };
  const coordinationService = {
    async intake() {
      return "intake-result";
    },
    async runCycle(value) {
      return value;
    },
  };
  const coordinator = {
    async next() {
      return "coordinated-attention";
    },
  };

  const application = await createApplication({
    config: workCoordinationConfig(),
    store,
    workCoordinationDependencies: { workers },
    codeExecutorRuntimeFactory: async () => {
      runtimeOrder.push("code-executor");
      return null;
    },
    workflowRoutingRuntimeFactory: async () => {
      runtimeOrder.push("workflow");
      return workflowRouting;
    },
    workLedgerRuntimeFactory: async (options) => {
      runtimeOrder.push("ledger");
      calls.ledger = options;
      assert.equal(await options.confirmationSettlementReader.read({ confirmationId: "before-runtime" }), undefined);
      assert.equal(await options.obsoleteCodeJobSettler.settle({}), null);
      assert.equal(await options.hostContextRecoveryReader.read({ itemId: "before-runtime" }), null);
      return ledgerRuntime;
    },
    dailyWorkLedgerViewFactory: ({ ledger, activeWindowDays }) => {
      calls.dailyWorkLedgerView = { ledger, activeWindowDays };
      return {
        getSummary: ledger.getSummary,
        listItems: ledger.listItems,
        listTimeline: ledger.listTimeline,
      };
    },
    ownerWorkRetryServiceFactory: (options) => {
      serviceOrder.push("owner-work-retry");
      calls.ownerWorkRetry = options;
      return {
        async retryDecisionExhaustion(input) {
          return { retried: input };
        },
        async transition() {
          throw new Error("generic transition must remain private");
        },
      };
    },
    attentionInboxRuntimeFactory: async (options) => {
      runtimeOrder.push("attention");
      calls.attention = options;
      return {
        producer: attentionProducer,
        browser: attentionBrowser,
        consumer: attentionConsumer,
        async close() {
          closeCalls.push("attention");
        },
      };
    },
    workProposalRuntimeFactory: async (options) => {
      runtimeOrder.push("proposals");
      calls.proposals = options;
      return workProposalRuntimePort({
        producer: proposalProducer,
        consumer: proposalConsumer,
        async close() {
          closeCalls.push("proposals");
        },
      });
    },
    confirmationRuntimeFactory: async () => {
      runtimeOrder.push("confirmation");
      return {
        queue: confirmationQueue,
        producerQueue: confirmationProducerPort(),
        confirmationSettlementReader: {
          async read(input) { return { source: "private-confirmation", input }; },
        },
        async close() {
          closeCalls.push("confirmation");
        },
      };
    },
    configuredWorkforceFactory: (options) => {
      calls.workforce = options;
      return {
        employees: [configuredEmployee],
        workers: [configuredWorker],
      };
    },
    pullRequestFactsLoaderFactory: ({ github }) => {
      calls.pullRequestFactsGithub = github;
      return { async loadPullRequestFacts() {} };
    },
    prEngineerExclusiveGuardFactory: (options) => {
      serviceOrder.push("pr-facts-guard");
      calls.prFactsGuard = options;
      return inProcessExclusiveGuard(() => closeCalls.push("pr-facts-guard"));
    },
    prEngineerServiceFactory: (options) => {
      serviceOrder.push("pr-facts-service");
      calls.prFactsService = options;
      return {
        async recover() {
          serviceOrder.push("pr-facts-recover");
        },
        async context() {},
      };
    },
    workIntentPolicyFactory: (options) => {
      serviceOrder.push("policy");
      calls.policy = options;
      return policy;
    },
    roleWorkerDirectoryFactory: (options) => {
      serviceOrder.push("directory");
      calls.directory = options;
      return roleDirectory;
    },
    workflowFactSourceFactory: (options) => {
      serviceOrder.push("facts");
      calls.facts = options;
      return factSource;
    },
    roleContextAssemblerFactory: (options) => {
      serviceOrder.push("context-assembler");
      calls.contextAssembler = options;
      return roleContextAssembler;
    },
    orchestratorServiceFactory: (options) => {
      serviceOrder.push("orchestrator-service");
      calls.orchestratorService = options;
      return orchestratorService;
    },
    attentionResultReconcilerFactory: (options) => {
      serviceOrder.push("reconciler");
      calls.reconciler = options;
      return reconciler;
    },
    workProposalResultReconcilerFactory: (options) => {
      serviceOrder.push("proposal-reconciler");
      calls.proposalReconciler = options;
      return proposalReconciler;
    },
    workConditionWakerFactory: (options) => {
      serviceOrder.push("waker");
      calls.waker = options;
      return conditionWaker;
    },
    proactiveWorkLoopFactory: (options) => {
      serviceOrder.push("loop");
      calls.loop = options;
      return workLoop;
    },
    workIntentDispatcherFactory: (options) => {
      serviceOrder.push("dispatcher");
      calls.dispatcher = options;
      return dispatcher;
    },
    workCoordinationFactory: (options) => {
      serviceOrder.push("coordination");
      calls.coordination = options;
      return coordinationService;
    },
    attentionCoordinatorFactory: (options) => {
      serviceOrder.push("attention-coordinator");
      calls.coordinator = options;
      return coordinator;
    },
  });

  assert.deepEqual(runtimeOrder, [
    "code-executor",
    "workflow",
    "ledger",
    "attention",
    "proposals",
    "confirmation",
  ]);
  assert.deepEqual(serviceOrder, [
    "owner-work-retry",
    "policy",
    "directory",
    "pr-facts-guard",
    "pr-facts-service",
    "pr-facts-recover",
    "facts",
    "context-assembler",
    "orchestrator-service",
    "reconciler",
    "proposal-reconciler",
    "waker",
    "loop",
    "dispatcher",
    "coordination",
    "attention-coordinator",
  ]);
  assert.strictEqual(calls.ledger.store, store);
  assert.strictEqual(calls.ledger.assignmentSource, workflowRouting);
  assert.deepEqual(await calls.ledger.confirmationSettlementReader.read({ confirmationId: "after-runtime" }), {
    source: "private-confirmation", input: { confirmationId: "after-runtime" },
  });
  assert.equal(Object.isFrozen(calls.ledger.confirmationSettlementReader), true);
  assert.equal("confirmationSettlementReader" in application, false);
  assert.equal(Object.isFrozen(calls.ledger.obsoleteCodeJobSettler), true);
  assert.equal("obsoleteCodeJobSettler" in application, false);
  assert.equal(Object.isFrozen(calls.ledger.hostContextRecoveryReader), true);
  assert.equal("hostContextRecoveryReader" in application, false);
  assert.notStrictEqual(calls.ownerWorkRetry.ledger, ledgerRuntime);
  assert.deepEqual(Object.keys(calls.ownerWorkRetry.ledger).sort(), [
    "readItemForReconciliation",
    "transition",
  ]);
  assert.equal(Object.isFrozen(calls.ownerWorkRetry.ledger), true);
  assert.equal("actionAdmissionGate" in calls.ledger, false);
  assert.equal("actionAdmissionGate" in calls.proposals, false);
  assert.equal("actionAdmissionGate" in calls.dispatcher, false);
  assert.equal("actionAdmissionGate" in calls.orchestratorService, false);
  assert.equal("actionAdmissionGate" in calls.waker, false);
  assert.strictEqual(calls.attention.store, store);
  assert.notStrictEqual(
    calls.ledger.operationQueue,
    calls.attention.operationQueue,
  );
  assert.notStrictEqual(
    calls.attention.operationQueue,
    calls.proposals.operationQueue,
  );
  assert.deepEqual(calls.proposals.runnerScopes, [
    {
      runnerId: "github-review-runner",
      allowedKinds: ["github_review_proposal"],
      allowedRoleIds: ["pr-reviewer"],
    },
  ]);
  assert.strictEqual(
    calls.directory.legacyEmployeeRegistry,
    application.employeeRegistry,
  );
  assert.deepEqual(calls.directory.legacyOwnedRoleIds, ["pr-reviewer"]);
  assert.deepEqual(calls.directory.workers, [configuredWorker, ...workers]);
  assert.strictEqual(
    application.employeeRegistry.get("requirements-analyst"),
    configuredEmployee,
  );
  assert.deepEqual(calls.workforce.brainProviders, {});
  assert.deepEqual(calls.workforce.roles, {});
  assert.strictEqual(calls.workforce.store, store);
  assert.equal(typeof calls.workforce.onRun, "function");
  assert.deepEqual(
    await calls.workforce.onRun({ roleId: "requirements-analyst" }),
    {
      trigger: "employee:requirements-analyst",
      includeWork: true,
      roleId: "requirements-analyst",
    },
  );
  const shutdownController = new AbortController();
  const signalledRun = await calls.workforce.onRun({
    roleId: "requirements-analyst",
    signal: shutdownController.signal,
  });
  const { signal: signalledRunSignal, ...signalledRunOptions } = signalledRun;
  assert.strictEqual(signalledRunSignal, shutdownController.signal);
  assert.deepEqual(signalledRunOptions, {
    trigger: "employee:requirements-analyst",
    includeWork: true,
    roleId: "requirements-analyst",
  });
  assert.deepEqual(calls.policy, workCoordinationConfig().workCoordination.policy);
  assert.deepEqual(calls.prFactsGuard, {
    name: "mydashboard-pr-engineer-read-facts-v1",
  });
  assert.equal(
    typeof calls.pullRequestFactsGithub.loadPullRequestFacts,
    "function",
  );
  assert.deepEqual(Object.keys(calls.prFactsService.store).sort(), [
    "read",
    "write",
  ]);
  assert.equal(Object.isFrozen(calls.prFactsService.store), true);
  assert.deepEqual(Object.keys(calls.prFactsService.pullRequestFactsLoader), [
    "loadPullRequestFacts",
  ]);
  assert.equal(
    Object.isFrozen(calls.prFactsService.pullRequestFactsLoader),
    true,
  );
  assert.deepEqual(Object.keys(calls.prFactsService.exclusiveLease), ["run"]);
  assert.equal(Object.isFrozen(calls.prFactsService.exclusiveLease), true);
  assert.equal(calls.prFactsService.maximumAgeMs, 7_000);
  assert.equal(calls.facts.maximumAgeMs, 7_000);
  assert.deepEqual(Object.keys(calls.facts.store), ["read"]);
  assert.equal(Object.isFrozen(calls.facts.store), true);
  assert.deepEqual(Object.keys(calls.facts.pullRequestFacts), ["context"]);
  assert.equal(Object.isFrozen(calls.facts.pullRequestFacts), true);
  assert.notStrictEqual(
    calls.contextAssembler.graphReader,
    ledgerRuntime.graphReader,
  );
  assert.deepEqual(Object.keys(calls.contextAssembler.graphReader), [
    "getSnapshot",
  ]);
  assert.equal(Object.isFrozen(calls.contextAssembler.graphReader), true);
  assert.notStrictEqual(calls.contextAssembler.factSource, factSource);
  assert.deepEqual(Object.keys(calls.contextAssembler.factSource), ["read"]);
  assert.equal(Object.isFrozen(calls.contextAssembler.factSource), true);
  assert.deepEqual(
    Object.keys(calls.contextAssembler.pullRequestContextReader),
    ["read"],
  );
  assert.equal(
    Object.isFrozen(calls.contextAssembler.pullRequestContextReader),
    true,
  );
  assert.strictEqual(
    calls.orchestratorService.contextAssembler,
    roleContextAssembler,
  );
  assert.strictEqual(
    calls.orchestratorService.graphReader,
    ledgerRuntime.graphReader,
  );
  assert.deepEqual(calls.orchestratorService.capabilityRoles, {
    testing: "tester",
  });
  assert.strictEqual(calls.reconciler.attentionConsumer, attentionConsumer);
  assert.strictEqual(calls.reconciler.ledger, ledgerRuntime);
  assert.strictEqual(calls.proposalReconciler.proposalConsumer, proposalConsumer);
  assert.strictEqual(calls.proposalReconciler.ledger, ledgerRuntime);
  assert.strictEqual(
    calls.waker.factSource,
    calls.contextAssembler.factSource,
  );
  assert.strictEqual(calls.waker.ledger, ledgerRuntime);
  assert.strictEqual(calls.loop.roleDirectory, roleDirectory);
  assert.strictEqual(calls.loop.roleContextAssembler, roleContextAssembler);
  assert.strictEqual(calls.loop.orchestratorService, orchestratorService);
  assert.equal(calls.loop.issueActiveWindowDays, 14);
  assert.equal(calls.dailyWorkLedgerView.activeWindowDays, 14);
  assert.equal(Object.isFrozen(calls.dailyWorkLedgerView.ledger), true);
  assert.equal(calls.loop.decideTimeoutMs, 3_000);
  assert.strictEqual(calls.dispatcher.policy, policy);
  assert.strictEqual(calls.dispatcher.attentionProducer, attentionProducer);
  assert.strictEqual(calls.dispatcher.proposalProducer, proposalProducer);
  assert.strictEqual(calls.coordination.workLoop, workLoop);
  assert.equal(typeof calls.coordination.proposalRunner.runCycle, "function");
  assert.strictEqual(calls.coordination.dispatcher, dispatcher);
  assert.equal(calls.coordination.attentionLimit, 14);
  assert.equal(calls.coordination.proposalLimit, 16);
  assert.strictEqual(
    calls.coordination.proposalResultReconciler,
    proposalReconciler,
  );
  assert.strictEqual(calls.coordinator.externalQueue, confirmationQueue);
  assert.strictEqual(calls.coordinator.internalInbox, attentionBrowser);

  assert.deepEqual(Object.keys(application.workLedgerView).sort(), [
    "getSummary",
    "listItems",
    "listTimeline",
  ]);
  assert.deepEqual(Object.keys(application.dailyWorkLedgerView).sort(), [
    "getSummary",
    "listItems",
    "listTimeline",
  ]);
  assert.deepEqual(Object.keys(application.workGraphView), ["getSnapshot"]);
  assert.notStrictEqual(application.workGraphView, ledgerRuntime.graphReader);
  assert.notStrictEqual(application.workGraphView, ledgerRuntime.graphBrowserReader);
  assert.equal("createChild" in application.workGraphView, false);
  assert.deepEqual(Object.keys(application.attentionBrowser).sort(), [
    "answer",
    "later",
    "listMaintenance",
    "next",
    "readStatus",
    "reject",
  ]);
  assert.deepEqual(Object.keys(application.attentionCoordinator), ["next"]);
  assert.deepEqual(Object.keys(application.workCoordination).sort(), [
    "intake",
    "runCycle",
  ]);
  assert.deepEqual(Object.keys(application.ownerWorkRetry), [
    "retryDecisionExhaustion",
  ]);
  assert.equal("transition" in application.ownerWorkRetry, false);
  for (const port of [
    application.workLedgerView,
    application.dailyWorkLedgerView,
    application.workGraphView,
    application.attentionBrowser,
    application.attentionCoordinator,
    application.workCoordination,
    application.ownerWorkRetry,
  ]) {
    assert.equal(Object.isFrozen(port), true);
  }
  for (const privateName of [
    "workLedger",
    "workLedgerRuntime",
    "graphReader",
    "graphPlanner",
    "workGraphPlanner",
    "workGraphStore",
    "createGraphChild",
    "attentionInbox",
    "attentionInboxRuntime",
    "attentionProducer",
    "attentionConsumer",
    "workProposalRuntime",
    "proposalProducer",
    "proposalConsumer",
  ]) {
    assert.equal(privateName in application, false);
  }
  assert.deepEqual(await application.workLedgerView.getSummary(), {
    source: "ledger",
  });
  assert.deepEqual(await application.dailyWorkLedgerView.getSummary(), {
    source: "ledger",
  });
  assert.deepEqual(await application.workGraphView.getSnapshot(), {
    graphRevision: 8,
    tasks: [],
  });
  assert.equal(await application.workCoordination.intake(), "intake-result");
  assert.deepEqual(
    await application.ownerWorkRetry.retryDecisionExhaustion({ itemId: "work-1" }),
    { retried: { itemId: "work-1" } },
  );
  assert.equal(
    await application.attentionCoordinator.next(),
    "coordinated-attention",
  );

  await Promise.all([application.close(), application.close()]);
  assert.deepEqual(closeCalls, [
    "pr-facts-guard",
    "confirmation",
    "proposals",
    "attention",
    "ledger",
    "workflow",
  ]);
});

test("a late PR fact composition failure closes its guard before prior runtimes", async () => {
  const calls = {};
  const closeCalls = [];
  const startupFailure = new Error("workflow facts failed to compose");

  await assert.rejects(
    createApplication({
      config: workCoordinationConfig({ externalActions: false }),
      store: memoryStore(),
      externalActions: false,
      ...localCoordinationStubs({ calls, closeCalls, runners: {} }),
      prEngineerExclusiveGuardFactory: () =>
        inProcessExclusiveGuard(() => closeCalls.push("pr-facts-guard")),
      prEngineerServiceFactory: () => ({
        async recover() {},
        async context() {},
      }),
      workflowFactSourceFactory: () => {
        throw startupFailure;
      },
    }),
    (error) => error === startupFailure,
  );

  assert.deepEqual(closeCalls, [
    "pr-facts-guard",
    "proposals",
    "attention",
    "ledger",
    "workflow",
  ]);
  assert.equal(calls.loop, undefined);
});

test("missing GitHub PR facts authority fails startup and releases its guard", async () => {
  const calls = {};
  const closeCalls = [];
  let serviceCalls = 0;

  await assert.rejects(
    createApplication({
      config: workCoordinationConfig({ externalActions: false }),
      store: memoryStore(),
      externalActions: false,
      ...localCoordinationStubs({ calls, closeCalls, runners: {} }),
      pullRequestFactsLoaderFactory: () => ({}),
      prEngineerExclusiveGuardFactory: () =>
        inProcessExclusiveGuard(() => closeCalls.push("pr-facts-guard")),
      prEngineerServiceFactory: () => {
        serviceCalls += 1;
        return { async recover() {}, async context() {} };
      },
    }),
    /GitHub pull request facts loader is invalid/u,
  );

  assert.equal(serviceCalls, 0);
  assert.equal(calls.loop, undefined);
  assert.deepEqual(closeCalls, [
    "pr-facts-guard",
    "proposals",
    "attention",
    "ledger",
    "workflow",
  ]);
});

test("corrupted PR fact state aborts before facts or employee loops open", async () => {
  const calls = {};
  const closeCalls = [];
  let factSourceCalls = 0;
  const store = storedValues({
    "pr-engineer-read-facts": {
      schemaVersion: 1,
      revision: 0,
      records: [],
      contentDigest: "0".repeat(64),
    },
  });

  await assert.rejects(
    createApplication({
      config: workCoordinationConfig({ externalActions: false }),
      store,
      externalActions: false,
      ...localCoordinationStubs({ calls, closeCalls, runners: {} }),
      pullRequestFactsLoaderFactory: () => ({
        async loadPullRequestFacts() {
          throw new Error("corruption recovery must not call GitHub");
        },
      }),
      prEngineerExclusiveGuardFactory: () =>
        inProcessExclusiveGuard(() => closeCalls.push("pr-facts-guard")),
      workflowFactSourceFactory: () => {
        factSourceCalls += 1;
        return workflowFactSourcePort();
      },
    }),
    (error) => error.code === "PR_FACT_STATE_CORRUPTED",
  );

  assert.equal(factSourceCalls, 0);
  assert.equal(calls.loop, undefined);
  assert.deepEqual(closeCalls, [
    "pr-facts-guard",
    "proposals",
    "attention",
    "ledger",
    "workflow",
  ]);
});

test("work coordination normalizes omitted timing before composing the loop and orchestrator", async () => {
  const cases = [
    {
      omitted: [
        "leaseDurationMs",
        "resolveTimeoutMs",
        "decisionTimeoutMs",
      ],
      expected: {
        leaseDurationMs: 120_000,
        resolveTimeoutMs: 10_000,
        decideTimeoutMs: 60_000,
        evidenceVerificationTimeoutMs: 49_000,
      },
    },
    {
      omitted: ["decisionTimeoutMs"],
      expected: {
        leaseDurationMs: 16_000,
        resolveTimeoutMs: 2_000,
        decideTimeoutMs: 3_000,
        evidenceVerificationTimeoutMs: 10_000,
      },
    },
  ];

  for (const { omitted, expected } of cases) {
    const config = structuredClone(
      workCoordinationConfig({ externalActions: false }),
    );
    for (const field of omitted) delete config.workCoordination[field];
    const calls = {};
    const closeCalls = [];
    const application = await createApplication({
      config,
      store: memoryStore(),
      externalActions: false,
      ...localCoordinationStubs({ calls, closeCalls, runners: {} }),
    });

    assert.equal(calls.loop.leaseDurationMs, expected.leaseDurationMs);
    assert.equal(calls.loop.resolveTimeoutMs, expected.resolveTimeoutMs);
    assert.equal(calls.loop.decideTimeoutMs, expected.decideTimeoutMs);
    assert.equal(
      calls.orchestratorService.evidenceVerificationTimeoutMs,
      expected.evidenceVerificationTimeoutMs,
    );
    assert.equal(
      calls.orchestratorService.evidenceMutationMarginMs,
      1_000,
    );
    assert.equal(
      calls.loop.resolveTimeoutMs +
        calls.loop.decideTimeoutMs +
        calls.orchestratorService.evidenceMutationMarginMs +
        calls.orchestratorService.evidenceVerificationTimeoutMs,
      calls.loop.leaseDurationMs,
    );

    await application.close();
  }
});

test("composed intent dispatch honors configured leases and fences expired acknowledgements", async (t) => {
  const cases = [
    { name: "configured lease accommodates slow delivery", leaseDurationMs: 180_000, delayMs: 35_000, delivered: 1 },
    { name: "omitted lease preserves the dispatcher default", delayMs: 35_000, delivered: 0 },
    { name: "configured lease still expires", leaseDurationMs: 180_000, delayMs: 180_001, delivered: 0 },
  ];
  for (const scenario of cases) {
    await t.test(scenario.name, async (t) => {
      let now = Date.parse("2026-10-14T04:00:00.000Z");
      const clock = () => new Date(now).toISOString();
      const config = workCoordinationConfig({ externalActions: false });
      if (scenario.leaseDurationMs === undefined) {
        delete config.workCoordination.leaseDurationMs;
      } else {
        config.workCoordination.leaseDurationMs = scenario.leaseDurationMs;
      }
      const event = normalizeWorkflowEvent({
        schemaVersion: 1,
        eventType: "issue.created",
        occurredAt: clock(),
        source: { provider: "github", scopeId: "lease-regression" },
        subject: { id: "github:issue:acme/repo#42", repository: "acme/repo", number: 42 },
        payload: { title: "Clarify acceptance", state: "open" },
      });
      const assignment = {
        sequence: 1,
        assignment: {
          assignmentId: "workflow-assignment-lease-regression",
          eventId: event.eventId,
          target: { type: "role", id: "requirements-analyst" },
          reason: "requirements",
          createdAt: clock(),
        },
        event,
      };
      const calls = {};
      const stubs = localCoordinationStubs({ calls, closeCalls: [], runners: {} });
      delete stubs.workIntentDispatcherFactory;
      delete stubs.workIntentPolicyFactory;
      let ledger;
      let attentionCreates = 0;
      const application = await createApplication({
        config,
        store: storedValues({}),
        externalActions: false,
        ...stubs,
        workCoordinationDependencies: { clock },
        workflowRoutingRuntimeFactory: async () => ({
          async readAssignmentBatch({ afterSequence }) {
            return {
              items: afterSequence === 0 ? [assignment] : [],
              nextSequence: 1, highWatermark: 1, oldestAvailableSequence: 1,
            };
          },
          async close() {},
        }),
        workLedgerRuntimeFactory: async (options) => {
          ledger = await createWorkLedgerRuntime({
            ...options,
            clock,
            createCandidateProcessor: createLocalWorkLedgerCandidateProcessor,
            createGuard: () => ({ ...inProcessExclusiveGuard(), async acquire() {} }),
          });
          return ledger;
        },
        attentionInboxRuntimeFactory: async () => ({
          producer: {
            async create() {
              attentionCreates += 1;
              now += scenario.delayMs;
              return { requestId: "attention-lease-regression" };
            },
          },
          consumer: { async readOutbox() {} },
          browser: {
            async next() {}, async answer() {}, async reject() {}, async later() {},
            async listMaintenance() { return { items: [], total: 0 }; },
      async readStatus() { return null; },
          },
          async close() {},
        }),
      });
      t.after(() => application.close());
      await ledger.intake();
      const queued = (await ledger.listItems()).items[0];
      const claimed = await ledger.claim({
        itemId: queued.itemId, expectedRevision: queued.revision,
        workerId: "employee-requirements-analyst", leaseDurationMs: 60_000,
      });
      await ledger.stageIntent({
        itemId: claimed.itemId, expectedRevision: claimed.revision,
        leaseId: claimed.leaseId, actorId: claimed.ownerId, roleId: "requirements-analyst",
        intent: {
          schemaVersion: 1, type: "ask_user", summary: "Clarify acceptance", reason: "Evidence is incomplete",
          question: "Continue with this acceptance criterion?",
          choices: [
            { id: "yes", label: "Continue", description: "Keep the criterion" },
            { id: "no", label: "Revise", description: "Revise the criterion" },
          ],
        },
      });

      const result = await calls.coordination.dispatcher.dispatchPending();

      assert.equal(attentionCreates, 1);
      assert.equal(result.delivered, scenario.delivered, JSON.stringify(result));
      assert.equal(result.uncertain, 1 - scenario.delivered);
      const persisted = (await ledger.listOutbox()).items[0];
      assert.equal(persisted.status, scenario.delivered ? "delivered" : "dispatching");
      const item = await ledger.readItemForReconciliation({ itemId: queued.itemId });
      assert.equal(item.status, scenario.delivered ? "waiting_user" : "dispatch_pending");
      if (scenario.delivered) {
        assert.equal((await calls.coordination.dispatcher.dispatchPending()).scanned, 0);
        assert.equal(attentionCreates, 1);
      } else {
        assert.equal(result.items[0].code, "ack-result-uncertain");
        assert.equal(
          Date.parse(persisted.dispatchLeaseUntil) - Date.parse("2026-10-14T04:00:00.000Z"),
          scenario.leaseDurationMs ?? 30_000,
        );
      }
    });
  }
});

test("work coordination rejects optional timing below the role-context budget", async () => {
  const config = workCoordinationConfig({ externalActions: false });
  config.workCoordination.leaseDurationMs = 12_999;
  delete config.workCoordination.resolveTimeoutMs;
  delete config.workCoordination.decisionTimeoutMs;
  const calls = {};
  const closeCalls = [];

  await assert.rejects(
    createApplication({
      config,
      store: memoryStore(),
      externalActions: false,
      ...localCoordinationStubs({ calls, closeCalls, runners: {} }),
    }),
    /must preserve at least 1000ms.*10000ms for evidence verification/,
  );
  assert.equal(calls.loop, undefined);
  assert.deepEqual(closeCalls, ["workflow"]);
});

test("default delivery evidence service is shared, least-authority, and verifies trusted results", async () => {
  const config = workCoordinationConfig({ externalActions: false });
  const calls = {};
  const closeCalls = [];
  const taskId = "task-review";
  const roleId = "pr-reviewer";
  const proposalId = "proposal-review-1";
  const contractDigest = "b".repeat(64);
  const evidenceTarget = {
    schemaVersion: 1,
    taskId,
    roleId,
    contractRevision: 4,
    contractDigest,
    deliverables: [
      { deliverableId: "review", kind: "review-report" },
    ],
  };
  const proposal = normalizeBoundWorkProposal({
    proposalId,
    policyVersion: 1,
    kind: "github_review_proposal",
    requestedBy: { roleId, workItemId: taskId },
    source: { assignmentId: "assignment-review", eventId: "event-review" },
    binding: { evidenceTarget },
    payload: { verdict: "comment", body: "Review completed" },
  });
  const result = createWorkProposalResult({
    proposal,
    sequence: 1,
    transition: {
      status: "succeeded",
      summary: "Review published",
      evidence: ["github-review:published"],
    },
    downstreamRef: "github-review-1",
    at: "2026-08-06T01:00:00.000Z",
  });
  const resultId = result.resultId;
  const resultDigest = result.contentDigest;
  const authoritativeEvidence = {
    kind: "review-report",
    referenceId: resultId,
    contentDigest: resultDigest,
  };
  const evidenceReaderCalls = [];
  const proposalRuntime = workProposalRuntimePort({
    runners: {},
    evidenceReader: {
      async getResult({ resultId: requestedResultId }) {
        evidenceReaderCalls.push(["getResult", requestedResultId]);
        return requestedResultId === resultId ? structuredClone(result) : null;
      },
      async getResultForProposal() {
        throw new Error("review verification uses its exact result id");
      },
      async getProposalForEvidence({ proposalId: requestedProposalId }) {
        evidenceReaderCalls.push([
          "getProposalForEvidence",
          requestedProposalId,
        ]);
        return requestedProposalId === proposalId
          ? structuredClone(proposal)
          : null;
      },
      async listEvidenceCandidates() {
        throw new Error("verification must use exact result authority");
      },
    },
  });
  const compositionStubs = localCoordinationStubs({
    calls,
    closeCalls,
    runners: {},
  });

  const application = await createApplication({
    config,
    store: memoryStore(),
    ...compositionStubs,
    workProposalRuntimeFactory: async (options) => {
      calls.proposalRuntime = options;
      return proposalRuntime;
    },
    roleContextAssemblerFactory: (options) => {
      calls.contextAssembler = options;
      return { async assemble() {} };
    },
  });

  assert.strictEqual(
    calls.contextAssembler.evidenceCatalog,
    application.deliveryEvidence,
  );
  assert.strictEqual(
    calls.orchestratorService.evidenceVerifier,
    application.deliveryEvidence,
  );
  assert.deepEqual(Object.keys(application.deliveryEvidence), [
    "listForTask",
    "verify",
  ]);
  assert.equal(Object.isFrozen(application.deliveryEvidence), true);
  assert.equal("getResult" in application.deliveryEvidence, false);
  assert.equal("getProposalForEvidence" in application.deliveryEvidence, false);

  const coordination = config.workCoordination;
  const evidenceBudget =
    coordination.leaseDurationMs -
    coordination.resolveTimeoutMs -
    coordination.decisionTimeoutMs -
    1_000;
  assert.equal(
    calls.orchestratorService.evidenceVerificationTimeoutMs,
    evidenceBudget,
  );
  assert.equal(
    calls.orchestratorService.evidenceVerificationTimeoutMs +
      calls.orchestratorService.evidenceMutationMarginMs +
      coordination.resolveTimeoutMs +
      coordination.decisionTimeoutMs <=
      coordination.leaseDurationMs,
    true,
  );

  assert.deepEqual(
    await application.deliveryEvidence.verify({
      taskId,
      roleId,
      contractRevision: evidenceTarget.contractRevision,
      contractDigest,
      deliverableId: "review",
      evidence: authoritativeEvidence,
    }),
    authoritativeEvidence,
  );
  assert.deepEqual(evidenceReaderCalls, [
    ["getResult", resultId],
    ["getProposalForEvidence", proposalId],
  ]);

  await application.close();
});

test("disabled work coordination does not acquire private runtimes or services", async () => {
  let workFactoryCalls = 0;
  const unexpectedFactory = () => {
    workFactoryCalls += 1;
    throw new Error("work coordination must stay disabled");
  };
  const application = await createApplication({
    config: applicationConfig(),
    store: memoryStore(),
    workLedgerRuntimeFactory: unexpectedFactory,
    attentionInboxRuntimeFactory: unexpectedFactory,
    workProposalRuntimeFactory: unexpectedFactory,
    workIntentPolicyFactory: unexpectedFactory,
    workCoordinationFactory: unexpectedFactory,
    workProposalResultReconcilerFactory: unexpectedFactory,
  });

  assert.equal(workFactoryCalls, 0);
  assert.equal(application.workLedgerView, null);
  assert.equal(application.dailyWorkLedgerView, null);
  assert.equal(application.workGraphView, null);
  assert.equal(application.attentionBrowser, null);
  assert.equal(application.attentionCoordinator, null);
  assert.equal(application.workCoordination, null);
  await application.close();
});

test("enabled unified memory exposes search only and projects the existing work ledger", async () => {
  const config = {
    ...workCoordinationConfig({ externalActions: false }),
    memory: {
      enabled: true,
      maximumRecords: 1234,
      maximumStateBytes: 5_000_000,
    },
  };
  const calls = {};
  const memoryRuntime = {
    producer: { async appendBatch() {} },
    lifecycleProducer: {
      async appendWorkItems() {},
      async appendGraphEvents() {},
      async appendProjectionRecords() {},
      async appendAuthorityProjection() {},
      async adoptGraphCheckpoint() {},
    },
    authorityReader: {
      async getAuthorityState() {},
      async getAuthorityProjectionState() {},
      requiresAuthorityProjectionCheckpoint() { return false; },
    },
    search: {
      async search(value) { return { items: [value], nextCursor: null }; },
      async getHealth() { return { ready: true }; },
    },
    receiptVerifier: {
      async verify(value) { return { ...value, persisted: true }; },
    },
    maintenance: { async rebuildIndex() {} },
    async close() {},
  };
  const projector = { async runCycle() { return { added: 0 }; } };
  const application = await createApplication({
    config,
    store: memoryStore(),
    workflowRoutingRuntimeFactory: async () => ({
      async readAssignmentBatch() {},
      async close() {},
    }),
    workLedgerRuntimeFactory: async () => ({
      graphReader: { async getSnapshot() { return { graphRevision: 0 }; } },
      graphBrowserReader: { async getSnapshot() { return { graphRevision: 0 }; } },
      scopedGraphPlannerFactory: { forRoot() {} },
      graphDelivererFactory: { forClaim() {} },
      graphMemoryProjectionSource: graphMemoryProjectionSourcePort(),
      memoryAuthoritySource: memoryAuthoritySourcePort(),
      async getSummary() {},
      async listItems() { return { items: [], nextCursor: null }; },
      async listTimeline() { return { items: [], nextCursor: null }; },
      verifyPullRequestExecutionBinding(binding) {
        return structuredClone(binding);
      },
      verifyPullRequestExecutionBindings(request) {
        return structuredClone({
          ledgerRevision: request.ledgerRevision,
          current: request.bindings.map(() => true),
        });
      },
      ...ownerRetryLedgerMethods(),
      async close() {},
    }),
    attentionInboxRuntimeFactory: async () => ({
      producer: { async create() {} },
      consumer: { async readOutbox() {} },
      browser: {
        async next() {}, async answer() {}, async reject() {}, async later() {},
        async listMaintenance() { return { items: [], total: 0 }; },
      async readStatus() { return null; },
      },
      async close() {},
    }),
    workProposalRuntimeFactory: async () => workProposalRuntimePort(),
    memoryRuntimeFactory: async (options) => {
      calls.memory = options;
      return memoryRuntime;
    },
    codeJobRuntimeFactory: async (options) => {
      calls.codeJobRuntime = options;
      return {
        confirmationExecutor: null,
        reader: {
          async get() {}, async getDetail() {}, async list() {}, async listNewest() {},
        },
        control: codeJobControlPort(),
        worker: null,
        projectionSource: codeJobProjectionSourcePort(),
        async close() {},
      };
    },
    memoryProjectorFactory: (options) => {
      calls.projector = options;
      return projector;
    },
    workIntentPolicyFactory: () => ({ async bind() {} }),
    roleWorkerDirectoryFactory: () => ({ async resolve() {} }),
    prEngineerExclusiveGuardFactory: () => inProcessExclusiveGuard(),
    workflowFactSourceFactory: () => workflowFactSourcePort(),
    attentionResultReconcilerFactory: () => ({ async runCycle() {} }),
    workProposalResultReconcilerFactory: () => ({ async runCycle() {} }),
    workConditionWakerFactory: () => ({ async runCycle() {} }),
    proactiveWorkLoopFactory: () => ({ async runCycle() {} }),
    workIntentDispatcherFactory: () => ({ async dispatchPending() {} }),
    workCoordinationFactory: () => ({ async intake() {}, async runCycle() {} }),
    attentionCoordinatorFactory: () => ({ async next() {} }),
  });

  assert.equal(calls.memory.maximumRecords, 1234);
  assert.equal(calls.memory.maximumStateBytes, 5_000_000);
  assert.equal("memoryProducer" in calls.projector, false);
  assert.equal(Object.isFrozen(calls.projector.memoryLifecycleProducer), true);
  assert.deepEqual(
    Object.keys(calls.projector.memoryLifecycleProducer).sort(),
    [
      "adoptGraphCheckpoint",
      "appendAuthorityProjection",
      "appendGraphEvents",
      "appendProjectionRecords",
      "appendWorkItems",
    ],
  );
  assert.equal(Object.isFrozen(calls.projector.memoryAuthorityReader), true);
  assert.deepEqual(
    Object.keys(calls.projector.memoryAuthorityReader).sort(),
    [
      "getAuthorityProjectionState",
      "getAuthorityState",
      "requiresAuthorityProjectionCheckpoint",
    ],
  );
  assert.equal(Object.isFrozen(calls.projector.memoryAuthoritySource), true);
  assert.deepEqual(Object.keys(calls.projector.memoryAuthoritySource), [
    "readSnapshot",
  ]);
  assert.equal(
    Object.isFrozen(calls.projector.inputAuthorityBatchVerifier),
    true,
  );
  assert.deepEqual(
    await calls.projector.inputAuthorityBatchVerifier.verify({
      ledgerRevision: 7,
      bindings: [],
    }),
    { ledgerRevision: 7, current: [] },
  );
  assert.equal(Object.isFrozen(calls.projector.graphProjectionSource), true);
  assert.deepEqual(
    Object.keys(calls.projector.graphProjectionSource).sort(),
    ["ackBatch"],
  );
  assert.equal(Object.isFrozen(application.memorySearch), true);
  assert.deepEqual(Object.keys(application.memorySearch).sort(), [
    "getHealth",
    "search",
  ]);
  assert.deepEqual(Object.keys(application.memoryProjector), ["runCycle"]);
  assert.equal("memoryRuntime" in application, false);
  assert.equal("memoryProducer" in application, false);
  assert.deepEqual(await application.memorySearch.search({ q: "test" }), {
    items: [{ q: "test" }],
    nextCursor: null,
  });
  await application.close();
});

test("cited memory answering wires trusted ports without exposing CLI composition authority", async () => {
  const configuredBrain = {
    provider: "ollama",
    model: "configured-model",
    remoteData: { requirements: false, code: false, memory: false },
  };
  const localBrain = {
    provider: "ollama",
    model: "local-model",
    remoteData: { requirements: false, code: false, memory: false },
  };
  const config = {
    ...applicationConfig(),
    memory: {
      enabled: true,
      answering: {
        enabled: true,
        maximumRecords: 7,
        maximumContextBytes: 110_000,
        maximumConcurrent: 2,
        brain: configuredBrain,
        localBrain,
      },
    },
    brainProviders: { ollama: { kind: "ollama" } },
  };
  const calls = {};
  const memoryRuntime = {
    producer: { async append() {}, async appendBatch() {} },
    search: {
      async search() { return { items: [], nextCursor: null }; },
      async getHealth() { return { ready: true }; },
    },
    contextReader: { async readRecords() {} },
    receiptVerifier: { async verify() {} },
    maintenance: { async rebuildIndex() {} },
    async close() {},
  };
  const router = { async generate() {}, describe() {} };
  const retriever = { async retrieve() {} };
  const answerService = {
    async answer(value) { return { value }; },
    async hiddenWrite() {},
  };

  const application = await createApplication({
    config,
    store: memoryStore(),
    memoryRuntimeFactory: async () => memoryRuntime,
    memoryBrainRouterFactory: (options) => {
      calls.router = options;
      return router;
    },
    memoryContextRetrieverFactory: (options) => {
      calls.retriever = options;
      return retriever;
    },
    memoryAnswerServiceFactory: (options) => {
      calls.answer = options;
      return answerService;
    },
    memoryAnswerDependencies: {
      brainDependencies: { fetch: "injected-fetch" },
      beforeGenerate: async () => {},
    },
  });

  assert.deepEqual(calls.router.brainProviders, config.brainProviders);
  assert.equal(calls.router.dependencies.fetch, "injected-fetch");
  assert.equal(
    calls.router.dependencies.supervisedCliCompositionCapability,
    undefined,
  );
  const compositionSymbols = Object.getOwnPropertySymbols(
    calls.router.dependencies,
  );
  assert.equal(compositionSymbols.length, 0);
  assert.equal(Object.isFrozen(calls.retriever.memorySearch), true);
  assert.deepEqual(Object.keys(calls.retriever.memorySearch), ["search"]);
  assert.equal(Object.isFrozen(calls.retriever.contextReader), true);
  assert.deepEqual(Object.keys(calls.retriever.contextReader), ["readRecords"]);
  assert.equal(calls.retriever.maximumRecords, 7);
  assert.equal(calls.retriever.maximumContextBytes, 110_000);
  assert.strictEqual(calls.answer.contextRetriever, retriever);
  assert.strictEqual(calls.answer.brainRouter, router);
  assert.deepEqual(calls.answer.configuredBrain, configuredBrain);
  assert.deepEqual(calls.answer.localBrain, localBrain);
  assert.equal(calls.answer.maximumConcurrent, 2);
  assert.equal(typeof calls.answer.beforeGenerate, "function");
  assert.equal(Object.isFrozen(application.memoryAnswer), true);
  assert.deepEqual(Object.keys(application.memoryAnswer), ["answer"]);
  assert.equal("contextReader" in application, false);
  assert.equal("hiddenWrite" in application.memoryAnswer, false);
  assert.deepEqual(await application.memoryAnswer.answer({ safe: true }), {
    value: { safe: true },
  });
  await application.close();
});

test("query_memory roles receive one recovered least-authority agent primitive", async () => {
  const calls = {};
  const closeCalls = [];
  const config = workCoordinationConfig({ externalActions: false });
  config.memory = {
    enabled: true,
    answering: {
      enabled: true,
      maximumRecords: 7,
      maximumContextBytes: 110_000,
      maximumConcurrent: 2,
      brain: {
        provider: "ollama",
        model: "memory-model",
        remoteData: { requirements: false, code: false, memory: false },
      },
      localBrain: {
        provider: "ollama",
        model: "memory-local",
        remoteData: { requirements: false, code: false, memory: false },
      },
    },
  };
  config.brainProviders = { ollama: { kind: "ollama" } };
  config.employees.roles = {
    developer: {
      permissions: { allowedIntents: ["complete", "query_memory"] },
    },
  };
  const answerPort = { async answer() {} };
  const agentPort = {
    async recover() {
      calls.recovered = true;
    },
    async execute() {},
    async readContext() {},
    async verifyContext() {},
  };
  const contextAssembler = { async assemble() {} };
  const workLoop = { async runCycle() {} };
  const composition = localCoordinationStubs({
    calls,
    closeCalls,
    runners: {},
  });

  const application = await createApplication({
    config,
    store: memoryStore(),
    ...composition,
    memoryBrainRouterFactory() {
      return { async generate() {}, describe() {} };
    },
    memoryContextRetrieverFactory() {
      return { async retrieve() {} };
    },
    memoryAnswerServiceFactory() {
      return answerPort;
    },
    codeJobRuntimeFactory: async () => ({
      confirmationExecutor: null,
      reader: {
        async get() {},
        async getDetail() {},
        async list() {},
        async listNewest() {},
      },
      control: codeJobControlPort(),
      worker: null,
      projectionSource: codeJobProjectionSourcePort(),
      async close() {},
    }),
    agentMemoryQueryServiceFactory(options) {
      calls.agentMemory = options;
      return agentPort;
    },
    roleContextAssemblerFactory(options) {
      calls.contextAssembler = options;
      return contextAssembler;
    },
    proactiveWorkLoopFactory(options) {
      calls.loop = options;
      return workLoop;
    },
  });

  assert.equal(calls.recovered, true);
  assert.deepEqual(calls.agentMemory.allowedRoleIds, ["developer"]);
  assert.deepEqual(Object.keys(calls.agentMemory.store).sort(), ["read", "write"]);
  assert.deepEqual(Object.keys(calls.agentMemory.memoryAnswer), ["answer"]);
  assert.deepEqual(Object.keys(calls.agentMemory.memoryContextReader), [
    "readRecords",
  ]);
  assert.deepEqual(Object.keys(calls.agentMemory.memoryProducer), ["append"]);
  assert.equal(Object.isFrozen(calls.agentMemory.store), true);
  assert.deepEqual(Object.keys(calls.contextAssembler.memoryQueryReader), [
    "readContext",
  ]);
  assert.equal(Object.isFrozen(calls.contextAssembler.memoryQueryReader), true);
  assert.deepEqual(Object.keys(calls.loop.memoryQueryService).sort(), [
    "execute",
    "verifyContext",
  ]);
  assert.equal(Object.isFrozen(calls.loop.memoryQueryService), true);
  assert.equal("agentMemoryQueries" in application, false);
  await application.close();
});

test("query_memory permission fails closed when cited memory answering is disabled", async () => {
  const config = workCoordinationConfig({ externalActions: false });
  config.employees.roles = {
    developer: {
      permissions: { allowedIntents: ["complete", "query_memory"] },
    },
  };
  let constructed = 0;

  await assert.rejects(
    createApplication({
      config,
      store: memoryStore(),
      ...localCoordinationStubs({ calls: {}, closeCalls: [], runners: {} }),
      agentMemoryQueryServiceFactory() {
        constructed += 1;
        return {};
      },
    }),
    /query_memory.*统一记忆问答/,
  );
  assert.equal(constructed, 0);
});

test("memory imports are explicit opt-in ports with append-only authority", async () => {
  const config = {
    ...applicationConfig(),
    memory: {
      enabled: true,
      imports: { localSessions: true, git: true },
    },
  };
  const calls = {};
  const producer = {
    async append() {},
    async appendBatch(value) { return value; },
    async hiddenErase() {},
  };
  const memoryRuntime = {
    producer,
    search: { async search() {}, async getHealth() {} },
    contextReader: { async readRecords() {} },
    receiptVerifier: { async verify() {} },
    maintenance: { async rebuildIndex() {} },
    async close() {},
  };
  const sessionImporter = {
    async importSession(value) { return { kind: "session", value }; },
    async hiddenImport() {},
  };
  const gitImporter = {
    async importCommits(value) { return { kind: "git", value }; },
    async hiddenImport() {},
  };

  const application = await createApplication({
    config,
    store: memoryStore(),
    memoryRuntimeFactory: async () => memoryRuntime,
    localSessionImporterFactory: (options) => {
      calls.session = options;
      return sessionImporter;
    },
    gitActivityImporterFactory: (options) => {
      calls.git = options;
      return gitImporter;
    },
  });

  for (const options of [calls.session, calls.git]) {
    assert.equal(Object.isFrozen(options.memoryProducer), true);
    assert.deepEqual(Object.keys(options.memoryProducer), ["appendBatch"]);
    assert.equal("hiddenErase" in options.memoryProducer, false);
  }
  assert.equal(Object.isFrozen(application.memoryImports), true);
  assert.deepEqual(Object.keys(application.memoryImports), ["session", "git"]);
  assert.deepEqual(Object.keys(application.memoryImports.session), ["importSession"]);
  assert.deepEqual(Object.keys(application.memoryImports.git), ["importCommits"]);
  assert.equal("hiddenImport" in application.memoryImports.session, false);
  assert.deepEqual(
    await application.memoryImports.session.importSession({ id: "s1" }),
    { kind: "session", value: { id: "s1" } },
  );
  assert.deepEqual(
    await application.memoryImports.git.importCommits({ id: "g1" }),
    { kind: "git", value: { id: "g1" } },
  );
  await application.close();
});

test("disabling unified memory also disables answering and import children", async () => {
  const calls = { runtime: 0, answer: 0, sessionImport: 0, gitImport: 0 };
  const application = await createApplication({
    config: {
      ...applicationConfig(),
      memory: {
        enabled: false,
        answering: { enabled: true },
        imports: { localSessions: true, git: true },
      },
    },
    store: memoryStore(),
    memoryRuntimeFactory: async () => {
      calls.runtime += 1;
      return null;
    },
    memoryAnswerServiceFactory: () => {
      calls.answer += 1;
      return { async answer() {} };
    },
    localSessionImporterFactory: () => {
      calls.sessionImport += 1;
      return { async importSession() {} };
    },
    gitActivityImporterFactory: () => {
      calls.gitImport += 1;
      return { async importCommits() {} };
    },
  });

  assert.equal(application.memorySearch, null);
  assert.equal(application.memoryAnswer, null);
  assert.equal(application.memoryImports, null);
  assert.deepEqual(calls, {
    runtime: 0,
    answer: 0,
    sessionImport: 0,
    gitImport: 0,
  });
  await application.close();
});

test("enabled memory children fail closed when the runtime factory is unavailable", async () => {
  await assert.rejects(
    createApplication({
      config: {
        ...applicationConfig(),
        memory: {
          enabled: true,
          answering: { enabled: true },
          imports: { localSessions: true, git: true },
        },
      },
      store: memoryStore(),
      memoryRuntimeFactory: async () => null,
    }),
    /记忆问答需要启用统一记忆运行时/,
  );
});

test("application close is idempotent and attempts every runtime in reverse order", async () => {
  const closeCalls = [];
  const closeFailure = new Error("confirmation close failed");
  const application = await createApplication({
    config: externalActionConfig(),
    store: memoryStore(),
    codeExecutorRuntimeFactory: async () => ({
      async close() {
        closeCalls.push("code-executor");
      },
    }),
    workflowRoutingRuntimeFactory: async () => ({
      async close() {
        closeCalls.push("workflow");
      },
    }),
    confirmationRuntimeFactory: async () => ({
      queue: confirmationQueuePort(),
      producerQueue: confirmationProducerPort(),
      async close() {
        closeCalls.push("confirmation");
        throw closeFailure;
      },
    }),
  });

  const firstClose = application.close();
  const secondClose = application.close();
  assert.strictEqual(secondClose, firstClose);
  await assert.rejects(firstClose, (error) => error === closeFailure);
  await assert.rejects(secondClose, (error) => error === closeFailure);
  assert.deepEqual(closeCalls, ["confirmation", "workflow", "code-executor"]);
});

test("application close retries only runtimes that failed the prior close attempt", async () => {
  const closeCalls = [];
  const closeFailure = new Error("workflow close failed once");
  let workflowAttempts = 0;
  const application = await createApplication({
    config: applicationConfig(),
    store: memoryStore(),
    codeExecutorRuntimeFactory: async () => ({
      async close() {
        closeCalls.push("code-executor");
      },
    }),
    workflowRoutingRuntimeFactory: async () => ({
      async close() {
        workflowAttempts += 1;
        closeCalls.push(`workflow-${workflowAttempts}`);
        if (workflowAttempts === 1) throw closeFailure;
      },
    }),
  });

  await assert.rejects(application.close(), (error) => error === closeFailure);
  const recoveryClose = application.close();
  assert.strictEqual(application.close(), recoveryClose);
  await recoveryClose;
  await application.close();
  assert.deepEqual(closeCalls, [
    "workflow-1",
    "code-executor",
    "workflow-2",
  ]);
});

test("runtime lifecycle preserves every ordered failure event after recovery", async () => {
  const lifecycle = createApplicationRuntimeLifecycle();
  const workflowFailureOne = new Error("workflow close failed first");
  const executorFailure = new Error("executor close failed first");
  const workflowFailureTwo = new Error("workflow close failed second");
  let workflowAttempts = 0;
  let executorAttempts = 0;
  lifecycle.track({
    async close() {
      executorAttempts += 1;
      if (executorAttempts === 1) throw executorFailure;
    },
  });
  lifecycle.track({
    async close() {
      workflowAttempts += 1;
      if (workflowAttempts === 1) throw workflowFailureOne;
      if (workflowAttempts === 2) throw workflowFailureTwo;
    },
  });

  await assert.rejects(
    lifecycle.close(),
    (error) => error === workflowFailureOne,
  );
  const firstStatus = lifecycle.readStatus();
  assert.strictEqual(firstStatus.failure, workflowFailureOne);
  assert.deepEqual(firstStatus.failures, [
    workflowFailureOne,
    executorFailure,
  ]);
  assert.equal(Object.isFrozen(firstStatus.failures), true);

  await assert.rejects(
    lifecycle.close(),
    (error) => error === workflowFailureTwo,
  );
  await lifecycle.close();
  const recoveredStatus = lifecycle.readStatus();
  assert.equal(recoveredStatus.complete, true);
  assert.equal(recoveredStatus.failure, null);
  assert.deepEqual(recoveredStatus.failures, [
    workflowFailureOne,
    executorFailure,
    workflowFailureTwo,
  ]);
  assert.equal(Object.isFrozen(recoveredStatus.failures), true);
});

test("runtime lifecycle tracks the same close owner only once", async () => {
  const lifecycle = createApplicationRuntimeLifecycle();
  let closeCalls = 0;
  const runtime = {
    async close() {
      closeCalls += 1;
    },
  };

  assert.strictEqual(lifecycle.track(runtime), runtime);
  assert.strictEqual(lifecycle.track(runtime), runtime);
  await lifecycle.close();

  assert.equal(closeCalls, 1);
  assert.equal(lifecycle.readStatus().acquiredRuntimes, 1);
});

test("explicit null runtime lifecycle is rejected instead of internally orphaned", async () => {
  let application = null;
  const failure = await createApplication({
    config: applicationConfig(),
    store: memoryStore(),
    externalActions: false,
    runtimeLifecycle: null,
  }).then(
    (value) => {
      application = value;
      return null;
    },
    (error) => error,
  );

  try {
    assert.equal(application, null);
    assert.match(failure.message, /runtimeLifecycle is invalid/u);
  } finally {
    await application?.close();
  }
});

test("default construction waits for pending startup cleanup", async () => {
  const startupFailure = new Error("workflow startup failed");
  let signalCleanupStarted;
  let releaseCleanup;
  const cleanupStarted = new Promise((resolve) => {
    signalCleanupStarted = resolve;
  });
  const cleanupRelease = new Promise((resolve) => {
    releaseCleanup = resolve;
  });
  let constructionSettled = false;
  const construction = createApplication({
    config: applicationConfig(),
    store: memoryStore(),
    codeExecutorRuntimeFactory: async () => ({
      async close() {
        signalCleanupStarted();
        await cleanupRelease;
      },
    }),
    workflowRoutingRuntimeFactory: async () => {
      throw startupFailure;
    },
  }).then(
    () => null,
    (error) => error,
  ).finally(() => {
    constructionSettled = true;
  });

  await cleanupStarted;
  try {
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(constructionSettled, false);
  } finally {
    releaseCleanup();
  }
  assert.strictEqual(await construction, startupFailure);
});

test("a later startup failure releases the acquired workflow runtime", async () => {
  const closeCalls = [];
  const startupFailure = new Error("confirmation startup failed");

  await assert.rejects(
    createApplication({
      config: externalActionConfig(),
      store: memoryStore(),
      codeExecutorRuntimeFactory: async () => ({
        async close() {
          closeCalls.push("code-executor");
        },
      }),
      workflowRoutingRuntimeFactory: async () => ({
        async close() {
          closeCalls.push("workflow");
        },
      }),
      confirmationRuntimeFactory: async () => {
        throw startupFailure;
      },
    }),
    (error) => error === startupFailure,
  );
  assert.deepEqual(closeCalls, ["workflow", "code-executor"]);
});

test("work coordination startup preserves its error while closing every acquired runtime", async () => {
  const closeCalls = [];
  const startupFailure = new Error("attention startup failed");
  const cleanupFailure = new Error("ledger close failed");

  await assert.rejects(
    createApplication({
      config: workCoordinationConfig({ externalActions: false }),
      store: memoryStore(),
      externalActions: false,
      codeExecutorRuntimeFactory: async () => ({
        async close() {
          closeCalls.push("code-executor");
        },
      }),
      workflowRoutingRuntimeFactory: async () => ({
        async readAssignmentBatch() {},
        async close() {
          closeCalls.push("workflow");
        },
      }),
      workLedgerRuntimeFactory: async () => ({
        ...ownerRetryLedgerMethods(),
        async close() {
          closeCalls.push("ledger");
          throw cleanupFailure;
        },
      }),
      attentionInboxRuntimeFactory: async () => {
        throw startupFailure;
      },
    }),
    (error) => error === startupFailure,
  );
  assert.deepEqual(closeCalls, ["ledger", "workflow", "code-executor"]);
});

test("application adopts retryable configured-workforce construction cleanup", async () => {
  const constructionFailure = new Error("configured role construction failed");
  const cleanupFailure = new Error("configured provider cleanup failed once");
  const invalidRole = new Proxy({}, {
    ownKeys() {
      throw constructionFailure;
    },
  });
  const config = workCoordinationConfig({ externalActions: false });
  config.brainProviders = { cli: { kind: "codex-cli" } };
  config.employees = {
    ...config.employees,
    roles: { developer: invalidRole },
  };
  const calls = {};
  const closeCalls = [];
  const lifecycle = createApplicationRuntimeLifecycle();
  const stubs = localCoordinationStubs({ calls, closeCalls, runners: {} });
  let cleanupAttempts = 0;

  await assert.rejects(
    createApplication({
      config,
      store: memoryStore(),
      versionedConfiguration: false,
      externalActions: false,
      ...stubs,
      configuredWorkforceFactory: (options) => createTestConfiguredWorkforce(
        options,
        {
          supervisedCliProviderFactory(providerOptions) {
            return {
              id: providerOptions.id,
              remote: true,
              singleAttempt: true,
              async generate() {
                return '{"ok":true}';
              },
              async close() {
                cleanupAttempts += 1;
                if (cleanupAttempts === 1) throw cleanupFailure;
              },
            };
          },
        },
      ),
      operationsRuntimeFactory: () => Object.freeze({}),
      runtimeLifecycle: lifecycle,
    }),
    (error) => error === constructionFailure,
  );
  await new Promise((resolve) => setImmediate(resolve));

  const failedStatus = lifecycle.readStatus();
  assert.strictEqual(failedStatus.failure, cleanupFailure);
  assert.deepEqual(failedStatus.failures, [cleanupFailure]);
  assert.equal(failedStatus.complete, false);
  await lifecycle.close();
  assert.equal(cleanupAttempts, 2);
  assert.equal(lifecycle.readStatus().complete, true);
});

test("non-versioned Code Job startup adopts partial configured directory cleanup", async () => {
  const constructionFailure = new Error("configured code directory failed");
  const cleanupFailure = new Error("configured code provider cleanup failed once");
  const config = defaultCodeJobConfiguration();
  const calls = {};
  const closeCalls = [];
  const lifecycle = createApplicationRuntimeLifecycle();
  let constructionCleanupOwner;
  let dependencySymbolCount = null;
  let cleanupAttempts = 0;

  await assert.rejects(
    createApplication({
      ...defaultCodeJobApplicationOptions({
        config,
        calls,
        closeCalls,
        lifecycle,
        versioned: false,
      }),
      codeJobBrainDirectoryFactory(options) {
        constructionCleanupOwner = options.constructionCleanupOwner;
        dependencySymbolCount = Object.getOwnPropertySymbols(
          options.dependencies,
        ).length;
        return createTestConfiguredBrainRouter(
          {
            constructionCleanupOwner,
            brainProviders: {
              acquired: { kind: "codex-cli" },
              failing: { kind: "claude-cli" },
            },
          },
          {
            supervisedCliProviderFactory(providerOptions) {
              if (providerOptions.id === "failing") {
                throw constructionFailure;
              }
              return {
                id: providerOptions.id,
                remote: true,
                singleAttempt: true,
                async generate() { return '{"ok":true}'; },
                async close() {
                  cleanupAttempts += 1;
                  if (cleanupAttempts === 1) throw cleanupFailure;
                },
              };
            },
          },
        );
      },
    }),
    (error) => error === constructionFailure,
  );
  await new Promise((resolve) => setImmediate(resolve));

  assert.ok(constructionCleanupOwner);
  assert.equal(Object.isFrozen(constructionCleanupOwner), true);
  assert.equal(dependencySymbolCount, 0);
  assert.equal(cleanupAttempts, 1);
  assert.strictEqual(lifecycle.readStatus().failure, cleanupFailure);
  assert.equal(lifecycle.readStatus().complete, false);

  await lifecycle.close();
  assert.equal(cleanupAttempts, 2);
  assert.equal(lifecycle.readStatus().complete, true);
});

test("Code Job composition forwards controlled reading support through the frozen brain boundary", async () => {
  for (const versioned of [false, true]) {
    const config = defaultCodeJobConfiguration();
    const calls = {}; const closeCalls = [];
    const application = await createApplication({
      ...defaultCodeJobApplicationOptions({ config, calls, closeCalls,
        lifecycle: createApplicationRuntimeLifecycle(), versioned }),
      codeJobBrainDirectoryFactory() {
        return { async decide() {}, describe(roleId) {
          assert.equal(roleId, "developer");
          return { supportsCodeReading: true };
        }, hiddenWrite() { assert.fail("must not be exposed"); }, async close() {} };
      },
    });
    assert.equal(Object.isFrozen(calls.codeJobRuntime.brainDirectory), true);
    assert.equal(typeof calls.codeJobRuntime.brainDirectory.describe, "function");
    assert.equal((await calls.codeJobRuntime.brainDirectory.describe("developer")).supportsCodeReading, true);
    assert.equal(Object.hasOwn(calls.codeJobRuntime.brainDirectory, "hiddenWrite"), false);
    await application.close();
  }
});

test("default non-versioned Code Job validates every role before CLI acquisition", async (t) => {
  const roleFailure = new TypeError("employees.roles.invalid-extra is invalid");
  const invalidRole = new Proxy({}, {
    getPrototypeOf() {
      throw roleFailure;
    },
  });
  const config = structuredClone(defaultCodeJobConfiguration());
  config.employees.roles["invalid-extra"] = invalidRole;
  const calls = {};
  const closeCalls = [];
  const lifecycle = createApplicationRuntimeLifecycle();
  const providerIds = new WeakMap();
  const originalIdDescriptor = Object.getOwnPropertyDescriptor(
    SupervisedCliBrainProvider.prototype,
    "id",
  );
  let cliAcquisitions = 0;
  Object.defineProperty(SupervisedCliBrainProvider.prototype, "id", {
    configurable: true,
    get() {
      return providerIds.get(this);
    },
    set(value) {
      cliAcquisitions += 1;
      providerIds.set(this, value);
    },
  });
  t.after(() => {
    if (originalIdDescriptor) {
      Object.defineProperty(
        SupervisedCliBrainProvider.prototype,
        "id",
        originalIdDescriptor,
      );
    } else {
      delete SupervisedCliBrainProvider.prototype.id;
    }
  });

  const failure = await createApplication(
    defaultCodeJobApplicationOptions({
      config,
      calls,
      closeCalls,
      lifecycle,
      versioned: false,
    }),
  ).then(
    () => null,
    (error) => error,
  );
  await new Promise((resolve) => setImmediate(resolve));

  assert.strictEqual(failure, roleFailure);
  assert.equal(cliAcquisitions, 0);
  assert.equal(lifecycle.readStatus().pendingRuntimes, 0);
  assert.equal(lifecycle.readStatus().complete, true);
});

test("application does not adopt stale cleanup from a reused Error identity", async () => {
  const constructionFailure = new Error("reused application construction failure");
  const cleanupFailure = new Error("prior construction cleanup failed once");
  const priorConstructionOwner = createConfiguredConstructionCleanupOwner();
  const invalidRole = new Proxy({}, {
    ownKeys() {
      throw constructionFailure;
    },
  });
  let cleanupAttempts = 0;
  let priorFailure = null;
  try {
    createTestConfiguredWorkforce(
      {
        constructionCleanupOwner: priorConstructionOwner,
        brainProviders: { cli: { kind: "codex-cli" } },
        roles: { developer: invalidRole },
        store: memoryStore(),
      },
      {
        supervisedCliProviderFactory(providerOptions) {
          return {
            id: providerOptions.id,
            remote: true,
            singleAttempt: true,
            async generate() {
              return '{"ok":true}';
            },
            async close() {
              cleanupAttempts += 1;
              if (cleanupAttempts === 1) throw cleanupFailure;
            },
          };
        },
      },
    );
  } catch (error) {
    priorFailure = error;
  }
  assert.strictEqual(priorFailure, constructionFailure);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(cleanupAttempts, 1);

  const config = workCoordinationConfig({ externalActions: false });
  const calls = {};
  const closeCalls = [];
  const lifecycle = createApplicationRuntimeLifecycle();
  const stubs = localCoordinationStubs({ calls, closeCalls, runners: {} });
  await assert.rejects(
    createApplication({
      config,
      store: memoryStore(),
      versionedConfiguration: false,
      externalActions: false,
      ...stubs,
      configuredWorkforceFactory() {
        throw constructionFailure;
      },
      operationsRuntimeFactory: () => Object.freeze({}),
      runtimeLifecycle: lifecycle,
    }),
    (error) => error === constructionFailure,
  );
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(cleanupAttempts, 1);
  assert.equal(lifecycle.readStatus().complete, true);
  assert.equal(lifecycle.readStatus().failure, null);
  assert.deepEqual(lifecycle.readStatus().failures, []);
  const priorCleanup = readConfiguredConstructionCleanup(
    priorConstructionOwner,
  );
  assert.ok(priorCleanup, "prior construction cleanup ownership was lost");
  assert.strictEqual(priorCleanup.readStatus().failure, cleanupFailure);
  await priorCleanup.close();
  assert.equal(cleanupAttempts, 2);
  assert.equal(priorCleanup.readStatus().complete, true);
});

test("external confirmation runtime requires both action authorization gates", async () => {
  let calls = 0;
  const createConfirmation = async () => {
    calls += 1;
    throw new Error("confirmation runtime must stay disabled");
  };
  const withoutConfiguredActions = await createApplication({
    config: applicationConfig(),
    store: memoryStore(),
    confirmationRuntimeFactory: createConfirmation,
  });
  const withoutProcessAuthorization = await createApplication({
    config: externalActionConfig(),
    store: memoryStore(),
    externalActions: false,
    confirmationRuntimeFactory: createConfirmation,
  });

  assert.equal(calls, 0);
  assert.equal(withoutConfiguredActions.confirmationQueue, null);
  assert.equal(withoutProcessAuthorization.confirmationQueue, null);
  await withoutConfiguredActions.close();
  await withoutProcessAuthorization.close();
});

test("Review and generic GitHub actions share one credential acquire port while disabled actions construct none", async () => {
  const enabledCalls = {};
  const enabledCloseCalls = [];
  const config = workCoordinationConfig();
  config.githubActions = {
    enabled: true,
    actorAccountId: "review-account",
    tokenEnv: "TEST_GITHUB_TOKEN",
    ghCommand: process.execPath,
    timeoutMs: 12_000,
    enabledActions: ["review", "comment"],
  };
  const source = Object.freeze({
    async acquire() {
      throw new Error("credential acquisition must remain behind confirmation");
    },
  });
  let sourceConstructions = 0;
  let sourceFactoryOptions = null;
  const privateRuntimeDirectory = path.join(
    path.parse(process.cwd()).root,
    "mydashboard-runtime",
    "c".repeat(64),
  );
  const runners = {
    "github-review-runner": { async claim() {}, async advance() {} },
    "github-pr-action-runner": { async claim() {}, async advance() {} },
  };
  const confirmationProducer = confirmationProducerPort();

  const enabledApplication = await createApplication({
    config,
    store: memoryStore(),
    privateRuntimeDirectory,
    ...localCoordinationStubs({
      calls: enabledCalls,
      closeCalls: enabledCloseCalls,
      runners,
    }),
    githubCredentialSourceFactory: async (options) => {
      sourceConstructions += 1;
      sourceFactoryOptions = options;
      return source;
    },
    pullRequestExternalActionTransportFactory: () => ({
      async observe() {},
      async perform() {},
    }),
    pullRequestExternalActionExecutorFactory(options) {
      enabledCalls.externalExecutor = options;
      return {
        async execute() {},
        async reconcile() {},
        async close() {},
      };
    },
    confirmationRuntimeFactory: async (_activeConfig, dependencies) => {
      enabledCalls.confirmation = dependencies;
      return {
        queue: confirmationQueuePort(),
        producerQueue: confirmationProducer,
        async close() {},
      };
    },
    githubReviewProposalRunnerFactory: () => ({ async runCycle() {} }),
    pullRequestExternalActionProposalRunnerFactory: () => ({ async runCycle() {} }),
    workProposalRunnerGroupFactory: () => ({ async runCycle() {} }),
  });

  assert.equal(sourceConstructions, 1);
  assert.equal(
    sourceFactoryOptions.privateRuntimeDirectory,
    privateRuntimeDirectory,
  );
  assert.strictEqual(
    enabledCalls.externalExecutor.credentialSource,
    enabledCalls.confirmation.credentialSource,
  );
  assert.notStrictEqual(enabledCalls.externalExecutor.credentialSource, source);
  assert.deepEqual(
    Reflect.ownKeys(enabledCalls.externalExecutor.credentialSource),
    ["acquire"],
  );
  assert.equal(Object.isFrozen(enabledCalls.externalExecutor.credentialSource), true);
  await enabledApplication.close();

  const disabledConfig = workCoordinationConfig({ externalActions: false });
  const disabledCalls = {};
  const disabledCloseCalls = [];
  const disabledApplication = await createApplication({
    config: disabledConfig,
    store: memoryStore(),
    ...localCoordinationStubs({
      calls: disabledCalls,
      closeCalls: disabledCloseCalls,
      runners: {},
    }),
    githubCredentialSourceFactory: async () => {
      sourceConstructions += 1;
      throw new Error("disabled GitHub actions must not construct credentials");
    },
  });

  assert.equal(sourceConstructions, 1);
  await disabledApplication.close();
});

test("configured GitHub credential factory uses the project-private managed runtime across volumes", async (t) => {
  if (process.platform !== "win32") {
    t.skip("cross-volume path.relative behavior is Windows-specific");
    return;
  }

  const projectRoot = "D:\\projects\\dashboard";
  const digest = "b".repeat(64);
  const privateRuntimeDirectory = path.join(
    "C:\\Users\\owner\\AppData\\Local\\MyDashboard\\runtime",
    digest,
  );
  const expectedRuntimeTemporaryRoot = path.join(
    privateRuntimeDirectory,
    "github-credentials-v1",
  );
  const preparedRoots = [];
  const ghSourceOptions = [];

  const source = await createConfiguredGitHubCredentialSource(
    {
      githubActions: Object.freeze({
        enabled: true,
        credentialMode: "gh-login",
        actorAccountId: "review-account",
        ghCommand: "gh",
      }),
      projectRoot,
      privateRuntimeDirectory,
      protectedRoots: Object.freeze([projectRoot]),
    },
    {
      projectIdentity: ({ projectRoot: receivedProjectRoot }) => {
        assert.equal(receivedProjectRoot, projectRoot);
        return digest;
      },
      privateDirectoryManager: {
        async prepare(options) {
          preparedRoots.push(options.directory);
          await options.validateLocation();
          return Object.freeze({
            path: options.directory,
            device: "1",
            inode: "2",
          });
        },
      },
      async createGhLoginCredentialSource(options) {
        ghSourceOptions.push(options);
        return Object.freeze({ async acquire() {} });
      },
    },
  );

  assert.equal(typeof source.acquire, "function");
  assert.deepEqual(preparedRoots, [expectedRuntimeTemporaryRoot]);
  assert.equal(
    ghSourceOptions[0].runtimeTemporaryRoot,
    expectedRuntimeTemporaryRoot,
  );
});

test("configured GitHub credential factory keeps token-env directory-free and prepares one project-private gh-login root", async (t) => {
  const projectDirectory = path.join(path.parse(process.cwd()).root, "projects", "dashboard");
  const homeDirectory = path.join(path.parse(process.cwd()).root, "users", "owner");
  const projectDigest = "a".repeat(64);
  const privateRuntimeDirectory = path.join(
    path.parse(process.cwd()).root,
    "mydashboard-runtime",
    projectDigest,
  );
  const protectedRoots = Object.freeze([
    projectDirectory,
    path.join(homeDirectory, ".codex"),
    path.join(homeDirectory, ".mydashboard-cli-credentials-v1"),
  ]);
  const tokenSources = [];
  const ghSources = [];
  const prepared = [];
  const dependencies = {
    projectIdentity: ({ projectRoot }) => projectIdentityDigest({
      projectRoot,
      projectDigest,
    }),
    createTokenEnvCredentialSource(options) {
      tokenSources.push(options);
      return Object.freeze({ async acquire() {} });
    },
    async createGhLoginCredentialSource(options) {
      ghSources.push(options);
      return Object.freeze({ async acquire() {} });
    },
    privateDirectoryManager: {
      async prepare(options) {
        prepared.push(options);
        await options.validateLocation();
        return Object.freeze({
          path: options.directory,
          device: "1",
          inode: "2",
        });
      },
    },
  };
  const baseConfig = {
    enabled: true,
    actorAccountId: "review-account",
    tokenEnv: "TEST_GITHUB_TOKEN",
    ghCommand: process.execPath,
  };

  for (const credentialMode of [undefined, "token-env"]) {
    const githubActions = Object.freeze({
      ...baseConfig,
      ...(credentialMode === undefined ? {} : { credentialMode }),
    });
    await createConfiguredGitHubCredentialSource(
      { githubActions, projectRoot: projectDirectory, protectedRoots },
      dependencies,
    );
  }
  assert.equal(tokenSources.length, 2);
  assert.equal(prepared.length, 0);
  assert.equal(ghSources.length, 0);
  assert.deepEqual(tokenSources, [
    { actorAccountId: "review-account", tokenEnv: "TEST_GITHUB_TOKEN" },
    { actorAccountId: "review-account", tokenEnv: "TEST_GITHUB_TOKEN" },
  ]);

  const ghSource = await createConfiguredGitHubCredentialSource(
    {
      githubActions: Object.freeze({
        enabled: true,
        credentialMode: "gh-login",
        actorAccountId: "review-account",
        ghCommand: process.execPath,
      }),
      projectRoot: projectDirectory,
      privateRuntimeDirectory,
      protectedRoots,
    },
    dependencies,
  );
  assert.equal(typeof ghSource.acquire, "function");
  assert.equal(prepared.length, 1);
  assert.equal(ghSources.length, 1);
  const expectedRoot = path.join(
    privateRuntimeDirectory,
    "github-credentials-v1",
  );
  assert.equal(prepared[0].directory, expectedRoot);
  assert.equal(path.dirname(prepared[0].directory), privateRuntimeDirectory);
  assert.equal(ghSources[0].runtimeTemporaryRoot, expectedRoot);
  assert.deepEqual(ghSources[0].protectedRoots, protectedRoots);

  await t.test("location validation rejects either overlap direction", async () => {
    for (const protectedRoot of [privateRuntimeDirectory, path.join(expectedRoot, "nested")]) {
      await assert.rejects(
        createConfiguredGitHubCredentialSource(
          {
            githubActions: Object.freeze({
              enabled: true,
              credentialMode: "gh-login",
              actorAccountId: "review-account",
              ghCommand: process.execPath,
            }),
            projectRoot: projectDirectory,
            privateRuntimeDirectory,
            protectedRoots: Object.freeze([protectedRoot]),
          },
          dependencies,
        ),
        /runtime temporary root/i,
      );
    }
  });

  await t.test("prepared identity must name the exact configured root", async () => {
    let sourceCreations = 0;
    await assert.rejects(
      createConfiguredGitHubCredentialSource(
        {
          githubActions: Object.freeze({
            enabled: true,
            credentialMode: "gh-login",
            actorAccountId: "review-account",
            ghCommand: process.execPath,
          }),
          projectRoot: projectDirectory,
          privateRuntimeDirectory,
          protectedRoots,
        },
        {
          ...dependencies,
          privateDirectoryManager: {
            async prepare(options) {
              await options.validateLocation();
              return Object.freeze({
                path: path.join(options.directory, "redirected"),
                device: "1",
                inode: "2",
              });
            },
          },
          async createGhLoginCredentialSource() {
            sourceCreations += 1;
            return Object.freeze({ async acquire() {} });
          },
        },
      ),
      /prepared identity/i,
    );
    assert.equal(sourceCreations, 0);
  });

  await t.test("prepared identity is an exact passive directory identity", async () => {
    const invalidIdentities = [
      Object.freeze({ path: expectedRoot }),
      Object.freeze({ path: expectedRoot, device: "1", inode: "2", extra: true }),
      Object.freeze({ path: expectedRoot, device: 1, inode: "2" }),
      new Proxy(Object.freeze({
        path: expectedRoot,
        device: "1",
        inode: "2",
      }), {}),
      Object.freeze(Object.defineProperty({ device: "1", inode: "2" }, "path", {
        enumerable: true,
        get() { return expectedRoot; },
      })),
    ];
    for (const identity of invalidIdentities) {
      await assert.rejects(
        createConfiguredGitHubCredentialSource(
          {
            githubActions: Object.freeze({
              enabled: true,
              credentialMode: "gh-login",
              actorAccountId: "review-account",
              ghCommand: process.execPath,
            }),
            projectRoot: projectDirectory,
            privateRuntimeDirectory,
            protectedRoots,
          },
          {
            ...dependencies,
            privateDirectoryManager: {
              async prepare(options) {
                await options.validateLocation();
                return identity;
              },
            },
          },
        ),
        /prepared identity/i,
      );
    }
  });

  await t.test("managed runtime identity must bind the current project digest", async () => {
    await assert.rejects(
      createConfiguredGitHubCredentialSource(
        {
          githubActions: Object.freeze({
            enabled: true,
            credentialMode: "gh-login",
            actorAccountId: "review-account",
            ghCommand: process.execPath,
          }),
          projectRoot: projectDirectory,
          privateRuntimeDirectory: path.join(
            path.dirname(privateRuntimeDirectory),
            "d".repeat(64),
          ),
          protectedRoots,
        },
        dependencies,
      ),
      /project-private runtime directory/i,
    );
  });

  await t.test("test dependencies are an exact plain data record", async () => {
    const githubActions = Object.freeze({
      ...baseConfig,
      credentialMode: "token-env",
    });
    const cases = [
      { ...dependencies, unexpectedAuthority: true },
      new Proxy({ ...dependencies }, {}),
      Object.defineProperty({ ...dependencies }, "projectIdentity", {
        enumerable: true,
        get() { return dependencies.projectIdentity; },
      }),
    ];
    for (const candidate of cases) {
      await assert.rejects(
        createConfiguredGitHubCredentialSource(
          { githubActions, projectRoot: projectDirectory, protectedRoots },
          candidate,
        ),
        /dependencies are invalid/i,
      );
    }
  });
});

test("generic action dependencies cannot replace the actor-bound executor or expose its credential source", async () => {
  const calls = {};
  const closeCalls = [];
  const config = workCoordinationConfig();
  config.githubActions = {
    enabled: true,
    actorAccountId: "review-account",
    tokenEnv: "TEST_GITHUB_TOKEN",
    ghCommand: process.execPath,
    enabledActions: ["comment"],
  };
  const source = Object.freeze({ async acquire() {} });
  const transport = Object.freeze({ async observe() {}, async perform() {} });
  const dependencyBag = { transport };
  for (const name of ["executor", "credentialProvider", "credentialSource"]) {
    Object.defineProperty(dependencyBag, name, {
      enumerable: true,
      get() {
        throw new Error(`${name} compatibility seam must not be read`);
      },
    });
  }
  const application = await createApplication({
    config,
    store: memoryStore(),
    ...localCoordinationStubs({
      calls,
      closeCalls,
      runners: {
        "github-pr-action-runner": { async claim() {}, async advance() {} },
      },
    }),
    githubCredentialSourceFactory: async () => source,
    pullRequestExternalActionDependencies: dependencyBag,
    pullRequestExternalActionExecutorFactory(options) {
      calls.externalExecutor = options;
      return {
        async execute() {},
        async reconcile() {},
        async close() {},
      };
    },
    confirmationRuntimeFactory: async (_config, dependencies) => ({
      queue: confirmationQueuePort(),
      producerQueue: confirmationProducerPort(),
      async close() {
        await dependencies.pullRequestExternalActionExecutor.close();
      },
    }),
    pullRequestExternalActionProposalRunnerFactory: () => ({ async runCycle() {} }),
    workProposalRunnerGroupFactory: () => ({ async runCycle() {} }),
  });

  assert.equal("credentialProvider" in calls.externalExecutor, false);
  assert.notStrictEqual(calls.externalExecutor.credentialSource, source);
  assert.deepEqual(Reflect.ownKeys(calls.externalExecutor.credentialSource), ["acquire"]);
  assert.equal(typeof calls.externalExecutor.credentialSource.acquire, "function");
  assert.equal("credentialSource" in application, false);
  assert.equal("githubCredentialSource" in application, false);
  await application.close();
});

test("generic GitHub action composition requires an owned close capability", async () => {
  const calls = {};
  const closeCalls = [];
  const config = workCoordinationConfig();
  config.githubActions = {
    enabled: true,
    actorAccountId: "review-account",
    tokenEnv: "TEST_GITHUB_TOKEN",
    ghCommand: process.execPath,
    enabledActions: ["comment"],
  };

  const outcome = await createApplication({
      config,
      store: memoryStore(),
      ...localCoordinationStubs({
        calls,
        closeCalls,
        runners: {
          "github-pr-action-runner": { async claim() {}, async advance() {} },
        },
      }),
      githubCredentialSourceFactory: async () => Object.freeze({ async acquire() {} }),
      pullRequestExternalActionDependencies: {
        transport: Object.freeze({ async observe() {}, async perform() {} }),
      },
      pullRequestExternalActionExecutorFactory: () => ({
        async execute() {},
        async reconcile() {},
      }),
    }).then(
      (application) => ({ application }),
      (error) => ({ error }),
    );
  if (outcome.application) await outcome.application.close();
  assert.match(outcome.error?.message ?? "", /pullRequestExternalActionExecutor is invalid/);
});

test("generic executor is closed when confirmation runtime ownership handoff fails", async () => {
  const calls = {};
  const closeCalls = [];
  const startupFailure = new Error("confirmation startup failed");
  const config = workCoordinationConfig();
  config.githubActions = {
    enabled: true,
    actorAccountId: "review-account",
    tokenEnv: "TEST_GITHUB_TOKEN",
    ghCommand: process.execPath,
    enabledActions: ["comment"],
  };
  let executorCloses = 0;

  await assert.rejects(
    createApplication({
      config,
      store: memoryStore(),
      ...localCoordinationStubs({
        calls,
        closeCalls,
        runners: {
          "github-pr-action-runner": { async claim() {}, async advance() {} },
        },
      }),
      githubCredentialSourceFactory: async () =>
        Object.freeze({ async acquire() {} }),
      pullRequestExternalActionDependencies: {
        transport: Object.freeze({ async observe() {}, async perform() {} }),
      },
      pullRequestExternalActionExecutorFactory: () => ({
        async execute() {},
        async reconcile() {},
        async close() { executorCloses += 1; },
      }),
      confirmationRuntimeFactory: async () => { throw startupFailure; },
    }),
    (error) => error === startupFailure,
  );
  assert.equal(executorCloses, 1);
});

test("an explicit comment-only PR action composes one fixed executor and one scoped runner", async () => {
  const calls = {};
  const closeCalls = [];
  const config = workCoordinationConfig();
  config.githubActions = {
    enabled: true,
    actorAccountId: "review-account",
    tokenEnv: "TEST_GITHUB_TOKEN",
    ghCommand: process.execPath,
    networkEnv: { HTTPS_PROXY: "http://127.0.0.1:8080" },
    timeoutMs: 12_000,
    enabledActions: ["comment"],
  };
  const environment = { TEST_GITHUB_TOKEN: "test-only-token" };
  const transport = { async observe() {}, async perform() {} };
  let executorCalls = 0;
  const executor = {
    async execute() { executorCalls += 1; },
    async reconcile() { executorCalls += 1; },
    async close() {},
  };
  const proposalRunnerPort = { async runCycle() {} };
  const groupedRunner = { async runCycle() {} };
  const runnerAuthority = { async claim() {}, async advance() {} };
  const confirmationProducer = confirmationProducerPort();
  const recoveryStatusReader = { async readRecoveryStatus() { return { kinds: [] }; } };

  const application = await createApplication({
    config,
    store: memoryStore(),
    ...localCoordinationStubs({
      calls,
      closeCalls,
      runners: { "github-pr-action-runner": runnerAuthority },
    }),
    pullRequestExternalActionDependencies: { env: environment },
    pullRequestExternalActionTransportFactory(options) {
      calls.transport = options;
      return transport;
    },
    pullRequestExternalActionExecutorFactory(options) {
      calls.externalExecutor = options;
      return executor;
    },
    confirmationRuntimeFactory: async (_config, dependencies) => {
      calls.confirmation = dependencies;
      return {
        queue: confirmationQueuePort(),
        producerQueue: confirmationProducer,
        recoveryStatusReader,
        async close() { closeCalls.push("confirmation"); },
      };
    },
    pullRequestExternalActionProposalRunnerFactory(options) {
      calls.externalRunner = options;
      return proposalRunnerPort;
    },
    githubReviewProposalRunnerFactory() {
      throw new Error("legacy Review runner must stay disabled");
    },
    workProposalRunnerGroupFactory(runners) {
      calls.runnerGroup = runners;
      return groupedRunner;
    },
    operationsRuntimeFactory(options) {
      calls.operations = options;
      return { admission: { async run(operation) { return operation(); } } };
    },
  });

  assert.deepEqual(calls.proposalRuntime.runnerScopes, [{
    runnerId: "github-pr-action-runner",
    allowedKinds: ["github_pull_request_action_proposal"],
    allowedRoleIds: ["pr-reviewer"],
  }]);
  assert.deepEqual(calls.externalExecutor.enabledActions, ["comment"]);
  assert.deepEqual(Reflect.ownKeys(calls.externalExecutor.credentialSource), [
    "acquire",
  ]);
  assert.equal(Object.isFrozen(calls.externalExecutor.credentialSource), true);
  assert.equal("credentialProvider" in calls.externalExecutor, false);
  assert.equal(calls.externalExecutor.timeoutMs, 12_000);
  assert.strictEqual(calls.externalExecutor.transport, transport);
  assert.deepEqual(calls.transport, {
    ghCommand: process.execPath,
    env: environment,
    networkEnv: { HTTPS_PROXY: "http://127.0.0.1:8080" },
    timeoutMs: 12_000,
  });
  assert.deepEqual(Object.keys(calls.externalExecutor.inputAuthorityVerifier), [
    "verify",
  ]);
  assert.equal(
    Object.isFrozen(calls.confirmation.pullRequestExternalActionExecutor),
    true,
  );
  await calls.confirmation.pullRequestExternalActionExecutor.execute({});
  await calls.confirmation.pullRequestExternalActionExecutor.reconcile({});
  assert.equal(executorCalls, 2);
  assert.strictEqual(calls.externalRunner.runner, runnerAuthority);
  assert.strictEqual(calls.externalRunner.confirmationProducer, confirmationProducer);
  assert.deepEqual(calls.externalRunner.enabledActions, ["comment"]);
  assert.equal(calls.externalRunner.actorAccountId, "review-account");
  assert.deepEqual(calls.runnerGroup, [proposalRunnerPort]);
  assert.strictEqual(calls.operations.externalActionStatus, recoveryStatusReader);
  await application.close();
});

test("an explicit empty PR action allow-list remains inert and never reads transport authority", async () => {
  const calls = {};
  const closeCalls = [];
  let authorityReads = 0;
  const config = workCoordinationConfig();
  config.githubActions = {
    enabled: true,
    actorAccountId: "review-account",
    enabledActions: [],
  };
  const externalDependencies = {};
  for (const name of ["credentialProvider", "transport", "executor"]) {
    Object.defineProperty(externalDependencies, name, {
      enumerable: true,
      get() {
        authorityReads += 1;
        throw new Error(`${name} must stay unread`);
      },
    });
  }
  let confirmations = 0;
  const application = await createApplication({
    config,
    store: memoryStore(),
    ...localCoordinationStubs({ calls, closeCalls, runners: {} }),
    pullRequestExternalActionDependencies: externalDependencies,
    pullRequestExternalActionExecutorFactory() {
      throw new Error("external executor must stay disabled");
    },
    pullRequestExternalActionProposalRunnerFactory() {
      throw new Error("external proposal runner must stay disabled");
    },
    githubReviewProposalRunnerFactory() {
      throw new Error("legacy Review runner must stay disabled");
    },
    confirmationRuntimeFactory: async () => {
      confirmations += 1;
      return {
        queue: confirmationQueuePort(),
        producerQueue: confirmationProducerPort(),
        async close() {},
      };
    },
    workProposalRunnerGroupFactory() {
      throw new Error("an empty runner set must not be grouped");
    },
  });

  assert.deepEqual(calls.proposalRuntime.runnerScopes, []);
  assert.equal(confirmations, 1);
  assert.equal(authorityReads, 0);
  await application.close();
});

test("composition keeps the Head ancestry producer private and uses its real runtime receipt path", async t => {
  const config = structuredClone(defaultCodeJobConfiguration());
  config.workflowRouting.enabled = true;
  config.changePackages = { enabled: true, gitCommand: config.codeExecutor.gitCommand };
  config.githubActions = { enabled: true, actorAccountId: "review-account", tokenEnv: "TEST_GITHUB_TOKEN",
    ghCommand: process.execPath, automaticOwnPrRepair: true, enabledActions: [] };
  let head = "a".repeat(40), runtime, hostile = 0;
  const account = config.githubActions.actorAccountId, target = () => ({ schemaVersion: 1, provider: "github", sourceAccountId: account,
    baseRepository: "acme/repo", baseRefName: "main", baseRefOid: "d".repeat(40),
    headRepository: "acme/repo", headRefName: "feature", headRefOid: head });
  const calls = [], closeCalls = [];
  t.mock.method(GitHubAdapter.prototype, "readPullRequestRoleHandoffFacts", async input => {
    assert.equal(input.account, account); calls.push("live");
    return { state: "open", isDraft: false, author: account, assignees: [account], gitTarget: target() };
  });
  t.mock.method(GitHubAdapter.prototype, "isCommitAncestor", async input => {
    assert.equal(input.ancestorOid, "a".repeat(40)); assert.equal(input.headRefOid, head); calls.push("ancestry"); return true;
  });
  const base = defaultCodeJobApplicationOptions({ config, calls: {}, closeCalls, versioned: true });
  const application = await createApplication({ ...base, store: storedValues({}),
    codeExecutorRuntimeFactory: async () => ({ ...await base.codeExecutorRuntimeFactory(),
      changePackageTargets: [{ workspaceId: "dashboard" }], completedChangeExporter: { async export() {} },
      auditArtifactReader: { async read() {} },
      controlledCommitBuilder: { async create() {}, async find() {}, async verify() {} },
      controlledCommitPublisher: { async publish() { assert.fail("No GitHub writes"); } },
    }),
    changePackageRuntimeFactory: async () => ({
      packageProducer: { async create() {} }, packageReader: { async get() {} }, applicationProducer: { async prepareConfirmation() {} },
      applicationExecutor: { async execute() {}, async reconcile() {} }, applicationReader: { async getResult() {} },
      applicationProjectionReader: { async getForJob() {} }, applicationProjectionWriter: { async getCheckpoint() {}, async applySnapshot() {} }, async close() {},
    }),
    changePackageApplicationResultReconcilerFactory: () => ({ async runCycle() {}, async runThrough() {} }),
    codeJobEvidenceReaderFactory: () => ({ async read() {} }),
    codeJobRuntimeFactory: async options => ({ ...await base.codeJobRuntimeFactory(options),
      changePackageDelivery: { async runCycle() {} }, pauseRecovery: { async runCycle() {} },
    }),
    confirmationRuntimeFactory: async () => ({ ...await base.confirmationRuntimeFactory(),
      applicationResultSource: { async readSnapshot() {} },
    }),
    workProposalRuntimeFactory: async options => {
      const runner = { async claim() {}, async advance() {} };
      return workProposalRuntimePort({ runners: { "code-action-runner": runner, "github-pr-action-runner": runner, "github-review-runner": runner } });
    },
    versionedCodeJobAuthorityFactory: () => ({ async create() {}, async verify(value) { return value; }, async decide() {}, async close() {} }),
    githubCredentialSourceFactory: async () => Object.freeze({ async acquire() { assert.fail("No external action credentials"); } }),
    pullRequestExternalActionDependencies: { transport: { async observe() {}, async perform() { assert.fail("No external actions"); } } },
    pullRequestExternalActionExecutorFactory: () => ({ async execute() { assert.fail("No external actions"); }, async reconcile() {}, async close() {} }),
    pullRequestExternalActionProposalRunnerFactory: () => ({ async runCycle() {} }),
    githubReviewProposalRunnerFactory: () => ({ async runCycle() {} }),
    privateRuntimeDirectory: path.join(tmpdir(), "mydashboard-ancestry-composition"),
    workLedgerDependencies: { attachHostHeadAncestry() { hostile++; } },
    workflowRoutingDependencies: { headAncestryReader: { async read() { hostile++; return []; } } },
    workLedgerRuntimeFactory: async options => {
      runtime = await createWorkLedgerRuntime({ ...options, createCandidateProcessor: createLocalWorkLedgerCandidateProcessor,
        createGuard: () => ({ ...inProcessExclusiveGuard(), acquire: async () => {} }) }); return runtime;
    },
    workflowRoutingRuntimeFactory: (configuration, dependencies) => createWorkflowRoutingRuntime(configuration, {
      ...dependencies, createGuard: () => ({ ...inProcessExclusiveGuard(), acquire: async () => {} }),
    }),
  });
  try {
    const ingest = async (included, time) => {
      const snapshot = { refreshedAt: time, sourceStatus: { githubPullRequests: { ok: true, stale: false, complete: true }, githubIssues: { ok: true } },
        items: included ? [{ id: "github:pr:acme/repo#42", kind: "pull_request", repo: "acme/repo", number: 42, title: "Bounded ancestry",
          state: "open", isDraft: false, author: account, assignees: [account], relation: "authored", actionState: "action_now",
          nextAction: "address_review", headRefOid: head, gitTargetAvailable: true, gitTarget: target() }] : [] };
      await application.workflowRouting.ingestSnapshot({ snapshot }); await runtime.intake();
    };
    await ingest(true, "2026-08-02T01:00:00.000Z"); await ingest(false, "2026-08-02T01:01:00.000Z");
    head = "b".repeat(40); await ingest(true, "2026-08-02T01:02:00.000Z");
    const roots = (await runtime.listItems()).items.filter(item => item.kind === "source_root");
    assert.equal(roots.length, 1); assert.equal(roots[0].source.current.headRefOid, head);
    assert.ok(roots[0].source.revisions.some(revision => revision.headAncestryProof));
    assert.deepEqual(calls, ["live", "ancestry", "live"]); assert.equal(hostile, 0);
    assert.equal(application.headAncestryReader, undefined); assert.equal(application.recordHostHeadAncestry, undefined);
    assert.equal(runtime.recordHostHeadAncestry, undefined); assert.equal(runtime.attachHostHeadAncestry, undefined);
  } finally { await application.close(); }
});

test("automatic own PR repair composes internal push with ownership guards and complete feedback readers", async (t) => {
  const scenarios = [
    { name: "generic push disabled", explicitPush: false, expectedBudget: 119_000 },
    { name: "generic push enabled", explicitPush: true, expectedBudget: 119_000 },
    {
      name: "automatic preparation can finish after the ordinary handler deadline",
      leaseDurationMs: 1_080_000, resolveTimeoutMs: 30_000, decisionTimeoutMs: 60_000,
      githubTimeoutMs: 60_000, gitTimeoutMs: 30_000, expectedBudget: 1_079_000,
      elapsedMs: 240_000, expectedStatus: "succeeded",
    },
    {
      name: "automatic preparation still times out before its lease expires",
      leaseDurationMs: 90_000, resolveTimeoutMs: 5_000, decisionTimeoutMs: 10_000,
      githubTimeoutMs: 60_000, gitTimeoutMs: 30_000, expectedBudget: 89_000,
      elapsedMs: 89_000, expectedStatus: "waiting_retry",
    },
    {
      name: "network preparation remains bounded by a short configured lease",
      leaseDurationMs: 120_000, resolveTimeoutMs: 5_000, decisionTimeoutMs: 10_000,
      githubTimeoutMs: 5_000, gitTimeoutMs: 2_000, expectedBudget: 119_000,
    },
  ];
  for (const scenario of scenarios) {
    const explicitPush = scenario.explicitPush === true;
    await t.test(scenario.name, async (t) => {
      const config = structuredClone(defaultCodeJobConfiguration());
      config.githubActions = {
        enabled: true, actorAccountId: "review-account", tokenEnv: "TEST_GITHUB_TOKEN",
        ghCommand: process.execPath, automaticOwnPrRepair: true,
        enabledActions: explicitPush ? ["push"] : [],
      };
      for (const field of ["leaseDurationMs", "resolveTimeoutMs", "decisionTimeoutMs"]) {
        if (scenario[field] !== undefined) config.workCoordination[field] = scenario[field];
      }
      if (scenario.githubTimeoutMs !== undefined) config.githubActions.timeoutMs = scenario.githubTimeoutMs;
      if (scenario.gitTimeoutMs !== undefined) config.codeExecutor.gitTimeoutMs = scenario.gitTimeoutMs;
      config.changePackages = { enabled: true, gitCommand: "C:\\Program Files\\Git\\cmd\\git.exe" };
      config.workCoordination.codeJobLimit = 9;
      config.workCoordination.policy.configurationChangeRoles = [];
      const calls = {};
      const closeCalls = [];
      const repairEnvelope = {
        id: "unowned-repair-push", kind: "github.pull-request-push",
        requestedBy: { roleId: "developer", workItemId: "work-42" },
        action: { controlledCommitEvidence: { executionSource: { kind: "review_repair", inputBinding: {} } } },
      };
      const conflictEnvelope = {
        ...repairEnvelope, id: "ordinary-conflict-push",
        action: { controlledCommitEvidence: { executionSource: { kind: "conflict_preparation" } } },
      };
      const ciEnvelope = { ...repairEnvelope, id: 'unowned-ci-push',
        action: { controlledCommitEvidence: { executionSource: { kind: 'ci_repair', inputBinding: {} } } } };
      const base = defaultCodeJobApplicationOptions({
        config, calls, closeCalls, versioned: true,
        lifecycle: createApplicationRuntimeLifecycle(),
        confirmationRuntimeFactory: async (_config, dependencies) => {
          calls.confirmation = dependencies;
          assert.throws(() => calls.externalExecutor.pushAuthorization.verifyPush(repairEnvelope), { code: "GITHUB_AUTHORIZATION_UNAVAILABLE" });
          assert.throws(() => calls.externalExecutor.pushAuthorization.verifyPush(ciEnvelope), { code: 'GITHUB_AUTHORIZATION_UNAVAILABLE' });
          return {
            reviewHandoffAssignee: { async assignAssignee() { throw new Error("No live assignment in composition test"); } },
            queue: confirmationQueuePort(), producerQueue: confirmationProducerPort(),
            memoryProjectionSource: confirmationMemoryProjectionSourcePort(),
            applicationResultSource: { async readSnapshot() {} },
            async close() { await dependencies.pullRequestExternalActionExecutor.close(); },
          };
        },
      });
      const application = await createApplication({
        ...base,
        privateRuntimeDirectory: path.join(tmpdir(), 'mydashboard-jenkins-composition', projectIdentityDigest({ projectRoot: path.resolve(import.meta.dirname, '..') })),
        roleContextAssemblerFactory: options => { calls.contextAssembler = options; return { async assemble() {} }; },
        workLedgerRuntimeFactory: async (options) => ({
          ...await base.workLedgerRuntimeFactory(options),
          async readPullRequestExecutionContext() { throw new Error("unused in composition test"); },
        }),
        workProposalRuntimeFactory: async (options) => {
          calls.proposalRuntime = options;
          const runner = { async claim() {}, async advance() {} };
          return workProposalRuntimePort({ runners: {
            "code-action-runner": runner, "github-pr-action-runner": runner, "github-review-runner": runner,
          } });
        },
        versionedCodeJobAuthorityFactory: () => ({ async create() {}, async verify(value) { return value; }, async decide() {}, async close() {} }),
        codeExecutorRuntimeFactory: async () => ({
          ...await base.codeExecutorRuntimeFactory(),
          changePackageTargets: [{ workspaceId: "dashboard" }],
          completedChangeExporter: { async export() {} },
          controlledCommitBuilder: { async create() {}, async find() {}, async verify() {} },
          controlledCommitPublisher: { async publish() {} },
          auditArtifactReader: { async read() {} },
        }),
        codeJobRuntimeFactory: async (options) => ({
          ...await base.codeJobRuntimeFactory(options),
          worker: { ...codeJobWorkerPort(), async runReady(request, runOperation) {
            calls.codeWorkerRequest = request; calls.codeWorkerOwner = runOperation; return { processed: 1 };
          } },
          pauseRecovery: { async runCycle(value) { calls.pauseRecoveryRequest = value; return { resumed: 1 }; } },
          changePackageDelivery: { async runCycle() {} },
        }),
        changePackageRuntimeFactory: async () => ({
          packageProducer: { async create() {} }, packageReader: { async get() {} },
          applicationProducer: { async prepareConfirmation() {} },
          applicationExecutor: { async execute() {}, async reconcile() {} },
          applicationReader: { async getResult() {} },
          applicationProjectionReader: { async getForJob() {} },
          applicationProjectionWriter: { async getCheckpoint() {}, async applySnapshot() {} },
          async close() {},
        }),
        changePackageApplicationResultReconcilerFactory: () => ({ async runCycle() {}, async runThrough() {} }),
        codeJobEvidenceReaderFactory: () => ({ async read() {} }),
        githubCredentialSourceFactory: async () => Object.freeze({ async acquire() {} }),
        pullRequestExternalActionDependencies: { transport: { async observe() {}, async perform() {} } },
        pullRequestExternalActionExecutorFactory(options) {
          calls.externalExecutor = options;
          return { async execute() {}, async reconcile() {}, async close() {} };
        },
        pullRequestExternalActionProposalRunnerFactory: () => ({ async runCycle() {} }),
        githubReviewProposalRunnerFactory: () => ({ async runCycle() {} }),
        codeActionProposalRunnerFactory(options) {
          calls.codeRunner = options;
          return createCodeActionProposalRunnerService(options);
        },
      });
      try {
        assert.equal(calls.coordination.codeJobRunner, null, 'housekeeping must not own long automatic code execution');
        assert.equal(Object.isFrozen(application.codeJobExecution), true);
        assert.deepEqual(Object.keys(application.codeJobExecution), ['runCycle']);
        const workerSignal = new AbortController().signal;
        const owner = operation => operation();
        assert.deepEqual(await application.codeJobExecution.runCycle({ signal: workerSignal }, owner), { processed: 1 });
        assert.strictEqual(calls.codeWorkerOwner, owner);
        assert.equal(calls.codeWorkerRequest.limit, 9);
        assert.strictEqual(calls.codeWorkerRequest.signal, workerSignal);
        assert.deepEqual(Object.keys(application.localCodeProposalRecovery), ["runCycle"]);
        assert.deepEqual(Object.keys(application.jenkinsConnection), ['status', 'connect']);
        assert.equal(Object.isFrozen(application.jenkinsConnection), true);
        assert.equal(await calls.contextAssembler.ciDiagnosticReader.read({ repository: 'acme/repo', headRefOid: 'a'.repeat(40), headRefName: 'main', checks: [], maximumBytes: 1000 }), null);
        assert.equal(Object.isFrozen(calls.codeJobRuntime.automaticPauseRecovery), true);
        assert.equal(await calls.codeJobRuntime.automaticPauseRecovery.canRecover({}), false);
        assert.deepEqual(await calls.codeJobRuntime.automaticPauseRecovery.withNativeQuiescence({}, () => {
          throw new Error('unbound native recovery must stay closed');
        }), { executed: false });
        assert.equal(Object.isFrozen(calls.coordination.codeJobPauseRecovery), true);
        assert.deepEqual(await calls.coordination.codeJobPauseRecovery.runCycle({ limit: 2 }), { resumed: 1 });
        assert.deepEqual(calls.pauseRecoveryRequest, { limit: 2 });
        assert.equal(Object.isFrozen(application.localCodeProposalRecovery), true);
        assert.equal(calls.codeRunner.handlerTimeoutMs, scenario.expectedBudget);
        assert.equal(calls.codeRunner.leaseDurationMs, scenario.leaseDurationMs ?? 120_000);
        assert.ok(calls.codeRunner.handlerTimeoutMs < calls.codeRunner.leaseDurationMs);
        if (scenario.elapsedMs !== undefined) {
          const proposal = normalizeBoundWorkProposal({
            proposalId: "automatic-code-preparation-budget", policyVersion: 1,
            kind: "code_action_proposal", requestedBy: { roleId: "developer", workItemId: "work-budget" },
            source: { assignmentId: "assignment-budget", eventId: "event-budget" },
            binding: { repository: "acme/repo" }, payload: { operation: "modify" },
          });
          let claimed = false;
          let start;
          let release;
          const started = new Promise((resolve) => { start = resolve; });
          const preparing = new Promise((resolve) => { release = resolve; });
          const advances = [];
          t.mock.method(CodeActionProposalHandler.prototype, "handle", async () => {
            start();
            await preparing;
            return { status: "succeeded", summary: "Automatic preparation completed", evidence: [] };
          });
          const runner = createCodeActionProposalRunnerService({
            ...calls.codeRunner,
            runner: {
              async claim({ leaseDurationMs }) {
                assert.equal(leaseDurationMs, scenario.leaseDurationMs);
                if (claimed) return null;
                claimed = true;
                return {
                  proposal, status: "pending_delivery", revision: 1, attempt: 1, downstreamRef: null,
                  lease: { runnerId: "code-action-runner", leaseId: "lease-budget", leaseUntil: "2026-10-14T04:30:00.000Z" },
                };
              },
              async advance(value) { advances.push(value); },
            },
          });
          t.mock.timers.enable({ apis: ["setTimeout"] });
          try {
            const execution = runner.runCycle({ limit: 1 });
            await started;
            t.mock.timers.tick(30_001);
            await Promise.resolve();
            assert.equal(advances.length, 0, "automatic preparation must not time out at the ordinary deadline");
            t.mock.timers.tick(scenario.elapsedMs - 30_001);
            if (scenario.expectedStatus === "succeeded") release();
            const result = await execution;
            assert.equal(result.outcomes[0].status, scenario.expectedStatus);
            if (scenario.expectedStatus === "waiting_retry") {
              assert.equal(advances[0].transition.reason, "WORK_PROPOSAL_HANDLER_TIMEOUT");
            }
          } finally {
            release();
            t.mock.timers.reset();
            t.mock.restoreAll();
          }
        }
        const { AutomaticLocalCodeAuthorization } = await import('../src/services/automatic-local-code-authorization.js');
        assert.ok(calls.codeRunner.automaticOwnPrRepair instanceof AutomaticLocalCodeAuthorization);
        const { CiRepairContextReader } = await import('../src/services/ci-repair-context-reader.js');
        assert.ok(calls.codeRunner.automaticOwnPrRepair.specialized.ciRepairContextReader instanceof CiRepairContextReader);
        assert.deepEqual(await application.reviewHandoffReconciler.runCycle(), [{ assigned: 0, already: 0, pending: 0 }]);
        assert.equal(application.prEmployee.config.automaticOwnPrRepair, true);
        assert.equal(calls.codeJobRuntime.workerLimits.concurrency, 2);
        assert.deepEqual(calls.externalExecutor.enabledActions, ["push"]);
        assert.deepEqual(config.githubActions.enabledActions, explicitPush ? ["push"] : []);
        assert.equal(typeof calls.codeJobRuntime.reviewRepairContextReader.read, "function");
        assert.equal(typeof calls.codeJobRuntime.reviewRepairContextReader.readBinding, "function");
        assert.strictEqual(calls.loop.reviewRepairContextReader, calls.codeJobRuntime.reviewRepairContextReader);
        assert.equal(await calls.externalExecutor.pushAuthorization.verifyPush(repairEnvelope), false);
        assert.equal(await calls.externalExecutor.pushAuthorization.verifyPush(ciEnvelope), false, 'explicit generic push cannot bypass CI repair provenance');
        assert.equal(await calls.externalExecutor.pushAuthorization.verifyPush(conflictEnvelope), explicitPush);
      } finally {
        await application.close();
      }
    });
  }
});

test("an explicit Review keeps legacy intake while unified execution owns work-proposal side effects", async () => {
  const calls = {};
  const closeCalls = [];
  const config = workCoordinationConfig();
  config.githubActions = {
    enabled: true,
    actorAccountId: "review-account",
    tokenEnv: "TEST_GITHUB_TOKEN",
    ghCommand: process.execPath,
    enabledActions: ["review"],
  };
  const legacyAuthority = { async claim() {}, async advance() {} };
  const unifiedAuthority = { async claim() {}, async advance() {} };
  const legacyRunner = { async runCycle() {} };
  const unifiedRunner = { async runCycle() {} };
  let executorCalls = 0;
  const executor = {
    async execute() { executorCalls += 1; },
    async reconcile() { executorCalls += 1; },
    async close() {},
  };
  const application = await createApplication({
    config,
    store: memoryStore(),
    ...localCoordinationStubs({
      calls,
      closeCalls,
      runners: {
        "github-review-runner": legacyAuthority,
        "github-pr-action-runner": unifiedAuthority,
      },
    }),
    pullRequestExternalActionDependencies: {
      transport: { async review() {} },
    },
    pullRequestExternalActionExecutorFactory() { return executor; },
    confirmationRuntimeFactory: async (_config, dependencies) => {
      calls.confirmation = dependencies;
      return {
        queue: confirmationQueuePort(),
        producerQueue: confirmationProducerPort(),
        async close() {},
      };
    },
    githubReviewProposalRunnerFactory(options) {
      calls.legacyRunner = options;
      return legacyRunner;
    },
    pullRequestExternalActionProposalRunnerFactory(options) {
      calls.unifiedRunner = options;
      return unifiedRunner;
    },
    workProposalRunnerGroupFactory(runners) {
      calls.runnerGroup = runners;
      return { async runCycle() {} };
    },
  });

  assert.deepEqual(calls.proposalRuntime.runnerScopes, [
    {
      runnerId: "github-review-runner",
      allowedKinds: ["github_review_proposal"],
      allowedRoleIds: ["pr-reviewer"],
    },
    {
      runnerId: "github-pr-action-runner",
      allowedKinds: ["github_pull_request_action_proposal"],
      allowedRoleIds: ["pr-reviewer"],
    },
  ]);
  assert.strictEqual(calls.legacyRunner.runner, legacyAuthority);
  assert.strictEqual(calls.unifiedRunner.runner, unifiedAuthority);
  await calls.confirmation.pullRequestExternalActionExecutor.execute({});
  await calls.confirmation.pullRequestExternalActionExecutor.reconcile({});
  assert.equal(executorCalls, 2);
  assert.deepEqual(calls.runnerGroup, [legacyRunner, unifiedRunner]);
  await application.close();
});

test("a configured PR push fails closed without sealed controlled-commit verification", async () => {
  const calls = {};
  const closeCalls = [];
  const config = workCoordinationConfig();
  config.githubActions = {
    enabled: true,
    actorAccountId: "review-account",
    tokenEnv: "TEST_GITHUB_TOKEN",
    ghCommand: process.execPath,
    enabledActions: ["push"],
  };

  await assert.rejects(
    createApplication({
      config,
      store: memoryStore(),
      ...localCoordinationStubs({
        calls,
        closeCalls,
        runners: {
          "github-pr-action-runner": { async claim() {}, async advance() {} },
        },
      }),
      pullRequestExternalActionDependencies: {
        transport: { async push() {} },
      },
    }),
    /push 动作需要可核验的受控 commit 证据/,
  );
});

test("application awaits recovered executor composition and propagates failure", async () => {
  const executor = { id: "controlled-executor" };
  let release;
  const recovery = new Promise((resolve) => {
    release = resolve;
  });
  let composed = false;
  let factoryCalled = false;
  const pending = createApplication({
    config: applicationConfig({ enabled: true }),
    store: memoryStore(),
    codeExecutorRuntimeFactory: () => {
      factoryCalled = true;
      return recovery;
    },
  }).then((application) => {
    composed = true;
    return application;
  });
  assert.equal(factoryCalled, true);
  assert.equal(composed, false);

  release({ executor, recovery: { recovered: true, cleanupPending: 0 } });
  const application = await pending;
  assert.equal(Object.hasOwn(application, "codeExecutor"), false);

  const startupFailure = new Error("recovery failed");
  await assert.rejects(
    createApplication({
      config: applicationConfig({ enabled: true }),
      store: memoryStore(),
      codeExecutorRuntimeFactory: async () => {
        throw startupFailure;
      },
    }),
    (error) => error === startupFailure,
  );
});

test("conflict preparation composition rejects partial or injected production authority", async (t) => {
  const enabledConflict = {
    enabled: true,
    conflictPreparation: {
      enabled: true,
      baseMirrorsByRepository: { "acme/repo": "D:\\mirrors\\base.git" },
      headMirrorsByRepository: {
        "contributor/repo": "D:\\mirrors\\head.git",
      },
    },
  };
  const verifier = { async verify(value) { return value; } };
  const preparer = { async prepare(value) { return value; } };
  const cases = [
    {
      name: "configured without ports",
      config: applicationConfig(enabledConflict),
      runtime: {
        authority: {
          workspaces: [{ capabilities: ["conflict_preparation_snapshot"] }],
        },
      },
    },
    {
      name: "configured without advertised workspace capability",
      config: applicationConfig(enabledConflict),
      runtime: {
        authority: { workspaces: [{ capabilities: [] }] },
        conflictPreparationVerifier: verifier,
        conflictExecutionSourcePreparer: preparer,
      },
    },
    {
      name: "unconfigured injected conflict materializer",
      config: applicationConfig({ enabled: true }),
      runtime: {
        authority: {
          workspaces: [{ capabilities: ["conflict_preparation_snapshot"] }],
        },
      },
    },
  ];
  for (const entry of cases) {
    await t.test(entry.name, async () => {
      await assert.rejects(
        createApplication({
          config: entry.config,
          store: memoryStore(),
          codeExecutorRuntimeFactory: async () => entry.runtime,
        }),
        /配置、工作区能力和生产端口不一致/,
      );
    });
  }
});

test("disabled code executor keeps staged conflict preparation inactive", async () => {
  const config = applicationConfig({
    enabled: false,
    conflictPreparation: {
      enabled: true,
      baseMirrorsByRepository: { "acme/repo": "D:\\mirrors\\base.git" },
      headMirrorsByRepository: {
        "contributor/repo": "D:\\mirrors\\head.git",
      },
    },
  });
  const application = await createApplication({
    config,
    store: memoryStore(),
    codeExecutorRuntimeFactory: async () => null,
  });

  await application.close();
});

test("application awaits the private confirmation runtime and exposes only its queue facade", async () => {
  const queue = confirmationQueuePort();
  let release;
  const recoveredRuntime = new Promise((resolve) => {
    release = resolve;
  });
  let completed = false;
  const pending = createApplication({
    config: externalActionConfig(),
    store: memoryStore(),
    confirmationRuntimeFactory: () => recoveredRuntime,
  }).then((application) => {
    completed = true;
    return application;
  });

  await Promise.resolve();
  assert.equal(completed, false);
  release({
    queue,
    producerQueue: confirmationProducerPort(),
    close: async () => {},
  });
  const application = await pending;

  assert.strictEqual(application.confirmationQueue, queue);
  assert.equal("confirmationRuntime" in application, false);
  assert.equal("githubActionExecutor" in application, false);
  assert.equal("executor" in application.confirmationQueue, false);
  assert.equal("recover" in application.confirmationQueue, false);
  await application.close();
});

test("employee recovery failure closes an acquired confirmation runtime", async () => {
  let closes = 0;
  const store = {
    async read(name, fallback = null) {
      if (name === "pr-employee-state") throw new Error("employee state corrupt");
      return fallback;
    },
    async write() {},
  };

  await assert.rejects(
    createApplication({
      config: {
        ...applicationConfig(),
        githubActions: {
          enabled: true,
          actorAccountId: "review-account",
          tokenEnv: "TEST_GITHUB_TOKEN",
          ghCommand: process.execPath,
        },
      },
      store,
      confirmationRuntimeFactory: async () => ({
        queue: confirmationQueuePort(),
        producerQueue: confirmationProducerPort(),
        async close() {
          closes += 1;
        },
      }),
    }),
    /employee state corrupt/,
  );
  assert.equal(closes, 1);
});

test("application does not open until a persisted invalidation intent is recovered", async () => {
  const state = invalidationPendingEmployeeState();
  const store = storedValues({ "pr-employee-state": state });
  let releaseInvalidation;
  const invalidationGate = new Promise((resolve) => {
    releaseInvalidation = resolve;
  });
  let invalidationCalls = 0;
  let applicationOpened = false;
  const pending = createApplication({
    config: {
      ...applicationConfig(),
      githubActions: {
        enabled: true,
        actorAccountId: "review-account",
        tokenEnv: "TEST_GITHUB_TOKEN",
        ghCommand: process.execPath,
      },
    },
    store,
    confirmationRuntimeFactory: async () => ({
      queue: confirmationQueuePort(),
      memoryProjectionSource: confirmationMemoryProjectionSourcePort(),
      producerQueue: confirmationProducerPort({
        async invalidate(id, intent) {
          invalidationCalls += 1;
          await invalidationGate;
          return {
            id,
            status: "stale",
            requestedBy: intent.requestedBy,
            approvalBindingDigest: intent.approvalBindingDigest,
            retryable: false,
            invalidation: {
              ...intent,
              at: "2026-08-02T01:02:00.000Z",
            },
          };
        },
      }),
      async close() {},
    }),
  }).then((application) => {
    applicationOpened = true;
    return application;
  });

  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(invalidationCalls, 1);
  assert.equal(applicationOpened, false);
  releaseInvalidation();
  const application = await pending;

  assert.equal(applicationOpened, true);
  assert.equal(
    (await store.read("pr-employee-state")).jobs[0].status,
    "superseded",
  );
  await application.close();
});

test("failed persisted invalidation recovery aborts startup and closes the runtime", async () => {
  const store = storedValues({
    "pr-employee-state": invalidationPendingEmployeeState(),
  });
  let closes = 0;
  const invalidationFailure = Object.assign(
    new Error("confirmation queue unavailable"),
    { statusCode: 503 },
  );

  await assert.rejects(
    createApplication({
      config: {
        ...applicationConfig(),
        githubActions: {
          enabled: true,
          actorAccountId: "review-account",
          tokenEnv: "TEST_GITHUB_TOKEN",
          ghCommand: process.execPath,
        },
      },
      store,
      confirmationRuntimeFactory: async () => ({
        queue: confirmationQueuePort(),
        producerQueue: confirmationProducerPort({
          async invalidate() {
            throw invalidationFailure;
          },
        }),
        async close() {
          closes += 1;
        },
      }),
    }),
    (error) => error.statusCode === 503 && /拒绝启动服务/.test(error.message),
  );

  assert.equal(closes, 1);
  assert.match(
    (await store.read("pr-employee-state")).jobs[0].error,
    /无法安全失效/,
  );
});

test("maintenance composition never acquires the external-action runtime", async () => {
  let confirmationFactoryCalls = 0;
  const application = await createApplication({
    config: {
      ...applicationConfig(),
      githubActions: {
        enabled: true,
        actorAccountId: "review-account",
      },
    },
    store: memoryStore(),
    externalActions: false,
    confirmationRuntimeFactory: async () => {
      confirmationFactoryCalls += 1;
      throw new Error("must not be called");
    },
  });

  assert.equal(confirmationFactoryCalls, 0);
  assert.equal(application.confirmationQueue, null);
  await application.close();
});

test("change package composition derives trusted targets and shares the confirmation queue", async () => {
  const calls = {};
  const closeCalls = [];
  const trustedTargets = Object.freeze([
    Object.freeze({
      workspaceId: "dashboard",
      sourceRoot: "D:\\trusted\\dashboard",
      targetAuthorityDigest: "a".repeat(64),
      writablePaths: Object.freeze(["src"]),
      excludePaths: Object.freeze(["node_modules"]),
    }),
  ]);
  const applicationExecutor = { async execute() {}, async reconcile() {} };
  const preparedPlan = { id: "confirmation-change-package-1" };
  const runtime = {
    packageReader: {
      async get(id) { return { packageId: id }; },
      async readFile() { throw new Error("must remain private"); },
    },
    applicationProducer: {
      async prepareConfirmation(value) {
        calls.prepared = value;
        return preparedPlan;
      },
    },
    applicationExecutor,
    applicationReader: {
      async getResult(id) { return { confirmationId: id }; },
    },
    applicationProjectionReader: {
      async getForJob(id) { return { status: "not_requested", jobId: id }; },
      async getForPackage() {},
      async getSummary() {},
    },
    applicationProjectionWriter: {
      async getCheckpoint() {},
      async applySnapshot() {},
    },
    async close() { closeCalls.push("change-package"); },
  };
  const confirmationProducer = confirmationProducerPort({
    async enqueue(plan) {
      calls.enqueued = plan;
      return { status: "applied", id: plan.id };
    },
  });
  const config = {
    ...applicationConfig({ enabled: true }),
    changePackages: {
      enabled: true,
      gitCommand: "C:\\Program Files\\Git\\cmd\\git.exe",
    },
  };
  const application = await createApplication({
    config,
    store: memoryStore(),
    codeExecutorRuntimeFactory: async () => ({
      authority: { workspaces: [] },
      changePackageTargets: trustedTargets,
      async close() { closeCalls.push("code-executor"); },
    }),
    changePackageRuntimeFactory: async (runtimeConfig, dependencies) => {
      calls.runtimeConfig = runtimeConfig;
      calls.runtimeDependencies = dependencies;
      return runtime;
    },
    confirmationRuntimeFactory: async (_runtimeConfig, dependencies) => {
      calls.confirmation = dependencies;
      return {
        queue: confirmationQueuePort(),
        producerQueue: confirmationProducer,
        async close() { closeCalls.push("confirmation"); },
      };
    },
  });

  assert.strictEqual(calls.runtimeConfig, config.changePackages);
  assert.strictEqual(calls.runtimeDependencies.trustedTargets, trustedTargets);
  assert.strictEqual(calls.runtimeDependencies.store, application.store);
  assert.deepEqual(
    Object.keys(calls.runtimeDependencies.applicationAuthorityVerifier),
    ["verify"],
  );
  assert.equal(
    Object.isFrozen(calls.runtimeDependencies.applicationAuthorityVerifier),
    true,
  );
  await assert.rejects(
    calls.runtimeDependencies.applicationAuthorityVerifier.verify({}),
    (error) => error?.code === "CHANGE_PACKAGE_APPLICATION_STALE",
  );
  assert.deepEqual(Object.keys(calls.confirmation.localExecutors), [
    "local.change-package-apply",
  ]);
  assert.equal(Object.isFrozen(calls.confirmation.localExecutors), true);
  assert.equal(
    Object.isFrozen(
      calls.confirmation.localExecutors["local.change-package-apply"],
    ),
    true,
  );
  assert.deepEqual(Object.keys(application.changePackageReader), ["get"]);
  assert.deepEqual(
    await application.changePackageReader.get("change-package-1"),
    { packageId: "change-package-1" },
  );
  assert.deepEqual(
    await application.changePackageApplicationReader.getResult(
      "confirmation-change-package-1",
    ),
    { confirmationId: "confirmation-change-package-1" },
  );
  assert.deepEqual(
    await application.changePackageApplicationStatusReader.getForJob(
      "code-job-1",
    ),
    { status: "not_requested", jobId: "code-job-1" },
  );
  assert.deepEqual(
    Object.keys(application.changePackageApplicationStatusReader),
    ["getForJob"],
  );
  const request = {
    packageId: "change-package-1",
    requestedBy: { roleId: "developer", workItemId: "work-1" },
  };
  assert.deepEqual(
    await application.changePackageApplicationRequester.request(request),
    { status: "applied", id: preparedPlan.id },
  );
  assert.strictEqual(calls.prepared, request);
  assert.strictEqual(calls.enqueued, preparedPlan);
  for (const privateName of [
    "changePackageRuntime",
    "changePackageProducer",
    "changePackageApplicationExecutor",
    "changePackageApplicationProducer",
  ]) {
    assert.equal(privateName in application, false);
  }

  await application.close();
  assert.deepEqual(closeCalls, [
    "confirmation",
    "change-package",
    "code-executor",
  ]);
});

test("maintenance mode does not acquire change package write authority", async () => {
  let changePackageCalls = 0;
  let confirmationCalls = 0;
  const application = await createApplication({
    config: {
      ...applicationConfig({ enabled: true }),
      changePackages: {
        enabled: true,
        gitCommand: "C:\\Program Files\\Git\\cmd\\git.exe",
      },
    },
    store: memoryStore(),
    externalActions: false,
    codeExecutorRuntimeFactory: async () => ({
      changePackageTargets: [{}],
    }),
    changePackageRuntimeFactory: async () => {
      changePackageCalls += 1;
    },
    confirmationRuntimeFactory: async () => {
      confirmationCalls += 1;
    },
  });

  assert.equal(changePackageCalls, 0);
  assert.equal(confirmationCalls, 0);
  assert.equal(application.changePackageReader, null);
  assert.equal(application.changePackageApplicationReader, null);
  assert.equal(application.changePackageApplicationStatusReader, null);
  assert.equal(application.changePackageApplicationRequester, null);
  await application.close();
});

test("local code and change package composition injects only frozen delivery ports", async () => {
  const calls = {};
  const applicationRequestOrder = [];
  const closeCalls = [];
  const config = {
    ...localCodeCoordinationConfig({ githubActions: false }),
    changePackages: {
      enabled: true,
      gitCommand: "C:\\Program Files\\Git\\cmd\\git.exe",
    },
  };
  const application = await createApplication({
    config,
    store: memoryStore(),
    codeExecutorRuntimeFactory: async () => ({
      authority: { workspaces: [] },
      executor: controlledCodeExecutorPort(),
      changePackageTargets: [{ workspaceId: "dashboard" }],
      completedChangeExporter: { async export() {} },
      controlledCommitBuilder: {
        async create() {}, async find() {}, async verify() {},
        async readSealed(value) { calls.sealedCommitRead = value; return { evidenceId: value.evidenceId }; },
      },
      auditArtifactReader: {
        async read(value) { return Buffer.from(JSON.stringify(value)); },
      },
      async close() {},
    }),
    changePackageRuntimeFactory: async (_runtimeConfig, dependencies) => {
      calls.changePackageRuntime = dependencies;
      return {
        packageProducer: { async create() {} },
        packageReader: { async get() {}, async readFile() {} },
        controlledCommitDelivery: { async deliver() {} },
        applicationProducer: {
          async prepareConfirmation(value) {
            applicationRequestOrder.push("prepare");
            calls.applicationRequest = value;
            return { id: "confirmation-change-package-1" };
          },
        },
        applicationExecutor: { async execute() {}, async reconcile() {} },
        applicationReader: { async getResult() {} },
        applicationProjectionReader: {
          async getForJob() {}, async getForPackage() {}, async getSummary() {},
        },
        applicationProjectionWriter: {
          async getCheckpoint() {
            return { sourceRevision: 0, sourceSnapshotDigest: "0".repeat(64) };
          },
          async applySnapshot() {},
        },
        async close() {},
      };
    },
    ...localCoordinationStubs({
      calls,
      closeCalls,
      runners: {
        "code-action-runner": { async claim() {}, async advance() {} },
      },
    }),
    codeJobRuntimeFactory: async (options) => {
      calls.codeJobRuntime = options;
      return {
        confirmationExecutor: { async execute() {}, async reconcile() {} },
        reader: {
          async get() { return calls.authorityJob ?? null; },
          async getDetail() {}, async list() {}, async listNewest() {},
        },
        control: codeJobControlPort(),
        worker: codeJobWorkerPort(),
        projectionSource: codeJobProjectionSourcePort(),
        changePackageDelivery: { async runCycle() {} },
        async close() {},
      };
    },
    codeJobEvidenceReaderFactory: (options) => {
      calls.codeJobEvidenceReader = options;
      return {
        async read(value) {
          return { request: value };
        },
      };
    },
    confirmationRuntimeFactory: async () => ({
      queue: confirmationQueuePort(),
      memoryProjectionSource: confirmationMemoryProjectionSourcePort(),
      producerQueue: confirmationProducerPort({
        async enqueue(value) {
          applicationRequestOrder.push("enqueue");
          calls.applicationPlan = value;
          return { id: value.id, status: "pending", queueRevision: 9 };
        },
      }),
      applicationResultSource: { async readSnapshot() {} },
      async close() {},
    }),
    changePackageApplicationResultReconcilerFactory: () => ({
      async runCycle() {
        return { status: "applied" };
      },
      async runThrough(sourceRevision) {
        applicationRequestOrder.push("reconcile");
        calls.applicationSourceRevision = sourceRevision;
        return { status: "applied", sourceRevision };
      },
    }),
    codeJobGrantFactory: () => ({
      async create() {},
      verify(value) { return value; },
    }),
    codeJobBrainDirectoryFactory: () => ({ async decide() {} }),
    codeActionProposalRunnerFactory: () => ({ async runCycle() {} }),
    workProposalRunnerGroupFactory: (runners) => runners[0],
  });

  assert.deepEqual(
    Object.keys(calls.changePackageRuntime.controlledCommitBuilder),
    ["create", "find", "verify", "readSealed"],
  );
  assert.deepEqual(await calls.changePackageRuntime.controlledCommitBuilder.readSealed({ evidenceId: "historical-commit" }), { evidenceId: "historical-commit" });
  assert.deepEqual(calls.sealedCommitRead, { evidenceId: "historical-commit" });
  assert.equal(
    Object.isFrozen(calls.changePackageRuntime.controlledCommitBuilder),
    true,
  );
  assert.deepEqual(
    Object.keys(calls.codeJobRuntime.controlledCommitDelivery),
    ["deliver"],
  );
  assert.equal(
    Object.isFrozen(calls.codeJobRuntime.controlledCommitDelivery),
    true,
  );

  calls.authorityJob = {
    jobId: "code-job-1",
    status: "completed",
    proposalId: "proposal-1",
    proposalContentDigest: "b".repeat(64),
    grantDigest: "c".repeat(64),
    workspaceId: "dashboard",
    inputBinding: null,
  };
  const sourceManifest = {
    job: { id: "code-job-1" },
    proposal: { id: "proposal-1", contentDigest: "b".repeat(64) },
    grant: { digest: "c".repeat(64) },
    workspace: { id: "dashboard" },
  };
  assert.equal(
    await calls.changePackageRuntime.applicationAuthorityVerifier.verify(
      sourceManifest,
    ),
    true,
  );
  calls.authorityJob.inputBinding = { schemaVersion: 1 };
  await assert.rejects(
    calls.changePackageRuntime.applicationAuthorityVerifier.verify(sourceManifest),
    (error) => error?.code === "CHANGE_PACKAGE_APPLICATION_STALE",
  );
  calls.authorityJob.inputBinding = {
    schemaVersion: 2,
    kind: "pull_request",
    repository: "acme/repo",
    pullRequestNumber: 42,
    rootItemId: "work-42",
    workKey: "pull-request-acme-repo-42",
    inputRevision: 1,
    headRevision: 1,
    headRefOid: "1".repeat(40),
    eventId: "event-42",
    eventDigest: "2".repeat(64),
    inputDigest: "3".repeat(64),
    gitTarget: {
      schemaVersion: 1,
      provider: "github",
      sourceAccountId: "runtime-user",
      baseRepository: "acme/repo",
      baseRefName: "main",
      baseRefOid: "4".repeat(40),
      headRepository: "contributor/repo",
      headRefName: "fix/race",
      headRefOid: "1".repeat(40),
    },
  };
  assert.equal(
    await calls.changePackageRuntime.applicationAuthorityVerifier.verify(
      sourceManifest,
    ),
    true,
  );

  for (const [name, methods] of [
    ["completedChangeExporter", ["export"]],
    ["changePackageProducer", ["create"]],
    ["changePackageReader", ["get"]],
  ]) {
    assert.equal(Object.isFrozen(calls.codeJobRuntime[name]), true);
    assert.deepEqual(Object.keys(calls.codeJobRuntime[name]), methods);
  }
  assert.deepEqual(
    Object.keys(calls.dispatcher.controlledCommitEvidenceReader),
    ["verify"],
  );
  assert.equal(
    Object.isFrozen(calls.dispatcher.controlledCommitEvidenceReader),
    true,
  );
  assert.equal(
    Object.isFrozen(calls.coordination.codeJobChangePackageDispatcher),
    true,
  );
  assert.deepEqual(
    Object.keys(calls.coordination.codeJobChangePackageDispatcher),
    ["runCycle"],
  );
  assert.equal(
    Object.isFrozen(
      calls.coordination.changePackageApplicationResultReconciler,
    ),
    true,
  );
  assert.deepEqual(
    Object.keys(calls.coordination.changePackageApplicationResultReconciler),
    ["runCycle"],
  );
  const applicationRequest = {
    packageId: "change-package-1",
    requestedBy: { roleId: "developer", workItemId: "work-1" },
  };
  assert.deepEqual(
    await application.changePackageApplicationRequester.request(
      applicationRequest,
    ),
    {
      id: "confirmation-change-package-1",
      status: "pending",
      queueRevision: 9,
    },
  );
  assert.strictEqual(calls.applicationRequest, applicationRequest);
  assert.deepEqual(calls.applicationPlan, {
    id: "confirmation-change-package-1",
  });
  assert.deepEqual(applicationRequestOrder, [
    "prepare",
    "enqueue",
    "reconcile",
  ]);
  assert.equal(calls.applicationSourceRevision, 9);
  for (const [name, methods] of [
    ["codeJobReader", ["get", "getDetail", "list", "listNewest"]],
    ["changePackageReader", ["get"]],
    ["auditArtifactReader", ["read"]],
  ]) {
    assert.equal(Object.isFrozen(calls.codeJobEvidenceReader[name]), true);
    assert.deepEqual(
      Object.keys(calls.codeJobEvidenceReader[name]).sort(),
      methods.sort(),
    );
  }
  assert.equal(Object.isFrozen(application.codeJobEvidenceReader), true);
  assert.deepEqual(Object.keys(application.codeJobEvidenceReader), ["read"]);
  assert.deepEqual(
    await application.codeJobEvidenceReader.read({ evidence: "request" }),
    { request: { evidence: "request" } },
  );
  for (const privateName of [
    "completedChangeExporter",
    "changePackageProducer",
    "changePackageDelivery",
    "codeJobChangePackageDispatcher",
  ]) {
    assert.equal(privateName in application, false);
  }

  await application.close();
});

test("local code execution fails closed when unified memory is disabled", async () => {
  const config = localCodeCoordinationConfig({ githubActions: false });
  config.memory.enabled = false;
  const calls = {};
  const closeCalls = [];
  let codeJobCalls = 0;

  await assert.rejects(
    createApplication({
      config,
      store: memoryStore(),
      codeExecutorRuntimeFactory: async () => ({
        authority: { workspaces: [] },
        executor: controlledCodeExecutorPort(),
        async close() {
          closeCalls.push("code-executor");
        },
      }),
      ...localCoordinationStubs({
        calls,
        closeCalls,
        runners: {
          "code-action-runner": { async claim() {}, async advance() {} },
        },
      }),
      codeJobRuntimeFactory: async () => {
        codeJobCalls += 1;
      },
    }),
    /需要启用统一记忆运行时/,
  );

  assert.equal(codeJobCalls, 0);
  assert.deepEqual(closeCalls, [
    "proposals",
    "attention",
    "ledger",
    "workflow",
    "code-executor",
  ]);
});

test("an injected application factory cannot delegate grant-free CLI construction to the shipped workforce", async () => {
  const config = workCoordinationConfig({ externalActions: false });
  config.brainProviders = { cli: { kind: "codex-cli" } };
  config.employees = { ...config.employees, roles: {} };
  const calls = {};
  const closeCalls = [];
  const stubs = localCoordinationStubs({ calls, closeCalls, runners: {} });
  const { configuredWorkforceFactory: _injectedWorkforce, ...runtimeStubs } = stubs;
  let receivedSymbolCount = null;

  await assert.rejects(
    createApplication({
      config,
      store: memoryStore(),
      versionedConfiguration: false,
      externalActions: false,
      ...runtimeStubs,
      configuredWorkforceFactory(options) {
        receivedSymbolCount = Object.getOwnPropertySymbols(
          options.dependencies,
        ).length;
        return createConfiguredWorkforce(options);
      },
      operationsRuntimeFactory: () => Object.freeze({}),
    }),
    /composition grant|composition authority/i,
  );
  assert.equal(receivedSymbolCount, 0);
});

test("default application composition supplies lexical authority for configured CLI providers", async () => {
  const config = workCoordinationConfig({ externalActions: false });
  config.brainProviders = { cli: { kind: "codex-cli" } };
  config.employees = { ...config.employees, roles: {} };
  const privateRuntimeDirectory = path.join(
    tmpdir(),
    "mydashboard-managed-cli-runtime-fixture",
  );
  const credentialRoot = path.join(
    tmpdir(),
    "mydashboard-managed-cli-credential-fixture",
  );
  const calls = {};
  const closeCalls = [];
  const stubs = localCoordinationStubs({ calls, closeCalls, runners: {} });
  const { configuredWorkforceFactory: _injectedWorkforce, ...runtimeStubs } = stubs;
  const application = await createApplication({
    config,
    store: memoryStore(),
    versionedConfiguration: false,
    externalActions: false,
    privateRuntimeDirectory,
    codexLoginLocationsFactory: () => ({
      sourceFile: path.join(credentialRoot, "auth.json"),
      mirrorRoot: path.join(privateRuntimeDirectory, "cli-credentials-v1"),
      mirrorDirectory: path.join(
        privateRuntimeDirectory,
        "cli-credentials-v1",
        "codex-login",
      ),
      probeRoot: path.join(privateRuntimeDirectory, "codex-login-probe-v1"),
    }),
    ...runtimeStubs,
    operationsRuntimeFactory: () => Object.freeze({}),
  });

  await application.close();
});

test("production composition shares one Codex login broker across every configured CLI route", async (t) => {
  if (process.platform !== "win32" || process.arch !== "x64") {
    t.skip("production supervised CLI composition is Windows x64 only");
    return;
  }
  const rawConfig = structuredClone(defaultCodeJobConfiguration());
  const loginBrain = {
    provider: "offline-cli",
    model: "fixed-login-model",
    remoteData: { requirements: true, code: true, memory: true },
  };
  rawConfig.brainProviders["offline-cli"].credentialMode = "codex-login";
  rawConfig.employees.roles.developer.enabled = true;
  rawConfig.employees.roles.developer.initialPaused = false;
  rawConfig.employees.roles.developer.brain = structuredClone(loginBrain);
  rawConfig.employees.roles.developer.taskBrain = structuredClone(loginBrain);
  rawConfig.memory.answering = {
    enabled: true,
    maximumRecords: 7,
    maximumContextBytes: 110_000,
    maximumConcurrent: 2,
    brain: structuredClone(loginBrain),
    localBrain: {
      provider: "ollama",
      model: "local-model",
      remoteData: { requirements: false, code: false, memory: false },
    },
  };
  const config = normalizeConfigurationDocument(rawConfig);
  const calls = {};
  const closeCalls = [];
  const lifecycle = createApplicationRuntimeLifecycle();
  const providerCloses = [];
  observeClose(
    t,
    SupervisedCliBrainProvider.prototype,
    "provider",
    providerCloses,
  );
  let brokerFactoryCalls = 0;
  let brokerRuntimeFacts = null;
  let memoryRouter = null;
  let statusCalls = 0;
  let acquireCalls = 0;
  const closeOrder = [];
  let providersClosedBeforeBroker = null;
  const unavailable = Object.assign(
    new Error("stable broker denial"),
    { code: "STRUCTURED_PROVIDER_CREDENTIAL_UNAVAILABLE", statusCode: 503 },
  );
  const broker = Object.freeze({
    async acquire() {
      acquireCalls += 1;
      throw unavailable;
    },
    async checkAvailability() {
      statusCalls += 1;
    },
    async readStatus() {
      statusCalls += 1;
      return Object.freeze({
        schemaVersion: 1,
        state: "available",
        cliAvailable: true,
        fileLoginAvailable: true,
      });
    },
    async close() {
      providersClosedBeforeBroker = providerCloses.length;
      closeOrder.push("broker");
    },
  });
  function inspectBrokerRuntimeFacts(runtimeFacts) {
    brokerRuntimeFacts = runtimeFacts;
    return runtimeFacts;
  }
  function brokerFactory(grant) {
    brokerFactoryCalls += 1;
    grant.consume(inspectBrokerRuntimeFacts);
    return broker;
  }
  const locations = Object.freeze({
    sourceFile: path.join(homedir(), ".codex", "auth.json"),
    mirrorRoot: path.join(homedir(), ".mydashboard-cli-credentials-v1"),
    mirrorDirectory: path.join(
      homedir(),
      ".mydashboard-cli-credentials-v1",
      "codex-login",
    ),
    probeRoot: path.join(homedir(), ".mydashboard-codex-login-probe-v1"),
  });
  const baseOptions = defaultCodeJobApplicationOptions({
    config,
    calls,
    closeCalls,
    lifecycle,
    versioned: false,
  });
  const {
    configuredWorkforceFactory: _injectedWorkforce,
    ...productionOptions
  } = baseOptions;
  const application = await createApplication({
    ...productionOptions,
    codexLoginCredentialBrokerFactory: brokerFactory,
    codexLoginLocationsFactory: () => locations,
    memoryContextRetrieverFactory: () => ({ async retrieve() {} }),
    memoryAnswerServiceFactory(options) {
      memoryRouter = options.brainRouter;
      return { async answer() {} };
    },
  });

  assert.equal(brokerFactoryCalls, 1);
  assert.deepEqual(Object.keys(brokerRuntimeFacts), ["protectedRoots"]);
  assert.equal(Object.isFrozen(brokerRuntimeFacts), true);
  assert.equal(Object.isFrozen(brokerRuntimeFacts.protectedRoots), true);
  assert.ok(brokerRuntimeFacts.protectedRoots.includes(path.resolve(".")));
  assert.deepEqual(Object.keys(application.brainProviderStatus), ["readStatus"]);
  assert.deepEqual(await application.brainProviderStatus.readStatus(), {
    schemaVersion: 1,
    state: "available",
    cliAvailable: true,
    fileLoginAvailable: true,
  });
  for (const privateName of [
    "codexLoginCredentialBroker",
    "codexLoginCredentialStore",
    "credentialLocations",
  ]) {
    assert.equal(privateName in application, false);
  }

  await memoryRouter.checkAvailability(loginBrain);
  await application.employeeRegistry
    .require("developer")
    .checkAvailability({});
  await assert.rejects(
    calls.codeJobRuntime.brainDirectory.decide(
      defaultCodeDecisionInput(),
      { beforeGenerate: async () => {} },
    ),
    { code: "STRUCTURED_PROVIDER_CREDENTIAL_UNAVAILABLE" },
  );
  assert.equal(statusCalls, 3);
  assert.equal(acquireCalls, 1);

  await application.close();
  assert.ok(providerCloses.length >= 3, providerCloses.length);
  assert.equal(providersClosedBeforeBroker, providerCloses.length);
  assert.deepEqual(closeOrder, ["broker"]);
});

test("native login diagnostics use the selected route even when the legacy broker is blocked", async () => {
  const rawConfig = structuredClone(defaultCodeJobConfiguration());
  rawConfig.brainProviders["offline-cli"].credentialMode = "codex-native-login";
  const config = normalizeConfigurationDocument(rawConfig);
  const calls = {};
  const closeCalls = [];
  const lifecycle = createApplicationRuntimeLifecycle();
  let legacyStatusCalls = 0;
  let nativeOptions;
  const nativeStatus = Object.freeze({
    schemaVersion: 1, state: "available", cliAvailable: true,
    fileLoginAvailable: true, credentialMode: "codex-native-login",
  });
  const application = await createApplication({
    ...defaultCodeJobApplicationOptions({ config, calls, closeCalls, lifecycle, versioned: false }),
    codexLoginCredentialBrokerFactory: () => ({
      async acquire() { throw new Error("legacy broker blocked"); },
      async checkAvailability() { throw new Error("legacy broker blocked"); },
      async readStatus() { legacyStatusCalls += 1; return { state: "broker_blocked" }; },
      async close() { closeCalls.push("legacy-broker"); },
    }),
    nativeCodexStatusProviderFactory: (options, grant) => {
      nativeOptions = options;
      const facts = grant.consume((value) => value);
      assert.ok(facts.protectedRoots.includes(path.resolve(".")));
      return {
        async readStatus() { return nativeStatus; },
        async close() { closeCalls.push("native-status"); },
      };
    },
  });
  assert.equal(nativeOptions.credentialMode, "codex-native-login");
  assert.equal(nativeOptions.cliKind, "codex-cli");
  assert.deepEqual(Object.keys(application.brainProviderStatus), ["readStatus"]);
  assert.deepEqual(await application.brainProviderStatus.readStatus(), nativeStatus);
  assert.equal(legacyStatusCalls, 0);
  await application.close();
  assert.ok(closeCalls.indexOf("native-status") < closeCalls.indexOf("legacy-broker"));
});

test("production native grants keep captured feedback read-only when automatic repair is disabled", async () => {
  const rawConfig = structuredClone(defaultCodeJobConfiguration());
  rawConfig.brainProviders["offline-cli"].credentialMode = "codex-native-login";
  const config = normalizeConfigurationDocument(rawConfig);
  const head = "a".repeat(40);
  const feedback = { changeRequests: [{ id: "original-review", author: "reviewer", body: "Keep unsaved edits",
    submittedAt: "2026-10-15T00:00:00.000Z", reviewedHeadRefOid: head }], threads: [] };
  const snapshot = createOriginalRepairFeedbackSnapshot({ repository: "acme/repo", number: 1,
    context: { schemaVersion: 1, headRefOid: head, reviewFeedbackDigest: ownReviewFeedbackDigest(feedback), feedback },
    provenance: { kind: "captured_before_repair", observedHeadRefOid: head, observedAt: "2026-10-15T00:00:00.000Z" } });
  let privateReader;
  let currentFeedbackReader;
  let feedbackWrites = 0;
  const application = await createApplication({
    ...defaultCodeJobApplicationOptions({ config, calls: {}, closeCalls: [],
      lifecycle: createApplicationRuntimeLifecycle(), versioned: false }),
    store: {
      async read(key, fallback) { return key === "automatic-own-pr-repair-state"
        ? structuredClone({ schemaVersion: 1, repairs: [], published: [], feedbackSnapshots: [snapshot] }) : fallback; },
      async write(key) { if (key === "automatic-own-pr-repair-state") feedbackWrites += 1; },
    },
    nativeCodexStatusProviderFactory(_options, grant) {
      const facts = grant.consume((value) => value);
      privateReader = facts.originalRepairFeedbackReader;
      currentFeedbackReader = facts.currentReviewFeedbackReader;
      assert.deepEqual(Object.keys(currentFeedbackReader), ["read"]);
      assert.equal(Object.isFrozen(currentFeedbackReader), true);
      assert.deepEqual(Object.keys(privateReader), ["read"]);
      assert.equal(Object.isFrozen(privateReader), true);
      return { async readStatus() { return { state: "available" }; }, async close() {} };
    },
  });
  try {
    assert.notEqual(config.githubActions?.automaticOwnPrRepair, true);
    assert.equal("originalRepairFeedbackReader" in application, false);
    assert.equal("currentReviewFeedbackReader" in application, false);
    const query = { snapshotId: snapshot.snapshotId, repository: snapshot.repository, number: snapshot.number,
      feedbackDigest: snapshot.feedbackDigest, originalHeadRefOid: snapshot.originalHeadRefOid };
    assert.deepEqual(await privateReader.read(query), snapshot);
    await assert.rejects(privateReader.read({ ...query, feedbackDigest: "0".repeat(64) }),
      { code: "OWN_PR_REPAIR_ORIGINAL_FEEDBACK_UNAVAILABLE" });
    assert.equal(feedbackWrites, 0);
  } finally { await application.close(); }
});

test("production composition factory carries real native completed reads into private durable proof", async t => {
  const gitTarget = { schemaVersion: 1, provider: "github", sourceAccountId: "reviewer", baseRepository: "acme/repo",
    headRepository: "acme/repo", baseRefName: "main", headRefName: "feature", baseRefOid: "a".repeat(40), headRefOid: "b".repeat(40) };
  const event = normalizeWorkflowEvent({ schemaVersion: 1, eventType: "pull_request.updated", occurredAt: "2026-11-09T01:00:00.000Z",
    source: { provider: "github", scopeId: "github-dashboard" }, subject: { id: "github:pr:acme/repo#42", repository: "acme/repo", number: 42 },
    payload: { relation: "review_requested", gitTarget, gitTargetAvailable: true, headRefOid: gitTarget.headRefOid } });
  const assignment = { assignmentId: "native-proof-assignment", eventId: event.eventId, target: { type: "role", id: "pr-engineer" } };
  const admitted = createPullRequestWorkSource({ sequence: 1, assignment, event });
  const item = { itemId: "native-proof-root", kind: "source_root", revision: 1, status: "working", sourceQuarantine: null,
    currentTarget: assignment.target, assignmentId: assignment.assignmentId, assignment, event, source: admitted.source,
    inputDigest: admitted.source.current.inputDigest, createdAt: event.occurredAt, activeIntentId: null,
    graph: { acceptanceContracts: [{ revision: 1, acceptanceCriteria: [], expectedDeliverables: [] }] } };
  const binding = currentWorkItemExecutionBinding(item);
  const facts = createPullRequestReadFacts({ identity: createPullRequestReadIdentity({ executionBinding: binding, event }),
    observedAt: "2026-11-09T01:01:00.000Z", reviewDecision: "REVIEW_REQUIRED", comments: [], reviews: [], reviewThreads: [], checks: [],
    truncation: { comments: false, reviews: false, reviewThreads: false, checks: false, byteBudget: false } });
  const store = storedValues({}), calls = {}, closeCalls = [];
  const rawConfig = structuredClone(defaultCodeJobConfiguration());
  rawConfig.brainProviders["offline-cli"].credentialMode = "codex-native-login";
  const appOptions = defaultCodeJobApplicationOptions({ config: normalizeConfigurationDocument(rawConfig), calls, closeCalls,
    lifecycle: createApplicationRuntimeLifecycle(), versioned: false });
  let productionFactory, factReads = 0, opened = 0, session;
  const application = await createApplication({ ...appOptions, store,
    async workLedgerRuntimeFactory(options) {
      const ledger = await appOptions.workLedgerRuntimeFactory(options);
      return { ...ledger, async readItemForReconciliation() { return item; },
        async readReviewAdoptionContext() { return { item, root: item, activeDispatch: null }; } };
    },
    prEngineerServiceFactory: () => ({ async recover() {}, async context() {}, async get() { return facts; },
      async refresh() { factReads++; return facts; } }),
    nativeCodexStatusProviderFactory(_options, grant) {
      const runtime = grant.consume(value => value);
      assert.deepEqual(Object.keys(runtime.currentReviewFeedbackReader), ["read"]);
      productionFactory = runtime.reviewReaderFactory;
      return { async readStatus() { return { state: "available" }; }, async close() {} };
    },
  });
  t.after(() => application.close());
  const skill = await loadNativeReviewSkill();
  const open = GitHubReviewReader.prototype.open;
  // Only the test harness replaces network I/O, after verifying that the actual
  // composition factory ignored all caller-supplied transport/source/policy.
  t.mock.method(GitHubReviewReader.prototype, "open", async function(target, options) {
    opened++;
    assert.equal(this.run, runJson);
    assert.deepEqual(options.skillDocuments, skill.documents);
    this.run = async (_command, args) => {
      const endpoint = args[3];
      if (endpoint === "user") return { login: "reviewer" };
      if (endpoint === "graphql") return { data: { repository: { nameWithOwner: "acme/repo", pullRequest: {
        number: 42, url: "https://github.com/acme/repo/pull/42", state: "OPEN", author: { login: "developer" }, changedFiles: 1,
        baseRefName: "main", baseRefOid: gitTarget.baseRefOid, headRefName: "feature", headRefOid: gitTarget.headRefOid,
        baseRef: { name: "main", repository: { nameWithOwner: "acme/repo" }, target: { oid: gitTarget.baseRefOid } },
        headRef: { name: "feature", repository: { nameWithOwner: "acme/repo" }, target: { oid: gitTarget.headRefOid } },
        headRepository: { nameWithOwner: "acme/repo" } } } } };
      if (endpoint === "repos/acme/repo/pulls/42/files?per_page=100") return [[{ filename: "src/app.js", status: "modified", additions: 1, deletions: 1 }]];
      if (endpoint === "repos/acme/repo/pulls/42") return { number: 42, title: "Qt Test", body: "", html_url: "https://github.com/acme/repo/pull/42",
        head: { sha: gitTarget.headRefOid }, base: { repo: { full_name: "acme/repo" } } };
      assert.fail(`Unexpected fixture endpoint: ${endpoint}`);
    };
    this.runText = async () => "diff --git a/src/app.js b/src/app.js\n-old\n+new\n";
    session = await Reflect.apply(open, this, [target, options]);
    return session;
  });
  const root = await mkdtemp(path.join(tmpdir(), "native-private-proof-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const home = path.join(root, "home"); await mkdir(home); await writeFile(path.join(home, "auth.json"), "offline-auth");
  const intent = { type: "propose_github_review", verdict: "approve", body: "Reviewed current code" };
  let sequence = 0;
  const provider = createNativeCodexBrainProvider({ id: "native-private-proof", cliKind: "codex-cli", credentialMode: "codex-native-login", timeoutMs: 3000 }, {
    environment: { ...process.env, CODEX_HOME: home, DIH_CODEX_NATIVE_TRANSPORT: "exec" }, temporaryRoot: path.join(root, "runtime"),
    commandLocator: { async resolve() { return { command: process.execPath, prefixArgs: [] }; } },
    rootDirectoryManager: { async prepare({ directory, validateLocation, signal }) {
      signal?.throwIfAborted(); await validateLocation(); await mkdir(directory, { recursive: true });
      const stat = await lstat(directory, { bigint: true });
      return { path: await realpath(directory), device: String(stat.dev), inode: String(stat.ino) };
    } },
    reviewReaderFactory: (target, options) => productionFactory(target, { ...options,
      run: () => assert.fail("Untrusted transport"), currentReviewFeedbackReader: { read() { assert.fail("Untrusted facts"); } },
      skillDocuments: { "review-skill/manifest.json": "forged" }, onCompleteReviewRead() { assert.fail("Untrusted completion callback"); } }),
    processRunner: { async run(invocation) {
      const rpc = async (method, params = {}) => {
        const response = await fetch(session.url, { method: "POST", headers: { "content-type": "application/json" },
          body: JSON.stringify({ jsonrpc: "2.0", id: ++sequence, method, params }) });
        return (await response.json()).result;
      };
      const tools = await rpc("tools/list");
      assert.deepEqual(tools.tools.map(value => value.name), ["read_document", "read_source", "list_directory"]);
      for (const document of tools.tools[0].inputSchema.properties.document.enum) {
        let offset = 0;
        do {
          const page = await rpc("tools/call", { name: "read_document", arguments: { document, offset } });
          assert.notEqual(page.isError, true);
          offset = JSON.parse(page.content[0].text).nextOffset;
        } while (offset !== null);
      }
      await writeFile(invocation.args[invocation.args.indexOf("--output-last-message") + 1], JSON.stringify({ result: JSON.stringify({ intent }) }));
      return { exitCode: 0, signal: null, stdout: "", stderr: "", stdoutBytes: Buffer.alloc(0), stderrBytes: Buffer.alloc(0) };
    } },
  });
  t.after(() => provider.close());
  const result = JSON.parse(await provider.generate({ model: "offline", reasoningEffort: "high", messages: [{ role: "user", content: "Review current code" }],
    schema: { type: "object", properties: { intent: { type: "object" } }, required: ["intent"], additionalProperties: false },
    reviewTarget: { gitTarget, pullRequestNumber: 42, feedbackSnapshot: { taskId: item.itemId, materialDigest: projectPullRequestReadFactsContext(facts).materialDigest } } }));
  assert.deepEqual(result.intent, intent);
  assert.equal(opened, 1); assert.ok(factReads >= 2);
  const persisted = await new ReviewPublicationAdoptionStore({ store }).readProofs();
  assert.equal(persisted.records.length, 1);
  assert.equal(persisted.records[0].producerTaskId, item.itemId);
  assert.equal(persisted.records[0].policyDigest, skill.digest);
});

test("application close stays bounded and incomplete while a configured provider activity never settles", async (t) => {
  const temporaryRoot = await mkdtemp(
    path.join(tmpdir(), "supervised-cli-application-close-"),
  );
  t.after(() => rm(temporaryRoot, { recursive: true, force: true }));
  let clockReads = 0;
  let processStarted;
  const started = new Promise((resolve) => { processStarted = resolve; });
  const provider = createTestSupervisedCliBrainProvider(
    {
      id: "cli",
      cliKind: "codex-cli",
      timeoutMs: 1_000,
      maxResponseBytes: 128 * 1024,
      maxRequestBytes: 256 * 1024,
    },
    {
      processRunner: {
        async run() {
          processStarted();
          return new Promise(() => {});
        },
      },
      commandLocator: {
        async resolve() {
          return Object.freeze({
            command: path.join(path.parse(process.cwd()).root, "fixture.exe"),
            prefixArgs: Object.freeze([]),
          });
        },
      },
      environment: { OPENAI_API_KEY: "credential" },
      temporaryRoot,
      monotonicClock: () => clockReads++ === 0 ? 0 : 600,
    },
  );
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const request = assert.rejects(
    provider.generate({
      model: "bounded-model",
      messages: [{ role: "user", content: "return JSON" }],
      schema: {
        type: "object",
        additionalProperties: false,
        required: ["ok"],
        properties: { ok: { type: "boolean" } },
      },
    }),
    { code: "STRUCTURED_PROVIDER_REAP_FAILED" },
  );
  try {
    const admission = await waitForCausalOutcome(
      [
        ["process-started", started],
        ["public-result", request],
      ],
      () => access(temporaryRoot),
      "configured provider runner admission",
    );
    if (admission.error) throw admission.error;
    assert.equal(admission.name, "process-started");
    t.mock.timers.runAll();
    const recovery = await waitForCausalOutcome(
      [["public-result", request]],
      async () => { t.mock.timers.runAll(); await access(temporaryRoot); },
      "configured provider bounded recovery deadline",
    );
    if (recovery.error) throw recovery.error;
  } finally {
    t.mock.timers.reset();
  }
  await within(250, request);

  const config = workCoordinationConfig({ externalActions: false });
  config.brainProviders = { cli: { kind: "codex-cli" } };
  config.employees = { ...config.employees, roles: {} };
  const calls = {};
  const closeCalls = [];
  const lifecycle = createApplicationRuntimeLifecycle();
  const application = await createApplication({
    config,
    store: memoryStore(),
    versionedConfiguration: false,
    externalActions: false,
    ...localCoordinationStubs({ calls, closeCalls, runners: {} }),
    configuredWorkforceFactory: (options) => createTestConfiguredWorkforce(
      options,
      { supervisedCliProviderFactory: () => provider },
    ),
    operationsRuntimeFactory: () => Object.freeze({}),
    runtimeLifecycle: lifecycle,
  });
  const closeFailure = await within(250, application.close()).then(
    () => null,
    (error) => error,
  );

  assert.equal(closeFailure?.code, "STRUCTURED_PROVIDER_CLEANUP_FAILED");
  const status = lifecycle.readStatus();
  assert.equal(status.complete, false);
  assert.ok(status.pendingRuntimes >= 1, status.pendingRuntimes);
  assert.strictEqual(status.failure, closeFailure);
});

test("application close stays bounded when a non-versioned Code Job CLI never settles", async (t) => {
  const temporaryRoot = await mkdtemp(
    path.join(tmpdir(), "supervised-cli-code-job-close-"),
  );
  t.after(() => rm(temporaryRoot, { recursive: true, force: true }));
  let clockReads = 0;
  let processStarted;
  const started = new Promise((resolve) => { processStarted = resolve; });
  const provider = createTestSupervisedCliBrainProvider(
    {
      id: "cli",
      cliKind: "codex-cli",
      timeoutMs: 1_000,
      maxResponseBytes: 128 * 1024,
      maxRequestBytes: 256 * 1024,
    },
    {
      processRunner: {
        async run() {
          processStarted();
          return new Promise(() => {});
        },
      },
      commandLocator: {
        async resolve() {
          return Object.freeze({
            command: path.join(path.parse(process.cwd()).root, "fixture.exe"),
            prefixArgs: Object.freeze([]),
          });
        },
      },
      environment: { OPENAI_API_KEY: "credential" },
      temporaryRoot,
      monotonicClock: () => clockReads++ === 0 ? 0 : 600,
    },
  );
  const config = localCodeCoordinationConfig({ githubActions: false });
  const directory = new CodeJobBrainDirectory({
    brainRouter: {
      generate({ brain, messages, schema, signal = null }) {
        return provider.generate({
          model: brain.model,
          messages,
          schema,
          ...(signal === null ? {} : { signal }),
        });
      },
      describe(brain) {
        return {
          provider: brain.provider,
          model: brain.model,
          remote: true,
          remoteData: structuredClone(brain.remoteData),
          singleAttempt: true,
        };
      },
      close: provider.close.bind(provider),
    },
    roles: config.employees.roles,
  });
  const calls = {};
  const closeCalls = [];
  const lifecycle = createApplicationRuntimeLifecycle();
  const application = await createApplication({
    config,
    versionedConfiguration: false,
    externalActions: true,
    store: memoryStore(),
    runtimeLifecycle: lifecycle,
    codeExecutorRuntimeFactory: async () => ({
      authority: { workspaces: [] },
      executor: controlledCodeExecutorPort(),
      async close() { closeCalls.push("code-executor"); },
    }),
    ...localCoordinationStubs({
      calls,
      closeCalls,
      runners: {
        "code-action-runner": { async claim() {}, async advance() {} },
      },
    }),
    codeJobGrantFactory: () => ({
      async create() {},
      verify(value) { return value; },
    }),
    codeJobBrainDirectoryFactory: () => directory,
    codeJobRuntimeFactory: async (options) => {
      calls.codeJobRuntime = options;
      return {
        confirmationExecutor: { async execute() {}, async reconcile() {} },
        reader: {
          async get() {},
          async getDetail() {},
          async list() {},
          async listNewest() {},
        },
        control: codeJobControlPort(),
        worker: codeJobWorkerPort(),
        projectionSource: codeJobProjectionSourcePort(),
        async close() { closeCalls.push("code-job"); },
      };
    },
    codeJobMemoryProjectorFactory: () => ({ async runCycle() {} }),
    codeActionProposalRunnerFactory: () => ({ async runCycle() {} }),
    confirmationRuntimeFactory: async () => ({
      queue: confirmationQueuePort(),
      memoryProjectionSource: confirmationMemoryProjectionSourcePort(),
      producerQueue: confirmationProducerPort(),
      async close() { closeCalls.push("confirmation"); },
    }),
    operationsRuntimeFactory: () => Object.freeze({}),
  });
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const decisionOutcome = calls.codeJobRuntime.brainDirectory.decide(
    {
      roleId: "developer",
      task: {
        operation: "modify",
        repository: "acme/repo",
        objective: "Prove bounded shutdown.",
        acceptanceCriteria: ["Application close remains bounded."],
        evidence: ["The local CLI process does not settle."],
      },
      capabilities: {
        allowedActions: ["read_text"],
        writablePaths: ["src"],
        requiredProfilesRemaining: 1,
      },
      turn: 1,
      observations: [],
    },
    { beforeGenerate: async () => {} },
  ).then(
    () => null,
    (error) => error,
  );
  try {
    const admission = await waitForCausalOutcome(
      [
        ["process-started", started],
        ["decision-outcome", decisionOutcome],
      ],
      () => access(temporaryRoot),
      "non-versioned Code Job runner admission",
    );
    if (admission.error) throw admission.error;
    assert.equal(
      admission.name,
      "process-started",
      admission.value?.stack,
    );
    t.mock.timers.runAll();
    const recovery = await waitForCausalOutcome(
      [["decision-outcome", decisionOutcome]],
      async () => { t.mock.timers.runAll(); await access(temporaryRoot); },
      "Code Job bounded recovery deadline",
    );
    if (recovery.error) throw recovery.error;
  } finally {
    t.mock.timers.reset();
  }
  assert.equal(
    (await within(500, decisionOutcome))?.code,
    "STRUCTURED_PROVIDER_REAP_FAILED",
  );

  const closeFailure = await within(250, application.close()).then(
    () => null,
    (error) => error,
  );
  assert.equal(closeFailure?.code, "STRUCTURED_PROVIDER_CLEANUP_FAILED");
  assert.equal(lifecycle.readStatus().complete, false);
});

async function assertDefaultCodeJobLifecycle(t, {
  versioned,
  postStart = async () => {},
}) {
  if (process.platform !== "win32" || process.arch !== "x64") {
    t.skip("production supervised CLI composition is Windows x64 only");
    return;
  }
  if (typeof postStart !== "function") {
    throw new TypeError("postStart is invalid");
  }
  const fixture = await createOfflineProductionCliFixture(
    t,
    versioned
      ? "versioned-default-code-job-cli"
      : "default-code-job-cli",
  );
  const config = defaultCodeJobConfiguration({ offlineCliTimeoutMs: 60_000 });
  // This fixture holds the real CLI until release to test lifecycle ownership.
  // Its settlement bound covers the request plus the provider's 30s recovery
  // window; provider deadline behavior has separate deterministic tests.
  const decisionSettlementBoundMs = 90_000;
  const calls = {};
  const closeCalls = [];
  const lifecycle = createApplicationRuntimeLifecycle();
  const observedCloses = [];
  let application = null;
  let decisionOutcome = null;
  let invocation = null;
  let released = false;
  fixture.registerTeardown(async () => {
    let teardownFailure = null;
    const attempt = async (operation) => {
      try {
        await operation();
      } catch (error) {
        teardownFailure ??= error;
      }
    };
    try {
      if (invocation !== null && !released) {
        await attempt(async () => {
          await fixture.release(invocation);
          released = true;
        });
      }
      if (decisionOutcome !== null) {
        await attempt(() => within(decisionSettlementBoundMs, decisionOutcome, "fixture teardown decision"));
      }
      if (application !== null) {
        let applicationCleanupFailure = null;
        for (
          let closeAttempt = 0;
          closeAttempt < 3 && !lifecycle.readStatus().complete;
          closeAttempt += 1
        ) {
          applicationCleanupFailure = await within(
            5_000,
            application.close(),
          ).then(
            () => null,
            (error) => error,
          );
        }
        if (!lifecycle.readStatus().complete) {
          teardownFailure ??= applicationCleanupFailure ??
            new Error("offline fixture application cleanup remained incomplete");
        }
      }
    } finally {
      t.mock.restoreAll();
    }
    if (teardownFailure) throw teardownFailure;
  });

  let operationFailure = null;
  try {
    observeClose(
      t,
      SupervisedCliBrainProvider.prototype,
      "provider",
      observedCloses,
    );
    observeClose(
      t,
      CodeJobBrainDirectory.prototype,
      "directory",
      observedCloses,
    );
    observeClose(
      t,
      VersionedCodeJobAuthority.prototype,
      "authority",
      observedCloses,
    );
    application = await createApplication(
      defaultCodeJobApplicationOptions({
        config,
        calls,
        closeCalls,
        lifecycle,
        versioned,
      }),
    );
    const previousInvocations = await fixture.invocationNames();
    const brainDigest = codeJobBrainDigest({
      roleId: "developer",
      taskBrain: config.employees.roles.developer.taskBrain,
      brainProviders: config.brainProviders,
    });
    decisionOutcome = calls.codeJobRuntime.brainDirectory.decide(
      defaultCodeDecisionInput(),
      {
        beforeGenerate: async () => {},
        brainDigest,
      },
    ).then(
      (value) => ({ value, error: null }),
      (error) => ({ value: null, error }),
    );
    const startController = new AbortController();
    let admission;
    try {
      admission = await Promise.race([
        fixture.waitForStart(previousInvocations, startController.signal).then(
          (startedInvocation) => ({
            invocation: startedInvocation,
            outcome: null,
          }),
        ),
        decisionOutcome.then((outcome) => ({ invocation: null, outcome })),
      ]);
    } finally {
      startController.abort();
    }
    invocation = admission.invocation;
    if (invocation !== null) {
      await postStart({
        application,
        decisionOutcome,
        fixture,
        invocation,
        lifecycle,
      });
    }
    assert.ok(invocation, admission.outcome?.error?.stack);

    const firstClose = application.close();
    assert.strictEqual(application.close(), firstClose);
    const firstFailure = await within(1_000, firstClose, "first application close").then(
      () => null,
      (error) => error,
    );
    assert.equal(firstFailure?.code, "STRUCTURED_PROVIDER_CLEANUP_FAILED");
    assert.equal(lifecycle.readStatus().complete, false);
    assert.deepEqual(
      observedCloses.map(({ label }) => label),
      versioned
        ? ["authority", "directory", "provider"]
        : ["directory", "provider"],
    );

    await fixture.release(invocation);
    released = true;
    const decision = await within(decisionSettlementBoundMs, decisionOutcome, "decision after release");
    if (versioned) {
      assert.equal(decision.error?.code, "INVALID_CODE_JOB_AUTHORITY");
    } else {
      assert.deepEqual(decision.value?.action, {
        type: "read_text",
        path: "src/app.js",
      });
    }

    const retry = application.close();
    assert.strictEqual(application.close(), retry);
    await within(1_000, retry, "retry application close");
    const countsAfterRecovery = observedCloses.length;
    await application.close();
    assert.equal(observedCloses.length, countsAfterRecovery);
    for (const label of [
      "provider",
      "directory",
      ...(versioned ? ["authority"] : []),
    ]) {
      const callsForOwner = observedCloses
        .filter((entry) => entry.label === label);
      assert.equal(callsForOwner.length, 2, label);
      assert.equal(
        new Set(callsForOwner.map(({ owner }) => owner)).size,
        1,
        label,
      );
    }
    assert.equal(lifecycle.readStatus().complete, true);
  } catch (error) {
    operationFailure = error;
  }

  let teardownFailure = null;
  try {
    await fixture.close();
  } catch (error) {
    teardownFailure = error;
  }
  if (operationFailure) throw operationFailure;
  if (teardownFailure) throw teardownFailure;
}

test("default non-versioned Code Job owns one real offline CLI lifecycle", async (t) => {
  await assertDefaultCodeJobLifecycle(t, { versioned: false });
});

test("default versioned Code Job owns one lazy real offline CLI lifecycle", async (t) => {
  await assertDefaultCodeJobLifecycle(t, { versioned: true });
});

test("real offline CLI teardown survives an injected post-start failure", async (t) => {
  if (process.platform !== "win32" || process.arch !== "x64") {
    t.skip("production supervised CLI composition is Windows x64 only");
    return;
  }
  const injectedFailure = new Error("injected post-start assertion failure");
  const environmentBefore = {
    path: process.env.PATH,
    credential: process.env.OPENAI_API_KEY,
    home: process.env.HOME,
    userProfile: process.env.USERPROFILE,
  };
  const originalProviderClose = SupervisedCliBrainProvider.prototype.close;
  const originalDirectoryClose = CodeJobBrainDirectory.prototype.close;
  const originalAuthorityClose = VersionedCodeJobAuthority.prototype.close;
  let fixtureRoot = null;
  let invocation = null;
  let processIds = [];
  let decisionOutcome = null;
  let lifecycle = null;

  const failure = await assertDefaultCodeJobLifecycle(t, {
    versioned: false,
    async postStart(context) {
      fixtureRoot = context.fixture.root;
      invocation = context.invocation;
      decisionOutcome = context.decisionOutcome;
      lifecycle = context.lifecycle;
      processIds = await context.fixture.runningProcessIds();
      assert.ok(processIds.length > 0, "the real fixture process was not observed");
      throw injectedFailure;
    },
  }).then(
    () => null,
    (error) => error,
  );

  assert.strictEqual(failure, injectedFailure);
  assert.notEqual(fixtureRoot, null);
  assert.notEqual(invocation, null);
  for (const processId of processIds) {
    assert.equal(processExists(processId), false, processId);
  }
  assert.equal(lifecycle.readStatus().complete, true);
  const settledDecision = await within(100, decisionOutcome);
  assert.equal(settledDecision.error, null, settledDecision.error?.stack);
  assert.deepEqual(settledDecision.value?.action, {
    type: "read_text",
    path: "src/app.js",
  });
  assert.strictEqual(
    SupervisedCliBrainProvider.prototype.close,
    originalProviderClose,
  );
  assert.strictEqual(
    CodeJobBrainDirectory.prototype.close,
    originalDirectoryClose,
  );
  assert.strictEqual(
    VersionedCodeJobAuthority.prototype.close,
    originalAuthorityClose,
  );
  assert.equal(process.env.PATH, environmentBefore.path);
  assert.equal(process.env.OPENAI_API_KEY, environmentBefore.credential);
  assert.equal(process.env.HOME, environmentBefore.home);
  assert.equal(process.env.USERPROFILE, environmentBefore.userProfile);
  await assert.rejects(access(invocation), { code: "ENOENT" });
  await assert.rejects(access(fixtureRoot), { code: "ENOENT" });
});

test("default Code Job startup failure preserves reverse cleanup evidence", async (t) => {
  for (const versioned of [false, true]) {
    const config = defaultCodeJobConfiguration();
    const calls = {};
    const closeCalls = [];
    const observedCloses = [];
    const lifecycle = createApplicationRuntimeLifecycle();
    const startupFailure = new Error(
      versioned
        ? "versioned startup failed after owner acquisition"
        : "startup failed after owner acquisition",
    );
    const cleanupFailure = new Error("memory cleanup failed once");
    const acquisitionStop = new Error("stop after lazy owner acquisition");
    let memoryCloseAttempts = 0;
    observeClose(
      t,
      SupervisedCliBrainProvider.prototype,
      versioned ? "versioned-provider" : "provider",
      observedCloses,
    );
    observeClose(
      t,
      CodeJobBrainDirectory.prototype,
      versioned ? "versioned-directory" : "directory",
      observedCloses,
    );
    if (versioned) {
      observeClose(
        t,
        VersionedCodeJobAuthority.prototype,
        "authority",
        observedCloses,
      );
    }
    const construction = createApplication(defaultCodeJobApplicationOptions({
      config,
      calls,
      closeCalls,
      lifecycle,
      versioned,
      codeJobRuntimeStarted: versioned
        ? async ({ brainDirectory }) => {
            const brainDigest = codeJobBrainDigest({
              roleId: "developer",
              taskBrain: config.employees.roles.developer.taskBrain,
              brainProviders: config.brainProviders,
            });
            await assert.rejects(
              brainDirectory.decide(defaultCodeDecisionInput(), {
                beforeGenerate: async () => { throw acquisitionStop; },
                brainDigest,
              }),
              (error) => error === acquisitionStop,
            );
          }
        : undefined,
      memoryRuntimeFactory: async () => ({
        producer: { async append() {}, async appendBatch() {} },
        lifecycleProducer: {
          async appendWorkItems() {},
          async appendGraphEvents() {},
          async appendProjectionRecords() {},
          async appendAuthorityProjection() {},
          async adoptGraphCheckpoint() {},
        },
        authorityReader: {
          async getAuthorityState() {},
          async getAuthorityProjectionState() {},
          requiresAuthorityProjectionCheckpoint() { return false; },
        },
        search: { async search() {}, async getHealth() {} },
        contextReader: { async readRecords() {} },
        receiptVerifier: { async verify(value) { return value; } },
        async close() {
          memoryCloseAttempts += 1;
          closeCalls.push("memory");
          if (memoryCloseAttempts === 1) throw cleanupFailure;
        },
      }),
      confirmationRuntimeFactory: async () => { throw startupFailure; },
    }));
    await assert.rejects(construction, (error) => error === startupFailure);
    await assert.rejects(lifecycle.close(), (error) => error === cleanupFailure);
    const failedStatus = lifecycle.readStatus();
    assert.strictEqual(failedStatus.failure, cleanupFailure);
    assert.deepEqual(failedStatus.failures, [cleanupFailure]);
    assert.equal(failedStatus.complete, false);
    await lifecycle.close();
    assert.equal(lifecycle.readStatus().complete, true);
    assert.equal(memoryCloseAttempts, 2);
    assert.deepEqual(
      observedCloses.map(({ label }) => label),
      versioned
        ? ["authority", "versioned-directory", "versioned-provider"]
        : ["directory", "provider"],
    );
    assert.deepEqual(closeCalls, [
      "code-job",
      "memory",
      "proposals",
      "attention",
      "ledger",
      "workflow",
      "code-executor",
      ...(versioned ? ["configuration"] : []),
      "memory",
    ]);
    t.mock.restoreAll();
  }
});

test("local code composition keeps CLI authority private from injected factories", async () => {
  const calls = {};
  const closeCalls = [];
  const workspaceRoot = path.join(process.cwd(), "workspace-acme");
  const configuredWorkspaceRoot = path.join(
    process.cwd(),
    "workspace-configured-only",
  );
  const config = localCodeCoordinationConfig();
  config.codeExecutor = {
    ...config.codeExecutor,
    workspaces: [{
      id: "configured-only",
      sourceRoot: configuredWorkspaceRoot,
    }],
    conflictPreparation: {
      enabled: true,
      baseMirrorsByRepository: { "acme/repo": "D:\\mirrors\\base.git" },
      headMirrorsByRepository: {
        "contributor/repo": "D:\\mirrors\\head.git",
      },
    },
  };
  const conflictPreparationVerifier = { async verify(value) { return value; } };
  const conflictExecutionSourcePreparer = { async prepare(value) { return value; } };
  const githubRunnerPort = { async claim() {}, async advance() {} };
  const codeRunnerPort = { async claim() {}, async advance() {} };
  const githubRunner = { id: "github-runner", async runCycle() {} };
  const codeRunner = { id: "code-runner", async runCycle() {} };
  const runnerGroup = { async runCycle() {} };
  const codeJobMemoryProjector = { async runCycle() {} };
  const localExecutor = { async execute() {}, async reconcile() {} };
  const codeJobReader = {
    async get(id) { return { id }; },
    async getDetail(value) { return { detail: value }; },
    async list(value) { return { value }; },
    async listNewest(value) { return { newest: value }; },
  };
  const executorAuthority = Object.freeze({
    workspaces: Object.freeze([
      Object.freeze({
        id: "acme-workspace",
        writablePaths: Object.freeze(["src"]),
        requiredProfiles: Object.freeze([
          Object.freeze({ id: "node-tests", configDigest: "a".repeat(64) }),
        ]),
        authorityDigest: "b".repeat(64),
        capabilities: Object.freeze(["conflict_preparation_snapshot"]),
      }),
    ]),
  });
  const application = await createApplication({
    config,
    store: memoryStore(),
    codeExecutorRuntimeFactory: async () => ({
      authority: executorAuthority,
      executor: controlledCodeExecutorPort(),
      changePackageTargets: [{
        workspaceId: "acme-workspace",
        sourceRoot: workspaceRoot,
      }],
      conflictPreparationVerifier,
      conflictExecutionSourcePreparer,
      async close() {
        closeCalls.push("code-executor");
      },
    }),
    ...localCoordinationStubs({
      calls,
      closeCalls,
      runners: {
        "github-review-runner": githubRunnerPort,
        "code-action-runner": codeRunnerPort,
      },
    }),
    codeJobRuntimeFactory: async (options) => {
      calls.codeJobRuntime = options;
      return {
        confirmationExecutor: localExecutor,
        reader: codeJobReader,
        control: codeJobControlPort(),
        worker: codeJobWorkerPort(),
        projectionSource: codeJobProjectionSourcePort(),
        async close() {
          closeCalls.push("code-job");
        },
      };
    },
    codeJobMemoryProjectorFactory: (options) => {
      calls.codeJobMemoryProjector = options;
      return codeJobMemoryProjector;
    },
    confirmationRuntimeFactory: async (_config, dependencies) => {
      calls.confirmation = dependencies;
      return {
        queue: confirmationQueuePort(),
        memoryProjectionSource: confirmationMemoryProjectionSourcePort(),
        producerQueue: confirmationProducerPort(),
        async close() {
          closeCalls.push("confirmation");
        },
      };
    },
    codeJobGrantFactory: (options) => {
      calls.grantFactory = options;
      return { async create() {}, verify(value) { return value; } };
    },
    codeJobBrainDirectoryFactory: (options) => {
      calls.codeBrainDirectory = options;
      return {
        async decide() {},
        async close() {
          closeCalls.push("code-brain");
        },
      };
    },
    githubReviewProposalRunnerFactory: (options) => {
      calls.githubRunner = options;
      return githubRunner;
    },
    codeActionProposalRunnerFactory: (options) => {
      calls.codeRunner = options;
      return codeRunner;
    },
    workProposalRunnerGroupFactory: (runners) => {
      calls.runnerGroup = runners;
      return runnerGroup;
    },
  });

  assert.deepEqual(calls.proposalRuntime.runnerScopes, [
    {
      runnerId: "github-review-runner",
      allowedKinds: ["github_review_proposal"],
      allowedRoleIds: ["pr-reviewer"],
    },
    {
      runnerId: "code-action-runner",
      allowedKinds: ["code_action_proposal"],
      allowedRoleIds: ["developer", "tester"],
    },
  ]);
  assert.strictEqual(calls.codeJobRuntime.store, application.store);
  assert.equal(Object.hasOwn(calls.codeRunner, "handlerTimeoutMs"), false);
  assert.equal(Object.isFrozen(calls.codeJobRuntime.executor), true);
  assert.deepEqual(Object.keys(calls.codeJobRuntime.executor).sort(), [
    "getActionResult",
    "perform",
    "reconcileAction",
    "reconcileCancellation",
    "resume",
    "start",
    "view",
  ]);
  assert.equal(Object.isFrozen(calls.codeJobRuntime.brainDirectory), true);
  assert.equal(Object.isFrozen(calls.codeJobRuntime.memoryReceiptVerifier), true);
  assert.deepEqual(
    Object.keys(calls.codeJobRuntime.memoryReceiptVerifier),
    ["verify"],
  );
  assert.deepEqual(calls.codeJobRuntime.workerLimits, {
    maxTurns: 64,
    observationLimit: 20,
  });
  assert.equal(Object.isFrozen(calls.confirmation.localExecutors), true);
  assert.deepEqual(Object.keys(calls.confirmation.localExecutors), [
    "local.code-job-create",
  ]);
  assert.equal(
    Object.isFrozen(
      calls.confirmation.localExecutors["local.code-job-create"],
    ),
    true,
  );
  assert.deepEqual(Object.keys(
    calls.confirmation.localExecutors["local.code-job-create"],
  ).sort(), [
    "execute",
    "reconcile",
  ]);
  assert.strictEqual(calls.grantFactory.executorAuthority, executorAuthority);
  assert.deepEqual(Object.keys(calls.grantFactory.conflictPreparationVerifier), [
    "verify",
  ]);
  assert.equal(Object.isFrozen(calls.grantFactory.conflictPreparationVerifier), true);
  assert.notStrictEqual(
    calls.grantFactory.conflictPreparationVerifier,
    conflictPreparationVerifier,
  );
  assert.deepEqual(
    Object.keys(calls.dispatcher.conflictExecutionSourcePreparer),
    ["prepare"],
  );
  assert.equal(
    Object.isFrozen(calls.dispatcher.conflictExecutionSourcePreparer),
    true,
  );
  assert.notStrictEqual(
    calls.dispatcher.conflictExecutionSourcePreparer,
    conflictExecutionSourcePreparer,
  );
  assert.equal(calls.grantFactory.policyVersion, 2);
  assert.deepEqual(calls.grantFactory.workspaceByRepository, {
    "acme/repo": "acme-workspace",
  });
  assert.deepEqual(calls.grantFactory.codeActionRoles, [
    "developer",
    "tester",
    "role-without-policy",
  ]);
  assert.deepEqual(calls.grantFactory.codeOperationsByRole, {
    developer: ["inspect", "modify", "verify"],
    tester: ["inspect", "verify"],
    "policy-only-role": ["inspect"],
  });
  assert.deepEqual(calls.grantFactory.taskBrainByRole, {
    developer:
      localCodeCoordinationConfig().employees.roles.developer.taskBrain,
    tester: localCodeCoordinationConfig().employees.roles.tester.taskBrain,
    "policy-only-role": null,
  });
  assert.deepEqual(
    calls.grantFactory.brainProviders,
    localCodeCoordinationConfig().brainProviders,
  );
  assert.equal(
    calls.workforce.dependencies.supervisedCliCompositionCapability,
    undefined,
  );
  assert.equal(
    calls.codeBrainDirectory.dependencies.supervisedCliCompositionCapability,
    undefined,
  );
  const workforceSymbols = Object.getOwnPropertySymbols(
    calls.workforce.dependencies,
  );
  const directorySymbols = Object.getOwnPropertySymbols(
    calls.codeBrainDirectory.dependencies,
  );
  assert.equal(workforceSymbols.length, 0);
  assert.equal(directorySymbols.length, 0);
  assert.strictEqual(calls.githubRunner.runner, githubRunnerPort);
  assert.strictEqual(calls.codeRunner.runner, codeRunnerPort);
  assert.strictEqual(
    calls.codeRunner.confirmationProducer,
    calls.githubRunner.confirmationProducer,
  );
  assert.equal(Object.isFrozen(calls.codeRunner.codeJobReader), true);
  assert.deepEqual(Object.keys(calls.codeRunner.codeJobReader).sort(), [
    "get",
    "getDetail",
    "list",
    "listNewest",
  ]);
  assert.strictEqual(
    calls.proposalResultReconciler.codeJobReader,
    calls.codeRunner.codeJobReader,
  );
  assert.equal(typeof calls.codeRunner.grantFactory.create, "function");
  assert.deepEqual(calls.runnerGroup, [githubRunner, codeRunner]);
  assert.strictEqual(calls.coordination.proposalRunner, runnerGroup);
  assert.equal(Object.isFrozen(calls.coordination.codeJobRunner), true);
  assert.equal(typeof calls.coordination.codeJobRunner.runCycle, "function");
  assert.equal(calls.coordination.codeJobLimit, 9);
  assert.equal(Object.isFrozen(calls.codeJobMemoryProjector.projectionSource), true);
  assert.deepEqual(
    Object.keys(calls.codeJobMemoryProjector.projectionSource).sort(),
    ["ack", "readBatch"],
  );
  assert.equal(Object.isFrozen(calls.codeJobMemoryProjector.memoryProducer), true);
  assert.deepEqual(
    Object.keys(calls.codeJobMemoryProjector.memoryProducer),
    ["appendBatch"],
  );
  assert.equal(Object.isFrozen(calls.coordination.codeJobMemoryProjector), true);
  assert.equal(
    typeof calls.coordination.codeJobMemoryProjector.runCycle,
    "function",
  );
  assert.equal(calls.coordination.codeJobMemoryLimit, 18);
  assert.equal("completedChangeExporter" in calls.codeJobRuntime, false);
  assert.equal("changePackageProducer" in calls.codeJobRuntime, false);
  assert.equal("changePackageReader" in calls.codeJobRuntime, false);
  assert.equal(calls.coordination.codeJobChangePackageDispatcher, null);

  assert.equal(Object.isFrozen(application.codeJobReader), true);
  assert.equal(Object.isFrozen(application.codeJobControl), true);
  assert.deepEqual(Object.keys(application.codeJobControl).sort(), [
    "cancel",
    "pause",
    "resume",
  ]);
  assert.deepEqual(Object.keys(application.codeJobReader).sort(), [
    "get",
    "getDetail",
    "list",
    "listNewest",
  ]);
  assert.deepEqual(await application.codeJobReader.get("job-1"), { id: "job-1" });
  assert.deepEqual(
    await application.codeJobReader.getDetail({ jobId: "job-1" }),
    { detail: { jobId: "job-1" } },
  );
  for (const privateName of [
    "codeJobRuntime",
    "codeJobStore",
    "codeJobExecutor",
    "codeJobWorker",
    "codeJobMemoryProjector",
    "projectionSource",
    "confirmationExecutor",
  ]) {
    assert.equal(privateName in application, false);
  }

  await application.close();
  assert.deepEqual(closeCalls, [
    "confirmation",
    "code-job",
    "code-brain",
    "memory",
    "proposals",
    "attention",
    "ledger",
    "workflow",
    "code-executor",
  ]);
});

test("local-only code actions create confirmation while maintenance keeps projection recovery", async () => {
  const calls = {};
  const closeCalls = [];
  const codeRunnerPort = { async claim() {}, async advance() {} };
  let codeJobCalls = 0;
  let confirmationCalls = 0;
  const baseOptions = {
    config: localCodeCoordinationConfig({ githubActions: false }),
    store: memoryStore(),
    codeExecutorRuntimeFactory: async () => ({
      authority: { workspaces: [] },
      executor: controlledCodeExecutorPort(),
      async close() {
        closeCalls.push("code-executor");
      },
    }),
    ...localCoordinationStubs({
      calls,
      closeCalls,
      runners: { "code-action-runner": codeRunnerPort },
    }),
    codeJobRuntimeFactory: async (options) => {
      codeJobCalls += 1;
      calls.codeJobRuntime = options;
      return {
        confirmationExecutor: { async execute() {}, async reconcile() {} },
        reader: {
          async get() {}, async getDetail() {}, async list() {}, async listNewest() {},
        },
        control: codeJobControlPort(),
        worker: codeJobWorkerPort(),
        projectionSource: codeJobProjectionSourcePort(),
        async close() {
          closeCalls.push("code-job");
        },
      };
    },
    confirmationRuntimeFactory: async () => {
      confirmationCalls += 1;
      return {
        queue: confirmationQueuePort(),
        memoryProjectionSource: confirmationMemoryProjectionSourcePort(),
        producerQueue: confirmationProducerPort(),
        async close() {
          closeCalls.push("confirmation");
        },
      };
    },
    codeJobGrantFactory: () => ({
      async create() {},
      verify(value) { return value; },
    }),
    codeActionProposalRunnerFactory: () => ({ async runCycle() {} }),
    workProposalRunnerGroupFactory: (runners) => runners[0] || null,
  };

  const application = await createApplication(baseOptions);
  assert.equal(codeJobCalls, 1);
  assert.equal(confirmationCalls, 1);
  assert.deepEqual(calls.proposalRuntime.runnerScopes, [
    {
      runnerId: "code-action-runner",
      allowedKinds: ["code_action_proposal"],
      allowedRoleIds: ["developer", "tester"],
    },
  ]);
  await application.close();

  codeJobCalls = 0;
  confirmationCalls = 0;
  const maintenance = await createApplication({
    ...baseOptions,
    externalActions: false,
  });
  assert.equal(codeJobCalls, 1);
  assert.equal(confirmationCalls, 0);
  assert.equal(Object.isFrozen(maintenance.codeJobReader), true);
  assert.equal(Object.isFrozen(maintenance.codeJobControl), true);
  assert.deepEqual(calls.proposalRuntime.runnerScopes, []);
  assert.equal(calls.coordination.codeJobRunner, null);
  assert.equal(
    typeof calls.coordination.codeJobMemoryProjector.runCycle,
    "function",
  );
  assert.equal("executor" in calls.codeJobRuntime, false);
  assert.equal("brainDirectory" in calls.codeJobRuntime, false);
  assert.equal("grantVerifier" in calls.codeJobRuntime, false);
  assert.equal("completedChangeExporter" in calls.codeJobRuntime, false);
  assert.equal("changePackageProducer" in calls.codeJobRuntime, false);
  assert.equal("changePackageReader" in calls.codeJobRuntime, false);
  assert.equal(calls.coordination.codeJobChangePackageDispatcher, null);
  await maintenance.close();
});

test("local composition constructs the real grant, handler, and runner group chain", async () => {
  const calls = {};
  const closeCalls = [];
  const authority = {
    workspaces: [
      {
        id: "acme-workspace",
        writablePaths: ["src"],
        requiredProfiles: [
          { id: "node-tests", configDigest: "a".repeat(64) },
        ],
        authorityDigest: "b".repeat(64),
      },
    ],
  };
  const application = await createApplication({
    config: localCodeCoordinationConfig({ githubActions: false }),
    store: memoryStore(),
    codeExecutorRuntimeFactory: async () => ({
      authority,
      executor: controlledCodeExecutorPort(),
    }),
    ...localCoordinationStubs({
      calls,
      closeCalls,
      runners: {
        "code-action-runner": { async claim() {}, async advance() {} },
      },
    }),
    codeJobRuntimeFactory: async () => ({
      confirmationExecutor: { async execute() {}, async reconcile() {} },
      reader: {
        async get() {}, async getDetail() {}, async list() {}, async listNewest() {},
      },
      control: codeJobControlPort(),
      worker: codeJobWorkerPort(),
      projectionSource: codeJobProjectionSourcePort(),
      async close() {},
    }),
    confirmationRuntimeFactory: async () => ({
      queue: confirmationQueuePort(),
      memoryProjectionSource: confirmationMemoryProjectionSourcePort(),
      producerQueue: confirmationProducerPort(),
      async close() {},
    }),
  });

  assert.equal(typeof calls.coordination.proposalRunner.runCycle, "function");
  assert.equal(Object.isFrozen(application.codeJobReader), true);
  await application.close();
});

test("confirmation startup failure closes the already acquired local code runtime in reverse order", async () => {
  const calls = {};
  const closeCalls = [];
  const startupFailure = new Error("confirmation startup failed");

  await assert.rejects(
    createApplication({
      config: localCodeCoordinationConfig({ githubActions: false }),
      store: memoryStore(),
      codeExecutorRuntimeFactory: async () => ({
        authority: { workspaces: [] },
        executor: controlledCodeExecutorPort(),
        async close() {
          closeCalls.push("code-executor");
        },
      }),
      ...localCoordinationStubs({
        calls,
        closeCalls,
        runners: {
          "code-action-runner": { async claim() {}, async advance() {} },
        },
      }),
      codeJobRuntimeFactory: async () => ({
        confirmationExecutor: { async execute() {}, async reconcile() {} },
        reader: {
          async get() {}, async getDetail() {}, async list() {}, async listNewest() {},
        },
        control: codeJobControlPort(),
        worker: codeJobWorkerPort(),
        projectionSource: codeJobProjectionSourcePort(),
        async close() {
          closeCalls.push("code-job");
        },
      }),
      codeJobGrantFactory: () => ({
        async create() {},
        verify(value) { return value; },
      }),
      confirmationRuntimeFactory: async () => {
        throw startupFailure;
      },
    }),
    (error) => error === startupFailure,
  );
  assert.deepEqual(closeCalls, [
    "code-job",
    "memory",
    "proposals",
    "attention",
    "ledger",
    "workflow",
    "code-executor",
  ]);
});

test("local code startup rejects an empty role-policy intersection before acquiring later guards", async () => {
  const config = localCodeCoordinationConfig({ githubActions: false });
  config.workCoordination.policy.codeActionRoles = ["role-without-policy"];
  const closeCalls = [];
  let codeJobCalls = 0;
  let confirmationCalls = 0;

  await assert.rejects(
    createApplication({
      config,
      store: memoryStore(),
      codeExecutorRuntimeFactory: async () => ({
        authority: { workspaces: [] },
        async close() {
          closeCalls.push("code-executor");
        },
      }),
      workflowRoutingRuntimeFactory: async () => ({
        async close() {
          closeCalls.push("workflow");
        },
      }),
      codeJobRuntimeFactory: async () => {
        codeJobCalls += 1;
      },
      confirmationRuntimeFactory: async () => {
        confirmationCalls += 1;
      },
    }),
    /没有同时满足岗位和操作策略的执行角色/,
  );
  assert.equal(codeJobCalls, 0);
  assert.equal(confirmationCalls, 0);
  assert.deepEqual(closeCalls, ["workflow", "code-executor"]);
});

test("versioned composition builds every subsystem from the stored active snapshot", async () => {
  const bootstrap = applicationConfig();
  const active = { ...applicationConfig(), refreshMinutes: 23 };
  const calls = [];
  const port = (methods) =>
    Object.freeze(
      Object.fromEntries(methods.map((name) => [name, async () => {}])),
    );
  const configurationRuntime = {
    startupConfiguration: active,
    status: Object.freeze({
      safeMode: false,
      activeVersion: 4,
      stateRevision: 9,
      migrationError: null,
    }),
    reader: port([
      "readSnapshot",
      "readActivationReconciliationSnapshot",
      "readActive",
      "readVersion",
      "readDraft",
      "readProjectionBatch",
    ]),
    draftManager: port([
      "createDraft",
      "createInitializationDraft",
      "reviseDraft",
    ]),
    simulator: port([
      "prepareInitialization",
      "prepareDraftActivation",
      "prepareRollback",
    ]),
    activationExecutor: port([
      "activateInitialization",
      "activateDraft",
      "activateRollback",
    ]),
    proposalPort: port([
      "createDraft",
      "createInitializationDraft",
      "reviseDraft",
    ]),
    async close() {
      calls.push("configuration-close");
    },
  };
  let activationOptions;
  let confirmationDependencies;
  let requesterOptions;

  const application = await createApplication({
    config: bootstrap,
    store: memoryStore(),
    versionedConfiguration: true,
    actionAdmissionGateFactory: () => new ActionAdmissionGate(),
    configurationRuntimeFactory: async (candidate, dependencies) => {
      calls.push({ candidate, dependencies });
      dependencies.actionAdmissionGate.bindEffective({
        version: 4,
        configurationDigest: "4".repeat(64),
      });
      return configurationRuntime;
    },
    configurationActivationExecutorFactory: (options) => {
      activationOptions = options;
      return { async execute() {}, async reconcile() {} };
    },
    confirmationRuntimeFactory: async (_config, dependencies) => {
      confirmationDependencies = dependencies;
      return {
        queue: confirmationQueuePort(),
        memoryProjectionSource: confirmationMemoryProjectionSourcePort(),
        producerQueue: confirmationProducerPort(),
        async close() {
          calls.push("confirmation-close");
        },
      };
    },
    configurationConfirmationRequesterFactory: (options) => {
      requesterOptions = options;
      return {
        async requestInitialization() {},
        async requestDraftActivation() {},
        async requestRollback() {},
      };
    },
  });

  assert.deepEqual(calls[0].candidate, bootstrap);
  assert.equal(calls[0].dependencies.store instanceof Object, true);
  assert.deepEqual(
    Object.keys(calls[0].dependencies.actionAdmissionGate).sort(),
    ["bindEffective", "cutover", "readStatus", "reconcileCutover", "run"],
  );
  assert.equal(
    Object.isFrozen(calls[0].dependencies.actionAdmissionGate),
    true,
  );
  assert.strictEqual(application.config, active);
  assert.equal(application.configuration.status.activeVersion, 4);
  assert.strictEqual(application.configuration.reader, configurationRuntime.reader);
  assert.strictEqual(
    application.configuration.proposalPort,
    configurationRuntime.proposalPort,
  );
  assert.deepEqual(
    Object.keys(application.configuration.confirmationRequester),
    ["requestDraftActivation", "requestRollback"],
  );
  assert.deepEqual(Object.keys(application.configuration.runtimeStatus), [
    "readStatus",
  ]);
  assert.deepEqual(activationOptions.allowedActionTypes, [
    "activate_draft",
    "activate_rollback",
  ]);
  assert.equal(Object.isFrozen(activationOptions.allowedActionTypes), true);
  assert.deepEqual(Object.keys(requesterOptions.simulator), [
    "prepareInitialization",
    "prepareDraftActivation",
    "prepareRollback",
  ]);
  assert.deepEqual(Object.keys(requesterOptions.confirmationProducer), [
    "enqueue",
  ]);
  assert.deepEqual(Object.keys(confirmationDependencies.localExecutors), [
    "local.configuration-activate",
  ]);
  assert.notEqual(application.confirmationQueue, null);
  assert.equal("activationExecutor" in application.configuration, false);

  await application.close();
  assert.equal(calls.at(-1), "configuration-close");
});

test("safe mode grants only initialization through the shared confirmation queue", async () => {
  const config = applicationConfig();
  const calls = {};
  const port = (methods) =>
    Object.freeze(
      Object.fromEntries(methods.map((name) => [name, async () => {}])),
    );
  const application = await createApplication({
    config,
    store: memoryStore(),
    versionedConfiguration: true,
    configurationRuntimeFactory: async () => ({
      startupConfiguration: config,
      status: {
        safeMode: true,
        activeVersion: null,
        stateRevision: 1,
        migrationError: null,
      },
      reader: port([
        "readSnapshot",
        "readActivationReconciliationSnapshot",
        "readActive",
        "readVersion",
        "readDraft",
        "readProjectionBatch",
      ]),
      draftManager: port([
        "createDraft",
        "createInitializationDraft",
        "reviseDraft",
      ]),
      simulator: port([
        "prepareInitialization",
        "prepareDraftActivation",
        "prepareRollback",
      ]),
      activationExecutor: port([
        "activateInitialization",
        "activateDraft",
        "activateRollback",
      ]),
      proposalPort: port([
        "createDraft",
        "createInitializationDraft",
        "reviseDraft",
      ]),
      async close() {},
    }),
    configurationActivationExecutorFactory: (options) => {
      calls.activationOptions = options;
      return { async execute() {}, async reconcile() {} };
    },
    confirmationRuntimeFactory: async (_config, dependencies) => {
      calls.confirmationDependencies = dependencies;
      return {
        queue: confirmationQueuePort(),
        producerQueue: confirmationProducerPort(),
        async close() {},
      };
    },
    configurationConfirmationRequesterFactory: (options) => {
      calls.requesterOptions = options;
      return {
        async requestInitialization() {},
        async requestDraftActivation() {},
        async requestRollback() {},
      };
    },
  });

  assert.deepEqual(calls.activationOptions.allowedActionTypes, [
    "initialize_from_draft",
  ]);
  assert.equal(Object.isFrozen(calls.activationOptions.allowedActionTypes), true);
  assert.deepEqual(Object.keys(calls.activationOptions.activationExecutor), [
    "activateInitialization",
    "activateDraft",
    "activateRollback",
  ]);
  assert.deepEqual(Object.keys(calls.activationOptions.configurationReader), [
    "readActivationReconciliationSnapshot",
  ]);
  assert.deepEqual(Object.keys(calls.activationOptions.actionAdmissionGate), [
    "cutover",
    "readStatus",
    "reconcileCutover",
  ]);
  assert.deepEqual(
    Object.keys(calls.confirmationDependencies.localExecutors),
    ["local.configuration-activate"],
  );
  assert.equal(
    Object.isFrozen(calls.confirmationDependencies.localExecutors),
    true,
  );
  assert.deepEqual(
    Object.keys(calls.confirmationDependencies.actionAdmissionGate),
    ["run"],
  );
  assert.deepEqual(
    Object.keys(application.configuration.confirmationRequester),
    ["requestInitialization"],
  );
  assert.deepEqual(Object.keys(calls.requesterOptions.simulator), [
    "prepareInitialization",
    "prepareDraftActivation",
    "prepareRollback",
  ]);
  assert.deepEqual(Object.keys(calls.requesterOptions.confirmationProducer), [
    "enqueue",
  ]);
  assert.equal("activationExecutor" in application.configuration, false);
  await application.close();
});

test("versioned maintenance mode does not construct configuration action authority", async () => {
  const config = applicationConfig();
  const port = (methods) =>
    Object.freeze(
      Object.fromEntries(methods.map((name) => [name, async () => {}])),
    );
  let activationExecutorCalls = 0;
  let confirmationRuntimeCalls = 0;
  const application = await createApplication({
    config,
    store: memoryStore(),
    versionedConfiguration: true,
    externalActions: false,
    configurationRuntimeFactory: async () => ({
      startupConfiguration: config,
      status: {
        safeMode: false,
        activeVersion: 1,
        stateRevision: 1,
        migrationError: null,
      },
      reader: port([
        "readSnapshot",
        "readActivationReconciliationSnapshot",
        "readActive",
        "readVersion",
        "readDraft",
        "readProjectionBatch",
      ]),
      draftManager: port([
        "createDraft",
        "createInitializationDraft",
        "reviseDraft",
      ]),
      simulator: port([
        "prepareInitialization",
        "prepareDraftActivation",
        "prepareRollback",
      ]),
      activationExecutor: port([
        "activateInitialization",
        "activateDraft",
        "activateRollback",
      ]),
      proposalPort: port([
        "createDraft",
        "createInitializationDraft",
        "reviseDraft",
      ]),
      async close() {},
    }),
    configurationActivationExecutorFactory: () => {
      activationExecutorCalls += 1;
      throw new Error("must not construct configuration action authority");
    },
    confirmationRuntimeFactory: async () => {
      confirmationRuntimeCalls += 1;
      throw new Error("must not construct confirmation runtime");
    },
  });

  assert.equal(activationExecutorCalls, 0);
  assert.equal(confirmationRuntimeCalls, 0);
  assert.equal(application.configuration.confirmationRequester, null);
  assert.equal(application.confirmationQueue, null);
  assert.equal("activationExecutor" in application.configuration, false);
  await application.close();
});

test("versioned local code shares one gate and reads Active authority", async () => {
  const baseConfig = localCodeCoordinationConfig({ githubActions: false });
  const answerBrain = {
    provider: "ollama",
    model: "memory-model",
    remoteData: { requirements: false, code: false, memory: false },
  };
  const config = {
    ...baseConfig,
    codeExecutor: {
      ...baseConfig.codeExecutor,
      conflictPreparation: {
        enabled: true,
        baseMirrorsByRepository: { "acme/repo": "D:\\mirrors\\base.git" },
        headMirrorsByRepository: {
          "contributor/repo": "D:\\mirrors\\head.git",
        },
      },
    },
    memory: {
      ...baseConfig.memory,
      answering: {
        enabled: true,
        maximumRecords: 10,
        maximumContextBytes: 100_000,
        maximumConcurrent: 1,
        brain: answerBrain,
        localBrain: answerBrain,
      },
    },
  };
  const calls = {};
  const closeCalls = [];
  const sharedGate = new ActionAdmissionGate();
  const configurationReader = {
    async readSnapshot() {},
    async readActivationReconciliationSnapshot() {},
    async readActive() {},
    async readVersion() {},
    async readDraft() {},
    async readProjectionBatch() {},
  };
  const versionedAuthority = {
    async create() {},
    async verify(value) {
      return value;
    },
    async decide() {},
    async close() {
      closeCalls.push("versioned-code-brain");
    },
  };
  const localExecutor = { async execute() {}, async reconcile() {} };
  const conflictPreparationVerifier = { async verify(value) { return value; } };
  const conflictExecutionSourcePreparer = { async prepare(value) { return value; } };

  const application = await createApplication({
    config,
    versionedConfiguration: true,
    store: memoryStore(),
    actionAdmissionGateFactory: () => sharedGate,
    workflowRoutingDependencies: {
      actionAdmissionGate: {
        run() { throw new Error("foreign workflow gate"); },
      },
    },
    workLedgerDependencies: {
      actionAdmissionGate: {
        run() { throw new Error("foreign ledger gate"); },
      },
    },
    workProposalDependencies: {
      actionAdmissionGate: {
        run() { throw new Error("foreign proposal gate"); },
      },
    },
    configurationRuntimeFactory: async (_candidate, dependencies) => {
      calls.configuration = dependencies;
      return {
        startupConfiguration: config,
        status: {
          safeMode: false,
          activeVersion: 1,
          stateRevision: 1,
          migrationError: null,
        },
        reader: configurationReader,
        draftManager: {
          async createDraft() {},
          async createInitializationDraft() {},
          async reviseDraft() {},
        },
        simulator: {
          async prepareInitialization() {},
          async prepareDraftActivation() {},
          async prepareRollback() {},
        },
        activationExecutor: {
          async activateInitialization() {},
          async activateDraft() {},
          async activateRollback() {},
        },
        proposalPort: {
          async createDraft() {},
          async createInitializationDraft() {},
          async reviseDraft() {},
        },
        async close() {
          closeCalls.push("configuration");
        },
      };
    },
    codeExecutorRuntimeFactory: async () => ({
      authority: {
        workspaces: [
          {
            id: "acme-workspace",
            writablePaths: ["src"],
            requiredProfiles: [
              { id: "node-tests", configDigest: "a".repeat(64) },
            ],
            authorityDigest: "b".repeat(64),
            capabilities: ["conflict_preparation_snapshot"],
          },
        ],
      },
      executor: controlledCodeExecutorPort(),
      conflictPreparationVerifier,
      conflictExecutionSourcePreparer,
      async close() {
        closeCalls.push("code-executor");
      },
    }),
    ...localCoordinationStubs({
      calls,
      closeCalls,
      runners: {
        "code-action-runner": { async claim() {}, async advance() {} },
      },
    }),
    versionedCodeJobAuthorityFactory: (options) => {
      calls.versionedAuthority = options;
      return versionedAuthority;
    },
    codeActionProposalRunnerFactory: (options) => {
      calls.codeRunner = options;
      return { async runCycle() {} };
    },
    codeJobRuntimeFactory: async (options) => {
      calls.codeJobRuntime = options;
      return {
        confirmationExecutor: localExecutor,
        reader: {
          async get() {},
          async getDetail() {},
          async list() {},
          async listNewest() {},
        },
        control: codeJobControlPort(),
        worker: codeJobWorkerPort(),
        projectionSource: codeJobProjectionSourcePort(),
        async close() {
          closeCalls.push("code-job");
        },
      };
    },
    memoryAnswerServiceFactory: (options) => {
      calls.memoryAnswer = options;
      return { async answer() {} };
    },
    confirmationRuntimeFactory: async (_config, dependencies) => {
      calls.confirmation = dependencies;
      return {
        queue: confirmationQueuePort(),
        memoryProjectionSource: confirmationMemoryProjectionSourcePort(),
        producerQueue: confirmationProducerPort(),
        async close() {
          closeCalls.push("confirmation");
        },
      };
    },
  });

  assert.notStrictEqual(
    calls.configuration.actionAdmissionGate,
    calls.codeJobRuntime.actionAdmissionGate,
  );
  assert.notStrictEqual(calls.configuration.actionAdmissionGate, sharedGate);
  assert.deepEqual(Object.keys(calls.codeJobRuntime.actionAdmissionGate), [
    "run",
  ]);
  assert.deepEqual(Object.keys(calls.versionedAuthority.actionAdmissionGate), [
    "run",
  ]);
  assert.deepEqual(Object.keys(calls.workflowRuntime.actionAdmissionGate), [
    "run",
  ]);
  assert.deepEqual(Object.keys(calls.ledgerRuntime.actionAdmissionGate), [
    "run",
  ]);
  assert.deepEqual(Object.keys(calls.proposalRuntime.actionAdmissionGate), [
    "run",
  ]);
  assert.deepEqual(Object.keys(calls.dispatcher.actionAdmissionGate), [
    "run",
  ]);
  assert.deepEqual(
    Object.keys(calls.orchestratorService.actionAdmissionGate),
    ["run"],
  );
  assert.deepEqual(Object.keys(calls.waker.actionAdmissionGate), ["run"]);
  assert.strictEqual(
    calls.workflowRuntime.actionAdmissionGate,
    calls.codeJobRuntime.actionAdmissionGate,
  );
  assert.strictEqual(
    calls.ledgerRuntime.actionAdmissionGate,
    calls.codeJobRuntime.actionAdmissionGate,
  );
  assert.strictEqual(
    calls.proposalRuntime.actionAdmissionGate,
    calls.codeJobRuntime.actionAdmissionGate,
  );
  assert.strictEqual(
    calls.dispatcher.actionAdmissionGate,
    calls.codeJobRuntime.actionAdmissionGate,
  );
  assert.strictEqual(
    calls.orchestratorService.actionAdmissionGate,
    calls.codeJobRuntime.actionAdmissionGate,
  );
  assert.strictEqual(
    calls.waker.actionAdmissionGate,
    calls.codeJobRuntime.actionAdmissionGate,
  );
  assert.strictEqual(
    calls.codeJobRuntime.actionAdmissionGate,
    calls.versionedAuthority.actionAdmissionGate,
  );
  assert.strictEqual(
    calls.workforce.actionAdmissionGate,
    calls.codeJobRuntime.actionAdmissionGate,
  );
  assert.strictEqual(
    calls.memoryAnswer.actionAdmissionGate,
    calls.codeJobRuntime.actionAdmissionGate,
  );
  assert.strictEqual(
    calls.versionedAuthority.configurationReader,
    configurationReader,
  );
  assert.deepEqual(
    Object.keys(calls.versionedAuthority.conflictPreparationVerifier),
    ["verify"],
  );
  assert.equal(
    Object.isFrozen(calls.versionedAuthority.conflictPreparationVerifier),
    true,
  );
  assert.deepEqual(
    Object.keys(calls.dispatcher.conflictExecutionSourcePreparer),
    ["prepare"],
  );
  assert.equal(
    Object.isFrozen(calls.dispatcher.conflictExecutionSourcePreparer),
    true,
  );
  assert.equal(
    await calls.codeJobRuntime.grantVerifier.verify("sealed-grant"),
    "sealed-grant",
  );
  assert.strictEqual(calls.codeRunner.grantFactory, versionedAuthority);
  assert.deepEqual(Object.keys(calls.confirmation.localExecutors).sort(), [
    "local.code-job-create",
    "local.configuration-activate",
  ]);
  assert.deepEqual(Object.keys(calls.confirmation.actionAdmissionGate), [
    "run",
  ]);
  assert.equal("activationExecutor" in application.configuration, false);
  assert.deepEqual(
    Object.keys(application.configuration.confirmationRequester),
    ["requestDraftActivation", "requestRollback"],
  );

  await application.close();
  assert.equal(
    closeCalls.filter((entry) => entry === "versioned-code-brain").length,
    1,
  );
});
