import path from "node:path";
import { types as utilTypes } from "node:util";
import { createGitHubActionExecutor } from "./adapters/github-action-adapter.js";
import {
  PULL_REQUEST_EXTERNAL_CONFIRMATION_KINDS,
} from "./domain/pull-request-external-action.js";
import { ActionAdmissionGateError } from "./lib/action-admission-gate.js";
import { projectRoot } from "./lib/config.js";
import { OperationQueue } from "./lib/operation-queue.js";
import { ProcessExclusiveGuard } from "./lib/process-exclusive-guard.js";
import { StateStore } from "./lib/state-store.js";
import { ConfirmationExecutorRouter } from "./services/confirmation-executor-router.js";
import { ConfirmationQueue } from "./services/confirmation-queue.js";

const GUARD_NAME = "mydashboard-confirmation-queue-v1";
const TOKEN_ENV_NAME = /^[A-Z_][A-Z0-9_]{0,127}$/;
const GITHUB_LOGIN = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/;
const INVALID_CONTROL = /[\u0000\u0008\u000b\u000c\u000e-\u001f\u007f]/;
const NETWORK_ENV_KEYS = new Set([
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "NO_PROXY",
  "ALL_PROXY",
  "SSL_CERT_FILE",
  "SSL_CERT_DIR",
]);
const USER_QUEUE_METHODS = [
  "next",
  "nextForAction",
  "get",
  "approve",
  "retry",
  "reject",
];
const HISTORY_READER_METHODS = ["list"];
const PRODUCER_QUEUE_METHODS = ["enqueue", "get", "invalidate"];
const APPLICATION_RESULT_SOURCE_METHODS = ["readSnapshot"];
const MEMORY_PROJECTION_SOURCE_METHODS = [
  "readMemoryPage",
  "readMemoryStatus",
];
const RECOVERY_STATUS_READER_METHODS = ["readRecoveryStatus"];
const REVIEW_HANDOFF_METHODS = ["readReviewHandoffs", "recordReviewHandoff"];
const CONFIGURATION_ACTIVATION_KIND = "local.configuration-activate";
const GITHUB_ACTION_CONFIG_KEYS = new Set([
  "enabled",
  "credentialMode",
  "actorAccountId",
  "tokenEnv",
  "ghCommand",
  "networkEnv",
  "timeoutMs",
  "enabledActions",
  "automaticReview",
  "assignAfterAutomaticReview",
  "automaticOwnPrRepair",
]);
const GITHUB_EXTERNAL_ACTIONS = new Set(
  Object.keys(PULL_REQUEST_EXTERNAL_CONFIRMATION_KINDS),
);
const LOCAL_EXECUTOR_KINDS = new Set([
  "local.code-job-create",
  "local.change-package-apply",
  "local.configuration-activate",
]);

export class ConfirmationRuntimeError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "ConfirmationRuntimeError";
    this.code = code;
  }
}

function invalidConfig(message = "外部确认运行配置无效") {
  return new ConfirmationRuntimeError(
    "INVALID_CONFIRMATION_RUNTIME_CONFIG",
    message,
  );
}

function isPlainRecord(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function dataProperty(record, name) {
  const descriptor = Object.getOwnPropertyDescriptor(record, name);
  if (!descriptor) return undefined;
  if (!descriptor.enumerable || !("value" in descriptor)) throw invalidConfig();
  return descriptor.value;
}

function normalizeNetworkEnv(value) {
  if (value === undefined) return Object.freeze({});
  if (!isPlainRecord(value)) throw invalidConfig("GitHub 网络环境配置无效");

  const result = {};
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== "string" || !NETWORK_ENV_KEYS.has(key)) {
      throw invalidConfig("GitHub 网络环境包含不受支持的变量");
    }
    const entry = dataProperty(value, key);
    if (
      typeof entry !== "string" ||
      INVALID_CONTROL.test(entry) ||
      Buffer.byteLength(entry, "utf8") > 4_096
    ) {
      throw invalidConfig("GitHub 网络环境变量值无效");
    }
    result[key] = entry;
  }
  return Object.freeze(result);
}

