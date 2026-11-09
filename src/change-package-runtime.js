import path from "node:path";

import { GitCheckoutInspector } from "./adapters/git-checkout-inspector.js";
import { projectRoot } from "./lib/config.js";
import { OperationQueue } from "./lib/operation-queue.js";
import { ProcessExclusiveGuard } from "./lib/process-exclusive-guard.js";
import { StateStore } from "./lib/state-store.js";
import { ChangePackageApplicationProjectionStore } from "./services/change-package-application-projection-store.js";
import { ChangePackageApplicationService } from "./services/change-package-application-service.js";
import { ChangePackageControlledCommitService } from "./services/change-package-controlled-commit-service.js";
import { ChangePackageStore } from "./services/change-package-store.js";

const APPLICATION_GUARD_NAME = "mydashboard-change-package-application-v1";
const CONFIG_KEYS = new Set(["enabled", "gitCommand", "gitTimeoutMs"]);

export class ChangePackageRuntimeError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "ChangePackageRuntimeError";
    this.code = code;
  }
}

function invalidConfig(message = "change package 运行配置无效") {
  return new ChangePackageRuntimeError(
    "INVALID_CHANGE_PACKAGE_RUNTIME_CONFIG",
    message,
  );
}

function isPlainRecord(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function dataProperty(record, name, error = new TypeError("invalid dependencies")) {
  const descriptor = Object.getOwnPropertyDescriptor(record, name);
  if (!descriptor) return undefined;
  if (!descriptor.enumerable || !("value" in descriptor)) throw error;
  return descriptor.value;
}

function normalizeEnabledConfig(value) {
  if (value === undefined) return null;
  if (!isPlainRecord(value)) throw invalidConfig();
  for (const key of Reflect.ownKeys(value)) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (
      typeof key !== "string" ||
      !CONFIG_KEYS.has(key) ||
      !descriptor?.enumerable ||
      !("value" in descriptor)
    ) {
      throw invalidConfig();
    }
  }
  const enabled = dataProperty(value, "enabled", invalidConfig());
  if (enabled === false || enabled === undefined) return null;
  if (enabled !== true) throw invalidConfig();
  const gitCommand = dataProperty(value, "gitCommand", invalidConfig());
  if (
    typeof gitCommand !== "string" ||
    !path.isAbsolute(gitCommand) ||
    gitCommand.includes("\0")
  ) {
    throw invalidConfig("gitCommand 必须是可信的绝对路径");
  }
  const gitTimeoutMs = dataProperty(value, "gitTimeoutMs", invalidConfig());
  if (
    gitTimeoutMs !== undefined &&
    (!Number.isSafeInteger(gitTimeoutMs) ||
      gitTimeoutMs < 1 ||
      gitTimeoutMs > 60_000)
  ) {
    throw invalidConfig("gitTimeoutMs 无效");
  }
  return Object.freeze({
    gitCommand: path.resolve(gitCommand),
    ...(gitTimeoutMs === undefined ? {} : { gitTimeoutMs }),
  });
}

function validateDependencies(value) {
  if (!isPlainRecord(value)) {
    throw new TypeError("dependencies must be a plain object");
  }
  const defaults = {
    createApplicationProjectionStore: (options) =>
      new ChangePackageApplicationProjectionStore(options),
    createApplicationService: (options) =>
      new ChangePackageApplicationService(options),
    createControlledCommitService: (options) =>
      new ChangePackageControlledCommitService(options),
    createGitInspector: (options) => new GitCheckoutInspector(options),
    createGuard: (options) => new ProcessExclusiveGuard(options),
    createOperationQueue: () => new OperationQueue(),
    createPackageStore: (options) => new ChangePackageStore(options),
    createStore: (dataDirectory) => new StateStore(dataDirectory),
  };
  return Object.fromEntries(
    Object.entries(defaults).map(([name, fallback]) => {
      const configured = dataProperty(value, name);
      const factory = configured === undefined ? fallback : configured;
      if (typeof factory !== "function") {
        throw new TypeError(`${name} must be a function`);
      }
      return [name, factory];
    }),
  );
}

