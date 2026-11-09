import assert from "node:assert/strict";
import test from "node:test";
import { OllamaStructuredProvider } from "../src/adapters/ollama-structured-provider.js";
import {
  OpenAICompatibleProvider,
  OpenAiCompatibleProvider,
} from "../src/adapters/openai-compatible-provider.js";
import { normalizeStructuredBrainRequest, readStructuredBrainGenerateInput } from "../src/lib/structured-brain-request.js";
import { BrainRouter } from "../src/services/brain-router.js";

const SCHEMA = Object.freeze({
  type: "object",
  additionalProperties: false,
  required: ["ok"],
  properties: { ok: { type: "boolean" } },
});
const MESSAGES = Object.freeze([
  Object.freeze({ role: "system", content: "Return JSON." }),
  Object.freeze({ role: "user", content: "{}" }),
]);

test("structured scheduling identity stays separate from authorized session history", () => {
  const source = { model: "bounded-model", messages: MESSAGES, schema: SCHEMA,
    sessionKey: `auth-v2:${"a".repeat(64)}`, admissionEntityKey: "github:pull_request:Owner/Repo#42" };
  const input = readStructuredBrainGenerateInput(source);
  const normalized = normalizeStructuredBrainRequest(source, { maxRequestBytes: 8 * 1024 });
  assert.equal(input.admissionEntityKey, source.admissionEntityKey);
  assert.equal(normalized.admissionEntityKey, "github:pull_request:owner/repo#42");
  assert.equal(normalized.sessionKey, source.sessionKey);
  let getterCalls = 0;
  Object.defineProperty(source, "admissionEntityKey", { enumerable: true, get() { getterCalls++; return "untrusted"; } });
  assert.throws(() => readStructuredBrainGenerateInput(source), /structured request is invalid/);
  assert.throws(() => normalizeStructuredBrainRequest(source, { maxRequestBytes: 8 * 1024 }), /structured request is invalid/);
  assert.equal(getterCalls, 0);
});

function textResponse(value, { ok = true, status = 200 } = {}) {
  const text = typeof value === "string" ? value : JSON.stringify(value);
  return {
    ok,
    status,
    body: new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(text));
        controller.close();
      },
    }),
  };
}

function remoteData(overrides = {}) {
  return { requirements: false, code: false, memory: false, ...overrides };
}

function responsesEnvelope(text = '{"ok":true}', overrides = {}) {
  return {
    object: "response",
    status: "completed",
    error: null,
    incomplete_details: null,
    output: [
      { type: "reasoning", id: "reasoning-1", summary: [] },
      {
        type: "message",
        id: "message-1",
        status: "completed",
        role: "assistant",
        content: [{ type: "output_text", text, annotations: [] }],
      },
    ],
    ...overrides,
  };
}

test("the shared structured request normalizer returns a detached deep-frozen request", () => {
  const source = {
    model: "bounded-model",
    messages: [
      { role: "system", content: "Return JSON." },
      { role: "user", content: "{}" },
    ],
    schema: {
      type: "object",
      properties: { nested: { type: "array", items: { type: "string" } } },
    },
  };

  const normalized = normalizeStructuredBrainRequest(source, {
    maxRequestBytes: 8 * 1024,
  });

  source.messages[0].content = "changed";
  source.schema.properties.nested.items.type = "number";
  assert.equal(normalized.messages[0].content, "Return JSON.");
  assert.equal(normalized.schema.properties.nested.items.type, "string");
  assert.equal(Object.isFrozen(normalized), true);
  assert.equal(Object.isFrozen(normalized.messages), true);
  assert.equal(Object.isFrozen(normalized.messages[0]), true);
  assert.equal(Object.isFrozen(normalized.schema.properties.nested.items), true);
});

test("structured messages preserve multiline prompts and code indentation", () => {
  const messages = [
    { role: "system", content: "# Review\r\n\r\n- 检查代码\n\t保留缩进" },
    { role: "user", content: "diff --git a/app.js b/app.js\n+\treturn true;\n" },
  ];
  const normalized = normalizeStructuredBrainRequest({
    model: "bounded-model", messages, schema: SCHEMA,
  }, { maxRequestBytes: 8 * 1024 });

  assert.deepEqual(normalized.messages, messages);
});

