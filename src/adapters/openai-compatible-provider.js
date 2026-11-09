import { types as utilTypes } from "node:util";
import { currentTaskExecution } from "../lib/task-execution-context.js";

import {
  normalizeAbortSignal,
  runStructuredProviderRequest,
} from "../lib/structured-provider-request.js";
import {
  normalizeStructuredBrainRequest,
  readStructuredBrainGenerateInput,
} from "../lib/structured-brain-request.js";

const DEFAULT_TIMEOUT_MS = 45_000;
const DEFAULT_MAX_RESPONSE_BYTES = 128 * 1024;
const DEFAULT_MAX_REQUEST_BYTES = 256 * 1024;
const CHAT_COMPLETIONS_PROTOCOL = "chat-completions";
const RESPONSES_PROTOCOL = "responses";
const JSON_SCHEMA_RESPONSE_FORMAT = "json-schema";
const JSON_OBJECT_RESPONSE_FORMAT = "json-object";
// Persisted providers created before protocol became explicit retain their
// bounded historical limits. New configuration templates always write a
// protocol; tightening old records requires a separately previewed migration.
const LEGACY_LIMITS = Object.freeze({
  minimumTimeoutMs: 1,
  maximumTimeoutMs: 2 * 1024 * 1024,
  minimumResponseBytes: 1,
  maximumResponseBytes: 2 * 1024 * 1024,
  minimumRequestBytes: 1,
  maximumRequestBytes: 2 * 1024 * 1024,
});
const PROTOCOL_LIMITS = Object.freeze({
  [CHAT_COMPLETIONS_PROTOCOL]: Object.freeze({
    minimumTimeoutMs: 10,
    maximumTimeoutMs: 120_000,
    minimumResponseBytes: 1_024,
    maximumResponseBytes: 1024 * 1024,
    minimumRequestBytes: 1_024,
    maximumRequestBytes: 2 * 1024 * 1024,
  }),
  [RESPONSES_PROTOCOL]: Object.freeze({
    minimumTimeoutMs: 1_000,
    maximumTimeoutMs: 3_600_000,
    minimumResponseBytes: 1_024,
    maximumResponseBytes: 1024 * 1024,
    minimumRequestBytes: 1_024,
    maximumRequestBytes: 1024 * 1024,
  }),
});
const SAFE_ID = /^[a-z0-9](?:[a-z0-9._-]{0,126}[a-z0-9])?$/;
const SAFE_ENV_NAME = /^[A-Z_][A-Z0-9_]{0,127}$/;
const API_KEY = /^[^\s\u0000-\u001f\u007f]{1,4096}$/;
const OPTION_KEYS = new Set([
  "id",
  "fetch",
  "baseUrl",
  "apiKeyEnv",
  "env",
  "environment",
  "timeoutMs",
  "maxResponseBytes",
  "maxRequestBytes",
  "protocol",
  "responseFormat",
]);

export class OpenAICompatibleProviderError extends Error {
  constructor(code, message, statusCode = 500) {
    super(message);
    this.name = "OpenAICompatibleProviderError";
    this.code = code;
    this.statusCode = statusCode;
  }
}

