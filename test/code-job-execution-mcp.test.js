import assert from "node:assert/strict";
import test from "node:test";
import { createCodeJobExecutionMcp } from "../src/adapters/code-job-execution-mcp.js";
import { createCodeExecutionContext } from "../src/lib/code-execution-context.js";
import { CODE_ACTION_DECISION_JSON_SCHEMA } from "../src/domain/structured-code-action-contract.js";
import { createCodeExecutionWatchdog, codeExecutionWatchdogSignal, startCodeExecutionTurn, closeCodeExecutionWatchdog } from '../src/lib/code-execution-watchdog.js';

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}
function decision(action = { type: "read_text", path: "src/file.cpp" }) {
  return { schemaVersion: 1, confidence: 90, summary: "Inspect source", reason: "Verify current behavior", action };
}
async function fixture(t, callbacks = {}, options = {}) {
  const context = createCodeExecutionContext({ performAction: async (args) => args,
    readSource: async (args) => args, getState: async () => ({ revision: 1 }), ...callbacks });
  const endpoint = await createCodeJobExecutionMcp(context, options);
  t.after(() => endpoint.close());
  return endpoint;
}
let nextId = 1;
async function rpc(endpoint, method, params = {}, id = nextId++) {
  const response = await fetch(endpoint.url, { method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id, method, params }) });
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.id, id);
  return body.result;
}
async function tool(endpoint, name, args, id) {
  const result = await rpc(endpoint, "tools/call", { name, arguments: args }, id);
  if (result.isError) throw Object.assign(new Error(result.content[0].text), { code: result.content[0].text });
  return JSON.parse(result.content[0].text);
}

test("execution MCP exposes exactly scoped semantic tools and marks only reads as read-only", async (t) => {
  const endpoint = await fixture(t);
  assert.match(endpoint.url, /^http:\/\/127\.0\.0\.1:\d+\/code-execution\/[a-f0-9]{64}$/);
  assert.deepEqual(endpoint.tools, ["perform_action", "read_source", "edit_source", "get_state", "read_conflict_source"]);
  assert.ok((await rpc(endpoint, "initialize")).capabilities.tools);
  assert.deepEqual(await rpc(endpoint, "ping"), {});
  const tools = (await rpc(endpoint, "tools/list")).tools;
  assert.deepEqual(tools.map(({ name }) => name), endpoint.tools);
  assert.deepEqual(tools[0].inputSchema.properties.decision, CODE_ACTION_DECISION_JSON_SCHEMA);
  assert.equal(tools[0].annotations?.readOnlyHint, false);
  assert.notEqual(tools[0].annotations?.idempotentHint, true);
  assert.deepEqual(tools.filter(({ annotations }) => annotations.readOnlyHint).map(({ name }) => name),
    ["read_source", "get_state", "read_conflict_source"]);
  assert.deepEqual(await tool(endpoint, "get_state", {}), { revision: 1 });
  await assert.rejects(tool(endpoint, "shell", {}), { code: "CODE_EXECUTION_TOOL_NOT_ALLOWED" });
  await assert.rejects(tool(endpoint, "perform_action", { decision: decision({ type: "complete", outcome: "done", evidence: [] }) }),
    { code: "CODE_EXECUTION_COMPLETE_NOT_ALLOWED" });
});

test('MCP ping, get_state and cached mutation replay cannot renew host inactivity', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const watchdog = createCodeExecutionWatchdog({ startupMs: 1000 }); startCodeExecutionTurn(watchdog);
  t.after(() => closeCodeExecutionWatchdog(watchdog));
  let writes = 0;
  const endpoint = await fixture(t, { progressFingerprint: async () => String(writes).repeat(64),
    performAction: async () => { writes++; return { material: 'saved' }; } }, { watchdog });
  const args = { decision: decision({ type: 'write_text', path: 'src/file.cpp', content: 'new content' }) };
  await tool(endpoint, 'perform_action', args, 'stable-mutation');
  for (let index = 0; index < 14; index++) {
    await rpc(endpoint, 'ping'); await tool(endpoint, 'get_state', {});
    await tool(endpoint, 'perform_action', args, 'stable-mutation');
    t.mock.timers.tick(60_000);
  }
  assert.equal(writes, 1); assert.equal(codeExecutionWatchdogSignal(watchdog).aborted, false);
  t.mock.timers.tick(60_000);
  assert.equal(codeExecutionWatchdogSignal(watchdog).reason.code, 'STRUCTURED_PROVIDER_IDLE_TIMEOUT');
});