function normalizeEnabledActions(value) {
  if (value === undefined) return Object.freeze([]);
  if (!Array.isArray(value) || value.length > GITHUB_EXTERNAL_ACTIONS.size) {
    throw invalidConfig("GitHub PR 动作白名单无效");
  }
  const result = [];
  const unique = new Set();
  for (const action of value) {
    if (
      typeof action !== "string" ||
      !GITHUB_EXTERNAL_ACTIONS.has(action) ||
      unique.has(action)
    ) {
      throw invalidConfig("GitHub PR 动作白名单无效");
    }
    unique.add(action);
    result.push(action);
  }
  return Object.freeze(result);
}

function normalizeEnabledConfig(config) {
  if (!isPlainRecord(config)) throw invalidConfig();
  const githubActions = dataProperty(config, "githubActions");
  if (githubActions === undefined) return null;
  if (!isPlainRecord(githubActions)) throw invalidConfig();

  if (
    Reflect.ownKeys(githubActions).some(
      (key) => typeof key !== "string" || !GITHUB_ACTION_CONFIG_KEYS.has(key),
    )
  ) {
    throw invalidConfig(
      "GitHub 动作配置包含不受支持的字段",
    );
  }

  const enabled = dataProperty(githubActions, "enabled");
  if (enabled === false || enabled === undefined) return null;
  if (enabled !== true) throw invalidConfig();

  const actorAccountId = dataProperty(githubActions, "actorAccountId");
  if (
    typeof actorAccountId !== "string" ||
    !GITHUB_LOGIN.test(actorAccountId)
  ) {
    throw invalidConfig("GitHub 写入账号无效");
  }

  const credentialMode = dataProperty(githubActions, "credentialMode") ?? "token-env";
  if (!new Set(["gh-login", "token-env"]).has(credentialMode)) {
    throw invalidConfig("GitHub 凭据模式无效");
  }
  const tokenEnv = dataProperty(githubActions, "tokenEnv");
  if (credentialMode === "token-env" && (
    typeof tokenEnv !== "string" ||
    !TOKEN_ENV_NAME.test(tokenEnv) ||
    tokenEnv === "__PROTO__"
  )) {
    throw invalidConfig("GitHub 凭据环境变量名无效");
  }
  if (credentialMode === "gh-login" && tokenEnv !== undefined) {
    throw invalidConfig("GitHub CLI 登录模式不接受环境变量 Token");
  }
  const ghCommand = dataProperty(githubActions, "ghCommand");
  if (
    typeof ghCommand !== "string" ||
    !path.isAbsolute(ghCommand) ||
    INVALID_CONTROL.test(ghCommand) ||
    Buffer.byteLength(ghCommand, "utf8") > 1_024
  ) {
    throw invalidConfig("ghCommand 必须是显式绝对路径");
  }
  const timeoutMs = dataProperty(githubActions, "timeoutMs");
  if (
    timeoutMs !== undefined &&
    (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1_000 || timeoutMs > 600_000)
  ) {
    throw invalidConfig("GitHub 动作超时时间无效");
  }
  const enabledActionsSource = dataProperty(githubActions, "enabledActions");
  const enabledActions = normalizeEnabledActions(enabledActionsSource);
  const automaticOwnPrRepair = dataProperty(githubActions, "automaticOwnPrRepair");
  if (automaticOwnPrRepair !== undefined && typeof automaticOwnPrRepair !== "boolean") throw invalidConfig("自动修复开关必须是布尔值");

  return Object.freeze({
    actorAccountId,
    ghCommand,
    credentialMode,
    ...(credentialMode === "token-env" ? { tokenEnv } : {}),
    enabledActions: Object.freeze([...new Set([...enabledActions, ...(automaticOwnPrRepair === true ? ["push"] : [])])]),
    reviewEnabled:
      enabledActionsSource === undefined || enabledActions.includes("review"),
    networkEnv: normalizeNetworkEnv(dataProperty(githubActions, "networkEnv")),
    ...(timeoutMs === undefined ? {} : { timeoutMs }),
  });
}