test("structured messages reject non-text controls and keep identifier validation strict", () => {
  const normalize = (overrides) => normalizeStructuredBrainRequest({
    model: "bounded-model", messages: MESSAGES, schema: SCHEMA, ...overrides,
  }, { maxRequestBytes: 8 * 1024 });
  const forbiddenCodes = [...Array(32).keys(), 127]
    .filter((code) => ![9, 10, 13].includes(code));
  for (const code of forbiddenCodes) {
    assert.throws(
      () => normalize({ messages: [{ role: "user", content: `text${String.fromCharCode(code)}text` }] }),
      /message\.content is invalid/,
      `reject control character ${code}`,
    );
  }
  for (const content of ["", " \t\r\n"]) {
    assert.throws(
      () => normalize({ messages: [{ role: "user", content }] }),
      /message\.content is invalid/,
    );
  }
  for (const control of ["\t", "\n", "\r"]) {
    assert.throws(() => normalize({ model: `model${control}name` }), /model is invalid/);
    assert.throws(() => normalize({ sessionKey: `session${control}key` }), /sessionKey is invalid/);
  }
});

test("the shared structured request normalizer rejects hostile data before touching it", () => {
  let proxyTraps = 0;
  const hostileSchema = new Proxy({}, {
    getPrototypeOf() {
      proxyTraps += 1;
      throw new Error("private proxy trap");
    },
  });
  assert.throws(
    () => normalizeStructuredBrainRequest({
      model: "model",
      messages: MESSAGES,
      schema: hostileSchema,
    }, { maxRequestBytes: 8 * 1024 }),
    /schema is invalid/i,
  );
  assert.equal(proxyTraps, 0);

  let getterCalls = 0;
  const accessorMessage = { role: "user" };
  Object.defineProperty(accessorMessage, "content", {
    enumerable: true,
    get() {
      getterCalls += 1;
      return "private getter";
    },
  });
  assert.throws(
    () => normalizeStructuredBrainRequest({
      model: "model",
      messages: [accessorMessage],
      schema: SCHEMA,
    }, { maxRequestBytes: 8 * 1024 }),
    /messages are invalid/i,
  );
  assert.equal(getterCalls, 0);

  const sparseMessages = new Array(1);
  assert.throws(
    () => normalizeStructuredBrainRequest({
      model: "model",
      messages: sparseMessages,
      schema: SCHEMA,
    }, { maxRequestBytes: 8 * 1024 }),
    /messages are invalid/i,
  );

  const cyclicSchema = { type: "object" };
  cyclicSchema.self = cyclicSchema;
  assert.throws(
    () => normalizeStructuredBrainRequest({
      model: "model",
      messages: MESSAGES,
      schema: cyclicSchema,
    }, { maxRequestBytes: 8 * 1024 }),
    /schema is invalid/i,
  );

  assert.throws(
    () => normalizeStructuredBrainRequest({
      model: "model",
      messages: [{ role: "user", content: "x".repeat(2_000) }],
      schema: SCHEMA,
    }, { maxRequestBytes: 1_024 }),
    (error) => error.code === "STRUCTURED_PROVIDER_REQUEST_TOO_LARGE" &&
      error.statusCode === 413,
  );
});

test("Ollama and OpenAI-compatible providers use the shared hostile-data boundary", async () => {
  const calls = { ollama: 0, openai: 0 };
  const providers = [
    new OllamaStructuredProvider({
      fetch: async () => {
        calls.ollama += 1;
        return textResponse({ message: { content: '{"ok":true}' } });
      },
    }),
    new OpenAICompatibleProvider({
      protocol: "responses",
      baseUrl: "https://models.example/v1",
      apiKeyEnv: "MODEL_TOKEN",
      env: { MODEL_TOKEN: "token" },
      fetch: async () => {
        calls.openai += 1;
        return textResponse(responsesEnvelope());
      },
    }),
  ];

  for (const provider of providers) {
    let proxyTraps = 0;
    const proxy = new Proxy({}, {
      getPrototypeOf() {
        proxyTraps += 1;
        throw new Error("private proxy trap");
      },
    });
    await assert.rejects(
      provider.generate({
        model: "model",
        messages: MESSAGES,
        schema: proxy,
      }),
      /schema is invalid/i,
    );
    assert.equal(proxyTraps, 0);

    let getterCalls = 0;
    const accessorSchema = { type: "object" };
    Object.defineProperty(accessorSchema, "properties", {
      enumerable: true,
      get() {
        getterCalls += 1;
        return {};
      },
    });
    await assert.rejects(
      provider.generate({
        model: "model",
        messages: MESSAGES,
        schema: accessorSchema,
      }),
      /schema is invalid/i,
    );
    assert.equal(getterCalls, 0);

    const sparse = new Array(1);
    await assert.rejects(
      provider.generate({
        model: "model",
        messages: MESSAGES,
        schema: { type: "object", anyOf: sparse },
      }),
      /schema is invalid/i,
    );
  }
  assert.deepEqual(calls, { ollama: 0, openai: 0 });
});

