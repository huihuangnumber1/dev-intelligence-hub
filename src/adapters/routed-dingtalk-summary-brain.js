import {
  InvalidDingTalkDigestError,
  createDingTalkDigestSchema,
  dingTalkSystemPrompt,
  parseDingTalkDigest,
  summarizeDingTalkConversations,
} from "./ollama-brain.js";
import { normalizeNativeFailure } from "../services/task-run-execution-receipts.js";

const FALLBACKABLE_CODES = new Set([
  "STRUCTURED_PROVIDER_UNAVAILABLE", "STRUCTURED_PROVIDER_CREDENTIAL_UNAVAILABLE",
  "STRUCTURED_PROVIDER_PROCESS_FAILED", "STRUCTURED_PROVIDER_TIMEOUT",
  "STRUCTURED_PROVIDER_RESPONSE_INVALID", "STRUCTURED_PROVIDER_RESPONSE_TOO_LARGE",
  "STRUCTURED_PROVIDER_OUTPUT_LIMIT",
]);

function abortError(signal) {
  if (signal?.aborted) throw signal.reason || Object.assign(new Error("DingTalk summary cancelled"), { name: "AbortError" });
}

function failureCode(error, fallback = "UNKNOWN_PROVIDER_FAILURE") {
  return typeof error?.code === "string" && /^[A-Z0-9_]{1,80}$/.test(error.code)
    ? error.code
    : fallback;
}

export class RoutedDingTalkSummaryBrain {
  constructor({ router, primaryBrain, allowRemoteDingTalkSummary = false, fallback, timeoutMs = 90_000 } = {}) {
    if (!router || typeof router.generate !== "function") throw new TypeError("DingTalk primary brain router is required");
    if (allowRemoteDingTalkSummary !== true) throw new TypeError("remote DingTalk summary authorization is required");
    if (!fallback || typeof fallback.summarizeDingTalk !== "function") throw new TypeError("DingTalk local fallback is required");
    this.router = router;
    this.primaryBrain = primaryBrain;
    this.fallback = fallback;
    this.timeoutMs = timeoutMs;
    this.provider = primaryBrain.provider;
    this.model = primaryBrain.model;
  }

  assessPullRequest(item, options) { return this.fallback.assessPullRequest(item, options); }

  async summarizeDingTalk(conversations, options = {}) {
    return (await this.summarizeDingTalkWithReceipt(conversations, options)).summaries;
  }

  async summarizeDingTalkWithReceipt(conversations, { signal = null } = {}) {
    let useFallback = false;
    const summaries = await summarizeDingTalkConversations(conversations, {
      signal,
      numCtx: this.fallback.numCtx,
      summarizeBatch: async (batch, batchOptions) => {
        abortError(batchOptions.signal);
        if (useFallback) return this.#fallbackBatch(batch, batchOptions);
        const groupIds = batch.map(({ groupId }) => groupId);
        const controller = new AbortController();
        const relay = () => controller.abort(signal.reason);
        signal?.addEventListener("abort", relay, { once: true });
        let timedOut = false;
        const timer = setTimeout(() => {
          timedOut = true;
          controller.abort(Object.assign(new Error("Luna DingTalk summary timed out"), { code: "STRUCTURED_PROVIDER_TIMEOUT" }));
        }, this.timeoutMs);
        try {
          const response = await this.router.generate({
            brain: { ...this.primaryBrain, remoteData: { ...this.primaryBrain.remoteData, dingtalk: true } },
            messages: [
              { role: "system", content: dingTalkSystemPrompt(false) },
              { role: "user", content: JSON.stringify(batch) },
            ],
            schema: createDingTalkDigestSchema(groupIds),
            dataClasses: ["dingtalk"],
            signal: controller.signal,
          });
          abortError(signal);
          return parseDingTalkDigest(typeof response === "string" || response?.summaries ? response : response?.message?.content, groupIds);
        } catch (error) {
          abortError(signal);
          if (!timedOut && !(error instanceof InvalidDingTalkDigestError) && !FALLBACKABLE_CODES.has(error?.code)) throw error;
          useFallback = true;
          const primaryFailureCode = timedOut
            ? "STRUCTURED_PROVIDER_TIMEOUT"
            : failureCode(error, error instanceof InvalidDingTalkDigestError ? "STRUCTURED_PROVIDER_RESPONSE_INVALID" : undefined);
          try {
            return await this.#fallbackBatch(batch, batchOptions);
          } catch (fallbackError) {
            const combined = new Error(fallbackError?.message || "DingTalk summary providers failed", { cause: fallbackError });
            combined.code = "DINGTALK_SUMMARY_BOTH_PROVIDERS_FAILED";
            combined.primaryFailureCode = primaryFailureCode;
            combined.fallbackFailureCode = failureCode(fallbackError);
            try {
              const diagnostic = Object.getOwnPropertyDescriptor(error, "nativeFailure")?.value;
              if (diagnostic) combined.primaryNativeFailure = normalizeNativeFailure(diagnostic);
            } catch { /* Keep provider-owned text and invalid diagnostics out of the public receipt. */ }
            throw combined;
          }
        } finally {
          clearTimeout(timer);
          signal?.removeEventListener("abort", relay);
        }
      },
    });
    return { summaries, fallbackUsed: useFallback };
  }

  async #fallbackBatch(batch, options) {
    if (typeof this.fallback.summarizeDingTalkBatch === "function") {
      return this.fallback.summarizeDingTalkBatch(batch, options);
    }
    return this.fallback.summarizeDingTalk(batch, options);
  }
}
