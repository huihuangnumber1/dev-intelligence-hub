import path from "node:path";
import { types as utilTypes } from "node:util";
import {
  createProductionCodexLoginCredentialBroker,
} from "./adapters/codex-login-credential-broker.js";
import { DingTalkAdapter } from "./adapters/dingtalk-adapter.js";
import { GitHubAdapter } from "./adapters/github-adapter.js";
import { createProductionSupervisedCliBrainProvider } from "./adapters/supervised-cli-brain-provider.js";
import { AutomaticReviewPublisher } from "./services/automatic-review-publisher.js";
import { AutomaticOwnPrRepair } from "./services/automatic-own-pr-repair.js";
import { AutomaticLocalCodeAuthorization } from "./services/automatic-local-code-authorization.js";
import { AutomaticOwnPrHandoff } from "./services/automatic-own-pr-handoff.js";
import { WorkContinuationScheduler } from "./services/work-continuation-scheduler.js";
import { HistoricalControlledCommitReader } from "./services/historical-controlled-commit-reader.js";
import { ReviewRepairContextReader, normalizeReviewRepairFeedbackContext } from "./services/review-repair-context-reader.js";
import { CiRepairContextReader } from './services/ci-repair-context-reader.js';
import { isHeadRepairExecutionSource } from './domain/code-execution-source.js';
import { OriginalRepairFeedbackReader } from "./services/original-repair-feedback-reader.js";
import { OwnPrRepairObjectSync, OWN_PR_REPAIR_OBJECT_MAX_PREPARATION_MS } from "./adapters/own-pr-repair-object-sync.js";
import { createGitHubPullRequestActionTransport } from "./adapters/github-pull-request-action-transport.js";
import { createGhLoginCredentialSource } from "./adapters/gh-login-credential-source.js";
import { OllamaBrain } from "./adapters/ollama-brain.js";
import { RoutedDingTalkSummaryBrain } from "./adapters/routed-dingtalk-summary-brain.js";
import { OllamaPrEmployeeReviewer } from "./adapters/ollama-pr-employee-reviewer.js";
import { RoutedPrEmployeeReviewer } from "./adapters/routed-pr-employee-reviewer.js";
import { TokenEnvCredentialSource } from "./adapters/token-env-credential-source.js";
import { createAttentionInboxRuntime } from "./attention-inbox-runtime.js";
import { createChangePackageRuntime } from "./change-package-runtime.js";
import { createCodeExecutorRuntime } from "./code-executor-runtime.js";
import { createCodeJobRuntime } from "./code-job-runtime.js";
import { createConfirmationRuntime } from "./confirmation-runtime.js";
import { ReviewHandoffReconciler } from "./services/review-handoff-reconciler.js";
import { createConfigurationRuntime } from "./configuration-runtime.js";
import {
  productionCodexLoginLocations,
} from "./lib/codex-login-credential-store.js";
import { ActionAdmissionGate } from "./lib/action-admission-gate.js";
import { loadConfigBootstrap, projectRoot } from "./lib/config.js";
import { OperationQueue } from "./lib/operation-queue.js";
import { PRODUCTION_PRIVATE_DIRECTORY_MANAGER } from "./lib/private-directory-manager.js";
import { createJenkinsRuntime } from "./jenkins-runtime.js";
import { ProcessExclusiveGuard } from "./lib/process-exclusive-guard.js";
import {
  createProjectScopedGuardFactory,
  projectIdentityDigest,
} from "./lib/project-identity.js";
import { StateStore } from "./lib/state-store.js";
import { createMemoryRuntime } from "./memory-runtime.js";
import { createOperationsRuntime } from "./operations-runtime.js";
import {
  createLazyOwnerWorkRequestRuntime,
  createOwnerWorkRequestRuntime,
} from "./owner-work-request-runtime.js";
import { AttentionCoordinator } from "./services/attention-coordinator.js";
import { AttentionResultReconciler } from "./services/attention-result-reconciler.js";
import { ConfigurationActivationExecutor } from "./services/configuration-activation-executor.js";
import { ConfigurationConfirmationRequester } from "./services/configuration-confirmation-requester.js";
import { DeliveryEvidenceService } from "./services/delivery-evidence-service.js";
import { createDailyWorkLedgerView } from "./services/daily-work-ledger-view.js";
import { AutomaticOwnPrConflict } from "./services/automatic-own-pr-conflict.js";
import { NotificationService } from "./services/notification-service.js";
import { OwnerWorkRetryService } from "./services/owner-work-retry-service.js";
import { EmployeeRegistry } from "./services/employee-registry.js";
import {
  createConfiguredConstructionCleanupOwner,
  createConfiguredBrainRouter,
  createConfiguredWorkforce,
  readConfiguredConstructionCleanup,
} from "./services/configured-workforce.js";
import { CodeJobMemoryProjector } from "./services/code-job-memory-projector.js";
import { ObsoleteCodeJobSettler } from "./services/obsolete-code-job-settler.js";
import { githubEntitySessionKey } from "./lib/session-key.js";
import { CodeJobEvidenceReader } from "./services/code-job-evidence-reader.js";
import { ChangePackageApplicationResultReconciler } from "./services/change-package-application-result-reconciler.js";
import { MemoryProjector } from "./services/memory-projector.js";
import { MemoryAnswerService } from "./services/memory-answer-service.js";
import { MemoryContextRetriever } from "./services/memory-context-retriever.js";
import { AgentMemoryQueryService } from "./services/agent-memory-query-service.js";
import { LocalSessionImporter } from "./services/local-session-importer.js";
import { GitActivityImporter } from "./services/git-activity-importer.js";
import { ProactiveWorkLoop } from "./services/proactive-work-loop.js";
import { TaskRunRegistry } from './services/task-run-registry.js';
import { createTaskRunView } from './services/task-run-view.js';
import { createTaskRunSettler,canUseNativeStopEvidence } from './services/work-ledger-run-control.js';
import { OrchestratorService } from "./services/orchestrator-service.js";
import { RoleContextAssembler } from "./services/role-context-assembler.js";
import { FailedCodeJobContextReader } from "./services/failed-code-job-context-reader.js";
import { ProactivePrEmployeeService } from "./services/proactive-pr-employee.js";
import { PrEngineerService } from "./services/pr-engineer-service.js";
import { BoundReviewFeedbackReader } from "./services/bound-review-feedback-reader.js";
import { ReviewPublicationAdoptionStore } from "./services/published-review-adoption.js";
import { loadNativeReviewSkill } from "./lib/native-review-skill.js";
import { ReviewPublicationReuseService, createReviewAdoptionTaskReader } from "./services/review-publication-reuse-service.js";
import { readGitHubReviewFeedbackSnapshot } from "./adapters/github-review-feedback-snapshot.js";
import { GitHubReviewReader } from "./adapters/github-review-reader.js";
import { projectPullRequestReadFactsContext } from "./domain/pull-request-read-facts.js";
import { runJson } from "./lib/command-runner.js";
import { RefreshService } from "./services/refresh-service.js";
import { OwnPrRepairProgressReader } from "./services/own-pr-repair-progress-reader.js";
import { RoleWorkerDirectory } from "./services/role-worker-directory.js";
import { WorkConditionWaker } from "./services/work-condition-waker.js";
import { normalizeWorkCoordinationTiming } from "./services/work-coordination-timing.js";
import { WorkCoordinationService } from "./services/work-coordination-service.js";
import { createCodeActionProposalRunnerService } from "./services/code-action-proposal-handler.js";
import { createConfigurationChangeProposalRunnerService } from "./services/configuration-change-proposal-handler.js";
import { CodeJobGrantFactory } from "./services/code-job-grant-factory.js";
import { createConfiguredCodeJobBrainDirectory } from "./services/code-job-brain-directory.js";
import { createGitHubReviewProposalRunnerService } from "./services/github-review-proposal-handler.js";
import { createPullRequestExternalActionExecutor } from "./services/pull-request-external-action-executor.js";
import { createPullRequestExternalActionProposalRunnerService } from "./services/pull-request-external-action-handler.js";
import { WorkIntentDispatcher } from "./services/work-intent-dispatcher.js";
import { WorkProposalResultReconciler } from "./services/work-proposal-result-reconciler.js";
import { VersionedCodeJobAuthority } from "./services/versioned-code-job-authority.js";
import { createWorkIntentPolicy } from "./services/work-intent-policy.js";
import { createWorkProposalRunnerGroup } from "./services/work-proposal-runner-group.js";
import { WorkflowFactSource } from "./services/workflow-fact-source.js";
import { createWorkLedgerRuntime } from "./work-ledger-runtime.js";
import { createWorkProposalRuntime } from "./work-proposal-runtime.js";
import { createWorkflowRoutingRuntime } from "./workflow-routing-runtime.js";
import { createPrTriageWorkRequest } from "./domain/owner-work-request.js";
import { matchRetiredTriageSource } from './services/work-ledger-triage-retirement.js';
import { normalizeOwnerWorkRequestState } from './services/owner-work-request-state.js';
import { isAutomaticReviewExecution } from './domain/automatic-review-policy.js';
import { DEFAULT_ISSUE_ACTIVE_WINDOW_DAYS } from "./domain/prioritizer.js";
import { createPullRequestExecutionBinding, samePullRequestExecutionBinding } from "./domain/pull-request-execution-binding.js";
import { AutomaticReviewScopeExitReader } from "./services/automatic-review-scope-exit-reader.js";
import { AutomaticReviewReentryReader } from "./services/automatic-review-reentry-reader.js";
import { AutomaticHeadAncestryReader } from "./services/automatic-head-ancestry-reader.js";
import { AutomaticReviewTestingStopReader } from './services/automatic-review-testing-retirement.js';
import { AutomaticRoleHandoffReader } from "./services/automatic-role-handoff-reader.js";

const GITHUB_REVIEW_PROPOSAL_RUNNER_ID = "github-review-runner";
const GITHUB_PULL_REQUEST_ACTION_RUNNER_ID = "github-pr-action-runner";
const CODE_ACTION_PROPOSAL_RUNNER_ID = "code-action-runner";
const CONFIGURATION_CHANGE_PROPOSAL_RUNNER_ID = "configuration-change-runner";
const PR_ENGINEER_FACTS_GUARD_NAME = "mydashboard-pr-engineer-read-facts-v1";
const SUPERVISED_CLI_COMPOSITION_SECRET = Object.freeze({});
const SUPERVISED_CLI_COMPOSITION_GRANT = Symbol("supervisedCliCompositionGrant");
const defaultPrEngineerExclusiveGuardFactory = (options) =>
  new ProcessExclusiveGuard(options);
const defaultVersionedCodeJobAuthorityFactory = (options) =>
  new VersionedCodeJobAuthority(options);

export class ProductionCliCompositionGrant {
  #consumer = null;
  #runtimeFacts;

  constructor(secret, runtimeFacts) {
    if (secret !== SUPERVISED_CLI_COMPOSITION_SECRET) {
      throw new TypeError(
        "Production CLI composition grants cannot be constructed",
      );
    }
    this.#runtimeFacts = productionCliRuntimeFacts(runtimeFacts);
    Object.freeze(this);
  }

  static is(value) {
    return value !== null &&
      typeof value === "object" &&
      #runtimeFacts in value;
  }

  consume(consumer) {
    if (typeof consumer !== "function") {
      throw new TypeError("Production CLI composition consumer is invalid");
    }
    this.#consumer ??= consumer;
    if (this.#consumer !== consumer) {
      throw new TypeError("Production CLI composition grant is opaque");
    }
    return consumer(this.#runtimeFacts);
  }
}

export function createPrTriageHandoff(readOwnerWorkRequests, readWorkLedger = () => null) {
  if (typeof readOwnerWorkRequests !== "function") {
    throw new TypeError("PR triage handoff runtime reader is invalid");
  }
  return Object.freeze({
    async submit(input) {
      const runtime = readOwnerWorkRequests();
      if (!runtime || typeof runtime.submit !== "function") {
        throw Object.assign(new Error("PR triage handoff runtime is not ready"), {
          code: "PR_TRIAGE_HANDOFF_NOT_READY",
        });
      }
      const request = createPrTriageWorkRequest(input);
      if (input.targetRoleId === "pr-engineer" && input.gitTarget &&
          ["review", "rereview", "complete_review"].includes(input.nextAction)) {
        const ledger = readWorkLedger();
        if (ledger) {
          const existing = await ledger.readCurrentAutomaticReviewWork({ repository: input.repository,
            number: input.number, headRefOid: input.expectedHeadRefOid, gitTarget: input.gitTarget });
          if (existing !== null) return existing;
        }
      }
      return runtime.submit(request);
    },
  });
}
Object.freeze(ProductionCliCompositionGrant.prototype);
Object.freeze(ProductionCliCompositionGrant);

function issueProductionCliCompositionGrant(runtimeFacts) {
  return new ProductionCliCompositionGrant(
    SUPERVISED_CLI_COMPOSITION_SECRET,
    runtimeFacts,
  );
}

function scopedRuntimeDependencies(dependencies, createGuard) {
  if (
    dependencies !== null &&
    (typeof dependencies === "object" || typeof dependencies === "function") &&
    Object.hasOwn(dependencies, "createGuard")
  ) {
    return dependencies;
  }
  return { ...dependencies, createGuard };
}

function frozenPort(source, methods, name) {
  if (!source || methods.some((method) => typeof source[method] !== "function")) {
    throw new TypeError(`${name} is invalid`);
  }
  return Object.freeze(
    Object.fromEntries(
      methods.map((method) => [method, source[method].bind(source)]),
    ),
  );
}

function ownedExecutorPort(source, name) {
  if (
    !source ||
    ["execute", "reconcile", "close"].some(
      (method) => typeof source[method] !== "function",
    )
  ) {
    throw new TypeError(`${name} is invalid`);
  }
  const execute = source.execute.bind(source);
  const reconcile = source.reconcile.bind(source);
  const closeOwner = source.close.bind(source);
  let closeAttempt = null;
  return Object.freeze({
    execute: (...args) => execute(...args),
    reconcile: (...args) => reconcile(...args),
    close() {
      closeAttempt ??= Promise.resolve().then(closeOwner);
      return closeAttempt;
    },
  });
}

function distinctAbsolutePaths(values) {
  const result = [];
  const seen = new Set();
  for (const value of values) {
    if (typeof value !== "string" || !path.isAbsolute(value)) continue;
    const resolved = path.resolve(value);
    const key = process.platform === "win32"
      ? resolved.toLowerCase()
      : resolved;
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(resolved);
  }
  return Object.freeze(result);
}

function canonicalPath(value) {
  const resolved = path.resolve(value);
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

function pathsOverlap(left, right) {
  const canonicalLeft = canonicalPath(left);
  const canonicalRight = canonicalPath(right);
  const leftToRight = path.relative(canonicalLeft, canonicalRight);
  const rightToLeft = path.relative(canonicalRight, canonicalLeft);
  const contains = (relative) =>
    relative === "" ||
    (!path.isAbsolute(relative) &&
      !relative.startsWith(`..${path.sep}`) && relative !== "..");
  return contains(leftToRight) || contains(rightToLeft);
}

function assertGitHubRuntimeTemporaryRoot(runtimeTemporaryRoot, protectedRoots) {
  if (
    typeof runtimeTemporaryRoot !== "string" ||
    !path.isAbsolute(runtimeTemporaryRoot) ||
    protectedRoots.some((protectedRoot) =>
      pathsOverlap(runtimeTemporaryRoot, protectedRoot))
  ) {
    throw new Error(
      "GitHub runtime temporary root overlaps a protected root",
    );
  }
}

function githubCredentialSourceDependencies(value) {
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    utilTypes.isProxy(value) ||
    ![Object.prototype, null].includes(Object.getPrototypeOf(value))
  ) {
    throw new TypeError("GitHub credential source dependencies are invalid");
  }
  const allowed = new Set([
    "projectIdentity",
    "createTokenEnvCredentialSource",
    "createGhLoginCredentialSource",
    "privateDirectoryManager",
  ]);
  const result = {};
  for (const key of Reflect.ownKeys(value)) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (
      typeof key !== "string" ||
      !allowed.has(key) ||
      !descriptor?.enumerable ||
      !Object.hasOwn(descriptor, "value")
    ) {
      throw new TypeError("GitHub credential source dependencies are invalid");
    }
    result[key] = descriptor.value;
  }
  for (const name of [
    "projectIdentity",
    "createTokenEnvCredentialSource",
    "createGhLoginCredentialSource",
  ]) {
    if (result[name] !== undefined && typeof result[name] !== "function") {
      throw new TypeError("GitHub credential source dependencies are invalid");
    }
  }
  if (
    result.privateDirectoryManager !== undefined &&
    (
      result.privateDirectoryManager === null ||
      typeof result.privateDirectoryManager !== "object" ||
      utilTypes.isProxy(result.privateDirectoryManager) ||
      typeof result.privateDirectoryManager.prepare !== "function"
    )
  ) {
    throw new TypeError("GitHub credential source dependencies are invalid");
  }
  return Object.freeze(result);
}

function exactPreparedDirectoryIdentity(value, expectedPath) {
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    utilTypes.isProxy(value) ||
    !Object.isFrozen(value) ||
    ![Object.prototype, null].includes(Object.getPrototypeOf(value))
  ) {
    return false;
  }
  const keys = Reflect.ownKeys(value);
  if (
    keys.length !== 3 ||
    !["path", "device", "inode"].every((key) => keys.includes(key))
  ) {
    return false;
  }
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (
    keys.some((key) =>
      typeof key !== "string" ||
      !descriptors[key]?.enumerable ||
      !Object.hasOwn(descriptors[key], "value"))
  ) {
    return false;
  }
  return descriptors.path.value === expectedPath &&
    typeof descriptors.device.value === "string" &&
    /^[0-9]+$/u.test(descriptors.device.value) &&
    typeof descriptors.inode.value === "string" &&
    /^[0-9]+$/u.test(descriptors.inode.value);
}

