import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import http from "node:http";
import path from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";

const root = path.resolve(import.meta.dirname, "..");
const command = path.join(root, "scripts", "verify-codex-login-readiness.mjs");
const timeoutScaleHook = pathToFileURL(path.join(
  root,
  "test",
  "fixtures",
  "codex-login-readiness-timeout-scale.mjs",
)).href;
const failureMarker = "CODEX_LOGIN_READINESS_FAILED\n";
const privateCanary = "PRIVATE_READINESS_CANARY_MUST_NOT_ESCAPE";
const capabilities = Object.freeze({
  available: Object.freeze({ cliAvailable: true, fileLoginAvailable: true }),
  file_login_unavailable: Object.freeze({
    cliAvailable: true,
    fileLoginAvailable: false,
  }),
  unsafe_source: Object.freeze({ cliAvailable: true, fileLoginAvailable: false }),
  broker_blocked: Object.freeze({ cliAvailable: true, fileLoginAvailable: false }),
  cli_unavailable: Object.freeze({ cliAvailable: false, fileLoginAvailable: false }),
});

async function listen(t, handler) {
  const server = http.createServer(handler);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(async () => {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  });
  return `http://127.0.0.1:${server.address().port}`;
}

async function runReadiness(
  arguments_,
  { timeoutMs = 20_000, nodeArguments = [] } = {},
) {
  const child = spawn(process.execPath, [...nodeArguments, command, ...arguments_], {
    cwd: root,
    env: { ...process.env, MYDASHBOARD_PRIVATE_CANARY: privateCanary },
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    stdout += chunk;
    if (stdout.length > 65_536) child.kill();
  });
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
    if (stderr.length > 65_536) child.kill();
  });
  const timeout = setTimeout(() => child.kill(), timeoutMs);
  const [status, signal] = await once(child, "close");
  clearTimeout(timeout);
  return { status, signal, stdout, stderr };
}

test("readiness command accepts every exact sanitized state through one fixed GET", async (t) => {
  let currentState = "available";
  const requests = [];
  const origin = await listen(t, (request, response) => {
    requests.push({
      method: request.method,
      url: request.url,
      authorization: request.headers.authorization,
      cookie: request.headers.cookie,
    });
    response.writeHead(200, { "content-type": "application/json; charset=utf-8" });
    response.end(JSON.stringify({
      schemaVersion: 1,
      state: currentState,
      ...capabilities[currentState],
    }));
  });

  for (const state of Object.keys(capabilities)) {
    currentState = state;
    const result = await runReadiness(["--origin", origin]);
    assert.equal(result.status, 0, `${state}: ${result.stderr}`);
    assert.equal(result.signal, null);
    assert.equal(result.stdout, `CODEX_LOGIN_READINESS_OK state=${state}\n`);
    assert.equal(result.stderr, "");
  }

  assert.equal(requests.length, Object.keys(capabilities).length);
  for (const request of requests) {
    assert.deepEqual(request, {
      method: "GET",
      url: "/api/brain-providers/status",
      authorization: undefined,
      cookie: undefined,
    });
  }
});