test("bounded edit RPCs replay once and reject ambiguous authority fields and oversized edits", async t => {
  let calls = 0;
  const endpoint = await fixture(t, { editSource: async value => { calls++; return value; } });
  const args = { path: "src/app.js", sourceVersion: "current", edits: [{ oldText: "before", newText: "after" }] };
  assert.deepEqual(await tool(endpoint, "edit_source", args, "edit-1"), args);
  assert.deepEqual(await tool(endpoint, "edit_source", args, "edit-1"), args);
  assert.equal(calls, 1);
  await assert.rejects(tool(endpoint, "edit_source", { ...args, edits: [{ oldText: "other", newText: "after" }] }, "edit-1"),
    { code: "CODE_EXECUTION_REQUEST_ID_CONFLICT" });
  for (const value of [{ ...args, expectedSha256: "forged" }, { ...args, path: "../outside" },
    { ...args, edits: [{ oldText: "", newText: "after" }] },
    { ...args, edits: [{ oldText: "before", newText: "x".repeat(48 * 1024 + 1) }] }]) {
    await assert.rejects(tool(endpoint, "edit_source", value), { code: "CODE_EDIT_ARGUMENT_INVALID" });
  }
  assert.equal(calls, 1);
});

test("mutating request IDs cache concurrent and reordered canonical replays without repeating actions", async (t) => {
  const entered = deferred(), release = deferred();
  let calls = 0;
  const endpoint = await fixture(t, { performAction: async () => {
    calls += 1; entered.resolve(); await release.promise; return { actionId: "trusted-action", status: "succeeded" };
  } });
  const original = decision({ type: "write_text", path: "src/file.cpp", content: "new source" });
  const first = tool(endpoint, "perform_action", { decision: original }, "mutation-1");
  await entered.promise;
  const reordered = { action: { content: "new source", path: "src/file.cpp", type: "write_text" }, reason: original.reason,
    summary: original.summary, confidence: 90, schemaVersion: 1 };
  const second = tool(endpoint, "perform_action", { decision: reordered }, "mutation-1");
  release.resolve();
  const results = await Promise.all([first, second]);
  assert.deepEqual(results[0], results[1]);
  assert.equal(calls, 1);
  await assert.rejects(tool(endpoint, "perform_action", { decision: decision({ type: "write_text", path: "src/file.cpp", content: "different" }) }, "mutation-1"),
    { code: "CODE_EXECUTION_REQUEST_ID_CONFLICT" });
  assert.equal(calls, 1);
  await tool(endpoint, "perform_action", { decision: original }, 1);
  await tool(endpoint, "perform_action", { decision: original }, "1");
  assert.equal(calls, 3, "numeric and string request IDs stay distinct");
});

test("standard MCP tool metadata and omitted empty arguments do not change semantic authority", async (t) => {
  const endpoint = await fixture(t);
  for (const params of [
    { name: "get_state", arguments: {}, _meta: { progressToken: "native-progress-1" } },
    { name: "get_state", _meta: { progressToken: 2 } },
  ]) {
    const result = await rpc(endpoint, "tools/call", params);
    assert.notEqual(result.isError, true);
    assert.deepEqual(JSON.parse(result.content[0].text), { revision: 1 });
  }
  for (const params of [
    { name: "get_state", arguments: null },
    { name: "get_state", arguments: {}, command: "shell" },
    { name: "get_state", arguments: {}, _meta: [] },
  ]) assert.equal((await rpc(endpoint, "tools/call", params)).isError, true);
});

test("failed admitted actions also retain replay receipts without leaking host error text", async (t) => {
  let calls = 0;
  const endpoint = await fixture(t, { performAction: async () => { calls += 1; throw new Error("SECRET_TOKEN_IN_HOST_ERROR"); } });
  for (let attempt = 0; attempt < 2; attempt += 1) {
    await assert.rejects(tool(endpoint, "perform_action", { decision: decision() }, "failure"), { code: "CODE_EXECUTION_FAILED" });
  }
  assert.equal(calls, 1);
});

test("bounded mutation replay cache rejects new IDs after 128 without evicting old receipts", async (t) => {
  let calls = 0;
  const endpoint = await fixture(t, { performAction: async () => ({ calls: ++calls }) });
  for (let id = 0; id < 128; id += 1) await tool(endpoint, "perform_action", { decision: decision() }, `action-${id}`);
  await assert.rejects(tool(endpoint, "perform_action", { decision: decision() }, "action-128"), { code: "CODE_EXECUTION_ACTION_LIMIT" });
  assert.deepEqual(await tool(endpoint, "perform_action", { decision: decision() }, "action-0"), { calls: 1 });
  assert.equal(calls, 128);
});