function validateDependencies(dependencies) {
  if (!isPlainRecord(dependencies)) {
    throw new TypeError("dependencies must be a plain object");
  }
  const defaults = {
    createExecutor: createGitHubActionExecutor,
    createExecutorRouter: (options) => new ConfirmationExecutorRouter(options),
    createGuard: (options) => new ProcessExclusiveGuard(options),
    createOperationQueue: () => new OperationQueue(),
    createQueue: (options) => new ConfirmationQueue(options),
    createStore: (dataDirectory) => new StateStore(dataDirectory),
  };
  const result = {};
  for (const [name, fallback] of Object.entries(defaults)) {
    const configuredFactory = dataProperty(dependencies, name);
    const candidate =
      configuredFactory === undefined ? fallback : configuredFactory;
    if (typeof candidate !== "function") {
      throw new TypeError(`${name} must be a function`);
    }
    result[name] = candidate;
  }
  return result;
}

function runtimeDataDirectory(dependencies) {
  const value = dataProperty(dependencies, "dataDirectory");
  if (value === undefined) return path.join(projectRoot, "data");
  if (typeof value !== "string" || !path.isAbsolute(value)) {
    throw invalidConfig("确认队列数据目录必须是绝对路径");
  }
  return path.resolve(value);
}

function assertPort(value, methods, name) {
  if (
    !value ||
    (typeof value !== "object" && typeof value !== "function") ||
    methods.some((method) => typeof value[method] !== "function")
  ) {
    throw new TypeError(`${name} does not implement its required contract`);
  }
  return value;
}

function normalizeLocalExecutors(dependencies) {
  const executors = {};
  const configured = dataProperty(dependencies, "localExecutors");
  if (configured !== undefined) {
    if (!isPlainRecord(configured)) {
      throw new TypeError("localExecutors must be a plain object");
    }
    for (const kind of Reflect.ownKeys(configured)) {
      const descriptor = Object.getOwnPropertyDescriptor(configured, kind);
      if (
        typeof kind !== "string" ||
        !LOCAL_EXECUTOR_KINDS.has(kind) ||
        !descriptor?.enumerable ||
        !("value" in descriptor)
      ) {
        throw new TypeError("localExecutors contains an unsupported kind");
      }
      executors[kind] = assertPort(
        descriptor.value,
        ["execute", "reconcile"],
        `localExecutors[${kind}]`,
      );
    }
  }

  const legacy = dataProperty(dependencies, "localExecutor");
  if (legacy !== undefined && legacy !== null) {
    if (Object.hasOwn(executors, "local.code-job-create")) {
      throw new TypeError(
        "localExecutor conflicts with localExecutors[local.code-job-create]",
      );
    }
    executors["local.code-job-create"] = assertPort(
      legacy,
      ["execute", "reconcile"],
      "localExecutor",
    );
  }
  return Object.freeze(executors);
}

function normalizePullRequestExternalExecutors(enabledConfig, dependencies) {
  const actions = enabledConfig?.enabledActions || [];
  if (actions.length === 0) return Object.freeze({});

  const configured = dataProperty(
    dependencies,
    "pullRequestExternalActionExecutor",
  );
  if (configured === undefined || configured === null) {
    throw invalidConfig(
      "已启用的 GitHub PR 动作缺少固定语义执行器",
    );
  }
  const executor = assertPort(
    configured,
    ["execute", "reconcile"],
    "pullRequestExternalActionExecutor",
  );
  return Object.freeze(Object.fromEntries(
    actions.map((action) => [
      PULL_REQUEST_EXTERNAL_CONFIRMATION_KINDS[action],
      executor,
    ]),
  ));
}

function createQueueFacade(queue, methods) {
  const facade = {};
  for (const method of methods) {
    const delegate = queue[method].bind(queue);
    facade[method] = (...args) => delegate(...args);
  }
  return Object.freeze(facade);
}

function runtimeAdmissionGate(dependencies) {
  const configured = dataProperty(dependencies, "actionAdmissionGate");
  return configured === undefined
    ? null
    : assertPort(configured, ["run"], "actionAdmissionGate");
}

function runtimeInputAuthorityVerifier(dependencies) {
  const configured = dataProperty(dependencies, "inputAuthorityVerifier");
  if (configured === undefined) return null;
  return assertPort(
    configured,
    ["verify"],
    "inputAuthorityVerifier",
  );
}