test("structured providers reject a top-level request Proxy without reading it", async () => {
  let getterCalls = 0;
  let fetchCalls = 0;
  const requestProxy = new Proxy({}, {
    get(_target, property) {
      getterCalls += 1;
      throw new Error(`PRIVATE_${String(property)}`);
    },
  });
  const providers = [
    new OllamaStructuredProvider({
      fetch: async () => {
        fetchCalls += 1;
        throw new Error("must not fetch");
      },
    }),
    new OpenAICompatibleProvider({
      baseUrl: "https://models.example/v1",
      apiKeyEnv: "MODEL_TOKEN",
      env: { MODEL_TOKEN: "private-token" },
      fetch: async () => {
        fetchCalls += 1;
        throw new Error("must not fetch");
      },
    }),
  ];

  for (const provider of providers) {
    await assert.rejects(
      provider.generate(requestProxy),
      (error) =>
        error instanceof TypeError &&
        !error.message.includes("PRIVATE_") &&
        !JSON.stringify(error).includes("PRIVATE_"),
    );
  }
  assert.equal(getterCalls, 0);
  assert.equal(fetchCalls, 0);
});

test("Ollama defaults to loopback and sends a bounded schema request without redirects", async () => {
  const calls = [];
  const provider = new OllamaStructuredProvider({
    fetch: async (url, options) => {
      calls.push({ url, options, body: JSON.parse(options.body) });
      return textResponse({ message: { content: '{"ok":true}' } });
    },
  });

  const output = await provider.generate({
    model: "qwen3.5:9b",
    messages: MESSAGES,
    schema: SCHEMA,
  });

  assert.equal(output, '{"ok":true}');
  assert.equal(provider.id, "ollama");
  assert.equal(provider.remote, false);
  assert.equal(calls[0].url, "http://127.0.0.1:11434/api/chat");
  assert.equal(calls[0].options.redirect, "error");
  assert.deepEqual(calls[0].body.format, SCHEMA);
  assert.equal(calls[0].body.stream, false);
  assert.equal(calls[0].body.keep_alive, "30m");
});

test("Ollama removes only an exact JSON transport fence", async () => {
  const fenced = new OllamaStructuredProvider({
    fetch: async () =>
      textResponse({ message: { content: "```json\n{\"ok\":true}\n```" } }),
  });
  const prose = new OllamaStructuredProvider({
    fetch: async () =>
      textResponse({
        message: { content: "Result:\n```json\n{\"ok\":true}\n```" },
      }),
  });

  assert.equal(
    await fenced.generate({ model: "qwen", messages: MESSAGES, schema: SCHEMA }),
    '{"ok":true}',
  );
  assert.equal(
    await prose.generate({ model: "qwen", messages: MESSAGES, schema: SCHEMA }),
    "Result:\n```json\n{\"ok\":true}\n```",
  );
});

test("remote endpoints require HTTPS and every endpoint rejects userinfo", () => {
  assert.throws(
    () => new OllamaStructuredProvider({ baseUrl: "http://models.example" }),
    /remote endpoint must use HTTPS/i,
  );
  assert.throws(
    () =>
      new OllamaStructuredProvider({
        baseUrl: "http://user:password@127.0.0.1:11434",
      }),
    /must not contain userinfo/i,
  );
  assert.throws(
    () =>
      new OpenAiCompatibleProvider({
        baseUrl: "http://api.example/v1",
        apiKeyEnv: "MODEL_TOKEN",
        env: { MODEL_TOKEN: "token" },
      }),
    /remote endpoint must use HTTPS/i,
  );
});