export async function createConfiguredGitHubCredentialSource(
  {
    githubActions,
    projectRoot: configuredProjectRoot,
    privateRuntimeDirectory,
    protectedRoots,
  },
  rawDependencies = {},
) {
  const dependencies = githubCredentialSourceDependencies(rawDependencies);
  const createTokenEnvSource = dependencies.createTokenEnvCredentialSource ??
    ((options) => new TokenEnvCredentialSource(options));
  const createGhLoginSource = dependencies.createGhLoginCredentialSource ??
    createGhLoginCredentialSource;
  const privateDirectoryManager = dependencies.privateDirectoryManager ??
    PRODUCTION_PRIVATE_DIRECTORY_MANAGER;
  const projectIdentity = dependencies.projectIdentity ?? projectIdentityDigest;
  const credentialMode = githubActions.credentialMode ?? "token-env";
  if (credentialMode === "token-env") {
    return createTokenEnvSource({
      actorAccountId: githubActions.actorAccountId,
      tokenEnv: githubActions.tokenEnv,
    });
  }

  const digest = projectIdentity({ projectRoot: configuredProjectRoot });
  if (!/^[a-f0-9]{64}$/u.test(digest)) {
    throw new TypeError("GitHub credential project identity is invalid");
  }
  const resolvedPrivateRuntimeDirectory = typeof privateRuntimeDirectory === "string"
    ? path.resolve(privateRuntimeDirectory)
    : "";
  const privateRuntimeProjectDigest = path.basename(
    resolvedPrivateRuntimeDirectory,
  );
  if (
    typeof privateRuntimeDirectory !== "string" ||
    !path.isAbsolute(privateRuntimeDirectory) ||
    (process.platform === "win32"
      ? privateRuntimeProjectDigest.toLowerCase()
      : privateRuntimeProjectDigest) !== digest
  ) {
    throw new TypeError("GitHub project-private runtime directory is invalid");
  }
  const runtimeTemporaryRoot = path.join(
    resolvedPrivateRuntimeDirectory,
    "github-credentials-v1",
  );
  assertGitHubRuntimeTemporaryRoot(runtimeTemporaryRoot, protectedRoots);
  const preparedIdentity = await privateDirectoryManager.prepare({
    directory: runtimeTemporaryRoot,
    signal: null,
    validateLocation() {
      assertGitHubRuntimeTemporaryRoot(runtimeTemporaryRoot, protectedRoots);
    },
  });
  if (!exactPreparedDirectoryIdentity(preparedIdentity, runtimeTemporaryRoot)) {
    throw new Error(
      "GitHub runtime temporary root prepared identity is invalid",
    );
  }
  return await createGhLoginSource({
    actorAccountId: githubActions.actorAccountId,
    ghCommand: githubActions.ghCommand,
    runtimeTemporaryRoot,
    protectedRoots,
  });
}

function immutableGitHubActionsConfig(config) {
  const enabledActions = Array.isArray(config.enabledActions)
    ? Object.freeze([...config.enabledActions])
    : null;
  const networkEnv = Object.freeze({ ...(config.networkEnv || {}) });
  const credentialMode = config.credentialMode ?? "token-env";
  return Object.freeze({
    enabled: config.enabled === true,
    credentialMode,
    actorAccountId: config.actorAccountId,
    ...(credentialMode === "token-env" ? { tokenEnv: config.tokenEnv } : {}),
    ghCommand: config.ghCommand,
    networkEnv,
    ...(config.timeoutMs === undefined ? {} : { timeoutMs: config.timeoutMs }),
    ...(enabledActions === null ? {} : { enabledActions }),
  });
}

function productionCliRuntimeFacts(value) {
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    ![Object.prototype, null].includes(Object.getPrototypeOf(value))
  ) {
    throw new TypeError("Production CLI runtime facts are invalid");
  }
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const keys = Reflect.ownKeys(descriptors);
  const allowed = new Set([
    "protectedRoots",
    "codexLoginCredentialBroker",
    "supervisedCliTemporaryRoot",
    "originalRepairFeedbackReader",
    "currentReviewFeedbackReader",
    "reviewReaderFactory",
  ]);
  if (
    !Object.hasOwn(descriptors, "protectedRoots") ||
    keys.length < 1 ||
    keys.length > 6 ||
    keys.some(
      (key) =>
        typeof key !== "string" ||
        !allowed.has(key) ||
        !descriptors[key]?.enumerable ||
        !("value" in descriptors[key]),
    )
  ) {
    throw new TypeError("Production CLI runtime facts are invalid");
  }
  const protectedRoots = descriptors.protectedRoots.value;
  if (
    !Array.isArray(protectedRoots) ||
    protectedRoots.some(
      (entry) => typeof entry !== "string" || !path.isAbsolute(entry),
    )
  ) {
    throw new TypeError("Production CLI runtime facts are invalid");
  }
  const broker = descriptors.codexLoginCredentialBroker?.value;
  if (
    broker !== undefined &&
    (
      broker === null ||
      typeof broker !== "object" ||
      ["acquire", "checkAvailability", "readStatus", "close"].some(
        (method) => typeof broker[method] !== "function",
      )
    )
  ) {
    throw new TypeError("Production CLI runtime facts are invalid");
  }
  const supervisedCliTemporaryRoot =
    descriptors.supervisedCliTemporaryRoot?.value;
  if (
    supervisedCliTemporaryRoot !== undefined &&
    (
      typeof supervisedCliTemporaryRoot !== "string" ||
      !path.isAbsolute(supervisedCliTemporaryRoot)
    )
  ) {
    throw new TypeError("Production CLI runtime facts are invalid");
  }
  const feedbackReader = descriptors.originalRepairFeedbackReader?.value;
  if (feedbackReader !== undefined && typeof feedbackReader?.read !== "function") {
    throw new TypeError("Production CLI original feedback reader is invalid");
  }
  const currentFeedbackReader = descriptors.currentReviewFeedbackReader?.value;
  const reviewReaderFactory = descriptors.reviewReaderFactory?.value;
  if (reviewReaderFactory !== undefined && typeof reviewReaderFactory !== "function") throw new TypeError("Production review reader factory is invalid");
  return Object.freeze({
    protectedRoots: distinctAbsolutePaths(protectedRoots),
    ...(broker === undefined ? {} : { codexLoginCredentialBroker: broker }),
    ...(supervisedCliTemporaryRoot === undefined
      ? {}
      : { supervisedCliTemporaryRoot: path.resolve(supervisedCliTemporaryRoot) }),
    ...(feedbackReader === undefined ? {} : {
      originalRepairFeedbackReader: frozenPort(feedbackReader, ["read"], "originalRepairFeedbackReader"),
    }),
    ...(currentFeedbackReader === undefined ? {} : {
      currentReviewFeedbackReader: frozenPort(currentFeedbackReader, ["read"], "currentReviewFeedbackReader"),
    }),
    ...(reviewReaderFactory === undefined ? {} : { reviewReaderFactory }),
  });
}

function codexLoginProtectedRoots(value) {
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    ![Object.prototype, null].includes(Object.getPrototypeOf(value))
  ) {
    throw new TypeError("Codex login locations are invalid");
  }
  const fields = ["sourceFile", "mirrorRoot", "mirrorDirectory", "probeRoot"];
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (
    Reflect.ownKeys(descriptors).length !== fields.length ||
    fields.some(
      (field) =>
        !descriptors[field]?.enumerable ||
        !("value" in descriptors[field]) ||
        typeof descriptors[field].value !== "string" ||
        !path.isAbsolute(descriptors[field].value),
    )
  ) {
    throw new TypeError("Codex login locations are invalid");
  }
  return distinctAbsolutePaths([
    path.dirname(descriptors.sourceFile.value),
    descriptors.mirrorRoot.value,
    descriptors.mirrorDirectory.value,
    descriptors.probeRoot.value,
  ]);
}

function configuredRepositoryRoots(config) {
  const conflict = config.codeExecutor?.conflictPreparation;
  return [
    ...Object.values(conflict?.baseMirrorsByRepository || {}),
    ...Object.values(conflict?.headMirrorsByRepository || {}),
  ];
}

function supervisedCliProtectedRoots({
  storeDataDirectory,
  operationsDataDirectory,
  backupDirectory,
  codeExecutorRuntime,
  config,
}) {
  const runtimeWorkspaceRoots = Array.isArray(
    codeExecutorRuntime?.changePackageTargets,
  )
    ? codeExecutorRuntime.changePackageTargets.map((target) => target?.sourceRoot)
    : [];
  const configuredWorkspaceRoots = (config.codeExecutor?.workspaces || [])
    .map((workspace) =>
      typeof workspace?.sourceRoot === "string"
        ? path.resolve(projectRoot, workspace.sourceRoot)
        : null);
  return distinctAbsolutePaths([
    projectRoot,
    storeDataDirectory,
    operationsDataDirectory,
    backupDirectory,
    ...runtimeWorkspaceRoots,
    ...configuredWorkspaceRoots,
    ...configuredRepositoryRoots(config),
  ]);
}

export function createApplicationRuntimeLifecycle() {
  const runtimes = [];
  const runtimeOwners = new Set();
  const failures = [];
  let closeAttempt = null;
  let lastFailure = null;

  const close = () => {
    if (closeAttempt) return closeAttempt;
    const attempt = (async () => {
      let firstFailure = null;
      for (let index = runtimes.length - 1; index >= 0; index -= 1) {
        const runtime = runtimes[index];
        if (runtime.closed) continue;
        try {
          await runtime.close();
          runtime.closed = true;
        } catch (error) {
          failures.push(error);
          firstFailure ||= error;
        }
      }
      lastFailure = firstFailure;
      if (firstFailure) throw firstFailure;
    })();
    closeAttempt = attempt;
    void attempt.then(
      () => {
        if (closeAttempt === attempt) closeAttempt = null;
      },
      () => {
        if (closeAttempt === attempt) closeAttempt = null;
      },
    );
    return attempt;
  };

  return Object.freeze({
    track(runtime) {
      if (
        runtime &&
        typeof runtime.close === "function" &&
        !runtimeOwners.has(runtime)
      ) {
        runtimeOwners.add(runtime);
        runtimes.push({ close: runtime.close.bind(runtime), closed: false });
      }
      return runtime;
    },
    close,
    readStatus() {
      const pendingRuntimes = runtimes.filter(({ closed }) => !closed).length;
      return Object.freeze({
        acquiredRuntimes: runtimes.length,
        pendingRuntimes,
        complete: pendingRuntimes === 0,
        failure: lastFailure,
        failures: Object.freeze([...failures]),
      });
    },
  });
}

function codeActionRunnerRoles(policy = {}) {
  const declaredRoles = Array.isArray(policy.codeActionRoles)
    ? policy.codeActionRoles
    : [];
  const operationsByRole =
    policy.codeOperationsByRole &&
    typeof policy.codeOperationsByRole === "object" &&
    !Array.isArray(policy.codeOperationsByRole)
      ? policy.codeOperationsByRole
      : {};
  const eligibleRoles =
    declaredRoles.filter(
      (roleId) =>
        typeof roleId === "string" && Object.hasOwn(operationsByRole, roleId),
    );
  return [...new Set(eligibleRoles)];
}

function agentMemoryQueryRoleIds(roles = {}) {
  return Object.entries(roles)
    .filter(([, role]) =>
      Array.isArray(role?.permissions?.allowedIntents) &&
      role.permissions.allowedIntents.includes("query_memory")
    )
    .map(([roleId]) => roleId)
    .sort((left, right) => left.localeCompare(right, "en"));
}

function conflictPreparationPorts(config, runtime) {
  const configured =
    config?.enabled === true && config?.conflictPreparation?.enabled === true;
  const workspaces = Array.isArray(runtime?.authority?.workspaces)
    ? runtime.authority.workspaces
    : [];
  const advertises = (workspace) =>
    Array.isArray(workspace?.capabilities) &&
    workspace.capabilities.includes("conflict_preparation_snapshot");
  const anyAdvertised = workspaces.some(advertises);
  const allAdvertised = workspaces.length > 0 && workspaces.every(advertises);
  const verifierAvailable =
    typeof runtime?.conflictPreparationVerifier?.verify === "function";
  const preparerAvailable =
    typeof runtime?.conflictExecutionSourcePreparer?.prepare === "function";
  if (
    anyAdvertised !== allAdvertised ||
    configured !== allAdvertised ||
    configured !== verifierAvailable ||
    configured !== preparerAvailable
  ) {
    throw new Error(
      "Conflict preparation 配置、工作区能力和生产端口不一致",
    );
  }
  if (!configured) return Object.freeze({ verifier: null, preparer: null });
  return Object.freeze({
    verifier: frozenPort(
      runtime.conflictPreparationVerifier,
      ["verify"],
      "codeExecutorRuntime.conflictPreparationVerifier",
    ),
    preparer: frozenPort(
      runtime.conflictExecutionSourcePreparer,
      ["prepare"],
      "codeExecutorRuntime.conflictExecutionSourcePreparer",
    ),
  });
}

function taskBrainConfigurationsByRole(roles) {
  const configured =
    roles && typeof roles === "object" && !Array.isArray(roles) ? roles : {};
  return Object.fromEntries(
    Object.entries(configured).map(([roleId, role]) => [
      roleId,
      role?.taskBrain ?? null,
    ]),
  );
}

function staleChangePackageAuthority(message, { cause } = {}) {
  const error = new Error(message, cause === undefined ? {} : { cause });
  error.code = "CHANGE_PACKAGE_APPLICATION_STALE";
  return error;
}

async function verifyChangePackageApplicationAuthority({
  manifest,
  codeJobReader,
  inputAuthorityVerifier,
}) {
  if (codeJobReader === null) {
    throw staleChangePackageAuthority("变更包缺少可核验的来源代码任务");
  }
  const job = await codeJobReader.get(manifest.job.id);
  if (
    job === null ||
    job.jobId !== manifest.job.id ||
    job.status !== "completed" ||
    job.proposalId !== manifest.proposal.id ||
    job.proposalContentDigest !== manifest.proposal.contentDigest ||
    job.grantDigest !== manifest.grant.digest ||
    job.workspaceId !== manifest.workspace.id ||
    !Object.hasOwn(job, "inputBinding")
  ) {
    throw staleChangePackageAuthority("变更包来源代码任务绑定不匹配");
  }
  if (job.inputBinding === null) return true;
  if (job.inputBinding.schemaVersion !== 2 || inputAuthorityVerifier === null) {
    throw staleChangePackageAuthority("旧版 PR 变更包只能恢复已有结果");
  }
  let verified;
  try {
    verified = await inputAuthorityVerifier.verify(
      structuredClone(job.inputBinding),
    );
  } catch (cause) {
    throw staleChangePackageAuthority("PR 变更包来源授权已失效", { cause });
  }
  if (!samePullRequestExecutionBinding(verified, job.inputBinding)) {
    throw staleChangePackageAuthority("PR 变更包来源授权已变化");
  }
  return true;
}

export function createBrain(config = {}, dependencies = {}) {
  if (!config.enabled) return null;
  if (config.provider === "ollama") {
    const fallback = new OllamaBrain({
      ...config,
      ...(dependencies.fetch ? { fetch: dependencies.fetch } : {}),
      ...(dependencies.actionAdmissionGate === undefined
        ? {}
        : { actionAdmissionGate: dependencies.actionAdmissionGate }),
    });
    if (!config.primaryBrain) return fallback;
    return new RoutedDingTalkSummaryBrain({
      router: dependencies.router,
      primaryBrain: config.primaryBrain,
      allowRemoteDingTalkSummary: config.allowRemoteDingTalkSummary,
      fallback,
      timeoutMs: config.timeoutMs,
    });
  }
  throw new Error(`Unsupported brain provider: ${config.provider || "(empty)"}`);
}

export function createPrEmployeeReviewer(
  baseConfig = {},
  roleOverrides = {},
  dependencies = {},
) {
  const config = { ...baseConfig, ...roleOverrides };
  if (!config.enabled) return null;
  if (config.provider === "ollama") {
    const fallback = new OllamaPrEmployeeReviewer({
      ...config,
      ...(dependencies.fetch ? { fetch: dependencies.fetch } : {}),
      ...(dependencies.actionAdmissionGate === undefined
        ? {}
        : { actionAdmissionGate: dependencies.actionAdmissionGate }),
    });
    if (dependencies.primaryBrain && config.allowRemoteCodeContext !== true) {
      throw new Error("PR employee primary brain requires explicit remote code context authorization");
    }
    return dependencies.primaryBrain
      ? new RoutedPrEmployeeReviewer({ router: dependencies.router, primaryBrain: dependencies.primaryBrain,
          fallback, timeoutMs: config.timeoutMs, contextTokens: config.contextTokens ?? config.numCtx })
      : fallback;
  }
  throw new Error(
    `Unsupported PR employee brain provider: ${config.provider || "(empty)"}`,
  );
}

export function createEmployeeRegistry(employees = []) {
  return new EmployeeRegistry(employees.filter(Boolean));
}