function runtimeCredentialSource(enabledConfig, dependencies) {
  if (!enabledConfig?.reviewEnabled) return null;
  const source = dataProperty(dependencies, "credentialSource");
  const keys = source === null ||
    typeof source !== "object" ||
    utilTypes.isProxy(source)
    ? []
    : Reflect.ownKeys(source);
  if (
    keys.length !== 1 ||
    keys[0] !== "acquire" ||
    !Object.isFrozen(source) ||
    typeof Object.getOwnPropertyDescriptor(source, "acquire")?.value !==
      "function"
  ) {
    throw new TypeError("credentialSource must be an exact frozen acquire port");
  }
  return source;
}

function fenceExecutor(kind, executor, admissionGate) {
  if (admissionGate === null || kind === CONFIGURATION_ACTIVATION_KIND) {
    return executor;
  }
  const execute = executor.execute.bind(executor);
  const reconcile = executor.reconcile.bind(executor);
  return Object.freeze({
    async execute(value) {
      let admitted = false;
      try {
        return await admissionGate.run(() => {
          admitted = true;
          return execute(value);
        });
      } catch (error) {
        if (!admitted && error instanceof ActionAdmissionGateError) {
          return Object.freeze({ status: "stale" });
        }
        throw error;
      }
    },
    reconcile,
  });
}

function reconcileOnlyExecutor(executor) {
  const reconcile = executor.reconcile.bind(executor);
  return Object.freeze({
    async execute() {
      return { status: "stale" };
    },
    async reconcile(value) {
      const result = await reconcile(value);
      return result?.status === "already" ? result : { status: "stale" };
    },
  });
}

function closeOnce(guard, githubExecutor, pullRequestExternalExecutors) {
  let result;
  return () => {
    if (!result) {
      result = Promise.resolve().then(async () => {
        let firstFailure = null;
        const owners = new Set([
          githubExecutor,
          ...Object.values(pullRequestExternalExecutors),
        ]);
        for (const owner of owners) {
          try {
            await owner?.close?.();
          } catch (error) {
            firstFailure ??= error;
          }
        }
        try {
          await guard.close();
        } catch (error) {
          firstFailure ??= error;
        }
        if (firstFailure) throw firstFailure;
      });
    }
    return result;
  };
}