test("readiness command rejects malformed, oversized, redirected, and secret-bearing responses without echo", async (t) => {
  let fixture = null;
  let requests = 0;
  const origin = await listen(t, (_request, response) => {
    requests += 1;
    response.writeHead(fixture.status ?? 200, fixture.headers ?? {
      "content-type": "application/json",
    });
    response.end(fixture.body);
  });
  const exact = JSON.stringify({
    schemaVersion: 1,
    state: "available",
    cliAvailable: true,
    fileLoginAvailable: true,
  });
  const cases = [
    { body: "not json" },
    { body: "null" },
    { body: "[]" },
    { body: exact.replace("{", `{"private":"${privateCanary}",`) },
    { body: exact.replace("{", `{"credentialMode":"${privateCanary}",`) },
    { body: exact.replace('"schemaVersion":1', '"schemaVersion":2') },
    { body: exact.replace('"available"', '"unknown"') },
    { body: exact.replace('"cliAvailable":true', '"cliAvailable":false') },
    { body: exact.replace('"schemaVersion":1', '"schemaVersion":1,"schemaVersion":1') },
    { body: Buffer.from([0xc3, 0x28]) },
    { body: Buffer.alloc((16 * 1024) + 1, 0x41) },
    { body: exact, headers: { "content-type": "text/plain" } },
    {
      body: privateCanary,
      status: 302,
      headers: { location: `${origin}/${privateCanary}` },
    },
    { body: privateCanary, status: 503 },
  ];

  for (const candidate of cases) {
    fixture = candidate;
    const result = await runReadiness(["--origin", origin]);
    assert.equal(result.status, 1);
    assert.equal(result.signal, null);
    assert.equal(result.stdout, "");
    assert.equal(result.stderr, failureMarker);
    assert.equal(`${result.stdout}${result.stderr}`.includes(privateCanary), false);
  }
  assert.equal(requests, cases.length);
});

test("readiness command accepts the sanitized native login route", async (t) => {
  const origin = await listen(t, (_request, response) => {
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({
      schemaVersion: 1,
      state: "available",
      cliAvailable: true,
      fileLoginAvailable: true,
      credentialMode: "codex-native-login",
    }));
  });
  const result = await runReadiness(["--origin", origin]);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, "CODEX_LOGIN_READINESS_OK state=available\n");
  assert.equal(result.stderr, "");
});

test("readiness command accepts no authority-bearing origin or extra option", async () => {
  for (const arguments_ of [
    [],
    ["--origin"],
    ["--origin", "http://localhost:4173"],
    ["--origin", "http://127.0.0.1"],
    ["--origin", "https://127.0.0.1:4173"],
    ["--origin", `http://user:${privateCanary}@127.0.0.1:4173`],
    ["--origin", "http://127.0.0.1:4173/private"],
    ["--origin", "http://127.0.0.1:4173?private=1"],
    ["--origin", "http://127.0.0.1:4173#private"],
    ["--origin", "http://127.0.0.1:4173", "--header", privateCanary],
  ]) {
    const result = await runReadiness(arguments_);
    assert.equal(result.status, 1);
    assert.equal(result.signal, null);
    assert.equal(result.stdout, "");
    assert.equal(result.stderr, failureMarker);
    assert.equal(`${result.stdout}${result.stderr}`.includes(privateCanary), false);
  }
});

test("readiness command accepts a broker response after its 75-second budget", async (t) => {
  const origin = await listen(t, (_request, response) => {
    setTimeout(() => {
      response.writeHead(200, {
        "content-type": "application/json; charset=utf-8",
      });
      response.end(JSON.stringify({
        schemaVersion: 1,
        state: "available",
        cliAvailable: true,
        fileLoginAvailable: true,
      }));
    }, 760);
  });
  const result = await runReadiness(["--origin", origin], {
    timeoutMs: 5_000,
    nodeArguments: ["--import", timeoutScaleHook],
  });

  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.signal, null);
  assert.equal(result.stdout, "CODEX_LOGIN_READINESS_OK state=available\n");
  assert.equal(result.stderr, "");
});

test("readiness command leaves time for the bounded broker probe and cleanup", {
  timeout: 100_000,
}, async (t) => {
  const origin = await listen(t, () => {});
  const startedAt = Date.now();
  const result = await runReadiness(["--origin", origin], { timeoutMs: 97_000 });
  const elapsed = Date.now() - startedAt;

  assert.equal(result.status, 1);
  assert.equal(result.signal, null);
  assert.equal(result.stdout, "");
  assert.equal(result.stderr, failureMarker);
  assert.equal(elapsed >= 89_000, true, `aborted too early after ${elapsed} ms`);
  assert.equal(elapsed < 95_000, true, `aborted too late after ${elapsed} ms`);
});