test("OpenAI-compatible credentials come only from the injected environment and stay out of errors", async () => {
  const secret = "super-secret-token";
  const calls = [];
  const provider = new OpenAiCompatibleProvider({
    baseUrl: "https://models.example/v1",
    apiKeyEnv: "MODEL_TOKEN",
    env: { MODEL_TOKEN: secret },
    fetch: async (url, options) => {
      calls.push({ url, options, body: JSON.parse(options.body) });
      return textResponse({
        choices: [{ message: { content: '{"ok":true}' } }],
      });
    },
  });

  const output = await provider.generate({
    model: "smart-model",
    messages: MESSAGES,
    schema: SCHEMA,
  });

  assert.equal(output, '{"ok":true}');
  assert.equal(OpenAICompatibleProvider, OpenAiCompatibleProvider);
  assert.equal(provider.protocol, "chat-completions");
  assert.equal(provider.responseFormat, "json-schema");
  assert.equal(calls[0].url, "https://models.example/v1/chat/completions");
  assert.equal(calls[0].options.headers.authorization, `Bearer ${secret}`);
  assert.equal(calls[0].options.redirect, "error");
  assert.equal(calls[0].body.response_format.json_schema.strict, true);
  assert.equal(JSON.stringify(provider).includes(secret), false);

  const failing = new OpenAiCompatibleProvider({
    baseUrl: "https://models.example/v1",
    apiKeyEnv: "MODEL_TOKEN",
    env: { MODEL_TOKEN: secret },
    fetch: async () => textResponse(secret, { ok: false, status: 401 }),
  });
  await assert.rejects(
    failing.generate({ model: "smart-model", messages: MESSAGES, schema: SCHEMA }),
    (error) => error.code === "STRUCTURED_PROVIDER_HTTP_FAILED" &&
      !error.message.includes(secret),
  );
  assert.throws(
    () =>
      new OpenAiCompatibleProvider({
        baseUrl: "https://models.example/v1",
        apiKeyEnv: "MODEL_TOKEN",
        env: { MODEL_TOKEN: secret },
        apiKey: secret,
      }),
    (error) => !error.message.includes(secret),
  );
  assert.throws(
    () =>
      new OpenAiCompatibleProvider({
        baseUrl: "https://models.example/v1",
        apiKeyEnv: "MODEL_TOKEN",
        env: { MODEL_TOKEN: secret },
        environment: { MODEL_TOKEN: secret },
      }),
    /ambiguous/i,
  );

  let getterCalls = 0;
  const unsafeOptions = {
    baseUrl: "https://models.example/v1",
    apiKeyEnv: "MODEL_TOKEN",
    env: { MODEL_TOKEN: secret },
  };
  Object.defineProperty(unsafeOptions, "apiKey", {
    enumerable: true,
    get() {
      getterCalls += 1;
      return secret;
    },
  });
  assert.throws(() => new OpenAiCompatibleProvider(unsafeOptions));
  assert.equal(getterCalls, 0);
});

test("OpenAI-compatible missing credentials fail lazily before fetch and can recover in-place", async () => {
  const environment = {};
  let fetchCalls = 0;
  const provider = new OpenAICompatibleProvider({
    baseUrl: "https://models.example/v1",
    apiKeyEnv: "MODEL_TOKEN",
    environment,
    fetch: async () => {
      fetchCalls += 1;
      return textResponse({
        choices: [{ message: { content: '{"ok":true}' } }],
      });
    },
  });
  const request = {
    model: "smart-model",
    messages: MESSAGES,
    schema: SCHEMA,
  };

  await assert.rejects(
    provider.generate(request),
    (error) => error.code === "BRAIN_CREDENTIAL_UNAVAILABLE" &&
      error.statusCode === 503,
  );
  assert.equal(fetchCalls, 0);

  environment.MODEL_TOKEN = "configured-after-startup";
  assert.equal(await provider.generate(request), '{"ok":true}');
  assert.equal(fetchCalls, 1);

  delete environment.MODEL_TOKEN;
  await assert.rejects(
    provider.generate(request),
    (error) => error.code === "BRAIN_CREDENTIAL_UNAVAILABLE",
  );
  assert.equal(fetchCalls, 1);
});

test("OpenAI-compatible chat json-object keeps the schema out of the remote request", async () => {
  const calls = [];
  const provider = new OpenAICompatibleProvider({
    responseFormat: "json-object",
    baseUrl: "https://models.example/v1",
    apiKeyEnv: "MODEL_TOKEN",
    env: { MODEL_TOKEN: "token" },
    fetch: async (url, options) => {
      calls.push({ url, body: JSON.parse(options.body) });
      return textResponse({
        choices: [{ message: { content: '{"ok":true}' } }],
      });
    },
  });
  const schema = {
    ...SCHEMA,
    properties: {
      ok: { type: "boolean" },
      tags: { type: "array", items: { type: "string" }, uniqueItems: true },
    },
  };

  const output = await provider.generate({
    model: "smart-model",
    messages: MESSAGES,
    schema,
  });

  assert.equal(output, '{"ok":true}');
  assert.equal(provider.protocol, "chat-completions");
  assert.equal(provider.responseFormat, "json-object");
  assert.deepEqual(calls, [{
    url: "https://models.example/v1/chat/completions",
    body: {
      model: "smart-model",
      messages: MESSAGES,
      temperature: 0,
      response_format: { type: "json_object" },
    },
  }]);
  assert.equal(JSON.stringify(calls[0].body).includes("uniqueItems"), false);
});