export async function createApplication({
  config: suppliedConfig,
  store: suppliedStore,
  configurationRuntimeFactory = createConfigurationRuntime,
  configurationRuntimeDependencies = {},
  configurationActivationExecutorFactory = (options) =>
    new ConfigurationActivationExecutor(options),
  configurationConfirmationRequesterFactory = (options) =>
    new ConfigurationConfirmationRequester(options),
  actionAdmissionGateFactory = () => new ActionAdmissionGate(),
  configBootstrapLoader = loadConfigBootstrap,
  versionedConfiguration = suppliedConfig === undefined,
  codeExecutorRuntimeFactory = createCodeExecutorRuntime,
  codeExecutorDependencies = {},
  changePackageRuntimeFactory = createChangePackageRuntime,
  changePackageRuntimeDependencies = {},
  codeJobRuntimeFactory = createCodeJobRuntime,
  codeJobRuntimeDependencies = {},
  confirmationRuntimeFactory = createConfirmationRuntime,
  confirmationRuntimeDependencies = {},
  workflowRoutingRuntimeFactory = createWorkflowRoutingRuntime,
  workflowRoutingDependencies = {},
  ownerWorkRequestRuntimeFactory = createOwnerWorkRequestRuntime,
  ownerWorkRequestDependencies = {},
  workLedgerRuntimeFactory = createWorkLedgerRuntime,
  dailyWorkLedgerViewFactory = createDailyWorkLedgerView,
  workLedgerDependencies = {},
  ownerWorkRetryServiceFactory = (options) =>
    new OwnerWorkRetryService(options),
  attentionInboxRuntimeFactory = createAttentionInboxRuntime,
  attentionInboxDependencies = {},
  workProposalRuntimeFactory = createWorkProposalRuntime,
  workProposalDependencies = {},
  memoryRuntimeFactory = createMemoryRuntime,
  memoryRuntimeDependencies = {},
  operationsRuntimeFactory = createOperationsRuntime,
  operationsRuntimeDependencies = {},
  operationsOptions = {},
  memoryProjectorFactory = (options) => new MemoryProjector(options),
  memoryContextRetrieverFactory = (options) =>
    new MemoryContextRetriever(options),
  memoryAnswerServiceFactory = (options) => new MemoryAnswerService(options),
  agentMemoryQueryServiceFactory = (options) =>
    new AgentMemoryQueryService(options),
  memoryBrainRouterFactory = createConfiguredBrainRouter,
  dingTalkBrainRouterFactory = createConfiguredBrainRouter,
  prEmployeeBrainRouterFactory = createConfiguredBrainRouter,
  memoryAnswerDependencies = {},
  codexLoginCredentialBrokerFactory =
    createProductionCodexLoginCredentialBroker,
  codexLoginLocationsFactory = productionCodexLoginLocations,
  nativeCodexStatusProviderFactory = createProductionSupervisedCliBrainProvider,
  localSessionImporterFactory = (options) => new LocalSessionImporter(options),
  gitActivityImporterFactory = (options) => new GitActivityImporter(options),
  codeJobMemoryProjectorFactory = (options) =>
    new CodeJobMemoryProjector(options),
  codeJobEvidenceReaderFactory = (options) =>
    new CodeJobEvidenceReader(options),
  changePackageApplicationResultReconcilerFactory = (options) =>
    new ChangePackageApplicationResultReconciler(options),
  workIntentPolicyFactory = createWorkIntentPolicy,
  roleWorkerDirectoryFactory = (options) => new RoleWorkerDirectory(options),
  configuredWorkforceFactory = createConfiguredWorkforce,
  pullRequestFactsLoaderFactory = ({ github }) => github,
  prEngineerExclusiveGuardFactory = defaultPrEngineerExclusiveGuardFactory,
  prEngineerServiceFactory = (options) => new PrEngineerService(options),
  workflowFactSourceFactory = (options) => new WorkflowFactSource(options),
  attentionResultReconcilerFactory = (options) =>
    new AttentionResultReconciler(options),
  workProposalResultReconcilerFactory = (options) =>
    new WorkProposalResultReconciler(options),
  githubReviewProposalRunnerFactory =
    createGitHubReviewProposalRunnerService,
  pullRequestExternalActionExecutorFactory =
    createPullRequestExternalActionExecutor,
  pullRequestExternalActionTransportFactory =
    createGitHubPullRequestActionTransport,
  githubCredentialSourceFactory = createConfiguredGitHubCredentialSource,
  pullRequestExternalActionProposalRunnerFactory =
    createPullRequestExternalActionProposalRunnerService,
  pullRequestExternalActionDependencies = {},
  codeJobGrantFactory = (options) => new CodeJobGrantFactory(options),
  codeJobBrainDirectoryFactory = createConfiguredCodeJobBrainDirectory,
  versionedCodeJobAuthorityFactory = defaultVersionedCodeJobAuthorityFactory,
  codeActionProposalRunnerFactory =
    createCodeActionProposalRunnerService,
  configurationChangeProposalRunnerFactory =
    createConfigurationChangeProposalRunnerService,
  workProposalRunnerGroupFactory = createWorkProposalRunnerGroup,
  workConditionWakerFactory = (options) => new WorkConditionWaker(options),
  proactiveWorkLoopFactory = (options) => new ProactiveWorkLoop(options),
  roleContextAssemblerFactory = (options) =>
    new RoleContextAssembler(options),
  orchestratorServiceFactory = (options) => new OrchestratorService(options),
  deliveryEvidenceServiceFactory = (options) =>
    new DeliveryEvidenceService(options),
  workIntentDispatcherFactory = (options) =>
    new WorkIntentDispatcher(options),
  workCoordinationFactory = (options) =>
    new WorkCoordinationService(options),
  attentionCoordinatorFactory = (options) => new AttentionCoordinator(options),
  workCoordinationDependencies = {},
  externalActions = true,
  privateRuntimeDirectory = null,
  runtimeLifecycle: suppliedRuntimeLifecycle,
} = {}) {
  if (typeof versionedConfiguration !== "boolean") {
    throw new TypeError("versionedConfiguration must be a boolean");
  }
  if (typeof actionAdmissionGateFactory !== "function") {
    throw new TypeError("actionAdmissionGateFactory must be a function");
  }
  if (typeof versionedCodeJobAuthorityFactory !== "function") {
    throw new TypeError("versionedCodeJobAuthorityFactory must be a function");
  }
  if (typeof pullRequestFactsLoaderFactory !== "function") {
    throw new TypeError("pullRequestFactsLoaderFactory must be a function");
  }
  if (typeof prEngineerExclusiveGuardFactory !== "function") {
    throw new TypeError("prEngineerExclusiveGuardFactory must be a function");
  }
  if (typeof prEngineerServiceFactory !== "function") {
    throw new TypeError("prEngineerServiceFactory must be a function");
  }
  if (typeof pullRequestExternalActionExecutorFactory !== "function") {
    throw new TypeError(
      "pullRequestExternalActionExecutorFactory must be a function",
    );
  }
  if (typeof pullRequestExternalActionTransportFactory !== "function") {
    throw new TypeError(
      "pullRequestExternalActionTransportFactory must be a function",
    );
  }
  if (typeof githubCredentialSourceFactory !== "function") {
    throw new TypeError("githubCredentialSourceFactory must be a function");
  }
  if (typeof pullRequestExternalActionProposalRunnerFactory !== "function") {
    throw new TypeError(
      "pullRequestExternalActionProposalRunnerFactory must be a function",
    );
  }
  if (typeof configurationActivationExecutorFactory !== "function") {
    throw new TypeError(
      "configurationActivationExecutorFactory must be a function",
    );
  }
  if (typeof configurationConfirmationRequesterFactory !== "function") {
    throw new TypeError(
      "configurationConfirmationRequesterFactory must be a function",
    );
  }
  if (typeof operationsRuntimeFactory !== "function") {
    throw new TypeError("operationsRuntimeFactory must be a function");
  }
  if (typeof agentMemoryQueryServiceFactory !== "function") {
    throw new TypeError("agentMemoryQueryServiceFactory must be a function");
  }
  if (typeof ownerWorkRequestRuntimeFactory !== "function") {
    throw new TypeError("ownerWorkRequestRuntimeFactory must be a function");
  }
  if (typeof codexLoginCredentialBrokerFactory !== "function") {
    throw new TypeError("codexLoginCredentialBrokerFactory must be a function");
  }
  if (typeof codexLoginLocationsFactory !== "function") {
    throw new TypeError("codexLoginLocationsFactory must be a function");
  }
  if (typeof nativeCodexStatusProviderFactory !== "function") {
    throw new TypeError("nativeCodexStatusProviderFactory must be a function");
  }
  const scopedRuntimeGuardFactory = createProjectScopedGuardFactory({
    projectRoot,
  });
  const runtimeDependencies = (dependencies) =>
    scopedRuntimeDependencies(dependencies, scopedRuntimeGuardFactory);
  const effectivePrEngineerExclusiveGuardFactory =
    prEngineerExclusiveGuardFactory === defaultPrEngineerExclusiveGuardFactory
      ? scopedRuntimeGuardFactory
      : prEngineerExclusiveGuardFactory;
  const ownsRuntimeLifecycle = suppliedRuntimeLifecycle === undefined;
  const runtimeLifecycle = frozenPort(
    ownsRuntimeLifecycle
      ? createApplicationRuntimeLifecycle()
      : suppliedRuntimeLifecycle,
    ["track", "close", "readStatus"],
    "runtimeLifecycle",
  );
  const configuredConstructionCleanupOwner =
    createConfiguredConstructionCleanupOwner();
  const actionAdmissionGate = versionedConfiguration
    ? frozenPort(
        actionAdmissionGateFactory(),
        ["bindEffective", "cutover", "readStatus", "reconcileCutover", "run"],
        "actionAdmissionGate",
      )
    : null;
  const ordinaryActionAdmissionGate = actionAdmissionGate === null
    ? null
    : frozenPort(
        actionAdmissionGate,
        ["run"],
        "ordinary action admission gate",
      );
  const bootstrap = suppliedConfig === undefined
    ? await configBootstrapLoader()
    : {
        candidate: suppliedConfig,
        fallbackConfiguration: suppliedConfig,
        bootstrapError: null,
      };
  let config = bootstrap.candidate ?? bootstrap.fallbackConfiguration;
  const jenkinsRuntime = createJenkinsRuntime({ projectRoot, privateRuntimeDirectory });
  const store = suppliedStore || new StateStore(path.join(projectRoot, "data"));
  const configuredOperations =
    operationsOptions &&
    typeof operationsOptions === "object" &&
    !Array.isArray(operationsOptions)
      ? operationsOptions
      : {};
  const storeDataDirectory =
    typeof store.dataDirectory === "string" &&
      path.isAbsolute(store.dataDirectory)
      ? store.dataDirectory
      : path.join(projectRoot, "data");
  const dataDirectory = typeof configuredOperations.dataDirectory === "string"
    ? configuredOperations.dataDirectory
    : store instanceof StateStore &&
        typeof store.dataDirectory === "string" &&
        path.isAbsolute(store.dataDirectory)
      ? store.dataDirectory
      : path.join(projectRoot, "data");
  const backupDirectory =
    typeof configuredOperations.backupDirectory === "string"
      ? configuredOperations.backupDirectory
      : path.join(projectRoot, "backups");
  const operationQueue = new OperationQueue();
  const trackRuntime = runtimeLifecycle.track;
  let configurationRuntime = null;
  let configurationConfirmationRequester = null;
  let codeExecutorRuntime = null;
  let changePackageRuntime = null;
  let automaticOwnPrRepair = null;
  let automaticLocalCodeAuthorization = null;
  let localCodeProposalRecovery = null;
  let codeAuthorizationRoleRegistry = null;
  let automaticReviewScopeExitReader = null;
  let automaticReviewReentryReader = null;
  let automaticHeadAncestryReader = null;
  let automaticReviewTestingStopReader = null;
  let automaticRoleHandoffReader = null;
  let workflowRouting = null;
  let workLedgerRuntime = null;
  let hostContextRecoveryReader = null;
  let ciRepairContextReader = null;
  let workContinuationScheduler = null;
  const originalRepairFeedbackReader = new OriginalRepairFeedbackReader({
    store,
    executionContextReader: Object.freeze({
      readPullRequestExecutionContext(input) {
        if (!workLedgerRuntime) throw Object.assign(new Error("Original feedback authority is not ready"), {
          code: "OWN_PR_REPAIR_ORIGINAL_FEEDBACK_UNAVAILABLE",
        });
        return workLedgerRuntime.readPullRequestExecutionContext(input);
      },
    }),
  });
  let ownerWorkRetry = null;
  let ownerWorkRequests = null;
  let attentionInboxRuntime = null;
  let workProposalRuntime = null;
  let memoryRuntime = null;
  let memoryAnswer = null;
  let agentMemoryQueries = null;
  let codeJobRuntime = null;
  let confirmationRuntime = null;
  let pullRequestExternalActionExecutor = null;
  let pullRequestExternalActionExecutorOwned = false;
  let codeJobReader = null;
  let obsoleteCodeJobSettler = null;
  let inputAuthorityVerifier = null;
  let currentReviewFeedbackReader = null;
  let recordCompletedReviewRead = null;
  let reviewPublicationReuse = null;
  let codeJobDeliveryEvidenceReader = null;
  let codeJobControl = null;
  const taskRuns = new TaskRunRegistry({store,receiptStore:store,...(workCoordinationDependencies.clock ? {clock:workCoordinationDependencies.clock} : {}),
    verifyStopped: async () => {
      if (!canUseNativeStopEvidence(config.brainProviders)) return false;
      const evidence = await brainProviderStatus?.readStatus();
      return evidence?.credentialMode === 'codex-native-login' && evidence.state === 'available';
    },
    settleControl:(input) => createTaskRunSettler({ledger:workLedgerRuntime,codeJobReader,codeJobControl})(input)});
  let codeJobWorker = null;
  let codeJobExecution = null;
  let codeJobMemoryProjector = null;
  let codeJobEvidenceReader = null;
  let codeJobChangePackageDispatcher = null;
  let changePackageReader = null;
  let changePackageApplicationReader = null;
  let changePackageApplicationStatusReader = null;
  let changePackageApplicationResultReconciler = null;
  let changePackageApplicationResultBarrier = null;
  let changePackageApplicationRequester = null;
  let grantFactory = null;
  let cliCompositionCapability = null;
  let brainProviderStatus = null;
  const brainDependencies = (dependencies, trustedProductionFactory) => ({
    ...dependencies,
    ...(trustedProductionFactory
      ? { [SUPERVISED_CLI_COMPOSITION_GRANT]: cliCompositionCapability }
      : {}),
  });
  const applicationAuthorityVerifier = Object.freeze({
    verify: (manifest) => verifyChangePackageApplicationAuthority({
      manifest,
      codeJobReader,
      inputAuthorityVerifier,
    }),
  });
  try {
    if (versionedConfiguration) {
      configurationRuntime = trackRuntime(
        await configurationRuntimeFactory(bootstrap.candidate, {
          ...runtimeDependencies(configurationRuntimeDependencies),
          store,
          actionAdmissionGate,
          fallbackConfiguration: bootstrap.fallbackConfiguration,
          bootstrapError: bootstrap.bootstrapError,
        }),
      );
      if (!configurationRuntime?.startupConfiguration) {
        throw new Error("版本化配置运行时没有提供启动配置");
      }
      config = configurationRuntime.startupConfiguration;
    }
    const roleConfig = config.employees?.prReviewer || { enabled: false };
    const github = new GitHubAdapter({
      maxPatchCharacters: roleConfig.maxPatchCharacters,
      readIncomingReviews: Object.hasOwn(config.githubActions || {}, "automaticReview"),
      ...(workCoordinationDependencies.clock
        ? { clock: workCoordinationDependencies.clock }
        : {}),
    });
    const dingtalk = new DingTalkAdapter({ ownerLogin: config.githubLogin });
    let brain = null;
    codeExecutorRuntime = trackRuntime(
      await codeExecutorRuntimeFactory(config.codeExecutor, {
        ...codeExecutorDependencies,
        store,
      }),
    );
    const cliProtectedRoots = supervisedCliProtectedRoots({
      storeDataDirectory,
      operationsDataDirectory: dataDirectory,
      backupDirectory,
      codeExecutorRuntime,
      config,
    });
    const brokerCompositionGrant = issueProductionCliCompositionGrant({
      protectedRoots: cliProtectedRoots,
    });
    const codexLoginCredentialBroker = trackRuntime(frozenPort(
      await codexLoginCredentialBrokerFactory(brokerCompositionGrant),
      ["acquire", "checkAvailability", "readStatus", "close"],
      "codexLoginCredentialBroker",
    ));
    brainProviderStatus = frozenPort(
      codexLoginCredentialBroker,
      ["readStatus"],
      "brainProviderStatus",
    );
    const codexLoginLocations = codexLoginLocationsFactory();
    const credentialRoots = codexLoginProtectedRoots(codexLoginLocations);
    const cliAndCredentialProtectedRoots = distinctAbsolutePaths([
      ...cliProtectedRoots,
      ...credentialRoots,
    ]);
    const cliRuntimeFacts = {
      protectedRoots: cliAndCredentialProtectedRoots,
      codexLoginCredentialBroker,
      originalRepairFeedbackReader: frozenPort(originalRepairFeedbackReader, ["read"], "originalRepairFeedbackReader"),
      currentReviewFeedbackReader: Object.freeze({ async read(input, options) {
        if (currentReviewFeedbackReader === null) throw Object.assign(new Error("PR_REVIEW_READ_FEEDBACK_UNAVAILABLE"), { code: "PR_REVIEW_READ_FEEDBACK_UNAVAILABLE" });
        return currentReviewFeedbackReader.read(input, options);
      } }),
      // This closure fixes the transport, fact source and policy to host-owned
      // producers. Callers cannot submit coverage or substitute reader options.
      async reviewReaderFactory(target, { signal = null } = {}) {
        const skill = await loadNativeReviewSkill();
        return new GitHubReviewReader({ originalRepairFeedbackReader,
          currentReviewFeedbackReader: { async read(input, options) {
            if (currentReviewFeedbackReader === null) throw Object.assign(new Error("PR_REVIEW_READ_FEEDBACK_UNAVAILABLE"), { code: "PR_REVIEW_READ_FEEDBACK_UNAVAILABLE" });
            return currentReviewFeedbackReader.read(input, options);
          } }, onCompleteReviewRead: receipt => recordCompletedReviewRead?.(receipt),
        }).open(target, { signal, skillDocuments: skill.documents });
      },
      ...(typeof privateRuntimeDirectory === "string" &&
          path.isAbsolute(privateRuntimeDirectory) &&
          path.resolve(privateRuntimeDirectory) ===
            path.dirname(codexLoginLocations.probeRoot)
        ? {
            supervisedCliTemporaryRoot: path.join(
              path.resolve(privateRuntimeDirectory),
              "supervised-cli-v1",
            ),
          }
        : {}),
    };
    cliCompositionCapability = issueProductionCliCompositionGrant(cliRuntimeFacts);
    const nativeProviderConfiguration = Object.values(config.brainProviders || {}).find(
      (provider) => provider.kind === "codex-cli" && provider.credentialMode === "codex-native-login",
    );
    if (nativeProviderConfiguration) {
      const nativeStatus = trackRuntime(frozenPort(
        await nativeCodexStatusProviderFactory({
          id: "codex-native-readiness",
          cliKind: "codex-cli",
          credentialMode: "codex-native-login",
          ...(nativeProviderConfiguration.maxConcurrentTurns === undefined ? {} : {
            maxConcurrentTurns: nativeProviderConfiguration.maxConcurrentTurns,
          }),
          timeoutMs: 30_000,
        }, issueProductionCliCompositionGrant(cliRuntimeFacts)),
        ["readStatus", "close"],
        "nativeCodexStatusProvider",
      ));
      brainProviderStatus = frozenPort(nativeStatus, ["readStatus"], "brainProviderStatus");
    }
    if (config.brain?.primaryBrain) {
      const router = trackRuntime(dingTalkBrainRouterFactory({
        constructionCleanupOwner: configuredConstructionCleanupOwner,
        brainProviders: config.brainProviders || {},
        dependencies: brainDependencies({}, dingTalkBrainRouterFactory === createConfiguredBrainRouter),
      }));
      brain = createBrain(config.brain, {
        ...(ordinaryActionAdmissionGate === null ? {} : { actionAdmissionGate: ordinaryActionAdmissionGate }),
        router,
      });
    } else {
      brain = createBrain(
        config.brain,
        ordinaryActionAdmissionGate === null ? {} : { actionAdmissionGate: ordinaryActionAdmissionGate },
      );
    }
    const controlledConflictPorts = conflictPreparationPorts(
      config.codeExecutor,
      codeExecutorRuntime,
    );
    const changePackageActionsEnabled =
      externalActions && config.changePackages?.enabled === true;
    if (changePackageActionsEnabled) {
      if (!codeExecutorRuntime) {
        throw new Error("change package 应用需要可用的代码执行器运行时");
      }
      if (
        !Array.isArray(codeExecutorRuntime.changePackageTargets) ||
        codeExecutorRuntime.changePackageTargets.length === 0
      ) {
        throw new Error("代码执行器没有可用于 change package 的可信工作区");
      }
      changePackageRuntime = trackRuntime(
        await changePackageRuntimeFactory(config.changePackages, {
          ...runtimeDependencies(changePackageRuntimeDependencies),
          store,
          trustedTargets: codeExecutorRuntime.changePackageTargets,
          applicationAuthorityVerifier,
          ...(codeExecutorRuntime.controlledCommitBuilder == null
            ? {}
            : {
                controlledCommitBuilder: frozenPort(
                  codeExecutorRuntime.controlledCommitBuilder,
                  ["create", "find", "verify", ...(typeof Object.getOwnPropertyDescriptor(codeExecutorRuntime.controlledCommitBuilder, "readSealed")?.value === "function" ? ["readSealed"] : [])],
                  "codeExecutorRuntime.controlledCommitBuilder",
                ),
              }),
        }),
      );
      if (!changePackageRuntime) {
        throw new Error("change package 配置已启用但运行时不可用");
      }
      changePackageReader = frozenPort(
        changePackageRuntime.packageReader,
        ["get"],
        "changePackageRuntime.packageReader",
      );
      changePackageApplicationReader = frozenPort(
        changePackageRuntime.applicationReader,
        ["getResult"],
        "changePackageRuntime.applicationReader",
      );
      changePackageApplicationStatusReader = frozenPort(
        changePackageRuntime.applicationProjectionReader,
        ["getForJob"],
        "changePackageRuntime.applicationProjectionReader",
      );
    }
    workflowRouting = trackRuntime(
      await workflowRoutingRuntimeFactory(config, {
        ...runtimeDependencies(workflowRoutingDependencies),
        store,
        ...(config.githubActions?.enabled === true && config.githubActions.automaticOwnPrRepair === true ? {
          headAncestryReader: Object.freeze({ read: options => automaticHeadAncestryReader?.read(options) ?? [] }),
        } : {}),
        ...(config.githubActions?.enabled === true && config.githubActions.automaticReview === true ? {
          scopeExitRecoveryReader: Object.freeze({ async read(options) {
            if (!workLedgerRuntime) return [];
            automaticReviewScopeExitReader ??= new AutomaticReviewScopeExitReader({ ledger: workLedgerRuntime, github,
              account: config.githubActions.actorAccountId,
              ...(workCoordinationDependencies.clock ? { clock: workCoordinationDependencies.clock } : {}) });
            return automaticReviewScopeExitReader.read(options);
          } }),
        } : {}),
        ...(config.githubActions?.enabled === true &&
          (config.githubActions.automaticReview === true || config.githubActions.automaticOwnPrRepair === true) ? {
          scopeReentryReader: Object.freeze({ async read(options) {
            if (!workLedgerRuntime) return [];
            automaticReviewReentryReader ??= new AutomaticReviewReentryReader({ ledger: workLedgerRuntime,
              account: config.githubActions.actorAccountId, github,
              automaticReview: config.githubActions.automaticReview === true,
              automaticOwnPrRepair: config.githubActions.automaticOwnPrRepair === true });
            return automaticReviewReentryReader.read(options);
          } }),
        } : {}),
        ...(config.githubActions?.enabled === true && config.githubActions.automaticOwnPrRepair === true && config.workCoordination?.enabled === true ? {
          roleHandoffReader: Object.freeze({ async read(options) {
            if (!workLedgerRuntime) return [];
            automaticRoleHandoffReader ??= new AutomaticRoleHandoffReader({ ledger: workLedgerRuntime, github,
              account: config.githubActions.actorAccountId,
              ...(workCoordinationDependencies.clock ? { clock: workCoordinationDependencies.clock } : {}) });
            return automaticRoleHandoffReader.read(options);
          } }),
        } : {}),
        ...(ordinaryActionAdmissionGate === null
          ? {}
          : { actionAdmissionGate: ordinaryActionAdmissionGate }),
      }),
    );
    const coordinationConfig = config.workCoordination || {};
    const coordinationEnabled = coordinationConfig.enabled === true;
    const coordinationTiming = coordinationEnabled
      ? normalizeWorkCoordinationTiming(
          {
            leaseDurationMs: coordinationConfig.leaseDurationMs,
            resolveTimeoutMs: coordinationConfig.resolveTimeoutMs,
            decisionTimeoutMs: coordinationConfig.decisionTimeoutMs,
          },
          { roleContextEnabled: true },
        )
      : null;
    const configuredGithubActions = config.githubActions || {};
    const automaticCodeHandlerTimeoutMs = coordinationTiming === null ? null : Math.min(
      Math.max(30_000, 2 * (configuredGithubActions.timeoutMs ?? 60_000) +
        OWN_PR_REPAIR_OBJECT_MAX_PREPARATION_MS + coordinationTiming.resolveTimeoutMs),
      coordinationTiming.leaseDurationMs - coordinationTiming.evidenceMutationMarginMs,
    );
    const automaticObjectPreparationMs = coordinationTiming === null ? null : Math.max(1, Math.min(
      OWN_PR_REPAIR_OBJECT_MAX_PREPARATION_MS,
      automaticCodeHandlerTimeoutMs - 2 * (configuredGithubActions.timeoutMs ?? 60_000) -
        coordinationTiming.resolveTimeoutMs - coordinationTiming.evidenceMutationMarginMs,
    ));
    const explicitPullRequestActions = Array.isArray(
      configuredGithubActions.enabledActions,
    )
      ? [...configuredGithubActions.enabledActions]
      : [];
    const ownPrRepairEnabled = configuredGithubActions.automaticOwnPrRepair === true;
    const executablePullRequestActions = [...new Set([
      ...explicitPullRequestActions, ...(ownPrRepairEnabled ? ["push"] : []),
    ])];
    const githubProposalExecutionEnabled =
      coordinationEnabled &&
      externalActions &&
      configuredGithubActions.enabled === true &&
      (
        configuredGithubActions.enabledActions === undefined ||
        explicitPullRequestActions.includes("review")
      );
    const pullRequestExternalActionExecutionEnabled =
      coordinationEnabled &&
      externalActions &&
      configuredGithubActions.enabled === true &&
      executablePullRequestActions.length > 0;
    const githubReviewExecutionEnabled =
      externalActions &&
      configuredGithubActions.enabled === true &&
      (
        configuredGithubActions.enabledActions === undefined ||
        explicitPullRequestActions.includes("review")
      );
    const githubCredentialExecutionEnabled =
      githubReviewExecutionEnabled || pullRequestExternalActionExecutionEnabled;
    let githubCredentialSource = null;
    if (githubCredentialExecutionEnabled) {
      const activeGithubActions = immutableGitHubActionsConfig(
        configuredGithubActions,
      );
      githubCredentialSource = frozenPort(
        await githubCredentialSourceFactory({
          githubActions: activeGithubActions,
          projectRoot,
          privateRuntimeDirectory,
          protectedRoots: cliAndCredentialProtectedRoots,
        }),
        ["acquire"],
        "githubCredentialSource",
      );
    }
    const localCodeExecutionEnabled =
      coordinationEnabled && externalActions && Boolean(codeExecutorRuntime);
    const configurationChangeRoleIds = Array.isArray(
      coordinationConfig.policy?.configurationChangeRoles,
    )
      ? [...new Set(coordinationConfig.policy.configurationChangeRoles)]
      : [];
    const configurationProposalExecutionEnabled =
      coordinationEnabled &&
      externalActions &&
      versionedConfiguration &&
      configurationChangeRoleIds.length > 0;
    if (
      coordinationEnabled &&
      configurationChangeRoleIds.length > 0 &&
      (!externalActions || !versionedConfiguration)
    ) {
      throw new Error(
        "配置变更提案需要启用版本化配置与外部动作恢复边界",
      );
    }
    const codeJobChangePackageDeliveryEnabled =
      localCodeExecutionEnabled && changePackageActionsEnabled;
    const codeRunnerRoleIds = localCodeExecutionEnabled
      ? codeActionRunnerRoles(coordinationConfig.policy)
      : [];
    if (localCodeExecutionEnabled && codeRunnerRoleIds.length === 0) {
      throw new Error("本地代码工作提案没有同时满足岗位和操作策略的执行角色");
    }
    if (coordinationEnabled) {
      hostContextRecoveryReader = Object.freeze({
        withStoppedRuns: (control, operation) => taskRuns.withStoppedRuns(
          [control.run, ...(Object.hasOwn(control, "childRun") ? [control.childRun] : [])], operation),
        async read({ itemId, childItemId }) {
          const config = (await configurationRuntime?.reader?.readActive())?.configuration;
          const role = await codeAuthorizationRoleRegistry?.get("orchestrator")?.roleView();
          if (config?.githubActions?.enabled !== true || config.githubActions.automaticOwnPrRepair !== true ||
              config.workCoordination?.enabled !== true || role?.enabled !== true || role.paused === true) return null;
          if (childItemId) {
            const developer = await codeAuthorizationRoleRegistry?.get("developer")?.roleView();
            if (developer?.enabled !== true || developer.paused === true) return null;
          }
          try { return { actorAccountId: config.githubActions.actorAccountId, run: await taskRuns.get("work-item", itemId),
            ...(childItemId ? { childRun: await taskRuns.get("work-item", childItemId) } : {}) }; }
          catch (error) { if (error?.code === "TASK_RUN_NOT_FOUND") return null; throw error; }
        },
        async readCiMaterials({ itemId, inputBinding, event }) {
          if (!ciRepairContextReader || !await hostContextRecoveryReader.read({ itemId })) return null;
          try {
            const observed = await ciRepairContextReader.read({ inputBinding, event });
            const control = await hostContextRecoveryReader.read({ itemId });
            return observed?.ciEvidence && control ? { ...control, ciEvidence: observed.ciEvidence } : null;
          } catch (error) { if (error?.code === "CODE_CI_REPAIR_CONTEXT_UNAVAILABLE") return null; throw error; }
        },
        async readReviewDiagnostics({ itemId, childItemId, confirmationIds }) {
          if (!Array.isArray(confirmationIds) || confirmationIds.length < 1 || confirmationIds.length > 4 ||
              new Set(confirmationIds).size !== confirmationIds.length ||
              !confirmationIds.every(id => typeof id === "string" && /^confirmation-github-review-[a-f0-9]{64}$/.test(id)) ||
              typeof confirmationRuntime?.confirmationSettlementReader?.read !== "function") return null;
          const confirmations = await Promise.all(confirmationIds.map(confirmationId =>
            confirmationRuntime.confirmationSettlementReader.read({ confirmationId })));
          const config = (await configurationRuntime?.reader?.readActive())?.configuration;
          const roles = await Promise.all(["orchestrator", "pr-engineer"].map(id => codeAuthorizationRoleRegistry?.get(id)?.roleView()));
          if (config?.githubActions?.enabled !== true || config.githubActions.automaticReview !== true ||
              config.workCoordination?.enabled !== true || roles.some(role => role?.enabled !== true || role.paused === true)) return null;
          try { return { actorAccountId: config.githubActions.actorAccountId, confirmations,
            run: await taskRuns.get("work-item", itemId), childRun: await taskRuns.get("work-item", childItemId) }; }
          catch (error) { if (error?.code === "TASK_RUN_NOT_FOUND") return null; throw error; }
        },
        async readTriageRetirement(input) {
          const [employeeState, ownerState] = await Promise.all([
            store.read('pr-employee-state', null), store.read('owner-work-requests-v1', null),
          ]);
          if (!ownerState || !Array.isArray(employeeState?.jobs)) return null;
          const record = normalizeOwnerWorkRequestState(ownerState).records.find(row => row.workItemId === input.itemId);
          const jobs = employeeState.jobs.filter(job => job?.handoffWorkItemId === input.itemId &&
            matchRetiredTriageSource(input, record, job));
          if (jobs.length !== 1) return null;
          const control = await hostContextRecoveryReader.readReviewDiagnostics(input);
          if (!control || control.actorAccountId.toLowerCase() !== input.inputBinding.gitTarget.sourceAccountId.toLowerCase() ||
              typeof github.readIncomingReviewRequest !== 'function') return null;
          let incomingFacts;
          try { incomingFacts = await github.readIncomingReviewRequest({ repository: input.inputBinding.repository,
            number: input.inputBinding.pullRequestNumber, account: control.actorAccountId }); }
          catch { return null; }
          const queue = await store.read('confirmation-queue', null);
          if (!Array.isArray(queue?.items) || !Number.isSafeInteger(queue.revision)) return null;
          const publishedReviews = queue.items.filter(item => item?.status === 'completed' && isAutomaticReviewExecution(item) &&
            item.display?.payload?.target?.resourceId === `${input.inputBinding.repository}#${input.inputBinding.pullRequestNumber}` &&
            item.display.payload.target.version === input.inputBinding.headRefOid);
          if (publishedReviews.length === 0 || publishedReviews.length > 4) return null;
          return { ...control, ownerRecord: record, triageJob: jobs[0], incomingFacts,
            observedAt: new Date(workCoordinationDependencies.clock?.() ?? Date.now()).toISOString(),
            publishedReviews: publishedReviews.map(item => ({ queueRevision: queue.revision, item })) };
        },
      });
      workLedgerRuntime = trackRuntime(
        await workLedgerRuntimeFactory({
          ...runtimeDependencies(workLedgerDependencies),
          store,
          assignmentSource: workflowRouting,
          operationQueue: new OperationQueue(),
          hostContextRecoveryReader,
          ...(config.githubActions?.enabled === true && config.githubActions.automaticOwnPrRepair === true &&
            typeof github.readPullRequestRoleHandoffFacts === "function" && typeof github.isCommitAncestor === "function" ? {
            attachHostHeadAncestry: ports => {
              // Keep the producer and its writer capability inside composition.
              // No runtime/read-only/native/CLI facade receives either object.
              automaticHeadAncestryReader = new AutomaticHeadAncestryReader({
                ledger: Object.freeze({ readCandidates: ports.readCandidates, readItemForReconciliation: ports.readItemForReconciliation }),
                github: frozenPort(github, ["readPullRequestRoleHandoffFacts", "isCommitAncestor"], "Head ancestry GitHub reads"),
                record: ports.record, account: config.githubActions.actorAccountId,
                ...(workCoordinationDependencies.clock ? { clock: workCoordinationDependencies.clock } : {}),
              });
            },
          } : {}),
          confirmationSettlementReader: Object.freeze({
            read: (input) => confirmationRuntime?.confirmationSettlementReader?.read(input),
          }),
          obsoleteCodeJobSettler: Object.freeze({
            read: (input) => obsoleteCodeJobSettler?.read(input),
            settle: (input, options) => obsoleteCodeJobSettler?.settle(input, options) ?? null,
          }),
          ...(config.githubActions?.enabled === true && config.githubActions.automaticReview === true ? {
            reviewTestingRetirementReader: Object.freeze({ async read(candidate) {
              if (!codeJobReader || !codeJobControl || !taskRuns || !codeExecutorRuntime?.executor?.view) return null;
              automaticReviewTestingStopReader ??= new AutomaticReviewTestingStopReader({ codeJobs: codeJobReader,
                codeControl: codeJobControl, taskRuns, codeExecutor: codeExecutorRuntime.executor });
              return automaticReviewTestingStopReader.read(candidate);
            } }),
          } : {}),
          ...(ordinaryActionAdmissionGate === null
            ? {}
            : { actionAdmissionGate: ordinaryActionAdmissionGate }),
        }),
      );
      ownerWorkRetry = frozenPort(
        ownerWorkRetryServiceFactory({
          ledger: frozenPort(
            workLedgerRuntime,
            ["readItemForReconciliation", "transition"],
            "owner work retry ledger",
          ),
        }),
        ["retryDecisionExhaustion"],
        "owner work retry service",
      );
      attentionInboxRuntime = trackRuntime(
        await attentionInboxRuntimeFactory({
          ...runtimeDependencies(attentionInboxDependencies),
          store,
          operationQueue: new OperationQueue(),
          authority: workLedgerRuntime,
        }),
      );
      workProposalRuntime = trackRuntime(
        await workProposalRuntimeFactory({
          ...runtimeDependencies(workProposalDependencies),
          store,
          operationQueue: new OperationQueue(),
          runnerScopes: [
            ...(githubProposalExecutionEnabled
              ? [
                  {
                    runnerId: GITHUB_REVIEW_PROPOSAL_RUNNER_ID,
                    allowedKinds: ["github_review_proposal"],
                    allowedRoleIds:
                      coordinationConfig.policy?.githubReviewRoles || [],
                  },
                ]
              : []),
            ...(pullRequestExternalActionExecutionEnabled
              ? [
                  {
                    runnerId: GITHUB_PULL_REQUEST_ACTION_RUNNER_ID,
                    allowedKinds: ["github_pull_request_action_proposal"],
                    allowedRoleIds:
                      coordinationConfig.policy?.githubReviewRoles || [],
                  },
                ]
              : []),
            ...(localCodeExecutionEnabled
              ? [
                  {
                    runnerId: CODE_ACTION_PROPOSAL_RUNNER_ID,
                    allowedKinds: ["code_action_proposal"],
                    allowedRoleIds: codeRunnerRoleIds,
                  },
                ]
              : []),
            ...(configurationProposalExecutionEnabled
              ? [
                  {
                    runnerId: CONFIGURATION_CHANGE_PROPOSAL_RUNNER_ID,
                    allowedKinds: ["configuration_change_proposal"],
                    allowedRoleIds: configurationChangeRoleIds,
                  },
                ]
              : []),
          ],
          ...(ordinaryActionAdmissionGate === null
            ? {}
            : { actionAdmissionGate: ordinaryActionAdmissionGate }),
        }),
      );
    }
    const memoryEnabled = config.memory?.enabled === true;
    if (memoryEnabled) {
      const confirmationMemoryAuthorityRequired =
        githubProposalExecutionEnabled ||
        pullRequestExternalActionExecutionEnabled;
      memoryRuntime = trackRuntime(
        await memoryRuntimeFactory({
          ...runtimeDependencies(memoryRuntimeDependencies),
          store,
          operationQueue: new OperationQueue(),
          maximumRecords: config.memory.maximumRecords,
          maximumStateBytes: config.memory.maximumStateBytes,
          ...(workLedgerRuntime === null
            ? {}
            : {
                authoritySource: frozenPort(
                  workLedgerRuntime.memoryAuthoritySource,
                  ["readStatus"],
                  "workLedgerRuntime.memoryAuthoritySource",
                ),
              }),
          ...(confirmationMemoryAuthorityRequired
            ? {
                confirmationAuthoritySource: Object.freeze({
                  readStatus: () => {
                    if (confirmationRuntime === null) {
                      throw new Error("确认记忆权威尚未启动");
                    }
                    return confirmationRuntime.memoryProjectionSource
                      .readMemoryStatus();
                  },
                }),
              }
            : {}),
        }),
      );
    }
    const memoryAnswerConfig = config.memory?.answering;
    if (memoryEnabled && memoryAnswerConfig?.enabled === true) {
      if (!memoryRuntime) {
        throw new Error("记忆问答需要启用统一记忆运行时");
      }
      const memoryBrainRouter = trackRuntime(memoryBrainRouterFactory({
        constructionCleanupOwner: configuredConstructionCleanupOwner,
        brainProviders: config.brainProviders || {},
        dependencies: brainDependencies(
          memoryAnswerDependencies.brainDependencies || {},
          memoryBrainRouterFactory === createConfiguredBrainRouter,
        ),
      }));
      const contextRetriever = memoryContextRetrieverFactory({
        memorySearch: frozenPort(
          memoryRuntime.search,
          ["search"],
          "memoryRuntime.search",
        ),
        contextReader: frozenPort(
          memoryRuntime.contextReader,
          ["readRecords"],
          "memoryRuntime.contextReader",
        ),
        maximumRecords: memoryAnswerConfig.maximumRecords,
        maximumContextBytes: memoryAnswerConfig.maximumContextBytes,
      });
      memoryAnswer = frozenPort(
        memoryAnswerServiceFactory({
          contextRetriever,
          brainRouter: memoryBrainRouter,
          configuredBrain: memoryAnswerConfig.brain,
          localBrain: memoryAnswerConfig.localBrain,
          maximumConcurrent: memoryAnswerConfig.maximumConcurrent,
          ...(ordinaryActionAdmissionGate === null
            ? {}
            : { actionAdmissionGate: ordinaryActionAdmissionGate }),
          ...(memoryAnswerDependencies.beforeGenerate
            ? { beforeGenerate: memoryAnswerDependencies.beforeGenerate }
            : {}),
        }),
        ["answer"],
        "memoryAnswerService",
      );
    }
    const memoryQueryRoleIds = coordinationEnabled
      ? agentMemoryQueryRoleIds(config.employees?.roles || {})
      : [];
    if (memoryQueryRoleIds.length > 0) {
      if (!memoryRuntime || !memoryAnswer) {
        throw new Error(
          "岗位 query_memory 权限需要启用带引用的统一记忆问答",
        );
      }
      agentMemoryQueries = agentMemoryQueryServiceFactory({
        store: frozenPort(store, ["read", "write"], "agent memory query store"),
        memoryAnswer,
        memoryContextReader: frozenPort(
          memoryRuntime.contextReader,
          ["readRecords"],
          "agent memory query context reader",
        ),
        memoryProducer: frozenPort(
          memoryRuntime.producer,
          ["append"],
          "agent memory query producer",
        ),
        allowedRoleIds: memoryQueryRoleIds,
        ...(workCoordinationDependencies.clock
          ? { clock: workCoordinationDependencies.clock }
          : {}),
      });
      await frozenPort(
        agentMemoryQueries,
        ["recover"],
        "agentMemoryQueryService",
      ).recover();
    }
    if (localCodeExecutionEnabled && !memoryRuntime) {
      throw new Error("本地代码工作提案需要启用统一记忆运行时");
    }
    if (localCodeExecutionEnabled && !workLedgerRuntime) {
      throw new Error("本地代码工作提案需要启用共享工作台账");
    }
    inputAuthorityVerifier = workLedgerRuntime === null
      ? null
      : Object.freeze({
          async verify(binding) {
            const verified = await workLedgerRuntime.verifyPullRequestExecutionBinding(binding);
            const root = await workLedgerRuntime.readItemForReconciliation?.({ itemId: verified.rootItemId });
            if (root?.source?.scope?.kind === "owner_requested" && root.source.identity.targetRoleId === "pr-engineer") {
              await ownerWorkRequests?.verifyAutomaticReviewContinuation?.(verified);
            }
            return verified;
          },
        });
    let activeCodeJobOptions = null;
    let codeJobNativeExecution = null;
    if (localCodeExecutionEnabled) {
      let codeJobBrainDirectory;
      if (versionedConfiguration) {
        grantFactory = versionedCodeJobAuthorityFactory({
          configurationReader: configurationRuntime.reader,
          executorAuthority: codeExecutorRuntime.authority,
          inspectAuthorityForWritablePaths: codeExecutorRuntime.inspectAuthorityForWritablePaths,
          startupConfiguration: config,
          brainDependencies: brainDependencies(
            workCoordinationDependencies.brainDependencies || {},
            versionedCodeJobAuthorityFactory ===
                defaultVersionedCodeJobAuthorityFactory &&
              codeJobBrainDirectoryFactory ===
                createConfiguredCodeJobBrainDirectory,
          ),
          actionAdmissionGate: ordinaryActionAdmissionGate,
          inputAuthorityVerifier,
          ...(controlledConflictPorts.verifier === null
            ? {}
            : {
                conflictPreparationVerifier:
                  controlledConflictPorts.verifier,
              }),
          grantFactoryFactory: codeJobGrantFactory,
          brainDirectoryFactory: codeJobBrainDirectoryFactory,
        });
        codeJobBrainDirectory = grantFactory;
      } else {
        grantFactory = codeJobGrantFactory({
          executorAuthority: codeExecutorRuntime.authority,
          policyVersion: coordinationConfig.policy?.version ?? 1,
          workspaceByRepository:
            coordinationConfig.policy?.workspaceByRepository || {},
          codeActionRoles: coordinationConfig.policy?.codeActionRoles || [],
          codeOperationsByRole:
            coordinationConfig.policy?.codeOperationsByRole || {},
          taskBrainByRole: taskBrainConfigurationsByRole(
            config.employees?.roles,
          ),
          brainProviders: config.brainProviders || {},
          inputAuthorityVerifier,
          ...(controlledConflictPorts.verifier === null
            ? {}
            : {
                conflictPreparationVerifier:
                  controlledConflictPorts.verifier,
              }),
        });
        codeJobBrainDirectory = codeJobBrainDirectoryFactory({
          brainProviders: config.brainProviders || {},
          roles: config.employees?.roles || {},
          constructionCleanupOwner: configuredConstructionCleanupOwner,
          dependencies: brainDependencies(
            workCoordinationDependencies.brainDependencies || {},
            codeJobBrainDirectoryFactory ===
              createConfiguredCodeJobBrainDirectory,
          ),
        });
      }
      codeJobBrainDirectory = trackRuntime(codeJobBrainDirectory);
      if (typeof codeJobBrainDirectory.withEntityQuiescence === "function") {
        codeJobNativeExecution = Object.freeze({ withEntityQuiescence: (grant, operation, { signal = null } = {}) => {
          if (!Number.isSafeInteger(grant.subject?.number) ||
              grant.inputBinding?.pullRequestNumber !== grant.subject.number) return { executed: false };
          return codeJobBrainDirectory.withEntityQuiescence({ roleId: grant.requestedBy.roleId,
            brainDigest: grant.brainDigest, signal, entityKey: githubEntitySessionKey({ kind: "pull_request",
              repository: grant.repository, number: grant.subject.number }) }, operation);
        } });
      }
      activeCodeJobOptions = {
        ...(ownPrRepairEnabled ? {
          reviewRepairContextReader: new ReviewRepairContextReader({
            github,
            executionContextReader: frozenPort(
              workLedgerRuntime,
              ["readPullRequestExecutionContext"],
              "workLedgerRuntime",
            ),
          }),
        } : {}),
        grantVerifier: frozenPort(
          grantFactory,
          ["verify"],
          "codeJobGrantFactory",
        ),
        executor: frozenPort(
          codeExecutorRuntime.executor,
          [
            "start",
            "view",
            "resume",
            "perform",
            "getActionResult",
            "reconcileAction",
            "reconcileCancellation",
          ],
          "codeExecutorRuntime.executor",
        ),
        brainDirectory: frozenPort(
          codeJobBrainDirectory,
          ["decide", ...(typeof codeJobBrainDirectory.describe === "function" ? ["describe"] : [])],
          "codeJobBrainDirectory",
        ),
        workerLimits: {
          ...(config.githubActions?.enabled === true && config.githubActions.automaticOwnPrRepair === true
            ? { concurrency: 2 } : {}),
          ...(coordinationConfig.codeJobMaximumTurns === undefined
            ? {}
            : { maxTurns: coordinationConfig.codeJobMaximumTurns }),
          ...(coordinationConfig.codeJobObservationLimit === undefined
            ? {}
            : {
                observationLimit:
                  coordinationConfig.codeJobObservationLimit,
              }),
        },
        // This read-only port does not alter permissions in the job grant.
        conflictSourceReader: codeExecutorRuntime.conflictSourceReader ?? null,
        ...(codeJobChangePackageDeliveryEnabled
          ? {
              completedChangeExporter: frozenPort(
                codeExecutorRuntime.completedChangeExporter,
                ["export"],
                "codeExecutorRuntime.completedChangeExporter",
              ),
              changePackageProducer: frozenPort(
                changePackageRuntime.packageProducer,
                ["create"],
                "changePackageRuntime.packageProducer",
              ),
              changePackageReader,
              ...(changePackageRuntime.controlledCommitDelivery === undefined
                ? {}
                : {
                    controlledCommitDelivery: frozenPort(
                      changePackageRuntime.controlledCommitDelivery,
                      ["deliver"],
                      "changePackageRuntime.controlledCommitDelivery",
                    ),
                  }),
            }
          : {}),
      };
    }
    if (coordinationEnabled && memoryRuntime) {
      codeJobRuntime = trackRuntime(
        await codeJobRuntimeFactory({
          taskRuns,
          ...(ownPrRepairEnabled ? { automaticPauseRecovery: Object.freeze({
            canRecover: job => automaticLocalCodeAuthorization?.canRecoverPausedCodeJob(job) ?? false,
            canReplanUnstartedWrite: job => automaticLocalCodeAuthorization?.canReplanUnstartedWrite(job) ?? false,
            withNativeQuiescence: (job, operation, options) => job?.grant && codeJobNativeExecution !== null
              ? codeJobNativeExecution.withEntityQuiescence(job.grant, operation, options) : { executed: false },
          }) } : {}),
          ...runtimeDependencies(codeJobRuntimeDependencies),
          store,
          ...(ordinaryActionAdmissionGate === null
            ? {}
            : { actionAdmissionGate: ordinaryActionAdmissionGate }),
          operationQueue: new OperationQueue(),
          memoryReceiptVerifier: frozenPort(
            memoryRuntime.receiptVerifier,
            ["verify"],
            "memoryRuntime.receiptVerifier",
          ),
          ...(activeCodeJobOptions ?? {}),
        }),
      );
      if (!codeJobRuntime) {
        throw new Error("代码任务记忆投影需要可用的代码任务运行时");
      }
      codeJobReader = frozenPort(
        codeJobRuntime.reader,
        ["get", "getDetail", "list", "listNewest"],
        "codeJobRuntime.reader",
      );
      if (
        typeof codeJobRuntime.reader.readDeliveryEvidence === "function"
      ) {
        codeJobDeliveryEvidenceReader = frozenPort(
          codeJobRuntime.reader,
          ["readDeliveryEvidence"],
          "codeJobRuntime.deliveryEvidenceReader",
        );
      }
      codeJobControl = frozenPort(
        codeJobRuntime.control,
        ["pause", "resume", "cancel"],
        "codeJobRuntime.control",
      );
      obsoleteCodeJobSettler = new ObsoleteCodeJobSettler({ codeJobReader, codeJobControl, taskRuns,
        ...(typeof codeExecutorRuntime?.executor?.view === "function" ? {
          codeExecutorReader: frozenPort(codeExecutorRuntime.executor, ["view"], "obsolete code executor stop reader"),
        } : {}),
        ...(codeJobNativeExecution !== null &&
            typeof codeExecutorRuntime?.executor?.view === "function" &&
            typeof codeExecutorRuntime.executor.reconcileCancellation === "function" ? {
          nativeExecution: codeJobNativeExecution,
          codeExecutorControl: frozenPort(codeExecutorRuntime.executor, ["reconcileCancellation"], "obsolete executor cleanup"),
        } : {}) });
      if (codeJobChangePackageDeliveryEnabled) {
        codeJobEvidenceReader = frozenPort(
          codeJobEvidenceReaderFactory({
            codeJobReader,
            changePackageReader,
            auditArtifactReader: frozenPort(
              codeExecutorRuntime.auditArtifactReader,
              ["read"],
              "codeExecutorRuntime.auditArtifactReader",
            ),
          }),
          ["read"],
          "codeJobEvidenceReader",
        );
      }
      codeJobMemoryProjector = frozenPort(
        codeJobMemoryProjectorFactory({
          projectionSource: frozenPort(
            codeJobRuntime.projectionSource,
            ["readBatch", "ack"],
            "codeJobRuntime.projectionSource",
          ),
          memoryProducer: frozenPort(
            memoryRuntime.producer,
            ["appendBatch"],
            "memoryRuntime.producer",
          ),
        }),
        ["runCycle"],
        "codeJobMemoryProjector",
      );
      if (codeJobChangePackageDeliveryEnabled) {
        codeJobChangePackageDispatcher = frozenPort(
          codeJobRuntime.changePackageDelivery,
          ["runCycle"],
          "codeJobRuntime.changePackageDelivery",
        );
      }
    }
    const localExecutors = {};
    const configurationActionRecoveryEnabled =
      versionedConfiguration && externalActions;
    const configurationInitializationEnabled =
      configurationActionRecoveryEnabled &&
      configurationRuntime.status.safeMode === true;
    if (configurationActionRecoveryEnabled) {
      const configurationActivationExecutor =
        configurationActivationExecutorFactory({
          activationExecutor: frozenPort(
            configurationRuntime.activationExecutor,
            ["activateInitialization", "activateDraft", "activateRollback"],
            "configurationRuntime.activationExecutor",
          ),
          configurationReader: frozenPort(
            configurationRuntime.reader,
            ["readActivationReconciliationSnapshot"],
            "configurationRuntime.reader",
          ),
          actionAdmissionGate: frozenPort(
            actionAdmissionGate,
            ["cutover", "readStatus", "reconcileCutover"],
            "configuration action admission gate",
          ),
          allowedActionTypes: Object.freeze(
            configurationInitializationEnabled
              ? ["initialize_from_draft"]
              : ["activate_draft", "activate_rollback"],
          ),
        });
      localExecutors["local.configuration-activate"] = frozenPort(
        configurationActivationExecutor,
        ["execute", "reconcile"],
        "configurationActivationExecutor",
      );
    }
    if (localCodeExecutionEnabled) {
      localExecutors["local.code-job-create"] = frozenPort(
        codeJobRuntime.confirmationExecutor,
        ["execute", "reconcile"],
        "codeJobRuntime.confirmationExecutor",
      );
      codeJobWorker = frozenPort(
        codeJobRuntime.worker,
        ["runCycle", ...(config.githubActions?.enabled === true && config.githubActions.automaticOwnPrRepair === true ? ['runReady'] : [])],
        "codeJobRuntime.worker",
      );
      if (config.githubActions?.enabled === true && config.githubActions.automaticOwnPrRepair === true) {
        codeJobExecution = Object.freeze({ runCycle: (options, runOperation) => codeJobWorker.runReady({
          ...options, limit: coordinationConfig.codeJobLimit ?? 10,
        }, runOperation) });
      }
    }
    if (changePackageActionsEnabled) {
      localExecutors["local.change-package-apply"] = frozenPort(
        changePackageRuntime.applicationExecutor,
        ["execute", "reconcile"],
        "changePackageRuntime.applicationExecutor",
      );
    }
    if (pullRequestExternalActionExecutionEnabled) {
      if (inputAuthorityVerifier === null) {
        throw new Error("GitHub PR 外部动作需要可核验的 PR 输入授权");
      }
      const controlledCommitVerifier =
        codeExecutorRuntime?.controlledCommitBuilder == null
          ? null
          : frozenPort(
              codeExecutorRuntime.controlledCommitBuilder,
              ["verify"],
              "codeExecutorRuntime.controlledCommitBuilder",
            );
      const controlledCommitPublisher =
        codeExecutorRuntime?.controlledCommitPublisher == null
          ? null
          : frozenPort(
              codeExecutorRuntime.controlledCommitPublisher,
              ["publish"],
              "codeExecutorRuntime.controlledCommitPublisher",
            );
      if (
        executablePullRequestActions.includes("push") &&
        controlledCommitVerifier === null
      ) {
        throw new Error("GitHub push 动作需要可核验的受控 commit 证据");
      }
      const environment = pullRequestExternalActionDependencies.env ?? process.env;
      let transport = pullRequestExternalActionDependencies.transport;
      if (transport === undefined) {
        if (
          executablePullRequestActions.includes("push") &&
          controlledCommitPublisher === null
        ) {
          throw new Error("GitHub push 动作需要受控 commit 发布端口");
        }
        transport = pullRequestExternalActionTransportFactory({
          ghCommand: configuredGithubActions.ghCommand,
          env: environment,
          networkEnv: configuredGithubActions.networkEnv,
          ...(configuredGithubActions.timeoutMs === undefined
            ? {}
            : { timeoutMs: configuredGithubActions.timeoutMs }),
          ...(controlledCommitPublisher === null
            ? {}
            : { controlledCommitPublisher }),
          ...(pullRequestExternalActionDependencies.processRunner === undefined
            ? {}
            : {
                runner: pullRequestExternalActionDependencies.processRunner,
              }),
        });
      }
      const constructedPullRequestExternalActionExecutor =
        pullRequestExternalActionExecutorFactory({
          enabledActions: executablePullRequestActions,
          ...(!ownPrRepairEnabled ? {} : {
            pushAuthorization: {
              verifyPush(envelope) {
                if (!isHeadRepairExecutionSource(envelope.action?.controlledCommitEvidence?.executionSource)) {
                  return automaticOwnPrRepair === null ? explicitPullRequestActions.includes("push")
                    : automaticOwnPrRepair.verifyPush(envelope).then(approved => approved || explicitPullRequestActions.includes("push"));
                }
                if (automaticOwnPrRepair === null) {
                  throw Object.assign(new Error("自动修复授权仍在恢复中"), {
                    code: "GITHUB_AUTHORIZATION_UNAVAILABLE",
                  });
                }
                return automaticOwnPrRepair.verifyPush(envelope);
              },
            },
          }),
          credentialSource: githubCredentialSource,
          ...(configuredGithubActions.timeoutMs === undefined
            ? {}
            : { timeoutMs: configuredGithubActions.timeoutMs }),
          transport,
          inputAuthorityVerifier,
          reviewResultVerifier: Object.freeze({ async verify(envelope, options) {
            return reviewPublicationReuse === null ? null : reviewPublicationReuse.verifyAutomaticSettlement(envelope, options);
          } }),
          ...(controlledCommitVerifier === null
            ? {}
            : { controlledCommitVerifier }),
        });
      try {
        pullRequestExternalActionExecutor = ownedExecutorPort(
          constructedPullRequestExternalActionExecutor,
          "pullRequestExternalActionExecutor",
        );
      } catch (error) {
        try {
          await constructedPullRequestExternalActionExecutor?.close?.();
        } catch {
          // Preserve the composition error after attempting acquired cleanup.
        }
        throw error;
      }
    }
    if (
      externalActions &&
      (Object.keys(localExecutors).length > 0 ||
        config.githubActions?.enabled === true)
    ) {
      confirmationRuntime = trackRuntime(
        await confirmationRuntimeFactory(config, {
          ...runtimeDependencies(confirmationRuntimeDependencies),
          store,
          ...(inputAuthorityVerifier === null
            ? {}
            : { inputAuthorityVerifier }),
          ...(ordinaryActionAdmissionGate === null
            ? {}
            : {
                actionAdmissionGate: ordinaryActionAdmissionGate,
              }),
          ...(Object.keys(localExecutors).length === 0
            ? {}
            : { localExecutors: Object.freeze(localExecutors) }),
          ...(pullRequestExternalActionExecutor === null
            ? {}
            : { pullRequestExternalActionExecutor }),
          ...(githubCredentialSource === null
            ? {}
            : { credentialSource: githubCredentialSource }),
          automaticReviewGuard: new AutomaticReviewPublisher({
            enabled: config.githubActions?.automaticReview === true,
            github,
            ...(workLedgerRuntime === null ? {} : { reviewAdmissionReader: {
              read: binding => workLedgerRuntime.readAutomaticReviewAdmission(binding),
            } }),
            ...(workCoordinationDependencies.clock ? { clock: workCoordinationDependencies.clock } : {}),
          }),
        }),
      );
      pullRequestExternalActionExecutorOwned = confirmationRuntime !== null;
    }
    if (ownPrRepairEnabled) {
      if (!localCodeExecutionEnabled || !confirmationRuntime || !configurationRuntime ||
          !codeJobReader || !codeExecutorRuntime?.controlledCommitBuilder || !changePackageRuntime) {
        throw new Error("自动修复我的 PR 需要版本化配置、开发执行器、验证配置及受控提交链路");
      }
      ciRepairContextReader = new CiRepairContextReader({ github: frozenPort(github,
        ['loadPullRequestFacts', 'readPullRequestLocalWorkFacts'], 'CI repair GitHub facts'), diagnostics: jenkinsRuntime?.diagnostics ?? null });
      const ownPrRepairDependencies = {
        configurationReader: configurationRuntime.reader, store, ledger: workLedgerRuntime,
        ciRepairContextReader,
        ...(codeExecutorRuntime.settledVerificationReader ? {
          settledVerificationReader: frozenPort(codeExecutorRuntime.settledVerificationReader, ['read'], 'settled verification recovery reader'),
        } : {}),
        ...(codeExecutorRuntime.inspectionEnvironmentReader ? {
          inspectionEnvironmentReader: frozenPort(codeExecutorRuntime.inspectionEnvironmentReader, ['read'], 'inspection environment recovery reader'),
        } : {}),
        confirmationSettlementReader: confirmationRuntime.confirmationSettlementReader,
        github, confirmations: Object.freeze({ ...confirmationRuntime.producerQueue, ...confirmationRuntime.queue }), codeJobReader,
        controlledCommitReader: codeExecutorRuntime.controlledCommitBuilder,
        historicalControlledCommitReader: new HistoricalControlledCommitReader({
          store, controlledCommitReader: codeExecutorRuntime.controlledCommitBuilder,
        }),
        grantVerifier: activeCodeJobOptions.grantVerifier,
        historicalRepairFeedbackReader: Object.freeze({
          async read({ inputBinding, feedbackDigest }) {
            const account = inputBinding.gitTarget.sourceAccountId;
            const live = await github.readOwnPullRequestFeedback({
              repository: inputBinding.repository, number: inputBinding.pullRequestNumber, account,
            });
            if (live.state !== "open" || live.isDraft === true ||
                live.author?.toLowerCase() !== account.toLowerCase() ||
                live.currentUser?.toLowerCase() !== account.toLowerCase() ||
                live.repo?.toLowerCase() !== inputBinding.repository.toLowerCase() ||
                live.number !== inputBinding.pullRequestNumber || live.reviewFeedbackAvailable !== true ||
                live.reviewFeedbackDigest !== feedbackDigest || !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u.test(live.headRefOid)) {
              throw Object.assign(new Error("Original repair feedback cannot be recovered exactly"), {
                code: "OWN_PR_REPAIR_ORIGINAL_FEEDBACK_UNAVAILABLE",
              });
            }
            return {
              context: normalizeReviewRepairFeedbackContext({ schemaVersion: 1,
                headRefOid: inputBinding.headRefOid, reviewFeedbackDigest: feedbackDigest, feedback: live.feedback }),
              provenance: { kind: "github_digest_matched_feedback", observedHeadRefOid: live.headRefOid,
                observedAt: new Date().toISOString() },
            };
          },
        }),
        ownerWorkRequests: Object.freeze({
          submitInternalReview: (request) => {
            if (!ownerWorkRequests) throw new Error("内部复审交接运行时尚未就绪");
            return ownerWorkRequests.submitInternalReview(request);
          },
        }),
        objectSync: trackRuntime(new OwnPrRepairObjectSync({ credentialSource: githubCredentialSource,
          maxPreparationMs: automaticObjectPreparationMs })),
      };
      automaticOwnPrRepair = new AutomaticOwnPrRepair({ ...ownPrRepairDependencies,
        conflictRepair: new AutomaticOwnPrConflict({ ...ownPrRepairDependencies,
          conflictInspectionReader: codeExecutorRuntime?.conflictInspectionReader,
          ...(codeExecutorRuntime?.conflictSourceReader ? { codeJobControl, taskRuns } : {}) }) });
      await automaticOwnPrRepair.recover();
      automaticLocalCodeAuthorization = new AutomaticLocalCodeAuthorization({
        ...ownPrRepairDependencies,
        specialized: automaticOwnPrRepair,
        taskRuns,
        roleStateReader: { async read(roleId) {
          return codeAuthorizationRoleRegistry?.get(roleId)?.roleView() ?? null;
        } },
      });
    }
    if (localCodeExecutionEnabled && !confirmationRuntime) {
      throw new Error("本地代码工作提案需要可用的确认运行时");
    }
    if (githubProposalExecutionEnabled && !confirmationRuntime) {
      throw new Error("GitHub 工作提案需要可用的确认运行时");
    }
    if (pullRequestExternalActionExecutionEnabled && !confirmationRuntime) {
      throw new Error("GitHub PR 外部动作提案需要可用的确认运行时");
    }
    if (changePackageActionsEnabled && !confirmationRuntime) {
      throw new Error("change package 应用需要可用的确认运行时");
    }
    if (configurationActionRecoveryEnabled && !confirmationRuntime) {
      throw new Error("版本化配置动作恢复需要可用的确认运行时");
    }
    if (configurationActionRecoveryEnabled) {
      configurationConfirmationRequester = frozenPort(
        configurationConfirmationRequesterFactory({
          simulator: frozenPort(
            configurationRuntime.simulator,
            [
              "prepareInitialization",
              "prepareDraftActivation",
              ...(configurationProposalExecutionEnabled
                ? ["prepareProposalDraftActivation"]
                : []),
              "prepareRollback",
            ],
            "configurationRuntime.simulator",
          ),
          confirmationProducer: frozenPort(
            confirmationRuntime.producerQueue,
            [
              "enqueue",
              ...(configurationProposalExecutionEnabled
                ? ["get", "invalidate"]
                : []),
            ],
            "confirmationRuntime.producerQueue",
          ),
        }),
        configurationInitializationEnabled
          ? ["requestInitialization"]
          : [
              "requestDraftActivation",
              "requestRollback",
              ...(configurationProposalExecutionEnabled
                ? ["requestProposalDraftActivation"]
                : []),
            ],
        "configurationConfirmationRequester",
      );
    }
    if (changePackageActionsEnabled) {
      const applicationProducer = frozenPort(
        changePackageRuntime.applicationProducer,
        ["prepareConfirmation"],
        "changePackageRuntime.applicationProducer",
      );
      const confirmationProducer = frozenPort(
        confirmationRuntime.producerQueue,
        ["enqueue"],
        "confirmationRuntime.producerQueue",
      );
      if (codeJobChangePackageDeliveryEnabled) {
        const resultReconciler =
          changePackageApplicationResultReconcilerFactory({
            applicationResultSource: frozenPort(
              confirmationRuntime.applicationResultSource,
              ["readSnapshot"],
              "confirmationRuntime.applicationResultSource",
            ),
            applicationReader: changePackageApplicationReader,
            projectionStore: frozenPort(
              changePackageRuntime.applicationProjectionWriter,
              ["getCheckpoint", "applySnapshot"],
              "changePackageRuntime.applicationProjectionWriter",
            ),
          });
        changePackageApplicationResultReconciler = frozenPort(
          resultReconciler,
          ["runCycle"],
          "changePackageApplicationResultReconciler",
        );
        changePackageApplicationResultBarrier = frozenPort(
          resultReconciler,
          ["runThrough"],
          "changePackageApplicationResultBarrier",
        );
      }
      changePackageApplicationRequester = Object.freeze({
        async request(value) {
          const plan = await applicationProducer.prepareConfirmation(value);
          const queued = await confirmationProducer.enqueue(plan);
          await changePackageApplicationResultBarrier?.runThrough(
            queued.queueRevision,
          );
          return queued;
        },
      });
    }
    const proposalRunners = [];
    let reviewProposalRunner = null;
    if (githubProposalExecutionEnabled) {
      reviewProposalRunner = githubReviewProposalRunnerFactory({
          enabled: true,
          publicationAdopter: Object.freeze({ async handle(input, options) {
            if (reviewPublicationReuse === null) throw Object.assign(new Error("REVIEW_PUBLICATION_REUSE_UNAVAILABLE"), { code: "REVIEW_PUBLICATION_REUSE_UNAVAILABLE" });
            return reviewPublicationReuse.handle(input, options);
          } }),
          runner:
            workProposalRuntime.runners[GITHUB_REVIEW_PROPOSAL_RUNNER_ID],
          confirmationProducer: confirmationRuntime.producerQueue,
          automaticReviewPublisher: new AutomaticReviewPublisher({
            enabled: config.githubActions.automaticReview === true,
            assignAfterReview: config.githubActions.assignAfterAutomaticReview !== false,
            queue: confirmationRuntime.queue,
            confirmationInvalidator: confirmationRuntime.producerQueue,
            github,
            reviewAdmissionReader: {
              read: binding => workLedgerRuntime.readAutomaticReviewAdmission(binding),
            },
            testingOwnersByProduct: coordinationConfig.policy?.testingOwnersByProduct || {},
            ...(workCoordinationDependencies.clock ? { clock: workCoordinationDependencies.clock } : {}),
          }),
          inputAuthorityVerifier,
          pullRequestContextReader: Object.freeze({
            async readCurrent(binding) {
              const context = await workLedgerRuntime.readPullRequestExecutionContext(binding);
              await inputAuthorityVerifier.verify(binding);
              return context;
            },
          }),
          actorAccountId: config.githubActions.actorAccountId,
          leaseDurationMs: coordinationConfig.leaseDurationMs,
          retryBaseMs: coordinationConfig.retryBaseMs,
          retryMaxMs: coordinationConfig.retryMaxMs,
          defaultBatchLimit: coordinationConfig.proposalLimit,
          ...(workCoordinationDependencies.clock
            ? { clock: workCoordinationDependencies.clock }
            : {}),
        });
      proposalRunners.push(reviewProposalRunner);
    }
    if (pullRequestExternalActionExecutionEnabled) {
      proposalRunners.push(
        pullRequestExternalActionProposalRunnerFactory({
          enabled: true,
          enabledActions: explicitPullRequestActions,
          runner:
            workProposalRuntime.runners[
              GITHUB_PULL_REQUEST_ACTION_RUNNER_ID
            ],
          confirmationProducer: confirmationRuntime.producerQueue,
          inputAuthorityVerifier,
          actorAccountId: configuredGithubActions.actorAccountId,
          leaseDurationMs: coordinationConfig.leaseDurationMs,
          retryBaseMs: coordinationConfig.retryBaseMs,
          retryMaxMs: coordinationConfig.retryMaxMs,
          defaultBatchLimit: coordinationConfig.proposalLimit,
          ...(workCoordinationDependencies.clock
            ? { clock: workCoordinationDependencies.clock }
            : {}),
        }),
      );
    }
    if (localCodeExecutionEnabled) {
      const codeProposalRunner = codeActionProposalRunnerFactory({
          enabled: true,
          runner: workProposalRuntime.runners[CODE_ACTION_PROPOSAL_RUNNER_ID],
          confirmationProducer: confirmationRuntime.producerQueue,
          codeJobReader,
          grantFactory,
          ...(automaticOwnPrRepair === null ? {} : {
            automaticOwnPrRepair: automaticLocalCodeAuthorization,
            // Two current-fact checks bracket globally bounded Git preparation.
            // Leave a margin for persisting the result before the lease expires.
            handlerTimeoutMs: automaticCodeHandlerTimeoutMs,
          }),
          leaseDurationMs: automaticOwnPrRepair === null
            ? coordinationConfig.leaseDurationMs
            : coordinationTiming.leaseDurationMs,
          retryBaseMs: coordinationConfig.retryBaseMs,
          retryMaxMs: coordinationConfig.retryMaxMs,
          defaultBatchLimit: coordinationConfig.proposalLimit,
          ...(workCoordinationDependencies.clock
            ? { clock: workCoordinationDependencies.clock }
            : {}),
        });
      proposalRunners.push(codeProposalRunner);
      if (automaticLocalCodeAuthorization !== null) {
        localCodeProposalRecovery = frozenPort(codeProposalRunner, ["runCycle"], "local code proposal recovery");
      }
    }
    if (configurationProposalExecutionEnabled) {
      proposalRunners.push(
        configurationChangeProposalRunnerFactory({
          enabled: true,
          runner:
            workProposalRuntime.runners[
              CONFIGURATION_CHANGE_PROPOSAL_RUNNER_ID
            ],
          configurationReader: configurationRuntime.reader,
          configurationProposalPort: configurationRuntime.proposalPort,
          confirmationRequester: configurationConfirmationRequester,
          leaseDurationMs: coordinationConfig.leaseDurationMs,
          retryBaseMs: coordinationConfig.retryBaseMs,
          retryMaxMs: coordinationConfig.retryMaxMs,
          defaultBatchLimit: coordinationConfig.proposalLimit,
          ...(workCoordinationDependencies.clock
            ? { clock: workCoordinationDependencies.clock }
            : {}),
        }),
      );
    }
    const proposalRunner = proposalRunners.length
      ? workProposalRunnerGroupFactory(proposalRunners)
      : null;
    if (proposalRunners.length && !proposalRunner) {
      throw new Error("工作提案 runner 组合失败");
    }
    const prEmployeeBrainRouter = roleConfig.enabled && roleConfig.primaryBrain
      ? trackRuntime(prEmployeeBrainRouterFactory({
          constructionCleanupOwner: configuredConstructionCleanupOwner,
          brainProviders: config.brainProviders || {},
          dependencies: brainDependencies(
            workCoordinationDependencies.brainDependencies || {},
            prEmployeeBrainRouterFactory === createConfiguredBrainRouter,
          ),
        }))
      : null;
    const prEmployee = new ProactivePrEmployeeService({
      github,
      reviewer: roleConfig.enabled
        ? createPrEmployeeReviewer(
            config.brain,
            {
              ...roleConfig.brain,
              allowRemoteCodeContext: roleConfig.allowRemoteCodeContext,
            },
            {
              ...(ordinaryActionAdmissionGate === null ? {} : { actionAdmissionGate: ordinaryActionAdmissionGate }),
              ...(prEmployeeBrainRouter ? { router: prEmployeeBrainRouter, primaryBrain: roleConfig.primaryBrain } : {}),
            },
          )
        : null,
      store,
      // The legacy PR employee handles low-risk patrol and triage.
      // Evidence-bound code Review belongs exclusively to pr-engineer.
      config: { ...roleConfig, triageOnly: true,
        automaticOwnPrRepair: ownPrRepairEnabled,
        automaticReviewPolicy: Object.hasOwn(config.githubActions || {}, "automaticReview")
          ? { enabled: config.githubActions.automaticReview, account: config.githubActions.actorAccountId } : null,
      },
      operationQueue,
      triageHandoff: createPrTriageHandoff(() => ownerWorkRequests, () => workLedgerRuntime),
      producerQueue: confirmationRuntime
        ? frozenPort(
            confirmationRuntime.producerQueue,
            ["get", "invalidate"],
            "confirmationRuntime.legacyRecoveryQueue",
          )
        : null,
      githubActions: { enabled: false },
      ...(ordinaryActionAdmissionGate === null
        ? {}
        : { actionAdmissionGate: ordinaryActionAdmissionGate }),
    });
    if (confirmationRuntime) await prEmployee.recoverConfirmations();
    let workCoordination = null;
    const configuredWorkforce = coordinationEnabled
      ? trackRuntime(configuredWorkforceFactory({
          ...(config.githubActions?.enabled === true &&
            (config.githubActions.automaticReview === true || config.githubActions.automaticOwnPrRepair === true)
            ? { waitForModelCapacity: true } : {}),
          constructionCleanupOwner: configuredConstructionCleanupOwner,
          brainProviders: config.brainProviders || {},
          roles: config.employees?.roles || {},
          store,
          ...(workCoordinationDependencies.clock
            ? { clock: workCoordinationDependencies.clock }
            : {}),
          dependencies: brainDependencies(
            workCoordinationDependencies.brainDependencies || {},
            configuredWorkforceFactory === createConfiguredWorkforce,
          ),
          ...(ordinaryActionAdmissionGate === null
            ? {}
            : { actionAdmissionGate: ordinaryActionAdmissionGate }),
          onRun: ({ roleId, signal = null, continuationTarget = null }) => {
            if (!workCoordination) {
              const error = new Error("员工主动循环尚未就绪");
              error.code = "WORK_COORDINATION_NOT_READY";
              throw error;
            }
            return workCoordination.runCycle({
              trigger: `employee:${roleId}`,
              includeWork: true,
              roleId,
              ...(continuationTarget === null ? {} : { continuationTarget }),
              ...(signal === null ? {} : { signal }),
            });
          },
        }))
      : { employees: [], workers: [] };
    const employeeRegistry = createEmployeeRegistry([
      prEmployee,
      ...configuredWorkforce.employees,
    ]);
    codeAuthorizationRoleRegistry = employeeRegistry;
    let workLedgerView = null;
    let dailyWorkLedgerView = null;
    let workGraphView = null;
    let attentionBrowser = null;
    let attentionCoordinator = null;
    let memoryProjector = null;
    let deliveryEvidence = null;
    if (coordinationEnabled) {
      ownerWorkRequests = trackRuntime(
        createLazyOwnerWorkRequestRuntime(() =>
          ownerWorkRequestRuntimeFactory({
            ...runtimeDependencies(ownerWorkRequestDependencies),
            store: frozenPort(
              store,
              ["read", "write"],
              "owner work request store",
            ),
            workflowRouting: frozenPort(
              workflowRouting,
              ["dryRun", "ingest"],
              "owner work request workflow routing",
            ),
            ledger: frozenPort(
              workLedgerRuntime,
              ["intake", "listItems", "readItemProgress", "readItemForReconciliation", "listOutbox", "verifyPullRequestExecutionBinding"],
              "owner work request ledger",
            ),
            roleReadiness: Object.freeze({
              async read(roleId) {
                const employee = employeeRegistry.get(roleId);
                if (!employee) {
                  return { roleId, enabled: false, paused: true };
                }
                const role = await employee.roleView();
                return {
                  roleId,
                  enabled: role?.enabled === true,
                  paused: role?.paused === true,
                };
              },
            }),
            capabilityReadiness: Object.freeze({
              async read(capability) {
                const roleId =
                  coordinationConfig.policy?.capabilityRoles?.[capability];
                const employee = typeof roleId === "string"
                  ? employeeRegistry.get(roleId)
                  : null;
                if (!employee) {
                  return {
                    capability,
                    roleId: roleId ?? null,
                    enabled: false,
                    paused: true,
                  };
                }
                const role = await employee.roleView();
                return {
                  capability,
                  roleId,
                  enabled: role?.enabled === true,
                  paused: role?.paused === true,
                };
              },
            }),
            pullRequestResolver: frozenPort(
              github,
              ["resolvePullRequestTarget"],
              "owner pull request resolver",
            ),
            incomingReviewReader: Object.freeze({ read: input => github.readIncomingReviewRequest(input) }),
            ...(ordinaryActionAdmissionGate === null
              ? {}
              : { actionAdmissionGate: ordinaryActionAdmissionGate }),
          }),
        ),
      );
      const clockOptions = workCoordinationDependencies.clock
        ? { clock: workCoordinationDependencies.clock }
        : {};
      const policy = workIntentPolicyFactory(coordinationConfig.policy || {});
      const suppliedWorkers = workCoordinationDependencies.workers || [];
      const roleWorkers = configuredWorkforce.workers.length
        ? [...configuredWorkforce.workers, ...suppliedWorkers]
        : suppliedWorkers;
      const roleDirectory = roleWorkerDirectoryFactory({
        workers: roleWorkers,
        legacyEmployeeRegistry: employeeRegistry,
        legacyOwnedRoleIds: ["pr-reviewer"],
      });
      const prEngineerGuard = trackRuntime(
        frozenPort(
          effectivePrEngineerExclusiveGuardFactory({
            name: PR_ENGINEER_FACTS_GUARD_NAME,
          }),
          ["run", "close"],
          "PR engineer fact guard",
        ),
      );
      const pullRequestFactsLoader = pullRequestFactsLoaderFactory({ github });
      const prEngineerService = prEngineerServiceFactory({
        store: frozenPort(
          store,
          ["read", "write"],
          "PR engineer fact state store",
        ),
        pullRequestFactsLoader: frozenPort(
          pullRequestFactsLoader,
          ["loadPullRequestFacts"],
          "GitHub pull request facts loader",
        ),
        reviewContextLoader: pullRequestFactsLoader,
        exclusiveLease: frozenPort(
          prEngineerGuard,
          ["run"],
          "PR engineer fact exclusive lease",
        ),
        ...clockOptions,
        maximumAgeMs: coordinationConfig.factMaximumAgeMs,
      });
      await frozenPort(
        prEngineerService,
        ["recover"],
        "PR engineer fact recovery",
      ).recover();
      // Deferred construction keeps this capability private to review invocations;
      // no ledger or refresh authority is passed to the CLI.
      let boundReviewReader = null;
      const getBoundReviewReader = () => boundReviewReader ??= new BoundReviewFeedbackReader({ ledger: workLedgerRuntime, factsReader: prEngineerService, inputAuthorityVerifier });
      currentReviewFeedbackReader = Object.freeze({ async read(input, options) {
        return getBoundReviewReader().read(input, options);
      } });
      let reuseService = null;
      const getReuseService = () => reuseService ??= new ReviewPublicationReuseService({
        taskReader: createReviewAdoptionTaskReader(frozenPort(workLedgerRuntime, ["readReviewAdoptionContext"], "Review adoption task reader")),
        factsReader: frozenPort(prEngineerService, ["get"], "Review adoption cached facts"),
        publicationSourceReader: Object.freeze({ listReviewPublicationSources(input) {
          const reader = workProposalRuntime.evidenceReader;
          if (typeof reader?.listReviewPublicationSources !== "function") throw Object.assign(new Error("REVIEW_PUBLICATION_REUSE_UNAVAILABLE"), { code: "REVIEW_PUBLICATION_REUSE_UNAVAILABLE" });
          return reader.listReviewPublicationSources(input);
        } }),
        confirmationReader: Object.freeze({ readSettlements(input) {
          const reader = confirmationRuntime?.confirmationSettlementReader;
          if (typeof reader?.readMany !== "function") throw Object.assign(new Error("REVIEW_PUBLICATION_REUSE_UNAVAILABLE"), { code: "REVIEW_PUBLICATION_REUSE_UNAVAILABLE" });
          return reader.readMany(input);
        } }),
        materialsReader: Object.freeze({ async read(input, options = {}) {
          const { excludedPublication, ...request } = input;
          const facts = await getBoundReviewReader().readCurrent(request, options);
          const materialDigest = projectPullRequestReadFactsContext(facts).materialDigest;
          if (typeof materialDigest !== "string") throw Object.assign(new Error("PR_REVIEW_READ_MATERIAL_CHANGED"), { code: "PR_REVIEW_READ_MATERIAL_CHANGED" });
          return readGitHubReviewFeedbackSnapshot({ target: { gitTarget: input.gitTarget, pullRequestNumber: input.pullRequestNumber,
            feedbackSnapshot: { taskId: input.taskId, materialDigest } }, factsReader: Object.freeze({ async read() { return facts; } }),
            run: runJson, options: { ...options, env: { ...process.env, GH_HOST: "github.com" } }, excludedPublication });
        } }),
        receiptStore: new ReviewPublicationAdoptionStore({ store: frozenPort(store, ["read", "write"], "Review adoption receipt store") }),
        inputAuthorityVerifier: frozenPort(inputAuthorityVerifier, ["verify"], "Review adoption input verifier"),
        policyReader: async () => (await loadNativeReviewSkill()).digest,
        ...clockOptions,
      });
      recordCompletedReviewRead = receipt => getReuseService().recordReviewCoverage(receipt);
      reviewPublicationReuse = Object.freeze({
        listCandidates: (input, options) => getReuseService().listCandidates(input, options),
        handle: (input, options) => getReuseService().handle(input, options),
        verifyProposal: input => getReuseService().verifyProposal(input),
        verifyAutomaticSettlement: (input, options) => getReuseService().verifyAutomaticSettlement(input, options),
      });
      const pullRequestFacts = frozenPort(
        prEngineerService,
        ["context"],
        "PR engineer fact context",
      );
      const factSourceService = workflowFactSourceFactory({
        store: frozenPort(
          store,
          ["read"],
          "workflow fact snapshot store",
        ),
        pullRequestFacts,
        ...clockOptions,
        maximumAgeMs: coordinationConfig.factMaximumAgeMs,
      });
      const factSource = frozenPort(
        factSourceService,
        ["read"],
        "workflow fact source",
      );
      const rawPullRequestContextReader = frozenPort(
        frozenPort(
          factSourceService,
          ["pullRequestTaskContextReader"],
          "workflow PR task context reader factory",
        ).pullRequestTaskContextReader(),
        ["read"],
        "workflow PR task context reader",
      );
      const pullRequestContextReader = Object.freeze({ async read(input, options) {
        const binding = createPullRequestExecutionBinding(input);
        await inputAuthorityVerifier.verify(binding);
        return rawPullRequestContextReader.read(input, options);
      } });
      const proposalResultReader = workProposalRuntime.evidenceReader
        ? frozenPort(
            workProposalRuntime.evidenceReader,
            [
              "getResult",
              "getResultForProposal",
              "getProposalForEvidence",
              "listEvidenceCandidates",
            ],
            "workProposalRuntime.evidenceReader",
          )
        : null;
      const deliveryEvidenceService = deliveryEvidenceServiceFactory({
        publicationAdoptionVerifier: frozenPort(reviewPublicationReuse, ["verifyProposal"], "Review publication adoption verifier"),
        ...(changePackageReader === null ? {} : { changePackageReader }),
        ...(codeJobDeliveryEvidenceReader === null
          ? {}
          : { codeJobReader: codeJobDeliveryEvidenceReader }),
        ...(proposalResultReader === null ? {} : { proposalResultReader }),
      });
      deliveryEvidence = frozenPort(
        deliveryEvidenceService,
        ["listForTask", "verify"],
        "deliveryEvidenceService",
      );
      const automaticMode = config.githubActions?.enabled === true &&
        (config.githubActions.automaticReview === true || config.githubActions.automaticOwnPrRepair === true);
      const roleContextAssembler = roleContextAssemblerFactory({
        publicationReuseReader: frozenPort(reviewPublicationReuse, ["listCandidates"], "Review publication candidate reader"),
        graphReader: frozenPort(
          workLedgerRuntime.graphReader,
          ["getSnapshot"],
          "workLedgerRuntime.graphReader",
        ),
        factSource,
        pullRequestContextReader,
        ...(jenkinsRuntime === null ? {} : { ciDiagnosticReader: jenkinsRuntime.diagnostics }),
        ...(automaticOwnPrRepair?.conflictRepair ? { conflictInspectionReader: Object.freeze({
          read: request => automaticOwnPrRepair.conflictRepair.readInspection(request),
        }) } : {}),
        internalReviewHandoffReader: Object.freeze({
          read: (input) => workLedgerRuntime.readInternalReviewHandoff(input),
        }),
        originalRepairFeedbackReader: Object.freeze({
          async readBinding(input) {
            if (automaticOwnPrRepair) await automaticOwnPrRepair.readOriginalFeedbackBinding(input);
            return originalRepairFeedbackReader.readBinding(input);
          },
        }),
        ...(codeJobReader === null ? {} : {
          failedCodeJobContextReader: new FailedCodeJobContextReader({ codeJobReader, ledger: workLedgerRuntime }),
        }),
        evidenceCatalog: deliveryEvidence,
        ...(automaticMode ? {
          settlementInputAuthorityVerifier: inputAuthorityVerifier,
          settlementEvidenceVerifier: deliveryEvidence,
        } : {}),
        ...(agentMemoryQueries === null
          ? {}
          : {
              memoryQueryReader: frozenPort(
                agentMemoryQueries,
                ["readContext"],
                "agentMemoryQueryService.reader",
              ),
            }),
      });
      const orchestratorService = orchestratorServiceFactory({
        automaticMode,
        contextAssembler: roleContextAssembler,
        graphReader: workLedgerRuntime.graphReader,
        scopedGraphPlannerFactory:
          workLedgerRuntime.scopedGraphPlannerFactory,
        graphDelivererFactory: workLedgerRuntime.graphDelivererFactory,
        capabilityRoles: coordinationConfig.policy?.capabilityRoles || {},
        evidenceVerificationTimeoutMs:
          coordinationTiming.evidenceVerificationTimeoutMs,
        evidenceMutationMarginMs:
          coordinationTiming.evidenceMutationMarginMs,
        ...clockOptions,
        ...(ordinaryActionAdmissionGate === null
          ? {}
          : { actionAdmissionGate: ordinaryActionAdmissionGate }),
        evidenceVerifier:
          workCoordinationDependencies.evidenceVerifier ?? deliveryEvidence,
      });
      const attentionResultReconciler = attentionResultReconcilerFactory({
        attentionConsumer: attentionInboxRuntime.consumer,
        attentionMaintenance: attentionInboxRuntime.maintenance ?? null,
        ledger: workLedgerRuntime,
      });
      const proposalResultReconciler = workProposalResultReconcilerFactory({
        proposalConsumer: workProposalRuntime.consumer,
        ledger: workLedgerRuntime,
        ...(codeJobReader === null ? {} : { codeJobReader }),
      });
      const conditionWaker = workConditionWakerFactory({
        ledger: workLedgerRuntime,
        graphReader: workLedgerRuntime.graphReader,
        graphPlanner: workLedgerRuntime.graphPlanner,
        factSource,
        ...clockOptions,
        ...(ordinaryActionAdmissionGate === null
          ? {}
          : { actionAdmissionGate: ordinaryActionAdmissionGate }),
      });
      if (configurationRuntime && typeof workLedgerRuntime?.listClaimCandidates === "function" &&
          typeof workLedgerRuntime?.readItemForReconciliation === "function" && typeof workLedgerRuntime?.readItemProgress === "function") {
        workContinuationScheduler = new WorkContinuationScheduler({
          store, ledger: workLedgerRuntime, configurationReader: configurationRuntime.reader, taskRuns,
          roleStateReader: { async read(roleId) { return employeeRegistry.get(roleId)?.roleView() ?? null; } },
          preparations: [
            () => workLedgerRuntime.retireAutomaticReviewTestingWork?.({ limit: 10 }),
            () => proposalResultReconciler.runCycle({ limit: 10 }),
            () => conditionWaker.runCycle({ limit: 10 }),
          ],
          ...clockOptions,
        });
      }
      const workLoop = proactiveWorkLoopFactory({
        taskRuns,
        ledger: Object.freeze({ ...workLedgerRuntime, verifyPullRequestExecutionBinding: inputAuthorityVerifier.verify }),
        roleDirectory,
        roleContextAssembler,
        orchestratorService,
        ...(automaticOwnPrRepair === null ? {} : { automaticOwnPrRepair }),
        ...(activeCodeJobOptions?.reviewRepairContextReader === undefined ? {} : {
          reviewRepairContextReader: activeCodeJobOptions.reviewRepairContextReader,
        }),
        ...(agentMemoryQueries === null
          ? {}
          : {
              memoryQueryService: frozenPort(
                agentMemoryQueries,
                ["execute", "verifyContext"],
                "agentMemoryQueryService.executor",
              ),
            }),
        ...clockOptions,
        leaseDurationMs: coordinationTiming.leaseDurationMs,
        maxAttempts: coordinationConfig.maxAttempts,
        retryBaseMs: coordinationConfig.retryBaseMs,
        retryMaxMs: coordinationConfig.retryMaxMs,
        resolveTimeoutMs: coordinationTiming.resolveTimeoutMs,
        decideTimeoutMs: coordinationTiming.decisionTimeoutMs,
        issueActiveWindowDays:
          config.githubRead?.issueActiveWindowDays ??
            DEFAULT_ISSUE_ACTIVE_WINDOW_DAYS,
        automaticReviewPolicy: Object.hasOwn(config.githubActions || {}, "automaticReview")
          ? { enabled: config.githubActions.automaticReview, account: config.githubActions.actorAccountId }
          : null,
      });
      const dispatcher = workIntentDispatcherFactory({
        ledger: workLedgerRuntime,
        policy,
        leaseDurationMs: coordinationConfig.leaseDurationMs,
        attentionProducer: attentionInboxRuntime.producer,
        proposalProducer: workProposalRuntime.producer,
        ...(automaticOwnPrRepair === null ? {} : { reviewRepairSourcePreparer: automaticOwnPrRepair }),
        ...(codeExecutorRuntime?.controlledCommitBuilder == null
          ? {}
          : {
              controlledCommitEvidenceReader: frozenPort(
                codeExecutorRuntime.controlledCommitBuilder,
                ["verify"],
                "codeExecutorRuntime.controlledCommitBuilder",
              ),
            }),
        ...(controlledConflictPorts.preparer === null
          ? {}
          : {
              conflictExecutionSourcePreparer:
                controlledConflictPorts.preparer,
            }),
        ...clockOptions,
        ...(ordinaryActionAdmissionGate === null
          ? {}
          : { actionAdmissionGate: ordinaryActionAdmissionGate }),
      });
      const coordinationService = workCoordinationFactory({
        ledger: workLedgerRuntime,
        codeJobRunner: codeJobExecution === null ? codeJobWorker : null,
        ...(codeJobRuntime?.pauseRecovery ? { codeJobPauseRecovery: frozenPort(
          codeJobRuntime.pauseRecovery, ["runCycle"], "codeJobRuntime.pauseRecovery",
        ) } : {}),
        codeJobMemoryProjector,
        codeJobChangePackageDispatcher,
        changePackageApplicationResultReconciler,
        proposalRunner,
        reviewProposalRunner,
        ...(automaticOwnPrRepair === null ? {} : { automaticOwnPrRepair }),
        ...(config.githubActions?.automaticReview === true ? { ownerPullRequestSourceRefresher: Object.freeze({
          runCycle: options => ownerWorkRequests.refreshBlockedPullRequestSources(options),
        }) } : {}),
        proposalResultReconciler,
        attentionResultReconciler,
        conditionWaker,
        workLoop,
        dispatcher,
        intakeLimit: coordinationConfig.intakeLimit,
        workLimit: coordinationConfig.workLimit,
        dispatchLimit: coordinationConfig.dispatchLimit,
        attentionLimit: coordinationConfig.attentionLimit,
        proposalLimit: coordinationConfig.proposalLimit,
        conditionLimit: coordinationConfig.conditionLimit,
        codeJobLimit: coordinationConfig.codeJobLimit,
        codeJobMemoryLimit: coordinationConfig.codeJobMemoryLimit,
      });
      const coordinator = attentionCoordinatorFactory({
        externalQueue: confirmationRuntime?.queue || null,
        internalInbox: attentionInboxRuntime.browser,
      });
      dailyWorkLedgerView = dailyWorkLedgerViewFactory({
        ledger: frozenPort(
          workLedgerRuntime,
          ["getSummary", "listItems", "listTimeline"],
          "daily work ledger source",
        ),
        activeWindowDays:
          config.githubRead?.issueActiveWindowDays ??
          DEFAULT_ISSUE_ACTIVE_WINDOW_DAYS,
      });
      workLedgerView = frozenPort(
        workLedgerRuntime,
        [
          "getSummary",
          ...(typeof workLedgerRuntime.getRoleWorkloads === "function"
            ? ["getRoleWorkloads"]
            : []),
          "listItems",
          "listTimeline",
        ],
        "workLedgerRuntime",
      );
      dailyWorkLedgerView = frozenPort(
        dailyWorkLedgerView,
        [
          "getSummary",
          ...(typeof dailyWorkLedgerView.getRoleWorkloads === "function"
            ? ["getRoleWorkloads"]
            : []),
          "listItems",
          "listTimeline",
        ],
        "dailyWorkLedgerView",
      );
      workGraphView = frozenPort(
        workLedgerRuntime.graphBrowserReader,
        ["getSnapshot"],
        "workLedgerRuntime.graphBrowserReader",
      );
      attentionBrowser = frozenPort(
        attentionInboxRuntime.browser,
        ["next", "answer", "reject", "later", "listMaintenance", "readStatus"],
        "attentionInboxRuntime.browser",
      );
      attentionCoordinator = frozenPort(
        coordinator,
        ["next"],
        "attentionCoordinator",
      );
      workCoordination = frozenPort(
        {intake:(...args)=>coordinationService.intake(...args),runCycle:async(...args)=>{
          const result = await coordinationService.runCycle(...args);
          await taskRuns.reconcile();
          return result;
        }},
        ["intake", "runCycle"],
        "workCoordination",
      );
      if (memoryRuntime) {
        memoryProjector = frozenPort(
          memoryProjectorFactory({
            memoryLifecycleProducer: frozenPort(
              memoryRuntime.lifecycleProducer,
              [
                "appendWorkItems",
                "appendGraphEvents",
                "appendProjectionRecords",
                "appendAuthorityProjection",
                "adoptGraphCheckpoint",
              ],
              "memoryRuntime.lifecycleProducer",
            ),
            memoryAuthorityReader: frozenPort(
              memoryRuntime.authorityReader,
              [
                "getAuthorityState",
                "getAuthorityProjectionState",
                "requiresAuthorityProjectionCheckpoint",
              ],
              "memoryRuntime.authorityReader",
            ),
            memoryAuthoritySource: frozenPort(
              workLedgerRuntime.memoryAuthoritySource,
              ["readSnapshot"],
              "workLedgerRuntime.memoryAuthoritySource",
            ),
            graphProjectionSource: frozenPort(
              workLedgerRuntime.graphMemoryProjectionSource,
              ["ackBatch"],
              "workLedgerRuntime.graphMemoryProjectionSource",
            ),
            ...(confirmationRuntime === null
              ? {}
              : {
                  confirmationProjectionSource: frozenPort(
                    confirmationRuntime.memoryProjectionSource,
                    ["readMemoryPage", "readMemoryStatus"],
                    "confirmationRuntime.memoryProjectionSource",
                  ),
                }),
            ...(inputAuthorityVerifier === null
              ? {}
              : {
                  inputAuthorityVerifier,
                  inputAuthorityBatchVerifier: Object.freeze({
                    verify: (request) =>
                      workLedgerRuntime.verifyPullRequestExecutionBindings(
                        request,
                      ),
                  }),
                }),
            store,
          }),
          ["runCycle"],
          "memoryProjector",
        );
      }
    }
    const memorySearch = memoryRuntime
      ? frozenPort(
          memoryRuntime.search,
          ["search", "getHealth"],
          "memoryRuntime.search",
        )
      : null;
    let memoryImports = null;
    const memoryImportConfig = config.memory?.imports || {};
    const localSessionImportEnabled =
      memoryEnabled && memoryImportConfig.localSessions === true;
    const gitImportEnabled = memoryEnabled && memoryImportConfig.git === true;
    if (localSessionImportEnabled || gitImportEnabled) {
      if (!memoryRuntime) {
        throw new Error("记忆导入需要启用统一记忆运行时");
      }
      const memoryProducer = frozenPort(
        memoryRuntime.producer,
        ["appendBatch"],
        "memoryRuntime.producer",
      );
      const imports = {};
      if (localSessionImportEnabled) {
        const importer = localSessionImporterFactory({
          memoryProducer,
        });
        imports.session = frozenPort(
          importer,
          ["importSession"],
          "localSessionImporter",
        );
      }
      if (gitImportEnabled) {
        const importer = gitActivityImporterFactory({
          memoryProducer,
        });
        imports.git = frozenPort(
          importer,
          ["importCommits"],
          "gitActivityImporter",
        );
      }
      memoryImports = Object.freeze(imports);
    }
    const notifier = new NotificationService(
      dingtalk,
      config.dingtalk,
      ordinaryActionAdmissionGate === null
        ? undefined
        : { actionAdmissionGate: ordinaryActionAdmissionGate },
    );
    const refreshService = new RefreshService({
      github,
      brain,
      dingtalk,
      store,
      notifier,
      config,
      operationQueue,
      repairProgressReader: new OwnPrRepairProgressReader({ store, github }),
    });
    const operations = operationsRuntimeFactory(
      {
        dataDirectory,
        backupDirectory,
        snapshotReader: store,
        ...(configuredOperations.probeTimeoutMs === undefined
          ? {}
          : { probeTimeoutMs: configuredOperations.probeTimeoutMs }),
        ...(confirmationRuntime?.recoveryStatusReader === undefined
          ? {}
          : {
              externalActionStatus: confirmationRuntime.recoveryStatusReader,
            }),
      },
      operationsRuntimeDependencies,
    );
    const standardReviewHandoff = ownerWorkRequests && confirmationRuntime?.reviewHandoffs
      ? new ReviewHandoffReconciler({
          confirmations: confirmationRuntime.reviewHandoffs,
          ownerWorkRequests,
          githubAssignee: confirmationRuntime.reviewHandoffAssignee,
          testingOwnersByProduct: config.workCoordination?.policy?.testingOwnersByProduct || {},
          automaticAssignmentsEnabled: config.githubActions?.automaticReview === true && config.githubActions?.assignAfterAutomaticReview !== false,
          timeoutMs: 2 * (config.githubActions?.timeoutMs ?? 60_000) +
            (coordinationTiming?.resolveTimeoutMs ?? 30_000),
        }) : null;
    const ownPrHandoff = ownPrRepairEnabled && workLedgerRuntime && codeJobReader && confirmationRuntime?.reviewHandoffAssignee
      ? new AutomaticOwnPrHandoff({ store, configurationReader: configurationRuntime.reader,
          ledger: workLedgerRuntime, github, codeJobReader, assignee: confirmationRuntime.reviewHandoffAssignee,
          roleStateReader: { async read(roleId) { return employeeRegistry.get(roleId)?.roleView() ?? null; } },
        }) : null;
    const reviewHandoffReconciler = ownPrHandoff === null ? standardReviewHandoff : Object.freeze({
      async runCycle(options = {}) {
        const runOperation = options.runOperation ?? (operation => operation());
        const results = await Promise.allSettled([
          standardReviewHandoff?.runCycle(options),
          runOperation(() => ownPrHandoff.runCycle({ signal: options.signal ?? null })),
        ]);
        const errors = results.filter(result => result.status === 'rejected').map(result => result.reason);
        if (errors.length) throw new AggregateError(errors, 'Review handoff recovery failed');
        return results.flatMap(result => result.value === undefined ? [] : Array.isArray(result.value) ? result.value : [result.value]);
      },
    });
    const close = () => runtimeLifecycle.close();
    return {
      config,
      configuration: configurationRuntime
        ? Object.freeze({
            status: configurationRuntime.status,
            reader: configurationRuntime.reader,
            draftManager: configurationRuntime.draftManager,
            simulator: configurationRuntime.simulator,
            proposalPort: configurationRuntime.proposalPort,
            confirmationRequester: configurationConfirmationRequester,
            runtimeStatus: frozenPort(
              actionAdmissionGate,
              ["readStatus"],
              "configuration runtime status",
            ),
          })
        : null,
      store,
      refreshService,
      employeeRegistry,
      prEmployee,
      confirmationQueue: confirmationRuntime?.queue || null,
      changePackageReader,
      changePackageApplicationReader,
      changePackageApplicationStatusReader,
      changePackageApplicationRequester,
      workflowRouting,
      codeJobReader,
      codeJobControl,
      taskRuns: coordinationEnabled ? Object.freeze({...createTaskRunView({registry:taskRuns,codeJobReader}),
        control:(...args)=>ordinaryActionAdmissionGate ? ordinaryActionAdmissionGate.run(()=>taskRuns.control(...args)) : taskRuns.control(...args)}) : null,
      codeJobEvidenceReader,
      codeJobExecution,
      workLedgerView,
      dailyWorkLedgerView,
      workGraphView,
      attentionBrowser,
      attentionCoordinator,
      workCoordination,
      workContinuationScheduler,
      localCodeProposalRecovery,
      ownerWorkRetry,
      ownerWorkRequests,
      reviewHandoffReconciler,
      deliveryEvidence,
      memorySearch,
      memoryAnswer,
      memoryImports,
      memoryProjector,
      brainProviderStatus,
      jenkinsConnection: jenkinsRuntime?.connection ?? null,
      operations,
      close,
    };
  } catch (error) {
    if (
      pullRequestExternalActionExecutor !== null &&
      !pullRequestExternalActionExecutorOwned
    ) {
      try {
        await pullRequestExternalActionExecutor.close();
      } catch {
        // Preserve the startup failure after attempting executor cleanup.
      }
    }
    let constructionCleanup = readConfiguredConstructionCleanup(
      configuredConstructionCleanupOwner,
    );
    while (constructionCleanup) {
      trackRuntime(constructionCleanup);
      constructionCleanup = readConfiguredConstructionCleanup(
        configuredConstructionCleanupOwner,
      );
    }
    try {
      const cleanupAttempt = Promise.resolve(runtimeLifecycle.close());
      if (ownsRuntimeLifecycle) {
        await cleanupAttempt;
      } else {
        void cleanupAttempt.catch(() => {});
      }
    } catch {
      // Preserve the startup failure after attempting every acquired runtime.
    }
    throw error;
  }
}
