import { normalizeBrainConfig } from "../services/brain-router.js";
import { normalizeAbortSignal } from "../lib/structured-provider-request.js";
import { githubEntitySessionKey } from "../lib/session-key.js";
import { normalizeNativeFailure } from "../services/task-run-execution-receipts.js";
import { isBrainCapacityFailure, isBrainModelFailure, isBrainRequestInfrastructureFailure } from "../domain/brain-failure-recovery.js";
import { InvalidEmployeeResultError, preparePrEmployeeAnalysis, parsePrEmployeeResult } from "./ollama-pr-employee-reviewer.js";

const FALLBACK_CODES = new Set([
  "STRUCTURED_PROVIDER_UNAVAILABLE", "STRUCTURED_PROVIDER_CREDENTIAL_UNAVAILABLE",
  "STRUCTURED_PROVIDER_PROCESS_FAILED", "STRUCTURED_PROVIDER_PROCESS_EXITED",
  "STRUCTURED_PROVIDER_TIMEOUT", "STRUCTURED_PROVIDER_QUEUE_TIMEOUT", "STRUCTURED_PROVIDER_BUSY",
  "STRUCTURED_PROVIDER_RESPONSE_INVALID", "STRUCTURED_PROVIDER_RESPONSE_TOO_LARGE",
  "STRUCTURED_PROVIDER_OUTPUT_LIMIT",
]);

function transportFailure(error, provider) {
  return provider === "ollama" && error?.code === undefined && error?.message === "Ollama employee transport request failed";
}

export class RoutedPrEmployeeReviewer {
  #failureReceipts = new WeakMap();

  constructor({ router, primaryBrain, fallback, timeoutMs = 90_000, contextTokens = 8192 }) {
    if (typeof router?.generate !== "function" || typeof fallback?.analyze !== "function" ||
        !Number.isSafeInteger(timeoutMs) || timeoutMs < 1 ||
        !Number.isSafeInteger(contextTokens) || contextTokens < 1) throw new TypeError("PR employee routing ports are invalid");
    this.router = router;
    this.brain = normalizeBrainConfig(primaryBrain);
    this.provider = this.brain.provider;
    this.model = this.brain.model;
    this.fallback = fallback;
    this.timeoutMs = timeoutMs;
    this.contextTokens = contextTokens;
  }

  async analyze(input, options) {
    return (await this.analyzeWithReceipt(input, options)).analysis;
  }

  getFailureReceipt(error) {
    const receipt = this.#failureReceipts.get(error);
    return receipt ? structuredClone(receipt) : null;
  }

  async analyzeWithReceipt(input, options) {
    const signal = normalizeAbortSignal(options?.signal ?? null);
    signal?.throwIfAborted();
    const { context, messages, schema } = preparePrEmployeeAnalysis(input, { contextTokens: this.contextTokens });
    const sessionKey = githubEntitySessionKey({ kind: "pull_request", repository: context.repository, number: context.number });
    const controller = new AbortController();
    let timedOut = false;
    const abort = () => controller.abort(signal.reason);
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) abort();
    let timer;
    let fallbackReason;
    let nativeFailure;
    try {
      const generate = () => {
        controller.signal.throwIfAborted();
        timer = setTimeout(() => {
          timedOut = true;
          controller.abort(Object.assign(new Error("PR employee primary model timed out"), { code: "PR_EMPLOYEE_PRIMARY_TIMEOUT" }));
        }, this.timeoutMs);
        return this.router.generate({ brain: this.brain, messages, schema,
          dataClasses: ["requirements", "code"], sessionKey, admissionEntityKey: sessionKey, signal: controller.signal });
      };
      const response = await (typeof this.router.withAdmission === "function"
        ? this.router.withAdmission(this.brain, { entityKey: sessionKey, signal: controller.signal }, generate) : generate());
      signal?.throwIfAborted();
      if (timedOut) fallbackReason = "PR_EMPLOYEE_PRIMARY_TIMEOUT";
      else return { analysis: parsePrEmployeeResult(response, context), brain: { provider: this.provider, model: this.model } };
    } catch (error) {
      this.#failureReceipts.delete(error);
      signal?.throwIfAborted();
      if (isBrainCapacityFailure(error?.code)) {
        this.#failureReceipts.set(error, { brain: { provider: this.provider, model: this.model }, modelFailure: false, infrastructureFailure: true });
        throw error;
      }
      if (error instanceof InvalidEmployeeResultError) fallbackReason = "PR_EMPLOYEE_RESULT_INVALID";
      else if (FALLBACK_CODES.has(error?.code)) fallbackReason = error.code;
      else if (timedOut && ["STRUCTURED_PROVIDER_CANCELLED", "BRAIN_REQUEST_CANCELLED", "PR_EMPLOYEE_PRIMARY_TIMEOUT"].includes(error?.code)) {
        fallbackReason = "PR_EMPLOYEE_PRIMARY_TIMEOUT";
      } else throw error;
      try {
        nativeFailure = normalizeNativeFailure(Object.getOwnPropertyDescriptor(error, "nativeFailure")?.value);
      } catch { /* Only retain validated protocol metadata. */ }
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
    }
    signal?.throwIfAborted();
    const brain = { provider: this.fallback.provider, model: this.fallback.model,
      fallbackFrom: { provider: this.provider, model: this.model, reason: fallbackReason,
        ...(nativeFailure ? { nativeFailure } : {}) } };
    try {
      await this.fallback.checkAvailability?.(options);
      signal?.throwIfAborted();
      const analysis = await this.fallback.analyze(input, options);
      signal?.throwIfAborted();
      return { analysis, brain };
    } catch (error) {
      this.#failureReceipts.delete(error);
      signal?.throwIfAborted();
      if (error !== null && (typeof error === "object" || typeof error === "function")) {
        const knownFailure = error instanceof InvalidEmployeeResultError || FALLBACK_CODES.has(error?.code) || transportFailure(error, brain.provider);
        const modelFailure = error?.code !== "STRUCTURED_PROVIDER_UNAVAILABLE" && knownFailure && (fallbackReason === "PR_EMPLOYEE_RESULT_INVALID" || isBrainModelFailure(fallbackReason) ||
          error instanceof InvalidEmployeeResultError || isBrainModelFailure(error?.code));
        const infrastructureFailure = !modelFailure && (transportFailure(error, brain.provider) ||
          (FALLBACK_CODES.has(error?.code) && isBrainRequestInfrastructureFailure(error.code)));
        this.#failureReceipts.set(error, { brain, modelFailure, ...(infrastructureFailure ? { infrastructureFailure: true } : {}) });
      }
      throw error;
    }
  }
}
