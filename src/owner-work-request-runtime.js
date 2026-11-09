import { ProcessExclusiveGuard } from "./lib/process-exclusive-guard.js";
import { OwnerWorkRequestService } from "./services/owner-work-request-service.js";

const GUARD_NAME = "mydashboard-owner-work-requests-v1";

function closedError() {
  return Object.assign(new Error("所有者工作请求运行时已关闭"), {
    code: "OWNER_WORK_REQUEST_RUNTIME_CLOSED",
    statusCode: 503,
  });
}

export async function createOwnerWorkRequestRuntime({
  store,
  workflowRouting,
  ledger,
  roleReadiness,
  capabilityReadiness,
  pullRequestResolver,
  incomingReviewReader,
  actionAdmissionGate,
  operationQueue,
  clock,
  createGuard = (options) => new ProcessExclusiveGuard(options),
} = {}) {
  if (typeof createGuard !== "function") {
    throw new TypeError("createGuard must be a function");
  }
  const guard = createGuard({ name: GUARD_NAME });
  if (
    !guard ||
    typeof guard.acquire !== "function" ||
    typeof guard.run !== "function" ||
    typeof guard.close !== "function"
  ) {
    throw new TypeError("owner work request guard is invalid");
  }
  let accepting = true;
  let closePromise = null;
  const active = new Set();
  const admit = (operation) => {
    if (!accepting) return Promise.reject(closedError());
    let promise;
    try {
      promise = Promise.resolve(operation());
    } catch (error) {
      promise = Promise.reject(error);
    }
    active.add(promise);
    promise.then(
      () => active.delete(promise),
      () => active.delete(promise),
    );
    return promise;
  };
  const close = () => {
    accepting = false;
    closePromise ||= Promise.allSettled([...active]).then(() => guard.close());
    return closePromise;
  };

  try {
    await guard.acquire();
    const service = new OwnerWorkRequestService({
      store,
      workflowRouting,
      ledger,
      roleReadiness,
      ...(capabilityReadiness === undefined ? {} : { capabilityReadiness }),
      ...(pullRequestResolver === undefined ? {} : { pullRequestResolver }),
      ...(incomingReviewReader === undefined ? {} : { incomingReviewReader }),
      exclusiveLease: guard,
      ...(actionAdmissionGate === undefined ? {} : { actionAdmissionGate }),
      ...(operationQueue === undefined ? {} : { operationQueue }),
      ...(clock === undefined ? {} : { clock }),
    });
    await service.recover();
    return Object.freeze({
      submit: (request, options) => admit(() => service.submit(request, options)),
      submitInternalReview: (request, options) => admit(() => service.submitInternalReview(request, options)),
      get: (requestId) => admit(() => service.get(requestId)),
      list: (options) => admit(() => service.list(options)),
      resumePending: () => admit(() => service.resumePending()),
      refreshBlockedPullRequestSources: options => admit(() => service.refreshBlockedPullRequestSources(options)),
      verifyAutomaticReviewContinuation: binding => admit(() => service.verifyAutomaticReviewContinuation(binding)),
      close,
    });
  } catch (error) {
    try {
      await close();
    } catch {
      // Preserve the startup failure after releasing the dedicated guard.
    }
    throw error;
  }
}

export function createLazyOwnerWorkRequestRuntime(factory) {
  if (typeof factory !== "function") {
    throw new TypeError("owner work request runtime factory must be a function");
  }
  let runtimePromise = null;
  let closed = false;
  const resolve = async () => {
    if (closed) throw closedError();
    if (runtimePromise === null) {
      const attempt = Promise.resolve().then(factory);
      runtimePromise = attempt;
      attempt.catch(() => {
        if (runtimePromise === attempt) runtimePromise = null;
      });
    }
    const runtime = await runtimePromise;
    if (
      !runtime ||
      !["submit", "get", "list", "resumePending", "close"].every(
        (method) => typeof runtime[method] === "function",
      )
    ) {
      throw new TypeError("owner work request runtime is invalid");
    }
    return runtime;
  };
  return Object.freeze({
    submit: async (...arguments_) => (await resolve()).submit(...arguments_),
    submitInternalReview: async (...arguments_) => (await resolve()).submitInternalReview(...arguments_),
    get: async (...arguments_) => (await resolve()).get(...arguments_),
    list: async (...arguments_) => (await resolve()).list(...arguments_),
    resumePending: async (...arguments_) =>
      (await resolve()).resumePending(...arguments_),
    refreshBlockedPullRequestSources: async (...arguments_) =>
      (await resolve()).refreshBlockedPullRequestSources(...arguments_),
    verifyAutomaticReviewContinuation: async (...arguments_) =>
      (await resolve()).verifyAutomaticReviewContinuation(...arguments_),
    async close() {
      closed = true;
      if (runtimePromise === null) return;
      const runtime = await runtimePromise;
      await runtime.close();
    },
  });
}