test("OpenAI-compatible response format rejects unsafe values and unsupported protocol combinations", () => {
  const baseOptions = {
    baseUrl: "https://models.example/v1",
    apiKeyEnv: "MODEL_TOKEN",
    env: { MODEL_TOKEN: "token" },
  };

  assert.throws(
    () => new OpenAICompatibleProvider({
      ...baseOptions,
      responseFormat: "markdown",
    }),
    /response format is invalid/i,
  );
  assert.throws(
    () => new OpenAICompatibleProvider({
      ...baseOptions,
      protocol: "responses",
      responseFormat: "json-object",
    }),
    /json-object.*chat-completions/i,
  );
});

test("OpenAI-compatible Responses sends an explicitly tool-free schema request", async () => {
  const calls = [];
  const localContextSentinel = "PRIVATE_WINDOWS_CONTEXT_MUST_NOT_BE_SENT";
  const provider = new OpenAICompatibleProvider({
    protocol: "responses",
    baseUrl: "https://models.example/v1",
    apiKeyEnv: "MODEL_TOKEN",
    env: {
      MODEL_TOKEN: "token",
      USERPROFILE: localContextSentinel,
      CODEX_HOME: localContextSentinel,
    },
    fetch: async (url, options) => {
      calls.push({ url, options, body: JSON.parse(options.body) });
      return textResponse(responsesEnvelope());
    },
  });

  const output = await provider.generate({
    model: "smart-model",
    messages: MESSAGES,
    schema: SCHEMA,
  });

  assert.equal(output, '{"ok":true}');
  assert.equal(provider.protocol, "responses");
  assert.equal(calls[0].url, "https://models.example/v1/responses");
  assert.equal(calls[0].options.redirect, "error");
  assert.deepEqual(calls[0].body, {
    model: "smart-model",
    input: MESSAGES,
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
        schema: SCHEMA,
      },
    },
  });
  assert.equal(JSON.stringify(calls[0].body).includes(localContextSentinel), false);
  assert.equal(Object.hasOwn(calls[0].body, "instructions"), false);
  assert.equal(Object.hasOwn(calls[0].body, "metadata"), false);
});

test("OpenAI-compatible Responses rejects unsafe or ambiguous output items", async () => {
  const validMessage = responsesEnvelope().output[1];
  const invalidResponses = [
    responsesEnvelope('{"ok":true}', { status: "incomplete" }),
    responsesEnvelope('{"ok":true}', { object: "not-a-response" }),
    responsesEnvelope('{"ok":true}', {
      output: [
        { type: "function_call", name: "view_image", arguments: "{}" },
        validMessage,
      ],
    }),
    responsesEnvelope('{"ok":true}', {
      output: [{
        ...validMessage,
        content: [{ type: "refusal", refusal: "no" }],
      }],
    }),
    responsesEnvelope('{"ok":true}', {
      output: [{
        ...validMessage,
        content: [
          { type: "output_text", text: '{"ok":true}' },
          { type: "output_text", text: '{"ok":false}' },
        ],
      }],
    }),
    responsesEnvelope('{"ok":true}', {
      output: [validMessage, structuredClone(validMessage)],
    }),
    responsesEnvelope('{"ok":true}', {
      output: [{ ...validMessage, status: "in_progress" }],
    }),
    responsesEnvelope('{"ok":true}', { error: { message: "failed" } }),
  ];

  for (const envelope of invalidResponses) {
    const provider = new OpenAICompatibleProvider({
      protocol: "responses",
      baseUrl: "https://models.example/v1",
      apiKeyEnv: "MODEL_TOKEN",
      env: { MODEL_TOKEN: "token" },
      fetch: async () => textResponse(envelope),
    });
    await assert.rejects(
      provider.generate({ model: "smart-model", messages: MESSAGES, schema: SCHEMA }),
      (error) => error.code === "STRUCTURED_PROVIDER_RESPONSE_INVALID",
    );
  }
});

