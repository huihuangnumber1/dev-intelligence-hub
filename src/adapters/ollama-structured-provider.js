import { currentTaskExecution } from "../lib/task-execution-context.js";
import {
  normalizeAbortSignal,
  runStructuredProviderRequest,
} from "../lib/structured-provider-request.js";
import {
  normalizeStructuredBrainRequest,
  readStructuredBrainGenerateInput,
} from "../lib/structured-brain-request.js";

const DEFAULT_BASE_URL = "http://127.0.0.1:11434";
const DEFAULT_TIMEOUT_MS = 45_000;
const DEFAULT_MAX_RESPONSE_BYTES = 128 * 1024;
const DEFAULT_MAX_REQUEST_BYTES = 256 * 1024;
const DEFAULT_CONTEXT_TOKENS = 8_192;
const SAFE_ID = /^[a-z0-9](?:[a-z0-9._-]{0,126}[a-z0-9])?$/;
const OPTION_KEYS = new Set([
  "id",
  "fetch",
  "baseUrl",
  "timeoutMs",
  "maxResponseBytes",
  "maxRequestBytes",
  "contextTokens",
]);

export class OllamaStructuredProviderError extends Error {
  constructor(code, message, statusCode = 500) {
    super(message);
    this.name = "OllamaStructuredProviderError";
    this.code = code;
    this.statusCode = statusCode;
  }
}

function providerError(code, message, statusCode) {
  return new OllamaStructuredProviderError(code, message, statusCode);
}

function cancellationError() {
  return providerError(
    "STRUCTURED_PROVIDER_CANCELLED",
    "Structured provider request was cancelled",
    499,
  );
}

function timeoutError() {
  return providerError(
    "STRUCTURED_PROVIDER_TIMEOUT",
    "Structured provider request timed out",
    504,
  );
}

function plainOptions(value) {
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Object.prototype ||
    Reflect.ownKeys(value).some((key) => {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      return (
        typeof key !== "string" ||
        !OPTION_KEYS.has(key) ||
        !descriptor?.enumerable ||
        !("value" in descriptor)
      );
    })
  ) {
    throw new TypeError("Ollama structured provider options are invalid");
  }
  return value;
}

function safeId(value) {
  if (typeof value !== "string" || !SAFE_ID.test(value)) {
    throw new TypeError("provider id is invalid");
  }
  return value;
}

function boundedInteger(value, name, minimum, maximum) {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new TypeError(`${name} is outside the supported range`);
  }
  return value;
}

function isLoopback(hostname) {
  const host = hostname.toLowerCase();
  return (
    host === "localhost" ||
    host === "::1" ||
    host === "[::1]" ||
    /^127(?:\.\d{1,3}){3}$/.test(host)
  );
}

function endpoint(value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new TypeError("Ollama baseUrl is invalid");
  }
  if (!new Set(["http:", "https:"]).has(url.protocol)) {
    throw new TypeError("Ollama baseUrl must use HTTP or HTTPS");
  }
  if (url.username || url.password) {
    throw new TypeError("Ollama baseUrl must not contain userinfo");
  }
  if (url.search || url.hash) {
    throw new TypeError("Ollama baseUrl must not contain query or fragment");
  }
  const remote = !isLoopback(url.hostname);
  if (remote && url.protocol !== "https:") {
    throw new TypeError("Remote endpoint must use HTTPS");
  }
  return {
    remote,
    requestUrl: `${url.toString().replace(/\/+$/, "")}/api/chat`,
  };
}

async function boundedResponseText(response, maximumBytes) {
  if (!response.body || typeof response.body.getReader !== "function") {
    throw providerError(
      "STRUCTURED_PROVIDER_RESPONSE_INVALID",
      "Structured provider response is invalid",
      502,
    );
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let bytes = 0;
  let text = "";
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > maximumBytes) {
        await reader.cancel().catch(() => {});
        throw providerError(
          "STRUCTURED_PROVIDER_RESPONSE_TOO_LARGE",
          "Structured provider response exceeds the configured limit",
          413,
        );
      }
      text += decoder.decode(value, { stream: true });
    }
    return text + decoder.decode();
  } catch (error) {
    if (error instanceof OllamaStructuredProviderError) throw error;
    throw providerError(
      "STRUCTURED_PROVIDER_RESPONSE_INVALID",
      "Structured provider response is invalid",
      502,
    );
  }
}