test("HTTP rejects duplicate JSON keys, origins, wrong paths, methods and tool notifications", async (t) => {
  let calls = 0;
  const endpoint = await fixture(t, { performAction: async () => { calls += 1; } });
  assert.equal((await fetch(endpoint.url)).status, 404);
  assert.equal((await fetch(endpoint.url, { method: "POST", headers: { origin: "http://foreign.test" }, body: "{}" })).status, 404);
  assert.equal((await fetch(endpoint.url.replace(/code-execution\/.+$/, "code-execution/wrong"), { method: "POST" })).status, 404);
  for (const body of ['{"jsonrpc":"2.0","id":1,"id":2,"method":"ping"}',
    '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"perform_action","arguments":{"decision":{"schemaVersion":1,"schemaVersion":2}}}}',
    "null", "[]", '{"jsonrpc":"2.0","id":null,"method":"ping"}', '{"jsonrpc":"2.0","id":{},"method":"ping"}']) {
    assert.equal((await fetch(endpoint.url, { method: "POST", body })).status, 400);
  }
  assert.equal((await fetch(endpoint.url, { method: "POST", body: JSON.stringify({ jsonrpc: "2.0", method: "tools/call",
    params: { name: "perform_action", arguments: { decision: decision() } } }) })).status, 400);
  assert.equal((await fetch(endpoint.url, { method: "POST", body: JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) })).status, 202);
  assert.equal(calls, 0);
});

test("the request bound accepts the maximum escaped write and rejects over 1 MiB", async (t) => {
  const endpoint = await fixture(t);
  const value = decision({ type: "write_text", path: "src/file.cpp", content: "\t\\\"".repeat(32 * 1024) });
  assert.ok(Buffer.byteLength(JSON.stringify(value)) > 128 * 1024);
  assert.deepEqual(await tool(endpoint, "perform_action", { decision: value }), { decision: value });
  assert.equal((await fetch(endpoint.url, { method: "POST", body: "x".repeat(1024 * 1024 + 1) })).status, 400);
});

test("source page calls are unbounded in count, with exact arguments and local range bounds", async (t) => {
  let reads = 0;
  const endpoint = await fixture(t, { readSource: async (args) => { reads += 1; return args; } });
  for (let page = 0; page < 140; page += 1) {
    assert.deepEqual(await tool(endpoint, "read_source", { path: "src/file.cpp", offset: page * 24_000, length: 24_000, sourceVersion: "read-action-1" }),
      { path: "src/file.cpp", offset: page * 24_000, length: 24_000, sourceVersion: "read-action-1" });
  }
  for (const args of [{ path: "src/file.cpp", offset: "0" }, { path: "src/file.cpp", offset: -1 },
    { path: "src/file.cpp", offset: 0, length: 48_001 }, { path: "src/file.cpp", offset: 0, revision: "other" },
    { path: "src/file.cpp", offset: 0, jobId: "other" }, { path: "src/file.cpp", offset: 0, sourceVersion: "" }]) {
    await assert.rejects(tool(endpoint, "read_source", args), { code: "CODE_EXECUTION_ARGUMENT_INVALID" });
  }
  await assert.rejects(tool(endpoint, "get_state", { revision: "other" }), { code: "CODE_EXECUTION_ARGUMENT_INVALID" });
  assert.equal(reads, 140);
});

test("close revokes new admissions immediately and waits for an admitted action and host cleanup", async (t) => {
  const entered = deferred(), release = deferred();
  let callbackSignal, closed = false, hostClosed = false;
  const endpoint = await fixture(t, { performAction: async (args, { signal }) => {
    callbackSignal = signal; entered.resolve(); await release.promise; return { status: "succeeded" };
  }, close: async () => { hostClosed = true; return { settled: true }; } });
  const active = tool(endpoint, "perform_action", { decision: decision() }, "active");
  await entered.promise;
  const closing = endpoint.close().then((receipt) => { closed = true; return receipt; });
  await Promise.resolve();
  assert.equal(callbackSignal.aborted, false);
  assert.equal(closed, false);
  assert.equal(hostClosed, false);
  await assert.rejects(tool(endpoint, "get_state", {}), { code: "CODE_EXECUTION_SESSION_REVOKED" });
  release.resolve();
  assert.deepEqual(await active, { status: "succeeded" });
  assert.deepEqual(await closing, { settled: true });
  assert.equal(hostClosed, true);
  await assert.rejects(fetch(endpoint.url));
});

test("parent abort revokes calls and aborts the active signal without claiming callback settlement", async (t) => {
  const parent = new AbortController(), entered = deferred(), release = deferred();
  let callbackSignal, closed = false;
  const endpoint = await fixture(t, { performAction: async (args, { signal }) => {
    callbackSignal = signal; entered.resolve(); await release.promise; return { settled: true };
  } }, { signal: parent.signal });
  const active = tool(endpoint, "perform_action", { decision: decision() });
  await entered.promise;
  parent.abort();
  assert.ok(callbackSignal.aborted);
  const closing = endpoint.close().then(() => { closed = true; });
  await Promise.resolve();
  assert.equal(closed, false);
  release.resolve();
  assert.deepEqual(await active, { settled: true });
  await closing;
});