test("OpenAI-compatible Responses keeps request, response, and timeout limits bounded", async () => {
  const baseOptions = {
    protocol: "responses",
    baseUrl: "https://models.example/v1",
    apiKeyEnv: "MODEL_TOKEN",
    env: { MODEL_TOKEN: "token" },
    fetch: async () => textResponse(responsesEnvelope()),
  };
  assert.throws(
    () => new OpenAICompatibleProvider({ ...baseOptions, protocol: "unknown" }),
    /protocol is invalid/i,
  );
  let protocolCoercions = 0;
  const hostileProtocol = {
    [Symbol.toPrimitive]() {
      protocolCoercions += 1;
      return "responses";
    },
  };
  assert.throws(
    () => new OpenAICompatibleProvider({
      ...baseOptions,
      protocol: hostileProtocol,
    }),
    /protocol is invalid/i,
  );
  assert.equal(protocolCoercions, 0);
  for (const timeoutMs of [999, 3_600_001]) {
    assert.throws(
      () => new OpenAICompatibleProvider({ ...baseOptions, timeoutMs }),
      /timeoutMs is outside/i,
    );
  }
  for (const [name, value] of [
    ["maxResponseBytes", 1024 * 1024 + 1],
    ["maxRequestBytes", 1024 * 1024 + 1],
  ]) {
    assert.throws(
      () => new OpenAICompatibleProvider({ ...baseOptions, [name]: value }),
      new RegExp(`${name} is outside`, "i"),
    );
  }
  assert.doesNotThrow(
    () => new OpenAICompatibleProvider({
      ...baseOptions,
      timeoutMs: 3_600_000,
      maxResponseBytes: 1024 * 1024,
      maxRequestBytes: 1024 * 1024,
    }),
  );

  let fetchCalls = 0;
  const requestBounded = new OpenAICompatibleProvider({
    ...baseOptions,
    maxRequestBytes: 1_024,
    fetch: async () => {
      fetchCalls += 1;
      return textResponse(responsesEnvelope());
    },
  });
  await assert.rejects(
    requestBounded.generate({
      model: "smart-model",
      messages: [{ role: "user", content: "x".repeat(2_000) }],
      schema: SCHEMA,
    }),
    (error) => error.code === "STRUCTURED_PROVIDER_REQUEST_TOO_LARGE",
  );
  assert.equal(fetchCalls, 0);

  const responseBounded = new OpenAICompatibleProvider({
    ...baseOptions,
    maxResponseBytes: 1_024,
    fetch: async () => textResponse(responsesEnvelope("x".repeat(2_000))),
  });
  await assert.rejects(
    responseBounded.generate({ model: "smart-model", messages: MESSAGES, schema: SCHEMA }),
    (error) => error.code === "STRUCTURED_PROVIDER_RESPONSE_TOO_LARGE",
  );

  const chatOptions = {
    protocol: "chat-completions",
    baseUrl: "https://models.example/v1",
    apiKeyEnv: "MODEL_TOKEN",
    env: { MODEL_TOKEN: "token" },
    fetch: async () => textResponse({
      choices: [{ message: { content: '{"ok":true}' } }],
    }),
  };
  assert.doesNotThrow(
    () => new OpenAICompatibleProvider({
      ...chatOptions,
      timeoutMs: 10,
      maxResponseBytes: 1024 * 1024,
      maxRequestBytes: 2 * 1024 * 1024,
    }),
  );
  assert.throws(
    () => new OpenAICompatibleProvider({
      ...chatOptions,
      timeoutMs: 120_001,
    }),
    /timeoutMs is outside/i,
  );
  assert.throws(
    () => new OpenAICompatibleProvider({
      ...chatOptions,
      maxRequestBytes: 2 * 1024 * 1024 + 1,
    }),
    /maxRequestBytes is outside/i,
  );
});

test("an omitted protocol preserves the bounded legacy provider ranges", () => {
  const options = {
    baseUrl: "https://legacy.example/v1",
    apiKeyEnv: "MODEL_TOKEN",
    env: { MODEL_TOKEN: "token" },
    fetch: async () => textResponse({
      choices: [{ message: { content: '{"ok":true}' } }],
    }),
  };

  assert.doesNotThrow(() => new OpenAICompatibleProvider({
    ...options,
    timeoutMs: 180_000,
    maxResponseBytes: 2 * 1024 * 1024,
    maxRequestBytes: 1,
  }));
  assert.throws(
    () => new OpenAICompatibleProvider({
      ...options,
      protocol: "chat-completions",
      timeoutMs: 180_000,
    }),
    /timeoutMs is outside/i,
  );
});