function providerError(code, message, statusCode) {
  return new OpenAICompatibleProviderError(code, message, statusCode);
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

function optionsObject(value) {
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
    throw new TypeError("OpenAI-compatible provider options are invalid");
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

function safeProtocol(value) {
  if (typeof value !== "string" || !Object.hasOwn(PROTOCOL_LIMITS, value)) {
    throw new TypeError("OpenAI-compatible protocol is invalid");
  }
  return value;
}

function safeResponseFormat(value) {
  if (
    typeof value !== "string" ||
    !new Set([
      JSON_SCHEMA_RESPONSE_FORMAT,
      JSON_OBJECT_RESPONSE_FORMAT,
    ]).has(value)
  ) {
    throw new TypeError("OpenAI-compatible response format is invalid");
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

function endpoint(value, protocol) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new TypeError("OpenAI-compatible baseUrl is invalid");
  }
  if (!new Set(["http:", "https:"]).has(url.protocol)) {
    throw new TypeError("OpenAI-compatible baseUrl must use HTTP or HTTPS");
  }
  if (url.username || url.password) {
    throw new TypeError("OpenAI-compatible baseUrl must not contain userinfo");
  }
  if (url.search || url.hash) {
    throw new TypeError(
      "OpenAI-compatible baseUrl must not contain query or fragment",
    );
  }
  const remote = !isLoopback(url.hostname);
  if (remote && url.protocol !== "https:") {
    throw new TypeError("Remote endpoint must use HTTPS");
  }
  return {
    remote,
    requestUrl: `${url.toString().replace(/\/+$/, "")}/${
      protocol === RESPONSES_PROTOCOL ? "responses" : "chat/completions"
    }`,
  };
}

function credentialReference(environment, name) {
  if (typeof name !== "string" || !SAFE_ENV_NAME.test(name)) {
    throw new TypeError("apiKeyEnv is invalid");
  }
  if (
    !environment ||
    typeof environment !== "object" ||
    utilTypes.isProxy(environment)
  ) {
    throw new TypeError("injected environment is invalid");
  }
  return Object.freeze({ environment, name });
}

function configuredApiKey(reference) {
  const { environment, name } = reference;
  const descriptor = Object.getOwnPropertyDescriptor(environment, name);
  if (
    !descriptor ||
    !("value" in descriptor) ||
    typeof descriptor.value !== "string" ||
    !API_KEY.test(descriptor.value)
  ) {
    throw providerError(
      "BRAIN_CREDENTIAL_UNAVAILABLE",
      "OpenAI-compatible credential is unavailable",
      503,
    );
  }
  return descriptor.value;
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
    if (error instanceof OpenAICompatibleProviderError) throw error;
    throw providerError(
      "STRUCTURED_PROVIDER_RESPONSE_INVALID",
      "Structured provider response is invalid",
      502,
    );
  }
}

function responseEnvelope(text) {
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
  return envelope;
}

function invalidResponse() {
  return providerError(
    "STRUCTURED_PROVIDER_RESPONSE_INVALID",
    "Structured provider response is invalid",
    502,
  );
}

function chatCompletionContent(envelope) {
  const content = envelope?.choices?.[0]?.message?.content;
  if (typeof content !== "string") {
    throw invalidResponse();
  }
  return content;
}

function dataObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function responsesContent(envelope) {
  if (
    !dataObject(envelope) ||
    envelope.object !== "response" ||
    envelope.status !== "completed" ||
    !Array.isArray(envelope.output) ||
    envelope.output.length < 1 ||
    (Object.hasOwn(envelope, "error") && envelope.error !== null) ||
    (Object.hasOwn(envelope, "incomplete_details") &&
      envelope.incomplete_details !== null)
  ) {
    throw invalidResponse();
  }

  let message = null;
  let reasoningItems = 0;
  for (const item of envelope.output) {
    if (!dataObject(item)) throw invalidResponse();
    if (item.type === "reasoning") {
      reasoningItems += 1;
      if (reasoningItems > 1 || message !== null) throw invalidResponse();
      continue;
    }
    if (item.type !== "message" || message !== null) throw invalidResponse();
    message = item;
  }

  if (
    message === null ||
    message.status !== "completed" ||
    message.role !== "assistant" ||
    !Array.isArray(message.content) ||
    message.content.length !== 1
  ) {
    throw invalidResponse();
  }
  const content = message.content[0];
  if (
    !dataObject(content) ||
    content.type !== "output_text" ||
    typeof content.text !== "string" ||
    !content.text.trim()
  ) {
    throw invalidResponse();
  }
  return content.text;
}

function responseContent(text, protocol) {
  const envelope = responseEnvelope(text);
  return protocol === RESPONSES_PROTOCOL
    ? responsesContent(envelope)
    : chatCompletionContent(envelope);
}

function chatCompletionsBody({ model, messages, schema }, responseFormat) {
  if (responseFormat === JSON_OBJECT_RESPONSE_FORMAT) {
    return {
      model,
      messages,
      temperature: 0,
      response_format: { type: "json_object" },
    };
  }
  return {
    model,
    messages,
    temperature: 0,
    response_format: {
      type: "json_schema",
      json_schema: {
        name: "work_decision",
        strict: true,
        schema,
      },
    },
  };
}

function responsesBody({ model, messages, schema }) {
  return {
    model,
    input: messages,
    tools: [],
    tool_choice: "none",
    parallel_tool_calls: false,
    store: false,
    background: false,
    stream: false,
    text: {
      format: {
        type: "json_schema",
        name: "work_decision",
        strict: true,
        schema,
      },
    },
  };
}

function requestBody(protocol, responseFormat, request) {
  return protocol === RESPONSES_PROTOCOL
    ? responsesBody(request)
    : chatCompletionsBody(request, responseFormat);
}

export class OpenAICompatibleProvider {
  #fetch;
  #requestUrl;
  #credentialReference;
  #protocol;
  #responseFormat;
  #timeoutMs;
  #maxResponseBytes;
  #maxRequestBytes;

  constructor(rawOptions = {}) {
    const options = optionsObject(rawOptions);
    if (options.fetch !== undefined && typeof options.fetch !== "function") {
      throw new TypeError("OpenAI-compatible provider requires fetch");
    }
    const protocolWasOmitted = !Object.hasOwn(options, "protocol");
    const protocol = safeProtocol(options.protocol ?? CHAT_COMPLETIONS_PROTOCOL);
    const responseFormat = safeResponseFormat(
      options.responseFormat ?? JSON_SCHEMA_RESPONSE_FORMAT,
    );
    if (
      protocol === RESPONSES_PROTOCOL &&
      responseFormat === JSON_OBJECT_RESPONSE_FORMAT
    ) {
      throw new TypeError(
        "OpenAI-compatible json-object response format requires chat-completions",
      );
    }
    const target = endpoint(options.baseUrl, protocol);
    const limits = protocolWasOmitted ? LEGACY_LIMITS : PROTOCOL_LIMITS[protocol];
    this.id = safeId(options.id ?? "openai-compatible");
    this.kind = "openai-compatible";
    this.protocol = protocol;
    this.responseFormat = responseFormat;
    this.remote = target.remote;
    this.#protocol = protocol;
    this.#responseFormat = responseFormat;
    this.#fetch = options.fetch ?? globalThis.fetch;
    if (typeof this.#fetch !== "function") {
      throw new TypeError("OpenAI-compatible provider requires fetch");
    }
    this.#requestUrl = target.requestUrl;
    if (options.env !== undefined && options.environment !== undefined) {
      throw new TypeError("injected environment is ambiguous");
    }
    const environment =
      options.env === undefined ? options.environment : options.env;
    this.#credentialReference = credentialReference(
      environment,
      options.apiKeyEnv,
    );
    this.#timeoutMs = boundedInteger(
      options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      "timeoutMs",
      limits.minimumTimeoutMs,
      limits.maximumTimeoutMs,
    );
    this.#maxResponseBytes = boundedInteger(
      options.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES,
      "maxResponseBytes",
      limits.minimumResponseBytes,
      limits.maximumResponseBytes,
    );
    this.#maxRequestBytes = boundedInteger(
      options.maxRequestBytes ?? DEFAULT_MAX_REQUEST_BYTES,
      "maxRequestBytes",
      limits.minimumRequestBytes,
      limits.maximumRequestBytes,
    );
    Object.freeze(this);
  }

  async generate(rawRequest = {}) {
    const input = readStructuredBrainGenerateInput(rawRequest);
    const externalSignal = normalizeAbortSignal(input.signal);
    if (externalSignal?.aborted) throw cancellationError();
    const apiKey = configuredApiKey(this.#credentialReference);
    const request = normalizeStructuredBrainRequest(
      {
        model: input.model,
        messages: input.messages,
        schema: input.schema,
      },
      { maxRequestBytes: this.#maxRequestBytes },
    );
    const body = JSON.stringify(
      requestBody(this.#protocol, this.#responseFormat, request),
    );
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
            headers: {
              authorization: `Bearer ${apiKey}`,
              "content-type": "application/json",
            },
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
          this.#protocol,
        );
      },
    });
  }
}

export {
  OpenAICompatibleProvider as OpenAiCompatibleProvider,
  OpenAICompatibleProviderError as OpenAiCompatibleProviderError,
};
