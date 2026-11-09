import path from "node:path";
import { codeJobError } from "./domain/code-job-contract.js";
import { projectRoot } from "./lib/config.js";
import { OperationQueue } from "./lib/operation-queue.js";
import { ProcessExclusiveGuard } from "./lib/process-exclusive-guard.js";
import { StateStore } from "./lib/state-store.js";
import { CodeJobApprovalExecutor } from "./services/code-job-approval-executor.js";
import { CodeJobChangePackageDispatcher } from "./services/code-job-change-package-dispatcher.js";
import { CodeJobStore } from "./services/code-job-store.js";
import { CodeJobWorkerService } from "./services/code-job-worker-service.js";
import { AutomaticCodeJobPauseRecovery } from "./services/automatic-code-job-pause-recovery.js";

const GUARD_NAME = "mydashboard-code-job-v1";

function runtimeClosedError() {
  return codeJobError(
    "CODE_JOB_RUNTIME_CLOSED",
    "代码任务运行时已关闭",
    503,
  );
}

function validateGuard(value) {
  if (
    !value ||
    typeof value.acquire !== "function" ||
    typeof value.run !== "function" ||
    typeof value.close !== "function"
  ) {
    throw new TypeError("code job guard is invalid");
  }
  return value;
}

function validateStore(value) {
  if (
    !value ||
    typeof value.read !== "function" ||
    typeof value.write !== "function"
  ) {
    throw new TypeError("code job durable store is invalid");
  }
  return value;
}

function runtimeDataDirectory(value) {
  if (value === undefined) return path.join(projectRoot, "data");
  if (typeof value !== "string" || !path.isAbsolute(value)) {
    throw new TypeError("code job dataDirectory must be an absolute path");
  }
  return path.resolve(value);
}

function frozenPort(methods) {
  return Object.freeze(methods);
}

function methodDescriptor(value, name) {
  if (
    value === null ||
    (typeof value !== "object" && typeof value !== "function")
  ) {
    return null;
  }
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
  const entries = methods.map((method) => {
    const descriptor = methodDescriptor(value, method);
    if (
      !descriptor ||
      !("value" in descriptor) ||
      typeof descriptor.value !== "function"
    ) {
      throw new TypeError(`${name} is invalid`);
    }
    return [
      method,
      (...args) => Reflect.apply(descriptor.value, value, args),
    ];
  });
  return Object.freeze(Object.fromEntries(entries));
}

function changePackageDeliveryPorts({
  completedChangeExporter,
  changePackageProducer,
  changePackageReader,
  controlledCommitDelivery,
}) {
  const supplied = [
    completedChangeExporter,
    changePackageProducer,
    changePackageReader,
  ].filter((value) => value !== undefined).length;
  if (supplied === 0) {
    if (controlledCommitDelivery !== undefined) {
      throw new TypeError(
        "change package delivery dependencies must be configured together",
      );
    }
    return null;
  }
  if (supplied !== 3) {
    throw new TypeError(
      "change package delivery dependencies must be configured together",
    );
  }
  return Object.freeze({
    completedChangeExporter: bindPort(
      completedChangeExporter,
      ["export"],
      "completed change package exporter",
    ),
    changePackageProducer: bindPort(
      changePackageProducer,
      ["create"],
      "change package producer",
    ),
    changePackageReader: bindPort(
      changePackageReader,
      ["get"],
      "change package reader",
    ),
    ...(controlledCommitDelivery === undefined
      ? {}
      : {
          controlledCommitDelivery: bindPort(
            controlledCommitDelivery,
            ["deliver"],
            "change package controlled commit delivery",
          ),
        }),
  });
}

function normalizeWorkerLimits(value) {
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Object.prototype ||
    Object.keys(value).some(
      (key) => !["maxTurns", "observationLimit", "concurrency"].includes(key),
    )
  ) {
    throw new TypeError("workerLimits is invalid");
  }
  return { ...value };
}