test("OpenAI-compatible Responses rejects accessors and branching schemas before fetch", async () => {
  let fetchCalls = 0;
  const provider = new OpenAICompatibleProvider({
    protocol: "responses",
    baseUrl: "https://models.example/v1",
    apiKeyEnv: "MODEL_TOKEN",
    env: { MODEL_TOKEN: "token" },
    fetch: async () => {
      fetchCalls += 1;
      return textResponse(responsesEnvelope());
    },
  });
  let getterCalls = 0;
  const hostileMessage = { role: "user" };
  Object.defineProperty(hostileMessage, "content", {
    enumerable: true,
    get() {
      getterCalls += 1;
      return "must not be read";
    },
  });
  await assert.rejects(
    provider.generate({
      model: "smart-model",
      messages: [hostileMessage],
      schema: SCHEMA,
    }),
    /messages are invalid/i,
  );
  assert.equal(getterCalls, 0);

  let shared = { const: true };
  for (let depth = 0; depth < 7; depth += 1) {
    shared = { anyOf: [shared, shared, shared, shared] };
  }
  await assert.rejects(
    provider.generate({
      model: "smart-model",
      messages: MESSAGES,
      schema: shared,
    }),
    /schema is invalid/i,
  );
  assert.equal(fetchCalls, 0);
});

test("providers bound response bytes and timeout without exposing response content", async () => {
  const oversized = new OllamaStructuredProvider({
    maxResponseBytes: 1_024,
    fetch: async () => textResponse("sensitive".repeat(200)),
  });
  await assert.rejects(
    oversized.generate({ model: "qwen", messages: MESSAGES, schema: SCHEMA }),
    (error) =>
      error.code === "STRUCTURED_PROVIDER_RESPONSE_TOO_LARGE" &&
      !error.message.includes("sensitive"),
  );

  const timedOut = new OllamaStructuredProvider({
    timeoutMs: 10,
    fetch: async () => new Promise(() => {}),
  });
  await assert.rejects(
    timedOut.generate({ model: "qwen", messages: MESSAGES, schema: SCHEMA }),
    (error) => error.code === "STRUCTURED_PROVIDER_TIMEOUT",
  );

  const bodyFailure = new OllamaStructuredProvider({
    fetch: async () => ({
      ok: true,
      status: 200,
      body: new ReadableStream({
        pull() {
          throw new Error("sensitive body reader failure");
        },
      }),
    }),
  });
  await assert.rejects(
    bodyFailure.generate({ model: "qwen", messages: MESSAGES, schema: SCHEMA }),
    (error) =>
      error.code === "STRUCTURED_PROVIDER_RESPONSE_INVALID" &&
      !error.message.includes("sensitive"),
  );

  let unboundedRead = false;
  const unbounded = new OllamaStructuredProvider({
    fetch: async () => ({
      ok: true,
      status: 200,
      async text() {
        unboundedRead = true;
        return "sensitive".repeat(1_000_000);
      },
    }),
  });
  await assert.rejects(
    unbounded.generate({ model: "qwen", messages: MESSAGES, schema: SCHEMA }),
    (error) => error.code === "STRUCTURED_PROVIDER_RESPONSE_INVALID",
  );
  assert.equal(unboundedRead, false);
});

test("structured providers propagate external cancellation without misreporting a timeout", async () => {
  const factories = [
    (fetch) => new OllamaStructuredProvider({ fetch, timeoutMs: 100 }),
    (fetch) => new OpenAiCompatibleProvider({
      baseUrl: "https://models.example/v1",
      apiKeyEnv: "MODEL_TOKEN",
      env: { MODEL_TOKEN: "token" },
      fetch,
      timeoutMs: 100,
    }),
    (fetch) => new OpenAiCompatibleProvider({
      protocol: "responses",
      baseUrl: "https://models.example/v1",
      apiKeyEnv: "MODEL_TOKEN",
      env: { MODEL_TOKEN: "token" },
      fetch,
      timeoutMs: 1_000,
    }),
  ];

  for (const createProvider of factories) {
    let observedSignal = null;
    let markStarted;
    const started = new Promise((resolve) => {
      markStarted = resolve;
    });
    const provider = createProvider(async (_url, { signal }) => {
      observedSignal = signal;
      markStarted();
      return new Promise((_, reject) => {
        signal.addEventListener("abort", () => {
          reject(Object.assign(new Error("aborted"), { name: "AbortError" }));
        }, { once: true });
      });
    });
    const controller = new AbortController();
    const pending = provider.generate({
      model: "model",
      messages: MESSAGES,
      schema: SCHEMA,
      signal: controller.signal,
    });
    await started;
    controller.abort();

    await assert.rejects(
      pending,
      (error) =>
        error.code === "STRUCTURED_PROVIDER_CANCELLED" &&
        error.statusCode === 499,
    );
    assert.equal(observedSignal.aborted, true);
  }
});