function responseContent(text) {
  let envelope;
  try {
    envelope = JSON.parse(text);
  } catch {
    throw providerError(
      "STRUCTURED_PROVIDER_RESPONSE_INVALID",
      "Structured provider response is invalid",
      502,
    );
  }
  const content = envelope?.message?.content;
  if (typeof content !== "string") {
    throw providerError(
      "STRUCTURED_PROVIDER_RESPONSE_INVALID",
      "Structured provider response is invalid",
      502,
    );
  }
  const fenced = /^```(?:json)?\r?\n([\s\S]*?)\r?\n```$/i.exec(
    content.trim(),
  );
  return fenced ? fenced[1].trim() : content;
}

export class OllamaStructuredProvider {
  #fetch;
  #requestUrl;
  #timeoutMs;
  #maxResponseBytes;
  #maxRequestBytes;
  #contextTokens;

  constructor(rawOptions = {}) {
    const options = plainOptions(rawOptions);
    if (options.fetch !== undefined && typeof options.fetch !== "function") {
      throw new TypeError("Ollama structured provider requires fetch");
    }
    const target = endpoint(options.baseUrl ?? DEFAULT_BASE_URL);
    this.id = safeId(options.id ?? "ollama");
    this.kind = "ollama";
    this.remote = target.remote;
    this.#fetch = options.fetch ?? globalThis.fetch;
    if (typeof this.#fetch !== "function") {
      throw new TypeError("Ollama structured provider requires fetch");
    }
    this.#requestUrl = target.requestUrl;
    this.#timeoutMs = boundedInteger(
      options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      "timeoutMs",
      10,
      120_000,
    );
    this.#maxResponseBytes = boundedInteger(
      options.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES,
      "maxResponseBytes",
      1_024,
      1024 * 1024,
    );
    this.#maxRequestBytes = boundedInteger(
      options.maxRequestBytes ?? DEFAULT_MAX_REQUEST_BYTES,
      "maxRequestBytes",
      1_024,
      2 * 1024 * 1024,
    );
    this.#contextTokens = boundedInteger(
      options.contextTokens ?? DEFAULT_CONTEXT_TOKENS,
      "contextTokens",
      1_024,
      128 * 1024,
    );
    Object.freeze(this);
  }

  async generate(rawRequest = {}) {
    const input = readStructuredBrainGenerateInput(rawRequest);
    const externalSignal = normalizeAbortSignal(input.signal);
    if (externalSignal?.aborted) throw cancellationError();
    const request = normalizeStructuredBrainRequest(
      {
        model: input.model,
        messages: input.messages,
        schema: input.schema,
      },
      { maxRequestBytes: this.#maxRequestBytes },
    );
    const body = JSON.stringify({
      model: request.model,
      stream: false,
      think: false,
      keep_alive: "30m",
      format: request.schema,
      options: { temperature: 0, num_ctx: this.#contextTokens },
      messages: request.messages,
    });
    if (Buffer.byteLength(body, "utf8") > this.#maxRequestBytes) {
      throw providerError(
        "STRUCTURED_PROVIDER_REQUEST_TOO_LARGE",
        "Structured provider request exceeds the configured limit",
        413,
      );
    }
    const controller = new AbortController();
    return runStructuredProviderRequest({
      controller,
      timeoutMs: this.#timeoutMs,
      signal: externalSignal,
      cancellationError,
      timeoutError,
      operation: async () => {
        let response;
        try {
          currentTaskExecution()?.reportModelState?.("running");
          response = await this.#fetch(this.#requestUrl, {
            method: "POST",
            redirect: "error",
            headers: { "content-type": "application/json" },
            body,
            signal: controller.signal,
          });
        } catch {
          throw providerError(
            "STRUCTURED_PROVIDER_REQUEST_FAILED",
            "Structured provider request failed",
            502,
          );
        }
        if (!response?.ok) {
          throw providerError(
            "STRUCTURED_PROVIDER_HTTP_FAILED",
            `Structured provider request failed with HTTP ${Number(response?.status) || 0}`,
            502,
          );
        }
        return responseContent(
          await boundedResponseText(response, this.#maxResponseBytes),
        );
      },
    });
  }
}