function operationAdmission() {
  let accepting = true;
  const active = new Set();
  return Object.freeze({
    run(operation) {
      if (!accepting) return Promise.reject(runtimeClosedError());
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

function sessionTransitionLease() {
  const queue = new OperationQueue();
  return Object.freeze({
    run(operation) {
      return queue.enqueue(operation);
    },
  });
}

export async function createCodeJobRuntime({
  store,
  grantVerifier,
  executor,
  brainDirectory,
  taskRuns,
  automaticPauseRecovery,
  reviewRepairContextReader,
  conflictSourceReader,
  actionAdmissionGate,
  dataDirectory,
  operationQueue = new OperationQueue(),
  workerOperationQueue = new OperationQueue(),
  clock,
  limits,
  memoryReceiptVerifier,
  completedChangeExporter,
  changePackageProducer,
  changePackageReader,
  controlledCommitDelivery,
  workerLimits = {},
  workerFactory = (options) => new CodeJobWorkerService(options),
  createGuard = (options) => new ProcessExclusiveGuard(options),
} = {}) {
  if (typeof createGuard !== "function") {
    throw new TypeError("createGuard must be a function");
  }
  if (typeof workerFactory !== "function") {
    throw new TypeError("workerFactory must be a function");
  }
  if (
    !workerOperationQueue ||
    typeof workerOperationQueue.enqueue !== "function"
  ) {
    throw new TypeError("workerOperationQueue is invalid");
  }
  if ((executor === undefined) !== (brainDirectory === undefined)) {
    throw new TypeError("executor and brainDirectory must be configured together");
  }
  if (executor !== undefined && grantVerifier === undefined) {
    throw new TypeError("grantVerifier is required when executor is configured");
  }
  const changePackagePorts = changePackageDeliveryPorts({
    completedChangeExporter,
    changePackageProducer,
    changePackageReader,
    controlledCommitDelivery,
  });
  const normalizedWorkerLimits = normalizeWorkerLimits(workerLimits);
  const durableStore = validateStore(
    store === undefined
      ? new StateStore(runtimeDataDirectory(dataDirectory))
      : store,
  );
  const guard = validateGuard(createGuard({ name: GUARD_NAME }));
  const admission = operationAdmission();
  const sessionTransitions = sessionTransitionLease();
  let closePromise = null;
  const close = () => {
    if (closePromise) return closePromise;
    const accepted = admission.stop();
    closePromise = Promise.allSettled(accepted).then(() => guard.close());
    return closePromise;
  };

  try {
    await guard.acquire();
    const jobs = new CodeJobStore({
      store: durableStore,
      exclusiveLease: guard,
      operationQueue,
      ...(clock ? { clock } : {}),
      ...(limits ? { limits } : {}),
      ...(memoryReceiptVerifier === undefined
        ? {}
        : { memoryReceiptVerifier }),
      ...(changePackagePorts === null
        ? {}
        : { changePackageReader: changePackagePorts.changePackageReader }),
    });
    await jobs.recover();
    const changePackageDispatcher = changePackagePorts === null
      ? null
      : new CodeJobChangePackageDispatcher({
          deliverySource: {
            readBatch: (value) => jobs.readChangePackageDeliveryBatch(value),
            ack: (value) => jobs.acknowledgeChangePackageDelivery(value),
          },
          completedChangeExporter:
            changePackagePorts.completedChangeExporter,
          packageProducer: changePackagePorts.changePackageProducer,
          ...(changePackagePorts.controlledCommitDelivery === undefined
            ? {}
            : {
                controlledCommitDelivery:
                  changePackagePorts.controlledCommitDelivery,
              }),
        });
    const approvalExecutor = grantVerifier === undefined
      ? null
      : new CodeJobApprovalExecutor({
          codeJobStore: jobs,
          grantVerifier,
        });
    const worker = executor === undefined
      ? null
      : workerFactory({
          ...normalizedWorkerLimits,
          jobStore: jobs,
          executor,
          brainDirectory,
          taskRuns,
          ...(typeof automaticPauseRecovery?.canReplanUnstartedWrite !== 'function' ? {} : {
            unstartedWriteRecovery: { canRecover: job => automaticPauseRecovery.canReplanUnstartedWrite(job) },
          }),
          ...(reviewRepairContextReader === undefined ? {} : { reviewRepairContextReader }),
          ...(conflictSourceReader == null ? {} : { conflictSourceReader }),
          grantVerifier,
          ...(actionAdmissionGate === undefined
            ? {}
            : { actionAdmissionGate }),
          operationQueue: workerOperationQueue,
          sessionTransitionLease: sessionTransitions,
          ...(changePackageDispatcher === null
            ? {}
            : { changePackageDeliveryEnabled: true }),
        });
    const pauseRecovery = worker === null || automaticPauseRecovery === undefined ? null :
      new AutomaticCodeJobPauseRecovery({ jobs, taskRuns, eligibility: automaticPauseRecovery });
    const workerPort = worker === null
      ? null
      : bindPort(
          worker,
          ["runCycle", "requestCancellation", ...(typeof worker.runReady === 'function' ? ['runReady'] : [])],
          "code job worker",
        );
    const signalWorkerCancellation = (jobId) => {
      if (workerPort === null) return;
      try {
        Promise.resolve(workerPort.requestCancellation(jobId)).catch(() => {});
      } catch {
        // The durable cancellation remains authoritative if interruption fails.
      }
    };
    const controlMutation = (method, value) =>
      admission.run(async () => {
        const changed = await sessionTransitions.run(() => jobs[method](value));
        return Object.freeze({
          status: changed.status,
          job: await jobs.get(changed.job.jobId),
        });
      });
    const cancelMutation = (value) =>
      admission.run(async () => {
        const changed = await sessionTransitions.run(() => jobs.cancel(value));
        if (changed.job.status === "cancelling") {
          signalWorkerCancellation(changed.job.jobId);
        }
        return Object.freeze({
          status: changed.status,
          job: await jobs.get(changed.job.jobId),
        });
      });
    return Object.freeze({
      confirmationExecutor: approvalExecutor === null
        ? null
        : frozenPort({
            execute: (value) =>
              admission.run(() => approvalExecutor.execute(value)),
            reconcile: (value) =>
              admission.run(() => approvalExecutor.reconcile(value)),
          }),
      reader: frozenPort({
        get: (value) => admission.run(() => jobs.get(value)),
        getDetail: (value) => admission.run(() => jobs.getDetail(value)),
        list: (value) => admission.run(() => jobs.list(value)),
        listNewest: (value) => admission.run(() => jobs.listNewest(value)),
        readDeliveryEvidence: (value) =>
          admission.run(() => jobs.readDeliveryEvidence(value)),
      }),
      control: frozenPort({
        pause: (value) => controlMutation("pause", value),
        resume: (value) => controlMutation("resume", value),
        cancel: cancelMutation,
      }),
      projectionSource: frozenPort({
        readBatch: (value) =>
          admission.run(() => jobs.readMemoryProjectionBatch(value)),
        ack: (value) =>
          admission.run(() => jobs.acknowledgeMemoryProjection(value)),
      }),
      changePackageDelivery: changePackageDispatcher === null
        ? null
        : frozenPort({
            runCycle: (value) =>
              admission.run(() => changePackageDispatcher.runCycle(value)),
          }),
      ...(pauseRecovery === null ? {} : { pauseRecovery: frozenPort({
        runCycle: value => admission.run(() => pauseRecovery.runCycle(value)),
      }) }),
      worker: workerPort === null
        ? null
        : frozenPort({
            runCycle: (value) =>
              admission.run(() => workerPort.runCycle(value)),
            ...(workerPort.runReady === undefined ? {} : { runReady(value, runOperation) {
              if (typeof runOperation !== 'function') throw new TypeError('managed code execution requires an operation owner');
              return admission.run(() => workerPort.runReady(value,
                operation => runOperation(() => admission.run(operation))));
            } }),
          }),
      close,
    });
  } catch (error) {
    try {
      await close();
    } catch {
      // Preserve the startup failure after releasing the independent guard.
    }
    throw error;
  }
}