test("structured providers do not start fetch after immediate cancellation", async () => {
  const factories = [
    (fetch) => new OllamaStructuredProvider({ fetch, timeoutMs: 100 }),
    (fetch) => new OpenAiCompatibleProvider({
      baseUrl: "https://models.example/v1",
      apiKeyEnv: "MODEL_TOKEN",
      env: { MODEL_TOKEN: "token" },
      fetch,
      timeoutMs: 100,
    }),
    (fetch) => new OpenAiCompatibleProvider({
      protocol: "responses",
      baseUrl: "https://models.example/v1",
      apiKeyEnv: "MODEL_TOKEN",
      env: { MODEL_TOKEN: "token" },
      fetch,
      timeoutMs: 1_000,
    }),
  ];

  for (const createProvider of factories) {
    let fetchCalls = 0;
    const provider = createProvider(async () => {
      fetchCalls += 1;
      throw new Error("fetch must not start");
    });
    const controller = new AbortController();
    const pending = provider.generate({
      model: "model",
      messages: MESSAGES,
      schema: SCHEMA,
      signal: controller.signal,
    });
    controller.abort();

    await assert.rejects(
      pending,
      (error) =>
        error.code === "STRUCTURED_PROVIDER_CANCELLED" &&
        error.statusCode === 499,
    );
    assert.equal(fetchCalls, 0);
  }
});

test("BrainRouter requires explicit remoteData authorization per classification", async () => {
  const calls = [];
  const remoteProvider = {
    id: "remote-brain",
    kind: "openai-compatible",
    remote: true,
    async generate(request) {
      calls.push(request);
      return '{"ok":true}';
    },
  };
  const router = new BrainRouter({ providers: [remoteProvider] });
  const brain = {
    provider: "remote-brain",
    model: "smart-model",
    remoteData: remoteData(),
  };

  await assert.rejects(
    router.generate({ brain, messages: MESSAGES, schema: SCHEMA }),
    (error) => error.code === "REMOTE_DATA_CLASSIFICATION_REQUIRED",
  );
  assert.equal(calls.length, 0);

  await assert.rejects(
    router.generate({ brain, messages: MESSAGES, schema: SCHEMA, dataClasses: ["code"] }),
    (error) => error.code === "REMOTE_DATA_NOT_AUTHORIZED",
  );
  assert.equal(calls.length, 0);

  const output = await router.generate({
    brain: { ...brain, remoteData: remoteData({ code: true }) },
    messages: MESSAGES,
    schema: SCHEMA,
    dataClasses: ["code"],
    signal: new AbortController().signal,
  });
  assert.equal(output, '{"ok":true}');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].signal.aborted, false);
  assert.deepEqual(router.describe(brain), {
    provider: "remote-brain",
    model: "smart-model",
    remote: true,
    remoteData: remoteData(),
  });
  assert.equal(Object.isFrozen(router.describe(brain)), true);
});

test("BrainRouter rejects a pre-cancelled request before provider admission", async () => {
  let providerCalls = 0;
  const router = new BrainRouter({
    providers: [{
      id: "local",
      remote: false,
      async generate() {
        providerCalls += 1;
        return '{"ok":true}';
      },
    }],
  });
  const controller = new AbortController();
  controller.abort();

  await assert.rejects(
    router.generate({
      brain: {
        provider: "local",
        model: "qwen",
        remoteData: remoteData(),
      },
      messages: MESSAGES,
      schema: SCHEMA,
      signal: controller.signal,
    }),
    (error) => error.code === "BRAIN_REQUEST_CANCELLED" && error.statusCode === 499,
  );
  assert.equal(providerCalls, 0);
});