function absoluteDirectory(value, fallback, label) {
  const selected = value === undefined ? fallback : value;
  if (
    typeof selected !== "string" ||
    !path.isAbsolute(selected) ||
    selected.includes("\0")
  ) {
    throw invalidConfig(`${label} 必须是绝对路径`);
  }
  return path.resolve(selected);
}

function methodDescriptor(value, name) {
  let owner = value;
  while (
    owner !== null &&
    owner !== Object.prototype &&
    owner !== Function.prototype
  ) {
    const descriptor = Object.getOwnPropertyDescriptor(owner, name);
    if (descriptor) return descriptor;
    owner = Object.getPrototypeOf(owner);
  }
  return null;
}

function bindPort(value, methods, name) {
  if (
    !value ||
    (typeof value !== "object" && typeof value !== "function")
  ) {
    throw new TypeError(`${name} does not implement its required contract`);
  }
  const captured = methods.map((method) => {
    const descriptor = methodDescriptor(value, method);
    if (!descriptor || !("value" in descriptor) || typeof descriptor.value !== "function") {
      throw new TypeError(`${name} does not implement its required contract`);
    }
    return [method, descriptor.value];
  });
  return Object.freeze(
    Object.fromEntries(
      captured.map(([method, implementation]) => [
        method,
        (...args) => Reflect.apply(implementation, value, args),
      ]),
    ),
  );
}

function admittedPort(value, methods, name, admission) {
  const port = bindPort(value, methods, name);
  return Object.freeze(
    Object.fromEntries(
      methods.map((method) => [
        method,
        (...args) => admission.run(() => port[method](...args)),
      ]),
    ),
  );
}

function operationAdmission() {
  let accepting = true;
  const active = new Set();
  return Object.freeze({
    run(operation) {
      if (!accepting) {
        return Promise.reject(
          new ChangePackageRuntimeError(
            "CHANGE_PACKAGE_RUNTIME_CLOSED",
            "change package 运行时已关闭",
          ),
        );
      }
      let result;
      try {
        result = Promise.resolve(operation());
      } catch (error) {
        result = Promise.reject(error);
      }
      active.add(result);
      result.then(
        () => active.delete(result),
        () => active.delete(result),
      );
      return result;
    },
    stop() {
      accepting = false;
      return [...active];
    },
  });
}

function closeOnce(admission, guard) {
  let result = null;
  return () => {
    if (!result) {
      const active = admission.stop();
      result = Promise.allSettled(active).then(() => guard.close());
    }
    return result;
  };
}

