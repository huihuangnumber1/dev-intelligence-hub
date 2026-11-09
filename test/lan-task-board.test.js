import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { readFile } from "node:fs/promises";
import vm from "node:vm";
import test from "node:test";
import { createLanTaskBoard } from "../src/services/lan-task-board.js";

const enabled = { enabled: true, host: "10.10.0.1", allow: ["10.10.0.2", "10.10.0.3"] };
function fixture() {
  let saved;
  let writeFailure = false;
  const listeners = [];
  const store = {
    async read(_key, fallback) { return structuredClone(saved ?? fallback); },
    async write(_key, value) {
      if (writeFailure) throw new Error("disk unavailable");
      saved = structuredClone(value);
    },
  };
  function createServerFn(handler) {
    const server = new EventEmitter();
    Object.assign(server, { handler, closed: false,
      listen({ host }, callback) {
        queueMicrotask(() => host === "10.0.0.99"
          ? server.emit("error", new Error("address unavailable")) : callback());
      },
      close(callback) { server.closed = true; callback(); },
      closeAllConnections() {},
    });
    listeners.push(server);
    return server;
  }
  return { listeners, store, createServerFn, failWrites() { writeFailure = true; },
    create() { return createLanTaskBoard(async () => ({ status: 200, type: "text/plain", body: "ok" }), { store, createServerFn }); } };
}

test("LAN settings survive restart, including disabled addresses", async () => {
  const f = fixture();
  const first = f.create();
  await first.configure(enabled);
  await first.close();
  const second = f.create();
  await second.ready;
  assert.deepEqual(second.view(), { ...enabled, url: "http://10.10.0.1:4174/", error: null });
  await second.configure({ ...enabled, enabled: false });
  await second.close();
  const third = f.create();
  await third.ready;
  assert.deepEqual(third.view(), { ...enabled, enabled: false, url: null, error: null });
  await third.close();
});

test("failed rebind or save preserves the working listener and saved settings", async () => {
  const f = fixture();
  const board = f.create();
  await board.configure(enabled);
  await assert.rejects(board.configure({ ...enabled, host: "10.0.0.99" }), { statusCode: 409 });
  assert.equal(f.listeners[0].closed, false);
  f.failWrites();
  await assert.rejects(board.configure({ ...enabled, host: "10.0.0.12" }), /disk unavailable/);
  assert.equal(f.listeners[2].closed, true);
  assert.equal(f.listeners[0].closed, false);
  await assert.rejects(board.configure({ ...enabled, enabled: false }), /disk unavailable/);
  assert.equal(board.view().enabled, true);
  await board.close();
  const restarted = f.create();
  await restarted.ready;
  assert.equal(restarted.view().host, enabled.host);
  await restarted.close();
});

test("restore bind failure keeps addresses editable and can be corrected", async () => {
  const f = fixture();
  await f.store.write("lan-task-board-settings", { ...enabled, host: "10.0.0.99" });
  const board = f.create();
  await board.ready;
  assert.equal(board.view().host, "10.0.0.99");
  assert.equal(board.view().url, null);
  assert.match(board.view().error, /无法恢复/);
  await board.configure(enabled);
  assert.equal(board.view().error, null);
  await board.close();
});

test("restored LAN listener enforces peer whitelist, GET-only access and revocation", async () => {
  const f = fixture();
  const board = f.create();
  await board.configure(enabled);
  const listener = f.listeners[0];
  async function request(address, method = "GET", host = "10.10.0.1:4174") {
    const response = { writeHead(status) { this.status = status; }, end() {} };
    await listener.handler({ socket: { remoteAddress: address }, headers: { host }, method, url: "/" }, response);
    return response.status;
  }
  assert.equal(await request(enabled.allow[0]), 200);
  assert.equal(await request("10.6.1.1"), 403);
  assert.equal(await request(enabled.allow[0], "POST"), 405);
  assert.equal(await request(enabled.allow[0], "GET", "attacker:4174"), 403);
  await board.configure({ ...enabled, enabled: false });
  assert.equal(await request(enabled.allow[0]), 403);
  await board.close();
});

test("settings read failure releases the form and preserves user input for retry", async () => {
  const handlers = new Map();
  const elements = { enabled: { checked: true }, host: { value: enabled.host }, allow: { value: enabled.allow.join("\n") } };
  const submit = { disabled: false };
  const status = { textContent: "" };
  const form = { elements, querySelector: () => submit, addEventListener: (name, fn) => handlers.set(name, fn) };
  const nodes = { "#lan-board-dialog": { showModal() {}, close() {} }, "#lan-board-form": form, "#lan-board-status": status,
    "#lan-board-open": { addEventListener: (_name, fn) => handlers.set("open", fn) }, "#lan-board-close": { addEventListener() {} } };
  let online = false;
  const calls = [];
  vm.runInNewContext(await readFile(new URL("../public/lan-board-settings.js", import.meta.url), "utf8"), {
    document: { querySelector: key => nodes[key] }, AbortSignal, TypeError,
    fetch: async (_url, options) => {
      calls.push(options);
      if (!online) throw new TypeError("Failed to fetch");
      return { ok: true, json: async () => ({ ...enabled, url: "http://10.10.0.1:4174/" }) };
    },
  });
  await handlers.get("open")();
  assert.equal(submit.disabled, false);
  assert.equal(elements.host.value, enabled.host);
  assert.match(status.textContent, /无法连接本机服务/);
  assert.ok(calls[0].signal instanceof AbortSignal);
  online = true;
  await handlers.get("submit")({ preventDefault() {} });
  assert.equal(submit.disabled, false);
  assert.match(status.textContent, /同事访问地址/);
});