export async function createConfirmationRuntime(config, dependencies = {}) {
  const enabledConfig = normalizeEnabledConfig(config);
  const localExecutors = normalizeLocalExecutors(dependencies);
  const pullRequestExternalExecutors = normalizePullRequestExternalExecutors(
    enabledConfig,
    dependencies,
  );
  if (
    !enabledConfig &&
    Object.keys(localExecutors).length === 0 &&
    Object.keys(pullRequestExternalExecutors).length === 0
  ) return null;

  const factories = validateDependencies(dependencies);
  const actionAdmissionGate = runtimeAdmissionGate(dependencies);
  const inputAuthorityVerifier = runtimeInputAuthorityVerifier(dependencies);
  const credentialSource = runtimeCredentialSource(enabledConfig, dependencies);
  let githubExecutorOptions = null;
  if (enabledConfig?.reviewEnabled) {
    githubExecutorOptions = {
      ghCommand: enabledConfig.ghCommand,
      credentialSource,
      networkEnv: enabledConfig.networkEnv,
      ...(dataProperty(dependencies, "automaticReviewGuard") === undefined ? {} : {
        automaticReviewGuard: assertPort(dataProperty(dependencies, "automaticReviewGuard"), ["verify"], "automaticReviewGuard"),
      }),
      ...(inputAuthorityVerifier === null
        ? {}
        : { inputAuthorityVerifier }),
      ...(enabledConfig.timeoutMs === undefined
        ? {}
        : { timeoutMs: enabledConfig.timeoutMs }),
    };
  }
  const dataDirectory = runtimeDataDirectory(dependencies);
  const clock = dataProperty(dependencies, "clock");
  const configuredStore = dataProperty(dependencies, "store");
  const store = assertPort(
    configuredStore === undefined
      ? factories.createStore(dataDirectory)
      : configuredStore,
    ["read", "write"],
    "store",
  );
  const operationQueue = assertPort(
    factories.createOperationQueue(),
    ["enqueue"],
    "operationQueue",
  );
  let githubExecutor = null;
  if (githubExecutorOptions) {
    githubExecutor = assertPort(
      factories.createExecutor(githubExecutorOptions),
      ["execute", "reconcile"],
      "githubExecutor",
    );
  }
  const unfencedExecutors = {
    ...(githubExecutor
      ? {
          "github.pull-request-review": reconcileOnlyExecutor(githubExecutor),
          "github.work-proposal-review": githubExecutor,
        }
      : {}),
    ...pullRequestExternalExecutors,
    ...localExecutors,
  };
  const executors = Object.freeze(
    Object.fromEntries(
      Object.entries(unfencedExecutors).map(([kind, candidate]) => [
        kind,
        fenceExecutor(kind, candidate, actionAdmissionGate),
      ]),
    ),
  );
  const executor = assertPort(
    factories.createExecutorRouter({ executors }),
    ["execute", "reconcile"],
    "executor",
  );
  const guard = assertPort(
    factories.createGuard({ name: GUARD_NAME }),
    ["acquire", "run", "close"],
    "guard",
  );
  const close = closeOnce(
    guard,
    githubExecutor,
    pullRequestExternalExecutors,
  );

  try {
    const coordination = dataProperty(config, "workCoordination");
    const automaticReviewEnabled = enabledConfig?.reviewEnabled === true &&
      isPlainRecord(coordination) && dataProperty(coordination, "enabled") === true &&
      dataProperty(dataProperty(config, "githubActions"), "automaticReview") === true;
    const queueOptions = {
      store,
      executor,
      operationQueue,
      exclusiveLease: guard,
      reviewHandoffPolicy: config.workCoordination?.policy || {},
      ...(clock === undefined ? {} : { clock }),
    };
    const queue = assertPort(
      factories.createQueue(queueOptions),
      [
        "recover",
        ...new Set([
          ...USER_QUEUE_METHODS,
          ...HISTORY_READER_METHODS,
          ...PRODUCER_QUEUE_METHODS,
          ...APPLICATION_RESULT_SOURCE_METHODS,
          ...MEMORY_PROJECTION_SOURCE_METHODS,
          ...RECOVERY_STATUS_READER_METHODS,
          ...REVIEW_HANDOFF_METHODS,
          "readSettlement",
          ...(automaticReviewEnabled ? ["nextForHuman"] : []),
        ]),
      ],
      "queue",
    );
    await guard.acquire();
    await queue.recover();
    const historyReader = createQueueFacade(queue, HISTORY_READER_METHODS);
    return Object.freeze({
      queue: Object.freeze({
        ...createQueueFacade(queue, USER_QUEUE_METHODS),
        ...(automaticReviewEnabled ? { next: options => queue.nextForHuman(options) } : {}),
        historyReader,
      }),
      historyReader,
      reviewHandoffs: createQueueFacade(queue, REVIEW_HANDOFF_METHODS),
      reviewHandoffAssignee: typeof githubExecutor?.assignAssignee === "function"
        ? Object.freeze({
            assignAssignee: (input, options) =>
              actionAdmissionGate === null
                ? githubExecutor.assignAssignee(input, options)
                : actionAdmissionGate.run(() =>
                    githubExecutor.assignAssignee(input, options)),
            ...(typeof githubExecutor.assignReviewOutcome === "function" ? {
              assignReviewOutcome: (input, options) => actionAdmissionGate === null
                ? githubExecutor.assignReviewOutcome(input, options)
                : actionAdmissionGate.run(() => githubExecutor.assignReviewOutcome(input, options)),
            } : {}),
          })
        : null,
      producerQueue: createQueueFacade(queue, PRODUCER_QUEUE_METHODS),
      applicationResultSource: createQueueFacade(
        queue,
        APPLICATION_RESULT_SOURCE_METHODS,
      ),
      memoryProjectionSource: createQueueFacade(
        queue,
        MEMORY_PROJECTION_SOURCE_METHODS,
      ),
      recoveryStatusReader: createQueueFacade(
        queue,
        RECOVERY_STATUS_READER_METHODS,
      ),
      confirmationSettlementReader: Object.freeze({
        read: (input) => queue.readSettlement(input),
        readMany: (input) => queue.readSettlements(input),
      }),
      close,
    });
  } catch (error) {
    try {
      await close();
    } catch {
      // Preserve the startup error; the operating-system guard still fails closed.
    }
    throw error;
  }
}