export async function createChangePackageRuntime(config, dependencies = {}) {
  const enabled = normalizeEnabledConfig(config);
  if (!enabled) return null;

  const factories = validateDependencies(dependencies);
  const dataDirectory = absoluteDirectory(
    dataProperty(dependencies, "dataDirectory"),
    path.join(projectRoot, "data"),
    "change package 数据目录",
  );
  const packageRoot = absoluteDirectory(
    dataProperty(dependencies, "packageRoot"),
    path.join(dataDirectory, "change-packages"),
    "change package 存储目录",
  );
  const configuredStore = dataProperty(dependencies, "store");
  const configuredTargets = dataProperty(dependencies, "trustedTargets");
  const configuredControlledCommitBuilder = dataProperty(
    dependencies,
    "controlledCommitBuilder",
  );
  const configuredApplicationAuthorityVerifier = dataProperty(
    dependencies,
    "applicationAuthorityVerifier",
  );
  const trustedTargets =
    configuredTargets === undefined ? [] : configuredTargets;
  const applicationAuthorityVerifier = bindPort(
    configuredApplicationAuthorityVerifier ?? {
      verify() {
        throw new Error("change package source authority is unavailable");
      },
    },
    ["verify"],
    "applicationAuthorityVerifier",
  );
  const processRunner = dataProperty(dependencies, "processRunner");
  const clock = dataProperty(dependencies, "clock");
  const store = bindPort(
    configuredStore === undefined
      ? factories.createStore(dataDirectory)
      : configuredStore,
    ["read", "write"],
    "store",
  );
  const packageStore = bindPort(
    factories.createPackageStore({
      root: packageRoot,
      createGuard: factories.createGuard,
    }),
    ["recover", "producer", "reader"],
    "packageStore",
  );
  const rawPackageProducer = packageStore.producer();
  const rawPackageReader = packageStore.reader();
  const packageProducer = bindPort(
    rawPackageProducer,
    ["create"],
    "packageProducer",
  );
  const packageReader = bindPort(
    rawPackageReader,
    ["get", "readFile"],
    "packageReader",
  );

  const inspectorOptions = {
    gitCommand: enabled.gitCommand,
    ...(enabled.gitTimeoutMs === undefined
      ? {}
      : { timeoutMs: enabled.gitTimeoutMs }),
  };
  if (processRunner !== undefined) inspectorOptions.processRunner = processRunner;
  const gitInspector = bindPort(
    factories.createGitInspector(inspectorOptions),
    ["inspect"],
    "gitInspector",
  );
  const guard = bindPort(
    factories.createGuard({ name: APPLICATION_GUARD_NAME }),
    ["acquire", "run", "close"],
    "guard",
  );
  const admission = operationAdmission();
  const close = closeOnce(admission, guard);

  try {
    const operationQueue = bindPort(
      factories.createOperationQueue(),
      ["enqueue"],
      "operationQueue",
    );
    const applicationProjectionStore = bindPort(
      factories.createApplicationProjectionStore({
        store,
        exclusiveLease: guard,
        operationQueue,
      }),
      ["recover", "reader", "getCheckpoint", "applySnapshot"],
      "applicationProjectionStore",
    );
    const applicationProjectionReader = bindPort(
      applicationProjectionStore.reader(),
      ["getForJob", "getForPackage", "getSummary"],
      "applicationProjectionReader",
    );
    const controlledCommitService = configuredControlledCommitBuilder === undefined
      ? null
      : bindPort(
          factories.createControlledCommitService({
            packageReader,
            controlledCommitBuilder: bindPort(
              configuredControlledCommitBuilder,
              ["create", "find", "verify", ...(typeof Object.getOwnPropertyDescriptor(configuredControlledCommitBuilder, "readSealed")?.value === "function" ? ["readSealed"] : [])],
              "controlledCommitBuilder",
            ),
            store,
            exclusiveLease: guard,
            operationQueue,
          }),
          ["recover", "delivery"],
          "controlledCommitService",
        );
    const applicationOptions = {
      packageReader,
      trustedTargets,
      gitInspector,
      applicationAuthorityVerifier,
      store,
      exclusiveLease: guard,
      operationQueue,
    };
    if (clock !== undefined) applicationOptions.clock = clock;
    const application = bindPort(
      factories.createApplicationService(applicationOptions),
      ["recover", "producer", "executor", "reader"],
      "applicationService",
    );
    await packageStore.recover();
    await guard.acquire();
    if (controlledCommitService !== null) {
      await controlledCommitService.recover();
    }
    await application.recover();
    await applicationProjectionStore.recover();
    return Object.freeze({
      packageProducer: admittedPort(
        packageProducer,
        ["create"],
        "packageProducer",
        admission,
      ),
      packageReader: admittedPort(
        packageReader,
        ["get", "readFile"],
        "packageReader",
        admission,
      ),
      ...(controlledCommitService === null
        ? {}
        : {
            controlledCommitDelivery: admittedPort(
              bindPort(
                controlledCommitService.delivery(),
                ["deliver"],
                "controlledCommitDelivery",
              ),
              ["deliver"],
              "controlledCommitDelivery",
              admission,
            ),
          }),
      applicationProducer: admittedPort(
        application.producer(),
        ["prepareConfirmation"],
        "applicationProducer",
        admission,
      ),
      applicationExecutor: admittedPort(
        application.executor(),
        ["execute", "reconcile"],
        "applicationExecutor",
        admission,
      ),
      applicationReader: admittedPort(
        application.reader(),
        ["getResult"],
        "applicationReader",
        admission,
      ),
      applicationProjectionReader: admittedPort(
        applicationProjectionReader,
        ["getForJob", "getForPackage", "getSummary"],
        "applicationProjectionReader",
        admission,
      ),
      applicationProjectionWriter: admittedPort(
        applicationProjectionStore,
        ["getCheckpoint", "applySnapshot"],
        "applicationProjectionWriter",
        admission,
      ),
      close,
    });
  } catch (error) {
    try {
      await close();
    } catch {
      // Preserve the startup failure after releasing the application guard.
    }
    throw error;
  }
}
