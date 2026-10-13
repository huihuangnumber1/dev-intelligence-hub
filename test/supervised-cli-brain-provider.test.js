import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  link,
  lstat,
  mkdir,
  mkdtemp,
  open,
  opendir,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  rmdir,
  symlink,
  truncate,
  unlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import {
  createProductionSupervisedCliBrainProvider,
  createTestSupervisedCliBrainProvider,
  SupervisedCliBrainProvider,
} from "../src/adapters/supervised-cli-brain-provider.js";
import { createTestSupervisedProcessRunner } from "../src/lib/supervised-process-runner.js";
import { BrainRouter } from "../src/services/brain-router.js";

const SCHEMA = Object.freeze({
  type: "object",
  additionalProperties: false,
  required: ["ok"],
  properties: {
    ok: { type: "boolean" },
    order: { type: "number" },
  },
});
const PRIVATE_PROMPT = "PRIVATE_PROMPT_MUST_STAY_IN_STDIN";
const HOST_TEST_SKIP = process.env.MYDASHBOARD_SKIP_HOST_TESTS === "true"
  ? "requires native Windows ACL timing guarantees"
  : false;

async function temporaryDirectory(t, prefix) {
  const directory = await mkdtemp(path.join(tmpdir(), prefix));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

function setWindowsDirectoryAcl(directory, dacl) {
  const script = `
    $ErrorActionPreference = 'Stop'
    $target = [Text.Encoding]::UTF8.GetString(
      [Convert]::FromBase64String($env:MYDASHBOARD_TEST_ACL_PATH)
    )
    $sid = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value
    $sddl = ('O:{0}G:{0}D:P' -f $sid) + $env:MYDASHBOARD_TEST_DACL.Replace('{SID}', $sid)
    $security = [Security.AccessControl.DirectorySecurity]::new()
    $sections = [Security.AccessControl.AccessControlSections]::Access -bor
      [Security.AccessControl.AccessControlSections]::Owner -bor
      [Security.AccessControl.AccessControlSections]::Group
    $security.SetSecurityDescriptorSddlForm($sddl, $sections)
    [System.IO.Directory]::SetAccessControl($target, $security)
  `;
  const result = spawnSync(
    "powershell.exe",
    ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", script],
    {
      encoding: "utf8",
      env: {
        ...process.env,
        MYDASHBOARD_TEST_ACL_PATH: Buffer.from(directory, "utf8").toString("base64"),
        MYDASHBOARD_TEST_DACL: dacl,
      },
    },
  );
  assert.equal(result.status, 0, result.stderr);
}

function brainRequest(overrides = {}) {
  return {
    model: "bounded-model",
    messages: [
      { role: "system", content: "Return JSON." },
      { role: "user", content: PRIVATE_PROMPT },
    ],
    schema: SCHEMA,
    ...overrides,
  };
}

function testDescriptor(kind) {
  return Object.freeze({
    command: path.join(
      path.parse(process.cwd()).root,
      "verified-cli-fixtures",
      kind === "codex-cli" ? "codex.exe" : "claude.exe",
    ),
    prefixArgs: Object.freeze([]),
  });
}

function recordingLocator(descriptor) {
  const calls = [];
  return {
    calls,
    async resolve(kind) {
      calls.push(kind);
      return descriptor;
    },
  };
}

function recordingRunner(handler) {
  const calls = [];
  return {
    calls,
    async run(invocation) {
      calls.push(invocation);
      return handler(invocation, calls.length - 1);
    },
  };
}

function cleanupFileSystem(overrides = {}) {
  return Object.freeze({
    lstat,
    open,
    opendir,
    realpath,
    rename,
    rmdir,
    unlink,
    ...overrides,
  });
}

async function privateDirectoryManagerModule() {
  return import("../src/lib/private-directory-manager.js").catch(() => null);
}

test("production supervised CLI policy rejects every platform except Windows x64", async () => {
  const managerModule = await privateDirectoryManagerModule();
  assert.ok(managerModule, "private directory manager is required");
  assert.equal(
    managerModule.productionSupervisedCliPlatformSupported("win32", "x64"),
    true,
  );
  for (const [platform, architecture] of [
    ["linux", "x64"],
    ["darwin", "arm64"],
    ["win32", "arm64"],
    ["win32", "ia32"],
  ]) {
    assert.equal(
      managerModule.productionSupervisedCliPlatformSupported(
        platform,
        architecture,
      ),
      false,
    );
  }
});

test("production construction requires lexical composition authority before platform or request access", async (t) => {
  const profile = await temporaryDirectory(t, "supervised-cli-unsupported-");
  const script = `
    const module = await import('./src/adapters/supervised-cli-brain-provider.js');
    Object.defineProperty(process, 'platform', { value: 'linux' });
    Object.defineProperty(process, 'arch', { value: 'x64' });
    let reads = 0;
    const request = new Proxy({}, {
      get() { reads += 1; return undefined; },
      ownKeys() { reads += 1; return []; },
    });
    let message = null;
    try {
      const provider = module.createProductionSupervisedCliBrainProvider({
        id: 'unsupported',
        cliKind: 'codex-cli',
      });
      await provider.generate(request);
    } catch (error) {
      message = error?.message;
    }
    process.stdout.write(JSON.stringify({ message, reads }));
  `;
  const child = spawnSync(
    process.execPath,
    ["--input-type=module", "-e", script],
    {
      cwd: process.cwd(),
      encoding: "utf8",
      env: {
        ...process.env,
        HOME: profile,
        USERPROFILE: profile,
        OPENAI_API_KEY: "test-only-credential",
      },
    },
  );
  assert.equal(child.status, 0, child.stderr);
  const result = JSON.parse(child.stdout);
  assert.match(result.message, /composition grant|composition authority/i);
  assert.equal(result.reads, 0);
  await assert.rejects(
    lstat(path.join(profile, ".mydashboard-supervised-cli-v1")),
    { code: "ENOENT" },
  );
});

async function within(milliseconds, promise) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(
          () => reject(new Error("provider request did not settle within its test bound")),
          milliseconds,
        );
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function deferred() {
  let resolve;
  const promise = new Promise((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

async function waitForCausalOutcome(outcomes, probe, description) {
  let settled = null;
  for (const [name, promise] of outcomes) {
    void Promise.resolve(promise).then(
      (value) => { settled ??= { name, value, error: null }; },
      (error) => { settled ??= { name, value: null, error }; },
    );
  }
  for (let attempt = 0; attempt < 10_000 && settled === null; attempt += 1) {
    await probe();
    await new Promise((resolve) => setImmediate(resolve));
  }
  if (settled === null) {
    throw new Error(`${description} did not occur within its causal poll bound`);
  }
  return settled;
}

function successfulProcess(stdoutBytes = Buffer.alloc(0)) {
  const bytes = Buffer.from(stdoutBytes);
  return {
    exitCode: 0,
    signal: null,
    stdout: bytes.toString("utf8"),
    stderr: "",
    stdoutBytes: bytes,
    stderrBytes: Buffer.alloc(0),
  };
}

function codexOutput(value) {
  return JSON.stringify({ result: JSON.stringify(value) });
}

const CODEX_OUTPUT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["result"],
  properties: { result: { type: "string" } },
};

async function directoryIdentity(directory) {
  const details = await lstat(directory, { bigint: true });
  return Object.freeze({
    path: directory,
    device: details.dev.toString(),
    inode: details.ino.toString(),
  });
}

function argumentValue(args, flag) {
  const index = args.indexOf(flag);
  assert.notEqual(index, -1, `missing ${flag}`);
  assert.ok(index + 1 < args.length, `missing ${flag} value`);
  return args[index + 1];
}

function isSameOrDescendantPath(parent, candidate) {
  const relative = path.relative(parent, candidate);
  return relative === "" || (
    relative !== ".." &&
    !relative.startsWith(`..${path.sep}`) &&
    !path.isAbsolute(relative)
  );
}

test("repository path checks distinguish sibling validation roots", () => {
  const repository = path.join(
    path.parse(process.cwd()).root,
    "workspace",
    "MyDashboard",
  );
  assert.equal(isSameOrDescendantPath(repository, repository), true);
  assert.equal(
    isSameOrDescendantPath(repository, path.join(repository, "runtime")),
    true,
  );
  assert.equal(
    isSameOrDescendantPath(repository, `${repository}-validation-temp`),
    false,
  );
});

function claudeEnvelope(result = '{"ok":true,"order":2}', overrides = {}) {
  return {
    type: "result",
    subtype: "success",
    is_error: false,
    duration_ms: 20,
    duration_api_ms: 10,
    num_turns: 1,
    result,
    session_id: "isolated-session",
    total_cost_usd: 0.001,
    usage: { input_tokens: 10, output_tokens: 5 },
    modelUsage: { "bounded-model": { inputTokens: 10, outputTokens: 5 } },
    permission_denials: [],
    uuid: "isolated-result",
    ...overrides,
  };
}

function providerOptions(cliKind) {
  return {
    id: cliKind,
    cliKind,
    timeoutMs: 300_000,
    maxResponseBytes: 128 * 1024,
    maxRequestBytes: 256 * 1024,
  };
}

function recordingCodexLoginBroker(events, options = {}) {
  return Object.freeze({
    async acquire({ signal }) {
      assert.equal(signal instanceof AbortSignal, true);
      events.push("acquire");
      return Object.freeze({
        async stage({ invocation, signal: stageSignal }) {
          assert.equal(stageSignal instanceof AbortSignal, true);
          assert.equal(Object.isFrozen(invocation), true);
          assert.deepEqual(Reflect.ownKeys(invocation).sort(), [
            "device",
            "inode",
            "path",
          ]);
          events.push("stage");
          const codexHome = path.join(invocation.path, "codex-home");
          await mkdir(codexHome);
          await writeFile(
            path.join(codexHome, "auth.json"),
            "fictional-login-credential",
          );
          return Object.freeze({ codexHome });
        },
        async capture({ signal: captureSignal }) {
          assert.equal(captureSignal instanceof AbortSignal, true);
          events.push("capture");
          if (options.captureError) throw options.captureError;
        },
        release({ safe }) {
          events.push(`release:${safe}`);
        },
      });
    },
    async readStatus({ signal }) {
      assert.equal(signal instanceof AbortSignal, true);
      events.push("readStatus");
      if (options.availabilityError) throw options.availabilityError;
      return options.availabilityStatus ?? Object.freeze({
        schemaVersion: 1,
        state: "available",
        cliAvailable: true,
        fileLoginAvailable: true,
      });
    },
  });
}

test("Codex runs once with fixed no-authority flags and an isolated environment", async (t) => {
  const parent = await temporaryDirectory(t, "supervised-codex-provider-");
  const temporaryRoot = path.join(parent, "runtime");
  const descriptor = testDescriptor("codex-cli");
  const locator = recordingLocator(descriptor);
  let invocationDirectory;
  const environment = {
    OPENAI_API_KEY: "codex-test-credential",
    PATH: "HOST_PATH_MUST_NOT_ESCAPE",
    GH_TOKEN: "GITHUB_TOKEN_MUST_NOT_ESCAPE",
    GITHUB_TOKEN: "GITHUB_TOKEN_MUST_NOT_ESCAPE",
    SSH_AUTH_SOCK: "SSH_AGENT_MUST_NOT_ESCAPE",
    GIT_CONFIG_COUNT: "1",
    GIT_CONFIG_KEY_0: "credential.helper",
    GIT_CONFIG_VALUE_0: "private-helper",
    NODE_OPTIONS: "--require=private-hook.js",
    USERPROFILE: "HOST_PROFILE_MUST_NOT_ESCAPE",
  };
  const runner = recordingRunner(async (invocation) => {
    invocationDirectory = invocation.cwd;
    assert.equal(invocation.executable, descriptor);
    assert.deepEqual(invocation.args.slice(0, 33), [
      "exec",
      "--ephemeral",
      "--ignore-user-config",
      "--ignore-rules",
      "--skip-git-repo-check",
      "--sandbox",
      "read-only",
      "--strict-config",
      "--disable",
      "shell_tool",
      "--disable",
      "apps",
      "--disable",
      "browser_use",
      "--disable",
      "computer_use",
      "--disable",
      "image_generation",
      "--disable",
      "multi_agent",
      "--disable",
      "hooks",
      "--disable",
      "plugins",
      "--disable",
      "remote_plugin",
      "--disable",
      "plugin_sharing",
      "--disable",
      "skill_search",
      "--disable",
      "goals",
      "--color",
    ]);
    assert.equal(invocation.args[33], "never");
    assert.equal(argumentValue(invocation.args, "--model"), "bounded-model");
    assert.equal(
      argumentValue(invocation.args, "-c"),
      'model_reasoning_effort="high"',
    );
    assert.equal(argumentValue(invocation.args, "-C"), invocation.cwd);
    assert.equal(invocation.args.at(-1), "-");
    for (const forbidden of [
      "resume",
      "--add-dir",
      "workspace-write",
      "--dangerously-bypass-approvals-and-sandbox",
      "--full-auto",
      "--plugin-dir",
      "--mcp-config",
    ]) {
      assert.equal(invocation.args.includes(forbidden), false, forbidden);
    }
    assert.equal(invocation.args.join(" ").includes(PRIVATE_PROMPT), false);
    for (const argument of invocation.args) {
      if (!path.isAbsolute(argument)) continue;
      assert.equal(
        isSameOrDescendantPath(process.cwd(), argument),
        false,
        `repository path escaped through argument: ${argument}`,
      );
    }

    const payload = JSON.parse(Buffer.from(invocation.input).toString("utf8"));
    assert.equal(payload.schemaVersion, 1);
    assert.match(payload.instruction, /output envelope/i);
    assert.deepEqual(payload.messages, brainRequest().messages);
    assert.deepEqual(payload.schema, SCHEMA);

    const childEnvironment = invocation.env;
    assert.deepEqual(Object.keys(childEnvironment).sort(), [
      "APPDATA",
      "CI",
      "HOME",
      "LANG",
      "LC_ALL",
      "LOCALAPPDATA",
      "NO_COLOR",
      "OPENAI_API_KEY",
      "TEMP",
      "TERM",
      "TMP",
      "TMPDIR",
      "USERPROFILE",
      "XDG_CACHE_HOME",
      "XDG_CONFIG_HOME",
      "XDG_DATA_HOME",
    ]);
    for (const forbidden of [
      "PATH",
      "GH_TOKEN",
      "GITHUB_TOKEN",
      "SSH_AUTH_SOCK",
      "NODE_OPTIONS",
    ]) {
      assert.equal(Object.hasOwn(childEnvironment, forbidden), false, forbidden);
    }
    assert.equal(childEnvironment.OPENAI_API_KEY, "codex-test-credential");
    assert.equal(Object.hasOwn(childEnvironment, "ANTHROPIC_API_KEY"), false);
    for (const name of [
      "HOME",
      "USERPROFILE",
      "APPDATA",
      "LOCALAPPDATA",
      "XDG_CONFIG_HOME",
      "XDG_CACHE_HOME",
      "XDG_DATA_HOME",
      "TEMP",
      "TMP",
      "TMPDIR",
    ]) {
      assert.equal(path.relative(invocation.cwd, childEnvironment[name]).startsWith(".."), false, name);
      assert.equal(childEnvironment[name].includes("HOST_PROFILE"), false, name);
    }

    const schemaFile = argumentValue(invocation.args, "--output-schema");
    const resultFile = argumentValue(invocation.args, "--output-last-message");
    assert.deepEqual(
      JSON.parse(await readFile(schemaFile, "utf8")),
      CODEX_OUTPUT_SCHEMA,
    );
    if (process.platform !== "win32") {
      assert.equal((await lstat(schemaFile)).mode & 0o777, 0o600);
      assert.equal((await lstat(invocation.cwd)).mode & 0o777, 0o700);
    }
    await writeFile(resultFile, codexOutput({ order: 2, ok: true }), "utf8");
    return successfulProcess();
  });
  const provider = createTestSupervisedCliBrainProvider(
    providerOptions("codex-cli"),
    { processRunner: runner, commandLocator: locator, environment, temporaryRoot },
  );

  assert.equal(
    await provider.generate(brainRequest({ reasoningEffort: "high" })),
    '{"ok":true,"order":2}',
  );
  assert.equal(provider.kind, "codex-cli");
  assert.equal(provider.remote, true);
  assert.equal(provider.singleAttempt, true);
  assert.deepEqual(locator.calls, ["codex-cli"]);
  assert.equal(runner.calls.length, 1);
  await assert.rejects(lstat(invocationDirectory), { code: "ENOENT" });
});

test("Codex resumes the persisted session for the same PR entity", async (t) => {
  const parent = await temporaryDirectory(t, "supervised-codex-session-");
  const temporaryRoot = path.join(parent, "runtime");
  const descriptor = testDescriptor("codex-cli");
  const sessions = new Map();
  const sessionStore = {
    async stage({ sessionKey }) {
      return { sessionId: sessions.get(sessionKey) ?? null };
    },
    async capture({ sessionKey, sessionId }) {
      sessions.set(sessionKey, sessionId);
    },
  };
  const runner = recordingRunner(async (invocation, index) => {
    const args = invocation.args;
    const resumeIndex = args.indexOf("resume");
    if (index === 0) {
      assert.equal(resumeIndex, -1);
      assert.equal(args.includes("--ephemeral"), false);
    } else {
      assert.notEqual(resumeIndex, -1);
      assert.equal(args[resumeIndex + 1], "019cfake-session-id");
      assert.equal(args.at(-1), "-");
    }
    assert.equal(args.includes("--json"), true);
    const resultFile = argumentValue(args, "--output-last-message");
    await writeFile(resultFile, codexOutput({ ok: true }), "utf8");
    return successfulProcess(
      Buffer.from(
        `${JSON.stringify({
          type: "thread.started",
          thread_id: "019cfake-session-id",
        })}\n`,
      ),
    );
  });
  const provider = createTestSupervisedCliBrainProvider(
    providerOptions("codex-cli"),
    {
      processRunner: runner,
      commandLocator: recordingLocator(descriptor),
      environment: { OPENAI_API_KEY: "codex-test-credential" },
      temporaryRoot,
      codexSessionStore: sessionStore,
    },
  );
  const request = brainRequest({
    sessionKey: "github:pull_request:example/software#24256",
  });

  assert.equal(await provider.generate(request), '{"ok":true}');
  assert.equal(await provider.generate(request), '{"ok":true}');
  assert.equal(runner.calls.length, 2);
  assert.equal(
    sessions.get("github:pull_request:example/software#24256"),
    "019cfake-session-id",
  );
});

test("Codex serializes concurrent turns for the same PR session", async (t) => {
  const parent = await temporaryDirectory(t, "supervised-codex-session-queue-");
  const temporaryRoot = path.join(parent, "runtime");
  const descriptor = testDescriptor("codex-cli");
  const sessions = new Map();
  const firstStarted = deferred();
  const releaseFirst = deferred();
  const sessionStore = {
    async stage({ sessionKey }) {
      return { sessionId: sessions.get(sessionKey) ?? null };
    },
    async capture({ sessionKey, sessionId }) {
      sessions.set(sessionKey, sessionId);
    },
  };
  const runner = recordingRunner(async (invocation, index) => {
    if (index === 0) {
      firstStarted.resolve();
      await releaseFirst.promise;
      assert.equal(invocation.args.includes("resume"), false);
    } else {
      const resumeIndex = invocation.args.indexOf("resume");
      assert.notEqual(resumeIndex, -1);
      assert.equal(invocation.args[resumeIndex + 1], "019cfake-session-id");
    }
    const resultFile = argumentValue(invocation.args, "--output-last-message");
    await writeFile(resultFile, codexOutput({ turn: index + 1 }), "utf8");
    return successfulProcess(Buffer.from(
      `${JSON.stringify({
        type: "thread.started",
        thread_id: "019cfake-session-id",
      })}\n`,
    ));
  });
  const provider = createTestSupervisedCliBrainProvider(
    providerOptions("codex-cli"),
    {
      processRunner: runner,
      commandLocator: recordingLocator(descriptor),
      environment: { OPENAI_API_KEY: "codex-test-credential" },
      temporaryRoot,
      codexSessionStore: sessionStore,
    },
  );
  const siblingProvider = createTestSupervisedCliBrainProvider(
    { ...providerOptions("codex-cli"), id: "codex-cli-sibling" },
    {
      processRunner: runner,
      commandLocator: recordingLocator(descriptor),
      environment: { OPENAI_API_KEY: "codex-test-credential" },
      temporaryRoot,
      codexSessionStore: sessionStore,
    },
  );
  const request = brainRequest({
    sessionKey: "github:pull_request:example/software#24256",
  });

  const first = provider.generate(request);
  await firstStarted.promise;
  const second = siblingProvider.generate(request);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(runner.calls.length, 1);

  releaseFirst.resolve();
  assert.equal(await first, '{"turn":1}');
  assert.equal(await second, '{"turn":2}');
  assert.equal(runner.calls.length, 2);
});

test("a cancelled queued Codex turn cannot let a later same-PR turn overtake", async (t) => {
  const parent = await temporaryDirectory(t, "supervised-codex-session-cancel-");
  const temporaryRoot = path.join(parent, "runtime");
  const descriptor = testDescriptor("codex-cli");
  const sessions = new Map();
  const firstStarted = deferred();
  const releaseFirst = deferred();
  const sessionStore = {
    async stage({ sessionKey }) {
      return { sessionId: sessions.get(sessionKey) ?? null };
    },
    async capture({ sessionKey, sessionId }) {
      sessions.set(sessionKey, sessionId);
    },
  };
  const runner = recordingRunner(async (invocation, index) => {
    if (index === 0) {
      firstStarted.resolve();
      await releaseFirst.promise;
    } else {
      const resumeIndex = invocation.args.indexOf("resume");
      assert.notEqual(resumeIndex, -1);
      assert.equal(invocation.args[resumeIndex + 1], "019cfake-session-id");
    }
    const resultFile = argumentValue(invocation.args, "--output-last-message");
    await writeFile(resultFile, codexOutput({ turn: index + 1 }), "utf8");
    return successfulProcess(Buffer.from(
      `${JSON.stringify({
        type: "thread.started",
        thread_id: "019cfake-session-id",
      })}\n`,
    ));
  });
  const provider = createTestSupervisedCliBrainProvider(
    providerOptions("codex-cli"),
    {
      processRunner: runner,
      commandLocator: recordingLocator(descriptor),
      environment: { OPENAI_API_KEY: "codex-test-credential" },
      temporaryRoot,
      codexSessionStore: sessionStore,
    },
  );
  const sessionKey = "github:pull_request:example/software#24256";
  const first = provider.generate(brainRequest({ sessionKey }));
  await firstStarted.promise;
  const cancelled = new AbortController();
  const middle = provider.generate(brainRequest({
    sessionKey,
    signal: cancelled.signal,
  }));
  await new Promise((resolve) => setImmediate(resolve));
  const last = provider.generate(brainRequest({ sessionKey }));
  await new Promise((resolve) => setImmediate(resolve));

  cancelled.abort();
  await assert.rejects(middle, { code: "STRUCTURED_PROVIDER_CANCELLED" });
  assert.equal(runner.calls.length, 1);

  releaseFirst.resolve();
  assert.equal(await first, '{"turn":1}');
  assert.equal(await last, '{"turn":2}');
  assert.equal(runner.calls.length, 2);
});

test("Codex login mode stages one isolated profile and omits every API credential", async (t) => {
  const parent = await temporaryDirectory(t, "supervised-codex-login-");
  const temporaryRoot = path.join(parent, "runtime");
  const descriptor = testDescriptor("codex-cli");
  const events = [];
  const locator = {
    async resolve() {
      events.push("locator");
      return descriptor;
    },
  };
  const runner = recordingRunner(async (invocation) => {
    events.push("run");
    assert.deepEqual(Object.keys(invocation.env).sort(), [
      "APPDATA",
      "CI",
      "CODEX_HOME",
      "HOME",
      "LANG",
      "LC_ALL",
      "LOCALAPPDATA",
      "NO_COLOR",
      "TEMP",
      "TERM",
      "TMP",
      "TMPDIR",
      "USERPROFILE",
      "XDG_CACHE_HOME",
      "XDG_CONFIG_HOME",
      "XDG_DATA_HOME",
    ].sort());
    assert.equal(invocation.env.CODEX_HOME, path.join(invocation.cwd, "codex-home"));
    for (const name of [
      "OPENAI_API_KEY",
      "CODEX_API_KEY",
      "CODEX_ACCESS_TOKEN",
      "GH_TOKEN",
      "GITHUB_TOKEN",
    ]) {
      assert.equal(Object.hasOwn(invocation.env, name), false, name);
    }
    assert.equal(
      await readFile(path.join(invocation.env.CODEX_HOME, "auth.json"), "utf8"),
      "fictional-login-credential",
    );
    const resultFile = argumentValue(invocation.args, "--output-last-message");
    await writeFile(resultFile, codexOutput({ ok: true }), "utf8");
    return successfulProcess();
  });
  const provider = createTestSupervisedCliBrainProvider(
    {
      ...providerOptions("codex-cli"),
      credentialMode: "codex-login",
    },
    {
      processRunner: runner,
      commandLocator: locator,
      environment: {
        OPENAI_API_KEY: "MUST_NOT_ESCAPE",
        CODEX_API_KEY: "MUST_NOT_ESCAPE",
        CODEX_ACCESS_TOKEN: "MUST_NOT_ESCAPE",
      },
      temporaryRoot,
      codexLoginCredentialBroker: recordingCodexLoginBroker(events),
    },
  );

  assert.equal(await provider.generate(brainRequest()), '{"ok":true}');
  assert.deepEqual(events, [
    "acquire",
    "locator",
    "stage",
    "run",
    "capture",
    "release:true",
  ]);
});

test("credential mode combinations fail at construction without touching a broker", async (t) => {
  const parent = await temporaryDirectory(t, "supervised-cli-mode-");
  const dependencies = {
    processRunner: recordingRunner(async () => successfulProcess()),
    commandLocator: recordingLocator(testDescriptor("codex-cli")),
    environment: {},
    temporaryRoot: path.join(parent, "runtime"),
  };
  assert.throws(
    () => createTestSupervisedCliBrainProvider({
      ...providerOptions("codex-cli"),
      credentialMode: "codex-login",
    }, dependencies),
    /credential broker|codex-login/u,
  );
  assert.throws(
    () => createTestSupervisedCliBrainProvider({
      ...providerOptions("claude-cli"),
      credentialMode: "codex-login",
    }, {
      ...dependencies,
      codexLoginCredentialBroker: recordingCodexLoginBroker([]),
    }),
    /Claude CLI credentialMode/u,
  );
  assert.throws(
    () => createTestSupervisedCliBrainProvider({
      ...providerOptions("codex-cli"),
      credentialMode: "unknown-mode",
    }, dependencies),
    /credentialMode/u,
  );
});

test("availability checks credentials or the login broker status without invoking a model", async (t) => {
  const parent = await temporaryDirectory(t, "supervised-cli-availability-");
  const apiLocator = recordingLocator(testDescriptor("codex-cli"));
  const apiRunner = recordingRunner(async () => {
    throw new Error("model process must not run");
  });
  const apiProvider = createTestSupervisedCliBrainProvider(
    providerOptions("codex-cli"),
    {
      processRunner: apiRunner,
      commandLocator: apiLocator,
      environment: { OPENAI_API_KEY: "fictional-api-credential" },
      temporaryRoot: path.join(parent, "api-runtime"),
    },
  );
  const apiController = new AbortController();
  await apiProvider.checkAvailability({ signal: apiController.signal });
  assert.deepEqual(apiLocator.calls, ["codex-cli"]);
  assert.equal(apiRunner.calls.length, 0);

  const loginEvents = [];
  const loginLocator = recordingLocator(testDescriptor("codex-cli"));
  const loginRunner = recordingRunner(async () => {
    throw new Error("model process must not run");
  });
  const loginProvider = createTestSupervisedCliBrainProvider({
    ...providerOptions("codex-cli"),
    credentialMode: "codex-login",
  }, {
    processRunner: loginRunner,
    commandLocator: loginLocator,
    environment: {},
    temporaryRoot: path.join(parent, "login-runtime"),
    codexLoginCredentialBroker: recordingCodexLoginBroker(loginEvents),
  });
  const loginController = new AbortController();
  await loginProvider.checkAvailability({ signal: loginController.signal });
  assert.deepEqual(loginEvents, ["readStatus"]);
  assert.equal(loginLocator.calls.length, 0);
  assert.equal(loginRunner.calls.length, 0);
});

test("availability does not queue a login probe behind an admitted generation", async (t) => {
  const parent = await temporaryDirectory(t, "supervised-cli-busy-availability-");
  const events = [];
  const generationStarted = deferred();
  const releaseGeneration = deferred();
  const runner = recordingRunner(async (invocation) => {
    generationStarted.resolve();
    await releaseGeneration.promise;
    const resultFile = argumentValue(invocation.args, "--output-last-message");
    await writeFile(resultFile, codexOutput({ ok: true }), "utf8");
    return successfulProcess();
  });
  const provider = createTestSupervisedCliBrainProvider({
    ...providerOptions("codex-cli"),
    credentialMode: "codex-login",
  }, {
    processRunner: runner,
    commandLocator: recordingLocator(testDescriptor("codex-cli")),
    environment: {},
    temporaryRoot: path.join(parent, "runtime"),
    codexLoginCredentialBroker: recordingCodexLoginBroker(events),
  });

  const generation = provider.generate(brainRequest());
  await generationStarted.promise;

  await within(250, provider.checkAvailability());
  assert.equal(events.includes("readStatus"), false);

  releaseGeneration.resolve();
  assert.equal(await generation, '{"ok":true}');
  await provider.close();
});

test("login availability maps broker status without publishing credential state", async (t) => {
  const parent = await temporaryDirectory(t, "supervised-login-status-");
  const cases = [
    [
      "file_login_unavailable",
      true,
      false,
      "STRUCTURED_PROVIDER_CREDENTIAL_UNAVAILABLE",
    ],
    ["unsafe_source", true, false, "STRUCTURED_PROVIDER_CREDENTIAL_UNAVAILABLE"],
    ["cli_unavailable", false, false, "STRUCTURED_PROVIDER_UNAVAILABLE"],
    ["broker_blocked", true, false, "STRUCTURED_PROVIDER_CLEANUP_FAILED"],
  ];
  for (const [state, cliAvailable, fileLoginAvailable, expectedCode] of cases) {
    await t.test(state, async (child) => {
      const events = [];
      const provider = createTestSupervisedCliBrainProvider({
        ...providerOptions("codex-cli"),
        credentialMode: "codex-login",
      }, {
        processRunner: recordingRunner(async () => successfulProcess()),
        commandLocator: recordingLocator(testDescriptor("codex-cli")),
        environment: {},
        temporaryRoot: path.join(parent, child.name),
        codexLoginCredentialBroker: recordingCodexLoginBroker(events, {
          availabilityStatus: Object.freeze({
            schemaVersion: 1,
            state,
            cliAvailable,
            fileLoginAvailable,
          }),
        }),
      });

      await assert.rejects(provider.checkAvailability(), { code: expectedCode });
      assert.deepEqual(events, ["readStatus"]);
      await provider.close();
    });
  }
});

test("availability fails before locator when the selected credential is unavailable", async (t) => {
  const parent = await temporaryDirectory(t, "supervised-cli-availability-denied-");
  const locator = recordingLocator(testDescriptor("codex-cli"));
  const provider = createTestSupervisedCliBrainProvider(
    providerOptions("codex-cli"),
    {
      processRunner: recordingRunner(async () => successfulProcess()),
      commandLocator: locator,
      environment: {},
      temporaryRoot: path.join(parent, "runtime"),
    },
  );
  await assert.rejects(provider.checkAvailability(), {
    code: "STRUCTURED_PROVIDER_CREDENTIAL_UNAVAILABLE",
  });
  assert.equal(locator.calls.length, 0);
});

test("login mode captures after a reaped process failure and before malformed result parsing", async (t) => {
  for (const scenario of [
    "process-failed",
    "malformed-result",
    "missing-envelope",
    "malformed-envelope-result",
  ]) {
    await t.test(scenario, async (child) => {
      const parent = await temporaryDirectory(child, `supervised-login-${scenario}-`);
      const events = [];
      const runner = recordingRunner(async (invocation) => {
        events.push("run");
        if (scenario === "process-failed") {
          throw Object.assign(new Error("fictional process detail"), {
            code: "STRUCTURED_PROVIDER_PROCESS_FAILED",
          });
        }
        const resultFile = argumentValue(invocation.args, "--output-last-message");
        const result = scenario === "missing-envelope"
          ? '{"ok":true}'
          : scenario === "malformed-envelope-result"
            ? '{"result":"not-json"}'
            : "not-json";
        await writeFile(resultFile, result, "utf8");
        return successfulProcess();
      });
      const provider = createTestSupervisedCliBrainProvider({
        ...providerOptions("codex-cli"),
        credentialMode: "codex-login",
      }, {
        processRunner: runner,
        commandLocator: {
          async resolve() {
            events.push("locator");
            return testDescriptor("codex-cli");
          },
        },
        environment: {},
        temporaryRoot: path.join(parent, "runtime"),
        codexLoginCredentialBroker: recordingCodexLoginBroker(events),
      });

      await assert.rejects(
        provider.generate(brainRequest()),
        {
          code: scenario === "process-failed"
            ? "STRUCTURED_PROVIDER_PROCESS_FAILED"
            : "STRUCTURED_PROVIDER_RESPONSE_INVALID",
        },
      );
      assert.deepEqual(events, [
        "acquire",
        "locator",
        "stage",
        "run",
        "capture",
        "release:true",
      ]);
    });
  }
});

test("login mode never captures an unproved process and fences capture uncertainty", async (t) => {
  for (const scenario of ["reap-failed", "capture-failed"]) {
    await t.test(scenario, async (child) => {
      const parent = await temporaryDirectory(child, `supervised-login-${scenario}-`);
      const events = [];
      const captureError = scenario === "capture-failed"
        ? Object.assign(new Error("fictional capture detail"), {
            code: "STRUCTURED_PROVIDER_CLEANUP_FAILED",
          })
        : null;
      const runner = recordingRunner(async (invocation) => {
        events.push("run");
        if (scenario === "reap-failed") {
          throw Object.assign(new Error("fictional reap detail"), {
            code: "STRUCTURED_PROVIDER_REAP_FAILED",
          });
        }
        const resultFile = argumentValue(invocation.args, "--output-last-message");
        await writeFile(resultFile, codexOutput({ ok: true }), "utf8");
        return successfulProcess();
      });
      const provider = createTestSupervisedCliBrainProvider({
        ...providerOptions("codex-cli"),
        credentialMode: "codex-login",
      }, {
        processRunner: runner,
        commandLocator: {
          async resolve() {
            events.push("locator");
            return testDescriptor("codex-cli");
          },
        },
        environment: {},
        temporaryRoot: path.join(parent, "runtime"),
        codexLoginCredentialBroker: recordingCodexLoginBroker(events, {
          captureError,
        }),
      });

      await assert.rejects(provider.generate(brainRequest()), {
        code: scenario === "reap-failed"
          ? "STRUCTURED_PROVIDER_REAP_FAILED"
          : "STRUCTURED_PROVIDER_CLEANUP_FAILED",
      });
      assert.deepEqual(events, scenario === "reap-failed"
        ? ["acquire", "locator", "stage", "run", "release:false"]
        : ["acquire", "locator", "stage", "run", "capture", "release:false"]);
    });
  }
});

test("Claude runs once with tools disabled and accepts only its exact success envelope", async (t) => {
  const parent = await temporaryDirectory(t, "supervised-claude-provider-");
  const temporaryRoot = path.join(parent, "runtime");
  const descriptor = testDescriptor("claude-cli");
  const locator = recordingLocator(descriptor);
  let invocationDirectory;
  const runner = recordingRunner(async (invocation) => {
    invocationDirectory = invocation.cwd;
    assert.equal(invocation.executable, descriptor);
    for (const [flag, value] of [
      ["--output-format", "json"],
      ["--input-format", "text"],
      ["--tools", ""],
      ["--permission-mode", "dontAsk"],
      ["--mcp-config", "{}"],
      ["--model", "bounded-model"],
    ]) {
      assert.equal(argumentValue(invocation.args, flag), value, flag);
    }
    for (const flag of [
      "--print",
      "--safe-mode",
      "--disable-slash-commands",
      "--strict-mcp-config",
      "--no-chrome",
      "--no-session-persistence",
    ]) {
      assert.equal(invocation.args.includes(flag), true, flag);
    }
    for (const forbidden of [
      "--max-turns",
      "--system-prompt",
      "--system-prompt-file",
      "--json-schema",
      "--allowedTools",
      "--dangerously-skip-permissions",
      "--add-dir",
      "--resume",
      "--continue",
      "--plugin-dir",
    ]) {
      assert.equal(invocation.args.includes(forbidden), false, forbidden);
    }
    assert.equal(invocation.args.join(" ").includes(PRIVATE_PROMPT), false);
    const payload = JSON.parse(Buffer.from(invocation.input).toString("utf8"));
    assert.deepEqual(payload.messages, brainRequest().messages);
    assert.deepEqual(payload.schema, SCHEMA);
    assert.equal(invocation.env.ANTHROPIC_API_KEY, "claude-test-credential");
    assert.equal(Object.hasOwn(invocation.env, "OPENAI_API_KEY"), false);
    assert.equal(
      Object.hasOwn(invocation.env, "CLAUDE_CODE_OAUTH_TOKEN"),
      false,
    );
    assert.deepEqual(Object.keys(invocation.env).sort(), [
      "ANTHROPIC_API_KEY",
      "APPDATA",
      "CI",
      "HOME",
      "LANG",
      "LC_ALL",
      "LOCALAPPDATA",
      "NO_COLOR",
      "TEMP",
      "TERM",
      "TMP",
      "TMPDIR",
      "USERPROFILE",
      "XDG_CACHE_HOME",
      "XDG_CONFIG_HOME",
      "XDG_DATA_HOME",
    ]);
    return successfulProcess(
      Buffer.from(JSON.stringify(claudeEnvelope()), "utf8"),
    );
  });
  const provider = createTestSupervisedCliBrainProvider(
    providerOptions("claude-cli"),
    {
      processRunner: runner,
      commandLocator: locator,
      environment: {
        ANTHROPIC_API_KEY: "claude-test-credential",
        CLAUDE_CODE_OAUTH_TOKEN: "HOST_LOGIN_MUST_NOT_ESCAPE",
      },
      temporaryRoot,
    },
  );

  assert.equal(await provider.generate(brainRequest()), '{"ok":true,"order":2}');
  assert.equal(runner.calls.length, 1);
  await assert.rejects(lstat(invocationDirectory), { code: "ENOENT" });
});

test("credentials, cancellation, and request limits fail before locator or spawn", async (t) => {
  const parent = await temporaryDirectory(t, "supervised-cli-admission-");
  const temporaryRoot = path.join(parent, "runtime");
  const descriptor = testDescriptor("codex-cli");
  const locator = recordingLocator(descriptor);
  const runner = recordingRunner(async (invocation) => {
    const resultFile = argumentValue(invocation.args, "--output-last-message");
    await writeFile(resultFile, codexOutput({ ok: true }), "utf8");
    return successfulProcess();
  });
  const environment = {};
  const provider = createTestSupervisedCliBrainProvider(
    providerOptions("codex-cli"),
    { processRunner: runner, commandLocator: locator, environment, temporaryRoot },
  );

  await assert.rejects(
    provider.generate(brainRequest()),
    (error) => error.code === "STRUCTURED_PROVIDER_CREDENTIAL_UNAVAILABLE" &&
      error.statusCode === 503,
  );
  assert.equal(locator.calls.length, 0);
  assert.equal(runner.calls.length, 0);

  environment.OPENAI_API_KEY = "configured-after-startup";
  const controller = new AbortController();
  controller.abort(new Error("private cancellation reason"));
  await assert.rejects(
    provider.generate(brainRequest({ signal: controller.signal })),
    (error) => error.code === "STRUCTURED_PROVIDER_CANCELLED" &&
      !error.message.includes("private cancellation reason"),
  );
  assert.equal(locator.calls.length, 0);

  const bounded = createTestSupervisedCliBrainProvider(
    { ...providerOptions("codex-cli"), maxRequestBytes: 1_024 },
    { processRunner: runner, commandLocator: locator, environment, temporaryRoot },
  );
  await assert.rejects(
    bounded.generate(brainRequest({
      messages: [{ role: "user", content: "x".repeat(2_000) }],
    })),
    { code: "STRUCTURED_PROVIDER_REQUEST_TOO_LARGE" },
  );
  assert.equal(locator.calls.length, 0);

  await assert.rejects(
    bounded.generate(brainRequest({
      messages: [{ role: "user", content: "x".repeat(670) }],
    })),
    { code: "STRUCTURED_PROVIDER_REQUEST_TOO_LARGE" },
  );
  assert.equal(locator.calls.length, 0);

  for (const model of [
    "--dangerously-skip-permissions",
    "-c",
    "model with spaces",
  ]) {
    await assert.rejects(
      provider.generate(brainRequest({ model })),
      /CLI model is invalid/,
    );
  }
  assert.equal(locator.calls.length, 0);

  assert.equal(await provider.generate(brainRequest()), '{"ok":true}');
  assert.equal(locator.calls.length, 1);
  assert.equal(runner.calls.length, 1);
});

test("cancellation bounds unresolved CLI discovery and a later attempt recovers", async (t) => {
  const parent = await temporaryDirectory(t, "supervised-cli-discovery-cancel-");
  const temporaryRoot = path.join(parent, "runtime");
  const descriptor = testDescriptor("codex-cli");
  let resolveCalls = 0;
  let discoverySignal = null;
  let discoveryStarted;
  const started = new Promise((resolve) => { discoveryStarted = resolve; });
  const locator = {
    async resolve(_kind, options = {}) {
      resolveCalls += 1;
      discoverySignal = options.signal ?? null;
      if (resolveCalls === 1) {
        discoveryStarted();
        return new Promise(() => {});
      }
      return descriptor;
    },
  };
  const runner = recordingRunner(async (invocation) => {
    const resultFile = argumentValue(invocation.args, "--output-last-message");
    await writeFile(resultFile, codexOutput({ ok: true }), "utf8");
    return successfulProcess();
  });
  const provider = createTestSupervisedCliBrainProvider(
    providerOptions("codex-cli"),
    {
      processRunner: runner,
      commandLocator: locator,
      environment: { OPENAI_API_KEY: "credential" },
      temporaryRoot,
    },
  );
  const controller = new AbortController();
  const cancelled = assert.rejects(
    provider.generate(brainRequest({ signal: controller.signal })),
    { code: "STRUCTURED_PROVIDER_CANCELLED" },
  );
  await started;
  controller.abort(new Error("private cancellation reason"));

  await within(1_000, cancelled);
  assert.equal(discoverySignal?.aborted, true);
  assert.equal(runner.calls.length, 0);
  assert.equal(await provider.generate(brainRequest()), '{"ok":true}');
  assert.equal(resolveCalls, 2);
});

test("the configured timeout bounds unresolved CLI discovery before spawn", async (t) => {
  const parent = await temporaryDirectory(t, "supervised-cli-discovery-timeout-");
  let discoverySignal = null;
  const runner = recordingRunner(async () => successfulProcess());
  const provider = createTestSupervisedCliBrainProvider(
    { ...providerOptions("codex-cli"), timeoutMs: 1_000 },
    {
      processRunner: runner,
      commandLocator: {
        async resolve(_kind, options = {}) {
          discoverySignal = options.signal ?? null;
          return new Promise(() => {});
        },
      },
      environment: { OPENAI_API_KEY: "credential" },
      temporaryRoot: path.join(parent, "runtime"),
    },
  );

  await within(
    3_000,
    assert.rejects(provider.generate(brainRequest()), {
      code: "STRUCTURED_PROVIDER_TIMEOUT",
    }),
  );
  assert.equal(discoverySignal?.aborted, true);
  assert.equal(runner.calls.length, 0);
});

test("cancellation bounds stale scanning and does not poison later use", async (t) => {
  const parent = await temporaryDirectory(t, "supervised-cli-scavenge-cancel-");
  const temporaryRoot = path.join(parent, "runtime");
  let scavengeCalls = 0;
  let scavengeSignal = null;
  let scavengeStarted;
  let releaseScavenge;
  const started = new Promise((resolve) => { scavengeStarted = resolve; });
  const released = new Promise((resolve) => { releaseScavenge = resolve; });
  const runner = recordingRunner(async (invocation) => {
    const resultFile = argumentValue(invocation.args, "--output-last-message");
    await writeFile(resultFile, codexOutput({ ok: true }), "utf8");
    return successfulProcess();
  });
  const provider = createTestSupervisedCliBrainProvider(
    providerOptions("codex-cli"),
    {
      processRunner: runner,
      commandLocator: recordingLocator(testDescriptor("codex-cli")),
      environment: { OPENAI_API_KEY: "credential" },
      temporaryRoot,
      staleInvocationScavenger: async ({ signal }) => {
        scavengeCalls += 1;
        scavengeSignal = signal;
        if (scavengeCalls === 1) {
          scavengeStarted();
          await released;
        }
      },
    },
  );
  const controller = new AbortController();
  const cancelled = assert.rejects(
    provider.generate(brainRequest({ signal: controller.signal })),
    { code: "STRUCTURED_PROVIDER_CANCELLED" },
  );
  await started;
  controller.abort();

  await within(1_000, cancelled);
  assert.equal(scavengeSignal?.aborted, true);
  assert.equal(runner.calls.length, 0);
  releaseScavenge();
  assert.equal(await provider.generate(brainRequest()), '{"ok":true}');
  assert.equal(scavengeCalls, 2);
});

test("stale scanning closes its root directory handle after cancellation", async (t) => {
  const parent = await temporaryDirectory(t, "supervised-cli-stale-root-close-");
  const temporaryRoot = path.join(parent, "runtime");
  const controller = new AbortController();
  let closeCalls = 0;
  const provider = createTestSupervisedCliBrainProvider(
    providerOptions("codex-cli"),
    {
      processRunner: recordingRunner(async () => successfulProcess()),
      commandLocator: recordingLocator(testDescriptor("codex-cli")),
      environment: { OPENAI_API_KEY: "credential" },
      temporaryRoot,
      cleanupFileSystem: cleanupFileSystem({
        async opendir(directory) {
          if (path.resolve(directory) !== path.resolve(temporaryRoot)) {
            return opendir(directory);
          }
          return {
            async read() {
              controller.abort();
              return null;
            },
            async close() {
              closeCalls += 1;
            },
          };
        },
      }),
    },
  );

  await assert.rejects(
    provider.generate(brainRequest({ signal: controller.signal })),
    { code: "STRUCTURED_PROVIDER_CANCELLED" },
  );
  assert.equal(closeCalls, 1);
});

test("stale marker inspection closes its file handle after cancellation", async (t) => {
  const parent = await temporaryDirectory(t, "supervised-cli-stale-marker-close-");
  const temporaryRoot = path.join(parent, "runtime");
  const staleDirectory = path.join(
    temporaryRoot,
    "invocation-codex-cli-stale-marker-close",
  );
  await mkdir(staleDirectory, { recursive: true });
  await writeFile(
    path.join(staleDirectory, ".mydashboard-invocation.json"),
    JSON.stringify({
      schemaVersion: 1,
      kind: "codex-cli",
      ownerPid: 72_001,
      createdAt: new Date(Date.now() - 48 * 60 * 60 * 1_000).toISOString(),
    }),
    "utf8",
  );
  const controller = new AbortController();
  let closeCalls = 0;
  const provider = createTestSupervisedCliBrainProvider(
    providerOptions("codex-cli"),
    {
      processRunner: recordingRunner(async () => successfulProcess()),
      commandLocator: recordingLocator(testDescriptor("codex-cli")),
      environment: { OPENAI_API_KEY: "credential" },
      temporaryRoot,
      isProcessAlive: () => false,
      cleanupFileSystem: cleanupFileSystem({
        async open(file, flags, mode) {
          const handle = await open(file, flags, mode);
          if (path.basename(file) === ".mydashboard-invocation.json") {
            controller.abort();
          }
          return {
            stat: (...args) => handle.stat(...args),
            readFile: (...args) => handle.readFile(...args),
            async close() {
              closeCalls += 1;
              await handle.close();
            },
          };
        },
      }),
    },
  );

  await assert.rejects(
    provider.generate(brainRequest({ signal: controller.signal })),
    { code: "STRUCTURED_PROVIDER_CANCELLED" },
  );
  assert.equal(closeCalls, 1);
});

test("cleanup inventory closes its directory handle after cancellation", async (t) => {
  const parent = await temporaryDirectory(t, "supervised-cli-inventory-close-");
  const temporaryRoot = path.join(parent, "runtime");
  const controller = new AbortController();
  let closeCalls = 0;
  let cleanupHandle = null;
  t.after(async () => cleanupHandle?.close().catch(() => {}));
  const runner = recordingRunner(async (invocation) => {
    const resultFile = argumentValue(invocation.args, "--output-last-message");
    await writeFile(resultFile, codexOutput({ ok: true }), "utf8");
    return successfulProcess();
  });
  const provider = createTestSupervisedCliBrainProvider(
    providerOptions("codex-cli"),
    {
      processRunner: runner,
      commandLocator: recordingLocator(testDescriptor("codex-cli")),
      environment: { OPENAI_API_KEY: "credential" },
      temporaryRoot,
      cleanupFileSystem: cleanupFileSystem({
        async opendir(directory) {
          const handle = await opendir(directory);
          if (!path.basename(directory).startsWith(".cleanup-")) return handle;
          cleanupHandle = handle;
          let cancelled = false;
          return {
            async read() {
              const entry = await handle.read();
              if (!cancelled) {
                cancelled = true;
                controller.abort();
              }
              return entry;
            },
            async close() {
              closeCalls += 1;
              await handle.close();
            },
          };
        },
      }),
    },
  );

  await assert.rejects(
    provider.generate(brainRequest({ signal: controller.signal })),
    { code: "STRUCTURED_PROVIDER_CANCELLED" },
  );
  assert.equal(closeCalls, 1);
});

test("an unsettled stale scan holds one cross-kind root lease after cancellation", async (t) => {
  const parent = await temporaryDirectory(t, "supervised-cli-cross-kind-lease-");
  const temporaryRoot = path.join(parent, "runtime");
  let firstStarted;
  let releaseFirst;
  const started = new Promise((resolve) => { firstStarted = resolve; });
  const released = new Promise((resolve) => { releaseFirst = resolve; });
  const first = createTestSupervisedCliBrainProvider(
    providerOptions("codex-cli"),
    {
      processRunner: recordingRunner(async () => successfulProcess()),
      commandLocator: recordingLocator(testDescriptor("codex-cli")),
      environment: { OPENAI_API_KEY: "credential" },
      temporaryRoot,
      staleInvocationScavenger: async () => {
        firstStarted();
        await released;
      },
    },
  );
  const firstController = new AbortController();
  const firstRequest = assert.rejects(
    first.generate(brainRequest({ signal: firstController.signal })),
    { code: "STRUCTURED_PROVIDER_CANCELLED" },
  );
  await started;
  firstController.abort();
  await within(1_000, firstRequest);

  let secondScans = 0;
  const secondLocator = recordingLocator(testDescriptor("claude-cli"));
  const secondRunner = recordingRunner(async () =>
    successfulProcess(Buffer.from(JSON.stringify(claudeEnvelope()))));
  const second = createTestSupervisedCliBrainProvider(
    providerOptions("claude-cli"),
    {
      processRunner: secondRunner,
      commandLocator: secondLocator,
      environment: { ANTHROPIC_API_KEY: "credential" },
      temporaryRoot,
      staleInvocationScavenger: async () => {
        secondScans += 1;
      },
    },
  );
  const secondController = new AbortController();
  const secondRequest = assert.rejects(
    second.generate(brainRequest({ signal: secondController.signal })),
    { code: "STRUCTURED_PROVIDER_CANCELLED" },
  );
  await new Promise((resolve) => setTimeout(resolve, 25));
  secondController.abort();
  await within(1_000, secondRequest);

  assert.equal(secondScans, 0);
  assert.equal(secondLocator.calls.length, 0);
  assert.equal(secondRunner.calls.length, 0);
  releaseFirst();
});

test("CLI discovery and initialization consume the runner's one total deadline", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const parent = await temporaryDirectory(t, "supervised-cli-total-deadline-");
  const temporaryRoot = path.join(parent, "runtime");
  let monotonicTime = 10_000;
  let discoverySignal = null;
  let scavengeSignal = null;
  const runner = recordingRunner(async (invocation) => {
    assert.equal(invocation.timeoutMs, 500);
    const resultFile = argumentValue(invocation.args, "--output-last-message");
    await writeFile(resultFile, codexOutput({ ok: true }), "utf8");
    return successfulProcess();
  });
  const provider = createTestSupervisedCliBrainProvider(
    { ...providerOptions("codex-cli"), timeoutMs: 1_000 },
    {
      processRunner: runner,
      commandLocator: {
        async resolve(_kind, options = {}) {
          discoverySignal = options.signal ?? null;
          monotonicTime += 200;
          return testDescriptor("codex-cli");
        },
      },
      environment: { OPENAI_API_KEY: "credential" },
      temporaryRoot,
      monotonicClock: () => monotonicTime,
      staleInvocationScavenger: async ({ signal }) => {
        scavengeSignal = signal;
        monotonicTime += 300;
      },
    },
  );

  try {
    assert.equal(await provider.generate(brainRequest()), '{"ok":true}');
  } finally {
    t.mock.timers.reset();
  }
  assert.equal(discoverySignal instanceof AbortSignal, true);
  assert.equal(scavengeSignal, discoverySignal);
  assert.equal(runner.calls.length, 1);
});

test("unsettled invocation setup cannot add settlement time beyond the total deadline", async (t) => {
  const parent = await temporaryDirectory(t, "supervised-cli-setup-deadline-");
  const startedAt = performance.now();
  const provider = createTestSupervisedCliBrainProvider(
    { ...providerOptions("codex-cli"), timeoutMs: 1_000 },
    {
      processRunner: recordingRunner(async () => successfulProcess()),
      commandLocator: recordingLocator(testDescriptor("codex-cli")),
      environment: { OPENAI_API_KEY: "credential" },
      temporaryRoot: path.join(parent, "runtime"),
      clock: () => Number.NaN,
      cleanupFileSystem: cleanupFileSystem({
        async rename() { return new Promise(() => {}); },
      }),
    },
  );

  await assert.rejects(provider.generate(brainRequest()), {
    code: "STRUCTURED_PROVIDER_TIMEOUT",
  });
  const elapsedMs = performance.now() - startedAt;
  assert.ok(elapsedMs >= 850, elapsedMs);
  assert.ok(elapsedMs < 1_350, elapsedMs);
});

test("protected roots reject equality and both ancestor directions before discovery or spawn", async (t) => {
  const parent = await temporaryDirectory(t, "supervised-cli-protected-roots-");
  const protectedRoot = path.join(parent, "protected");
  const nestedRoot = path.join(protectedRoot, "nested");
  const protectedDescendant = path.join(nestedRoot, "runtime");
  await mkdir(nestedRoot, { recursive: true });
  const protectedMode = (await lstat(protectedRoot)).mode & 0o777;

  for (const temporaryRoot of [
    protectedRoot,
    protectedDescendant,
    parent,
  ]) {
    const locator = recordingLocator(testDescriptor("codex-cli"));
    const runner = recordingRunner(async () => successfulProcess());
    const provider = createTestSupervisedCliBrainProvider(
      providerOptions("codex-cli"),
      {
        processRunner: runner,
        commandLocator: locator,
        environment: { OPENAI_API_KEY: "credential" },
        temporaryRoot,
        protectedRoots: [protectedRoot],
      },
    );

    await assert.rejects(
      provider.generate(brainRequest()),
      (error) =>
        error?.code === "STRUCTURED_PROVIDER_UNAVAILABLE" &&
        !error.message.includes(parent),
    );
    assert.equal(locator.calls.length, 0);
    assert.equal(runner.calls.length, 0);
  }
  await assert.rejects(lstat(protectedDescendant), { code: "ENOENT" });
  if (process.platform !== "win32") {
    assert.equal((await lstat(protectedRoot)).mode & 0o777, protectedMode);
  }
});

test("Windows rejects a weak owner or DACL before CLI discovery", {
  skip: HOST_TEST_SKIP,
}, async (t) => {
  if (process.platform !== "win32") {
    t.skip("Windows owner and DACL semantics are platform-specific");
    return;
  }
  const managerModule = await privateDirectoryManagerModule();
  assert.ok(managerModule, "private directory manager is required");
  const parent = await temporaryDirectory(t, "supervised-cli-windows-acl-");
  const temporaryRoot = path.join(parent, "runtime");
  await mkdir(temporaryRoot);
  const locator = recordingLocator(testDescriptor("codex-cli"));
  const runner = recordingRunner(async () => successfulProcess());
  const provider = createTestSupervisedCliBrainProvider(
    providerOptions("codex-cli"),
    {
      processRunner: runner,
      commandLocator: locator,
      environment: { OPENAI_API_KEY: "credential" },
      temporaryRoot,
      rootDirectoryManager: managerModule.createPrivateDirectoryManager(),
    },
  );

  await assert.rejects(provider.generate(brainRequest()), {
    code: "STRUCTURED_PROVIDER_UNAVAILABLE",
  });
  assert.equal(locator.calls.length, 0);
  assert.equal(runner.calls.length, 0);
});

test("Windows production root creation allows only supported non-mutating broad ACEs", {
  skip: HOST_TEST_SKIP,
}, async (t) => {
  if (process.platform !== "win32" || process.arch !== "x64") {
    t.skip("production supervised CLI roots are Windows x64 only");
    return;
  }
  const managerModule = await privateDirectoryManagerModule();
  const parent = await temporaryDirectory(t, "supervised-cli-acl-allowed-");
  const root = path.join(parent, "runtime");
  setWindowsDirectoryAcl(
    parent,
    "(A;OICI;FA;;;{SID})(A;OICI;FA;;;SY)(A;OICI;FA;;;BA)" +
      "(A;OICI;0x1200A9;;;BU)",
  );

  const identity = await managerModule.PRODUCTION_PRIVATE_DIRECTORY_MANAGER.prepare({
    directory: root,
    signal: new AbortController().signal,
    validateLocation: async () => {},
  });

  assert.equal(path.resolve(identity.path), path.resolve(root));
  assert.equal((await lstat(root)).isDirectory(), true);
});

test("Windows production directory preparation accepts an omitted optional signal", {
  skip: HOST_TEST_SKIP,
}, async (t) => {
  if (process.platform !== "win32" || process.arch !== "x64") {
    t.skip("production supervised CLI roots are Windows x64 only");
    return;
  }
  const managerModule = await privateDirectoryManagerModule();
  const parent = await temporaryDirectory(t, "supervised-cli-optional-signal-");
  const root = path.join(parent, "runtime");
  setWindowsDirectoryAcl(
    parent,
    "(A;OICI;FA;;;{SID})(A;OICI;FA;;;SY)(A;OICI;FA;;;BA)",
  );

  const identity = await managerModule.PRODUCTION_PRIVATE_DIRECTORY_MANAGER.prepare({
    directory: root,
    validateLocation: async () => {},
  });

  assert.equal(path.resolve(identity.path), path.resolve(root));
  assert.equal((await lstat(root)).isDirectory(), true);
});

async function assertProductionRootAclRejected(t, name, extraAce) {
  if (process.platform !== "win32" || process.arch !== "x64") {
    t.skip("production supervised CLI roots are Windows x64 only");
    return;
  }
  const managerModule = await privateDirectoryManagerModule();
  const parent = await temporaryDirectory(t, `supervised-cli-acl-${name}-`);
  const root = path.join(parent, "runtime");
  setWindowsDirectoryAcl(
    parent,
    "(A;OICI;FA;;;{SID})(A;OICI;FA;;;SY)(A;OICI;FA;;;BA)" + extraAce,
  );

  await assert.rejects(
    managerModule.PRODUCTION_PRIVATE_DIRECTORY_MANAGER.prepare({
      directory: root,
      signal: AbortSignal.timeout(30_000),
      validateLocation: async () => {},
    }),
    { code: "STRUCTURED_PROVIDER_UNAVAILABLE" },
  );
  await assert.rejects(lstat(root), { code: "ENOENT" });
}

test("Windows production root creation rejects broad child mutation rights", {
  skip: HOST_TEST_SKIP,
}, async (t) => {
  await assertProductionRootAclRejected(t, "child-create", "(A;OICI;0x6;;;BU)");
});

test("Windows production root creation rejects unsupported deny ACE shapes", {
  skip: HOST_TEST_SKIP,
}, async (t) => {
  await assertProductionRootAclRejected(t, "deny-shape", "(D;OICI;0x2;;;BU)");
});

test("Windows production root creation binds parent ACL trust to its creation handle across ABA", {
  skip: HOST_TEST_SKIP,
}, async (t) => {
  if (process.platform !== "win32" || process.arch !== "x64") {
    t.skip("production supervised CLI roots are Windows x64 only");
    return;
  }
  const managerModule = await privateDirectoryManagerModule();
  const container = await temporaryDirectory(t, "supervised-cli-acl-aba-");
  const active = path.join(container, "active-parent");
  const trusted = path.join(container, "trusted-parent");
  const holding = path.join(container, "parent-swap-holding");
  const nativePhase = path.join(container, "native-parent-opened.txt");
  const root = path.join(active, "runtime");
  await mkdir(active);
  await mkdir(trusted);
  setWindowsDirectoryAcl(
    active,
    "(A;OICI;FA;;;{SID})(A;OICI;FA;;;SY)(A;OICI;FA;;;BA)" +
      "(A;OICI;0x6;;;BU)",
  );
  setWindowsDirectoryAcl(
    trusted,
    "(A;OICI;FA;;;{SID})(A;OICI;FA;;;SY)(A;OICI;FA;;;BA)",
  );
  let trustInspections = 0;
  const manager = managerModule.createTestSynchronizedWindowsPrivateDirectoryManager({
    async beforeParentTrustInspection() {
      trustInspections += 1;
      await rename(active, holding);
      await rename(trusted, active);
    },
    async afterParentTrustInspection() {
      await rename(active, trusted);
      await rename(holding, active);
    },
    nativeParentOpenedSignal: nativePhase,
  });

  await assert.rejects(
    manager.prepare({
      directory: root,
      signal: AbortSignal.timeout(30_000),
      validateLocation: async () => {},
    }),
    { code: "STRUCTURED_PROVIDER_UNAVAILABLE" },
  );

  assert.equal(trustInspections, 1);
  assert.equal(await readFile(nativePhase, "utf8"), "parent-opened");
  await assert.rejects(lstat(root), { code: "ENOENT" });
});

test("root creation rejects a changed trusted parent before mutating the leaf", async () => {
  const managerModule = await privateDirectoryManagerModule();
  assert.ok(managerModule, "private directory manager is required");
  const parent = path.join(path.parse(process.cwd()).root, "trusted-parent");
  const temporaryRoot = path.join(parent, "runtime");
  let parentChecks = 0;
  let mkdirCalls = 0;
  const directoryDetails = (inode) => ({
    dev: 7n,
    ino: BigInt(inode),
    mode: 0o40700n,
    uid: 1n,
    isDirectory: () => true,
    isSymbolicLink: () => false,
  });
  const missing = Object.assign(new Error("missing"), { code: "ENOENT" });
  const manager = managerModule.createPrivateDirectoryManager({
    fileSystem: {
      async lstat(directory) {
        if (path.resolve(directory) === path.resolve(temporaryRoot)) throw missing;
        parentChecks += 1;
        return directoryDetails(parentChecks === 1 ? 11 : 12);
      },
      async realpath(directory) { return directory; },
      async mkdir() { mkdirCalls += 1; },
      async chmod() {},
    },
    inspectDirectoryTrust: async () => true,
  });

  await assert.rejects(
    manager.prepare({
      directory: temporaryRoot,
      signal: null,
      validateLocation: async () => {},
    }),
    { code: "STRUCTURED_PROVIDER_UNAVAILABLE" },
  );
  assert.equal(mkdirCalls, 0);
});

test("root creation delegates mutation through the pinned parent identity", async () => {
  const managerModule = await privateDirectoryManagerModule();
  assert.ok(managerModule, "private directory manager is required");
  const parent = path.join(path.parse(process.cwd()).root, "trusted-parent");
  const temporaryRoot = path.join(parent, "runtime");
  let created = false;
  let pinnedCreation = null;
  const directoryDetails = (inode) => ({
    dev: 7n,
    ino: BigInt(inode),
    mode: 0o40700n,
    uid: 1n,
    isDirectory: () => true,
    isSymbolicLink: () => false,
  });
  const missing = Object.assign(new Error("missing"), { code: "ENOENT" });
  const manager = managerModule.createPrivateDirectoryManager({
    fileSystem: {
      async lstat(directory) {
        if (path.resolve(directory) === path.resolve(temporaryRoot)) {
          if (!created) throw missing;
          return directoryDetails(22);
        }
        return directoryDetails(11);
      },
      async realpath(directory) { return directory; },
      async mkdir() { throw new Error("mutable pathname creation forbidden"); },
      async chmod() {},
    },
    inspectDirectoryTrust: async () => true,
    async createDirectoryAt({ parentIdentity, leafName }) {
      pinnedCreation = { parentIdentity, leafName };
      created = true;
    },
  });

  await manager.prepare({
    directory: temporaryRoot,
    signal: null,
    validateLocation: async () => {},
  });
  assert.equal(pinnedCreation.parentIdentity.device, "7");
  assert.equal(pinnedCreation.parentIdentity.inode, "11");
  assert.equal(pinnedCreation.leafName, "runtime");
});

test("protected-root real-path aliases are rejected before discovery or spawn", async (t) => {
  const parent = await temporaryDirectory(t, "supervised-cli-protected-alias-");
  const protectedRoot = path.join(parent, "protected");
  const protectedAlias = path.join(parent, "protected-alias");
  await mkdir(protectedRoot);
  await symlink(
    protectedRoot,
    protectedAlias,
    process.platform === "win32" ? "junction" : "dir",
  );
  const locator = recordingLocator(testDescriptor("codex-cli"));
  const runner = recordingRunner(async () => successfulProcess());
  const provider = createTestSupervisedCliBrainProvider(
    providerOptions("codex-cli"),
    {
      processRunner: runner,
      commandLocator: locator,
      environment: { OPENAI_API_KEY: "credential" },
      temporaryRoot: path.join(protectedRoot, "runtime"),
      protectedRoots: [protectedAlias],
    },
  );

  await assert.rejects(provider.generate(brainRequest()), {
    code: "STRUCTURED_PROVIDER_UNAVAILABLE",
  });
  assert.equal(locator.calls.length, 0);
  assert.equal(runner.calls.length, 0);
});

test("a replaced validated root fails before a second discovery or spawn", async (t) => {
  const parent = await temporaryDirectory(t, "supervised-cli-root-replaced-");
  const temporaryRoot = path.join(parent, "runtime");
  const replacedRoot = path.join(parent, "runtime-original");
  const locator = recordingLocator(testDescriptor("codex-cli"));
  const runner = recordingRunner(async (invocation) => {
    const resultFile = argumentValue(invocation.args, "--output-last-message");
    await writeFile(resultFile, codexOutput({ ok: true }), "utf8");
    return successfulProcess();
  });
  const provider = createTestSupervisedCliBrainProvider(
    providerOptions("codex-cli"),
    {
      processRunner: runner,
      commandLocator: locator,
      environment: { OPENAI_API_KEY: "credential" },
      temporaryRoot,
    },
  );

  assert.equal(await provider.generate(brainRequest()), '{"ok":true}');
  await rename(temporaryRoot, replacedRoot);
  await mkdir(temporaryRoot);

  await assert.rejects(provider.generate(brainRequest()), {
    code: "STRUCTURED_PROVIDER_UNAVAILABLE",
  });
  assert.equal(locator.calls.length, 1);
  assert.equal(runner.calls.length, 1);
});

test("Git metadata in an invocation-root ancestor fails closed before discovery or spawn", async (t) => {
  const parent = await temporaryDirectory(t, "supervised-cli-git-ancestor-");
  const temporaryRoot = path.join(parent, "runtime", "isolated");
  await writeFile(path.join(parent, ".git"), "gitdir: private-host-path", "utf8");
  const locator = recordingLocator(testDescriptor("codex-cli"));
  const runner = recordingRunner(async () => successfulProcess());
  const provider = createTestSupervisedCliBrainProvider(
    providerOptions("codex-cli"),
    {
      processRunner: runner,
      commandLocator: locator,
      environment: { OPENAI_API_KEY: "credential" },
      temporaryRoot,
    },
  );

  await assert.rejects(
    provider.generate(brainRequest()),
    (error) =>
      error?.code === "STRUCTURED_PROVIDER_UNAVAILABLE" &&
      !error.message.includes(parent) &&
      !JSON.stringify(error).includes(parent),
  );
  assert.equal(locator.calls.length, 0);
  assert.equal(runner.calls.length, 0);
});

test("remote data denial reaches neither supervised CLI locator nor runner", async (t) => {
  const parent = await temporaryDirectory(t, "supervised-cli-routing-denial-");
  for (const kind of ["codex-cli", "claude-cli"]) {
    const locator = recordingLocator(testDescriptor(kind));
    const runner = recordingRunner(async () => successfulProcess());
    const provider = createTestSupervisedCliBrainProvider(
      providerOptions(kind),
      {
        processRunner: runner,
        commandLocator: locator,
        environment: kind === "codex-cli"
          ? { OPENAI_API_KEY: "private-codex-key" }
          : { ANTHROPIC_API_KEY: "private-claude-key" },
        temporaryRoot: path.join(parent, kind),
      },
    );
    const router = new BrainRouter({ providers: [provider] });
    const configuredBrain = {
      provider: kind,
      model: "bounded-model",
      remoteData: { requirements: false, code: false, memory: false },
    };

    assert.equal(router.describe(configuredBrain).singleAttempt, true);
    await assert.rejects(
      router.generate({
        brain: configuredBrain,
        messages: brainRequest().messages,
        schema: SCHEMA,
        dataClasses: ["requirements"],
      }),
      (error) => error?.code === "REMOTE_DATA_NOT_AUTHORIZED",
    );
    assert.equal(locator.calls.length, 0);
    assert.equal(runner.calls.length, 0);
  }

  const brokerEvents = [];
  const loginLocator = recordingLocator(testDescriptor("codex-cli"));
  const loginRunner = recordingRunner(async () => successfulProcess());
  const loginProvider = createTestSupervisedCliBrainProvider(
    {
      ...providerOptions("codex-cli"),
      credentialMode: "codex-login",
    },
    {
      processRunner: loginRunner,
      commandLocator: loginLocator,
      environment: { OPENAI_API_KEY: "must-not-be-read" },
      temporaryRoot: path.join(parent, "codex-login"),
      codexLoginCredentialBroker:
        recordingCodexLoginBroker(brokerEvents),
    },
  );
  const loginRouter = new BrainRouter({ providers: [loginProvider] });

  await assert.rejects(
    loginRouter.generate({
      brain: {
        provider: "codex-cli",
        model: "bounded-model",
        remoteData: { requirements: false, code: false, memory: false },
      },
      messages: brainRequest().messages,
      schema: SCHEMA,
      dataClasses: ["code"],
    }),
    (error) => error?.code === "REMOTE_DATA_NOT_AUTHORIZED",
  );
  assert.deepEqual(brokerEvents, []);
  assert.equal(loginLocator.calls.length, 0);
  assert.equal(loginRunner.calls.length, 0);
});

test("an unavailable known CLI stays redacted and never reaches the runner", async (t) => {
  const parent = await temporaryDirectory(t, "supervised-cli-unavailable-");
  for (const kind of ["codex-cli", "claude-cli"]) {
    const locatorCalls = [];
    const locator = {
      async resolve(value) {
        locatorCalls.push(value);
        throw Object.assign(new Error("private executable lookup detail"), {
          code: "STRUCTURED_PROVIDER_UNAVAILABLE",
        });
      },
    };
    const runner = recordingRunner(async () => successfulProcess());
    const provider = createTestSupervisedCliBrainProvider(
      providerOptions(kind),
      {
        processRunner: runner,
        commandLocator: locator,
        environment: kind === "codex-cli"
          ? { OPENAI_API_KEY: "private-codex-key" }
          : { ANTHROPIC_API_KEY: "private-claude-key" },
        temporaryRoot: path.join(parent, kind),
      },
    );

    await assert.rejects(
      provider.generate(brainRequest()),
      (error) =>
        error?.code === "STRUCTURED_PROVIDER_UNAVAILABLE" &&
        error.statusCode === 503 &&
        !error.message.includes("private executable lookup detail"),
    );
    assert.deepEqual(locatorCalls, [kind]);
    assert.equal(runner.calls.length, 0);
  }
});

test("internal TypeErrors are redacted after request admission", async (t) => {
  const parent = await temporaryDirectory(t, "supervised-cli-type-error-");
  const privatePath = path.join(parent, "private-host-path", "codex.exe");
  const runner = recordingRunner(async () => successfulProcess());
  const provider = createTestSupervisedCliBrainProvider(
    providerOptions("codex-cli"),
    {
      processRunner: runner,
      commandLocator: {
        async resolve() {
          throw new TypeError(`cannot inspect ${privatePath}`);
        },
      },
      environment: { OPENAI_API_KEY: "private-key" },
      temporaryRoot: path.join(parent, "runtime"),
    },
  );

  await assert.rejects(
    provider.generate(brainRequest()),
    (error) =>
      error?.code === "STRUCTURED_PROVIDER_UNAVAILABLE" &&
      !error.message.includes(privatePath) &&
      !JSON.stringify(error).includes(privatePath),
  );
  assert.equal(runner.calls.length, 0);
});

test("Claude rejects malformed, conflicting, oversized, and non-UTF-8 output", async (t) => {
  const parent = await temporaryDirectory(t, "supervised-claude-invalid-");
  const temporaryRoot = path.join(parent, "runtime");
  const outputs = [
    Buffer.from(JSON.stringify(claudeEnvelope('{"ok":true}', { extra: true }))),
    Buffer.from(JSON.stringify(claudeEnvelope('{"ok":true}', { is_error: true }))),
    Buffer.from(JSON.stringify(claudeEnvelope('{"ok":true}', { subtype: "error" }))),
    Buffer.from(JSON.stringify(claudeEnvelope('{"ok":true}', { num_turns: 2 }))),
    Buffer.from(JSON.stringify(claudeEnvelope('{"ok":true}', { permission_denials: ["tool"] }))),
    Buffer.from(JSON.stringify(claudeEnvelope('{"ok":true}', { structured_output: { ok: true } }))),
    Buffer.from(JSON.stringify(claudeEnvelope("not-json"))),
    Buffer.from(JSON.stringify(claudeEnvelope("[]"))),
    Buffer.from(
      JSON.stringify(claudeEnvelope()).replace(
        '"is_error":false',
        '"is_error":true,"is_error":false',
      ),
    ),
    Buffer.from(
      JSON.stringify(claudeEnvelope()).replace(
        '"is_error":false',
        '"is_\\u0065rror":true,"is_error":false',
      ),
    ),
    Buffer.from(
      JSON.stringify(claudeEnvelope()).replace(
        '\\"ok\\":true',
        '\\"ok\\":false,\\"ok\\":true',
      ),
    ),
    Buffer.from([0xc3, 0x28]),
  ];

  for (const output of outputs) {
    let invocationDirectory;
    const runner = recordingRunner(async (invocation) => {
      invocationDirectory = invocation.cwd;
      return successfulProcess(output);
    });
    const provider = createTestSupervisedCliBrainProvider(
      providerOptions("claude-cli"),
      {
        processRunner: runner,
        commandLocator: recordingLocator(testDescriptor("claude-cli")),
        environment: { ANTHROPIC_API_KEY: "private-credential" },
        temporaryRoot,
      },
    );
    await assert.rejects(
      provider.generate(brainRequest()),
      (error) =>
        error.code === "STRUCTURED_PROVIDER_RESPONSE_INVALID" &&
        !error.message.includes(PRIVATE_PROMPT) &&
        !error.message.includes("private-credential") &&
        !error.message.includes(temporaryRoot) &&
        !JSON.stringify(error).includes(output.toString("utf8")),
    );
    await assert.rejects(lstat(invocationDirectory), { code: "ENOENT" });
  }

  const oversizedRunner = recordingRunner(async () => successfulProcess(
    Buffer.from("x".repeat(128 * 1024 + 1)),
  ));
  const oversized = createTestSupervisedCliBrainProvider(
    providerOptions("claude-cli"),
    {
      processRunner: oversizedRunner,
      commandLocator: recordingLocator(testDescriptor("claude-cli")),
      environment: { ANTHROPIC_API_KEY: "private-credential" },
      temporaryRoot,
    },
  );
  await assert.rejects(
    oversized.generate(brainRequest()),
    { code: "STRUCTURED_PROVIDER_RESPONSE_TOO_LARGE" },
  );
});

async function assertCodexResultLinkRejected(t, attack) {
  const parent = await temporaryDirectory(t, "supervised-codex-links-");
  const temporaryRoot = path.join(parent, "runtime");
  const victim = path.join(parent, "victim.json");
  await writeFile(victim, '{"private":true}', "utf8");
  const runner = recordingRunner(async (invocation) => {
    const resultFile = argumentValue(invocation.args, "--output-last-message");
    await rm(resultFile);
    if (attack === "hardlink") await link(victim, resultFile);
    else await symlink(victim, resultFile, "file");
    return successfulProcess();
  });
  const provider = createTestSupervisedCliBrainProvider(
    providerOptions("codex-cli"),
    {
      processRunner: runner,
      commandLocator: recordingLocator(testDescriptor("codex-cli")),
      environment: { OPENAI_API_KEY: "credential" },
      temporaryRoot,
    },
  );
  await assert.rejects(
    provider.generate(brainRequest()),
    { code: "STRUCTURED_PROVIDER_CLEANUP_FAILED" },
    attack,
  );
  assert.equal(await readFile(victim, "utf8"), '{"private":true}');
}

test("Codex result files reject hardlinks outside the invocation", async (t) => {
  await assertCodexResultLinkRejected(t, "hardlink");
});

test("Codex result files reject symlinks outside the invocation", async (t) => {
  const parent = await temporaryDirectory(t, "supervised-codex-symlink-probe-");
  const victim = path.join(parent, "victim.json");
  const probe = path.join(parent, "symlink-probe.json");
  await writeFile(victim, '{"private":true}', "utf8");
  try {
    await symlink(victim, probe, "file");
    await rm(probe);
  } catch (error) {
    if (["EPERM", "EACCES"].includes(error?.code)) {
      t.skip("file symlinks require Windows Developer Mode or elevated privilege");
      return;
    }
    throw error;
  }
  await assertCodexResultLinkRejected(t, "symlink");
});

test("invocation initialization failure cleans its verified directory and the provider recovers", async (t) => {
  const parent = await temporaryDirectory(t, "supervised-cli-init-recovery-");
  const temporaryRoot = path.join(parent, "runtime");
  let clockCalls = 0;
  const runner = recordingRunner(async (invocation) => {
    const resultFile = argumentValue(invocation.args, "--output-last-message");
    await writeFile(resultFile, codexOutput({ ok: true }), "utf8");
    return successfulProcess();
  });
  const provider = createTestSupervisedCliBrainProvider(
    providerOptions("codex-cli"),
    {
      processRunner: runner,
      commandLocator: recordingLocator(testDescriptor("codex-cli")),
      environment: { OPENAI_API_KEY: "credential" },
      temporaryRoot,
      clock: () => clockCalls++ === 0 ? Number.NaN : Date.now(),
    },
  );

  await assert.rejects(
    provider.generate(brainRequest()),
    { code: "STRUCTURED_PROVIDER_UNAVAILABLE" },
  );
  assert.deepEqual(await readdir(temporaryRoot), []);
  assert.equal(await provider.generate(brainRequest()), '{"ok":true}');
  assert.deepEqual(await readdir(temporaryRoot), []);
  assert.equal(runner.calls.length, 1);
});

test("temporary root and stale scan failures are retryable on the same provider", async (t) => {
  const parent = await temporaryDirectory(t, "supervised-cli-root-recovery-");
  const temporaryRoot = path.join(parent, "runtime");
  await writeFile(temporaryRoot, "blocks the first mkdir", "utf8");
  let scanCalls = 0;
  const runner = recordingRunner(async (invocation) => {
    const resultFile = argumentValue(invocation.args, "--output-last-message");
    await writeFile(resultFile, codexOutput({ ok: true }), "utf8");
    return successfulProcess();
  });
  const provider = createTestSupervisedCliBrainProvider(
    providerOptions("codex-cli"),
    {
      processRunner: runner,
      commandLocator: recordingLocator(testDescriptor("codex-cli")),
      environment: { OPENAI_API_KEY: "credential" },
      temporaryRoot,
      staleInvocationScavenger: async () => {
        scanCalls += 1;
        if (scanCalls === 1) throw new Error("private transient scan failure");
      },
    },
  );

  await assert.rejects(
    provider.generate(brainRequest()),
    { code: "STRUCTURED_PROVIDER_UNAVAILABLE" },
  );
  await rm(temporaryRoot);
  await assert.rejects(
    provider.generate(brainRequest()),
    { code: "STRUCTURED_PROVIDER_UNAVAILABLE" },
  );
  assert.equal(scanCalls, 1);
  assert.equal(await provider.generate(brainRequest()), '{"ok":true}');
  assert.equal(scanCalls, 2);
  assert.equal(runner.calls.length, 1);
});

test("provider failures are redacted and clean only their verified invocation", async (t) => {
  const parent = await temporaryDirectory(t, "supervised-cli-failure-");
  const temporaryRoot = path.join(parent, "runtime");
  let invocationDirectory;
  const runner = recordingRunner(async (invocation) => {
    invocationDirectory = invocation.cwd;
    throw Object.assign(new Error("PRIVATE_STDERR_AND_PATH_MUST_NOT_ESCAPE"), {
      code: "STRUCTURED_PROVIDER_PROCESS_FAILED",
      statusCode: 502,
    });
  });
  const provider = createTestSupervisedCliBrainProvider(
    providerOptions("codex-cli"),
    {
      processRunner: runner,
      commandLocator: recordingLocator(testDescriptor("codex-cli")),
      environment: { OPENAI_API_KEY: "private-credential" },
      temporaryRoot,
    },
  );

  await assert.rejects(
    provider.generate(brainRequest()),
    (error) =>
      error.code === "STRUCTURED_PROVIDER_PROCESS_FAILED" &&
      !error.message.includes("PRIVATE_STDERR") &&
      !error.message.includes(PRIVATE_PROMPT) &&
      !error.message.includes("private-credential") &&
      !error.message.includes(temporaryRoot),
  );
  await assert.rejects(lstat(invocationDirectory), { code: "ENOENT" });
});

test("provider keeps the runner's clean nonzero exit inside the public process-failure family", async (t) => {
  const parent = await temporaryDirectory(t, "supervised-cli-nonzero-");
  const temporaryRoot = path.join(parent, "runtime");
  const runner = recordingRunner(async () => {
    throw Object.assign(new Error("private nonzero detail"), {
      code: "STRUCTURED_PROVIDER_PROCESS_EXITED",
      statusCode: 502,
    });
  });
  const provider = createTestSupervisedCliBrainProvider(
    providerOptions("codex-cli"),
    {
      processRunner: runner,
      commandLocator: recordingLocator(testDescriptor("codex-cli")),
      environment: { OPENAI_API_KEY: "private-credential" },
      temporaryRoot,
    },
  );

  await assert.rejects(
    provider.generate(brainRequest()),
    (error) =>
      error?.code === "STRUCTURED_PROVIDER_PROCESS_FAILED" &&
      !error.message.includes("private nonzero detail"),
  );
  await provider.close();
});

test("cleanup failure takes precedence over an earlier process failure", async (t) => {
  const parent = await temporaryDirectory(t, "supervised-cli-cleanup-failure-");
  const temporaryRoot = path.join(parent, "runtime");
  let movedInvocation;
  const runner = recordingRunner(async (invocation) => {
    movedInvocation = `${invocation.cwd}-original`;
    await rename(invocation.cwd, movedInvocation);
    await mkdir(invocation.cwd);
    await writeFile(
      path.join(invocation.cwd, "untrusted-raced-entry.txt"),
      "must-not-be-deleted",
      "utf8",
    );
    throw Object.assign(new Error("private process failure"), {
      code: "STRUCTURED_PROVIDER_PROCESS_FAILED",
    });
  });
  const provider = createTestSupervisedCliBrainProvider(
    providerOptions("codex-cli"),
    {
      processRunner: runner,
      commandLocator: recordingLocator(testDescriptor("codex-cli")),
      environment: { OPENAI_API_KEY: "private-key" },
      temporaryRoot,
    },
  );

  await assert.rejects(
    provider.generate(brainRequest()),
    (error) =>
      error?.code === "STRUCTURED_PROVIDER_CLEANUP_FAILED" &&
      !error.message.includes("private process failure") &&
      !error.message.includes(temporaryRoot),
  );
  assert.equal((await lstat(movedInvocation)).isDirectory(), true);
  const quarantines = (await readdir(temporaryRoot))
    .filter((name) => name.startsWith(".cleanup-"));
  assert.equal(quarantines.length, 1);
  assert.equal(
    await readFile(
      path.join(
        temporaryRoot,
        quarantines[0],
        "untrusted-raced-entry.txt",
      ),
      "utf8",
    ),
    "must-not-be-deleted",
  );
});

test("cleanup retains an invocation whose entry count exceeds the fixed bound", async (t) => {
  const parent = await temporaryDirectory(t, "supervised-cli-cleanup-count-");
  const temporaryRoot = path.join(parent, "runtime");
  const runner = recordingRunner(async (invocation) => {
    for (let index = 0; index < 257; index += 1) {
      await writeFile(
        path.join(invocation.cwd, `entry-${String(index).padStart(3, "0")}`),
        "",
      );
    }
    const resultFile = argumentValue(invocation.args, "--output-last-message");
    await writeFile(resultFile, codexOutput({ ok: true }), "utf8");
    return successfulProcess();
  });
  const provider = createTestSupervisedCliBrainProvider(
    providerOptions("codex-cli"),
    {
      processRunner: runner,
      commandLocator: recordingLocator(testDescriptor("codex-cli")),
      environment: { OPENAI_API_KEY: "credential" },
      temporaryRoot,
    },
  );

  await assert.rejects(provider.generate(brainRequest()), {
    code: "STRUCTURED_PROVIDER_CLEANUP_FAILED",
  });
  assert.equal(
    (await readdir(temporaryRoot)).some((name) => name.startsWith(".cleanup-")),
    true,
  );
});

test("cleanup retains an invocation whose directory depth exceeds the fixed bound", async (t) => {
  const parent = await temporaryDirectory(t, "supervised-cli-cleanup-depth-");
  const temporaryRoot = path.join(parent, "runtime");
  const runner = recordingRunner(async (invocation) => {
    let directory = invocation.cwd;
    for (let depth = 0; depth < 17; depth += 1) {
      directory = path.join(directory, `depth-${String(depth).padStart(2, "0")}`);
      await mkdir(directory);
    }
    const resultFile = argumentValue(invocation.args, "--output-last-message");
    await writeFile(resultFile, codexOutput({ ok: true }), "utf8");
    return successfulProcess();
  });
  const provider = createTestSupervisedCliBrainProvider(
    providerOptions("codex-cli"),
    {
      processRunner: runner,
      commandLocator: recordingLocator(testDescriptor("codex-cli")),
      environment: { OPENAI_API_KEY: "credential" },
      temporaryRoot,
    },
  );

  await assert.rejects(provider.generate(brainRequest()), {
    code: "STRUCTURED_PROVIDER_CLEANUP_FAILED",
  });
  assert.equal(
    (await readdir(temporaryRoot)).some((name) => name.startsWith(".cleanup-")),
    true,
  );
});

test("cleanup accepts a Codex invocation larger than the old 16 MiB bound", async (t) => {
  const parent = await temporaryDirectory(t, "supervised-cli-cleanup-real-size-");
  const temporaryRoot = path.join(parent, "runtime");
  const events = [];
  const runner = recordingRunner(async (invocation) => {
    const profile = path.join(invocation.cwd, "codex-home");
    await mkdir(profile, { recursive: true });
    const rollout = path.join(profile, "session-rollout.jsonl");
    await writeFile(rollout, "");
    await truncate(rollout, 18 * 1024 * 1024);
    const resultFile = argumentValue(invocation.args, "--output-last-message");
    await writeFile(resultFile, codexOutput({ ok: true }), "utf8");
    return successfulProcess();
  });
  const provider = createTestSupervisedCliBrainProvider(
    { ...providerOptions("codex-cli"), credentialMode: "codex-login" },
    {
      processRunner: runner,
      commandLocator: recordingLocator(testDescriptor("codex-cli")),
      environment: {},
      temporaryRoot,
      codexLoginCredentialBroker: recordingCodexLoginBroker(events),
    },
  );

  await provider.generate(brainRequest());
  assert.deepEqual(await readdir(temporaryRoot), []);
  assert.equal(events.at(-1), "release:true");
});

test("cleanup retains an invocation whose aggregate regular-file bytes exceed the fixed bound", async (t) => {
  const parent = await temporaryDirectory(t, "supervised-cli-cleanup-bytes-");
  const temporaryRoot = path.join(parent, "runtime");
  const runner = recordingRunner(async (invocation) => {
    const oversized = path.join(invocation.cwd, "oversized.bin");
    await writeFile(oversized, "");
    await truncate(oversized, 64 * 1024 * 1024 + 1);
    const resultFile = argumentValue(invocation.args, "--output-last-message");
    await writeFile(resultFile, codexOutput({ ok: true }), "utf8");
    return successfulProcess();
  });
  const provider = createTestSupervisedCliBrainProvider(
    providerOptions("codex-cli"),
    {
      processRunner: runner,
      commandLocator: recordingLocator(testDescriptor("codex-cli")),
      environment: { OPENAI_API_KEY: "credential" },
      temporaryRoot,
    },
  );

  await assert.rejects(provider.generate(brainRequest()), {
    code: "STRUCTURED_PROVIDER_CLEANUP_FAILED",
  });
  assert.equal(
    (await readdir(temporaryRoot)).some((name) => name.startsWith(".cleanup-")),
    true,
  );
});

test("an unresolved cleanup operation is deadline-bounded and blocks providers sharing the root", async (t) => {
  const parent = await temporaryDirectory(t, "supervised-cli-cleanup-hang-");
  const temporaryRoot = path.join(parent, "runtime");
  let invocationDirectory;
  const firstRunner = recordingRunner(async (invocation) => {
    invocationDirectory = invocation.cwd;
    const resultFile = argumentValue(invocation.args, "--output-last-message");
    await writeFile(resultFile, codexOutput({ ok: true }), "utf8");
    return successfulProcess();
  });
  const first = createTestSupervisedCliBrainProvider(
    { ...providerOptions("codex-cli"), timeoutMs: 1_000 },
    {
      processRunner: firstRunner,
      commandLocator: recordingLocator(testDescriptor("codex-cli")),
      environment: { OPENAI_API_KEY: "credential" },
      temporaryRoot,
      cleanupFileSystem: cleanupFileSystem({
        async unlink() {
          return new Promise(() => {});
        },
      }),
    },
  );

  await within(
    3_000,
    assert.rejects(first.generate(brainRequest()), {
      code: "STRUCTURED_PROVIDER_CLEANUP_FAILED",
    }),
  );
  await assert.rejects(lstat(invocationDirectory), { code: "ENOENT" });
  assert.equal(
    (await readdir(temporaryRoot)).some((name) => name.startsWith(".cleanup-")),
    true,
  );

  const secondLocator = recordingLocator(testDescriptor("codex-cli"));
  const secondRunner = recordingRunner(async () => successfulProcess());
  const second = createTestSupervisedCliBrainProvider(
    providerOptions("codex-cli"),
    {
      processRunner: secondRunner,
      commandLocator: secondLocator,
      environment: { OPENAI_API_KEY: "credential" },
      temporaryRoot,
    },
  );
  await assert.rejects(second.generate(brainRequest()), {
    code: "STRUCTURED_PROVIDER_CLEANUP_FAILED",
  });
  assert.equal(secondLocator.calls.length, 0);
  assert.equal(secondRunner.calls.length, 0);
});

test("cancellation uses an independent cleanup budget after safe process settlement", async (t) => {
  const parent = await temporaryDirectory(t, "supervised-cli-cleanup-cancel-");
  const temporaryRoot = path.join(parent, "runtime");
  const controller = new AbortController();
  let invocationDirectory;
  const runner = recordingRunner(async (invocation) => {
    invocationDirectory = invocation.cwd;
    const resultFile = argumentValue(invocation.args, "--output-last-message");
    await writeFile(resultFile, codexOutput({ ok: true }), "utf8");
    controller.abort(new Error("private cancellation"));
    return successfulProcess();
  });
  const provider = createTestSupervisedCliBrainProvider(
    providerOptions("codex-cli"),
    {
      processRunner: runner,
      commandLocator: recordingLocator(testDescriptor("codex-cli")),
      environment: { OPENAI_API_KEY: "credential" },
      temporaryRoot,
    },
  );

  await assert.rejects(
    provider.generate(brainRequest({ signal: controller.signal })),
    (error) =>
      error?.code === "STRUCTURED_PROVIDER_CANCELLED" &&
      !error.message.includes("private cancellation") &&
      !error.message.includes(temporaryRoot),
  );
  await assert.rejects(lstat(invocationDirectory), { code: "ENOENT" });
});

async function assertCleanupLinkRejected(t, attack) {
  const parent = await temporaryDirectory(t, "supervised-cli-cleanup-links-");
  const victim = path.join(parent, "victim.txt");
  await writeFile(victim, "retain-me", "utf8");
  const temporaryRoot = path.join(parent, `runtime-${attack}`);
  const runner = recordingRunner(async (invocation) => {
    const entry = path.join(invocation.cwd, `untrusted-${attack}`);
    if (attack === "hardlink") await link(victim, entry);
    else await symlink(victim, entry, "file");
    const resultFile = argumentValue(invocation.args, "--output-last-message");
    await writeFile(resultFile, codexOutput({ ok: true }), "utf8");
    return successfulProcess();
  });
  const provider = createTestSupervisedCliBrainProvider(
    providerOptions("codex-cli"),
    {
      processRunner: runner,
      commandLocator: recordingLocator(testDescriptor("codex-cli")),
      environment: { OPENAI_API_KEY: "credential" },
      temporaryRoot,
    },
  );

  await assert.rejects(provider.generate(brainRequest()), {
    code: "STRUCTURED_PROVIDER_CLEANUP_FAILED",
  });
  assert.equal(await readFile(victim, "utf8"), "retain-me");
}

test("cleanup rejects a hard-linked entry without touching its target", async (t) => {
  await assertCleanupLinkRejected(t, "hardlink");
});

test("cleanup rejects a symbolic-link entry without touching its target", async (t) => {
  const parent = await temporaryDirectory(t, "supervised-cli-cleanup-symlink-probe-");
  const victim = path.join(parent, "victim.txt");
  const probe = path.join(parent, "symlink-probe");
  await writeFile(victim, "retain-me", "utf8");
  try {
    await symlink(victim, probe, "file");
    await unlink(probe);
  } catch (error) {
    if (["EPERM", "EACCES"].includes(error?.code)) {
      t.skip("file symlinks require Windows Developer Mode or elevated privilege");
      return;
    }
    throw error;
  }
  await assertCleanupLinkRejected(t, "symlink");
});

test("cleanup rejects a queued-directory swap before reading outside the quarantine", async (t) => {
  const parent = await temporaryDirectory(t, "supervised-cli-cleanup-dir-swap-");
  const victimDirectory = path.join(parent, "victim");
  const victimFile = path.join(victimDirectory, "outside.txt");
  const probe = path.join(parent, "junction-probe");
  await mkdir(victimDirectory);
  await writeFile(victimFile, "retain-me", "utf8");
  try {
    await symlink(victimDirectory, probe, "junction");
    await unlink(probe);
  } catch (error) {
    if (["EPERM", "EACCES"].includes(error?.code)) {
      t.skip("directory junctions are unavailable on this Windows host");
      return;
    }
    throw error;
  }
  const temporaryRoot = path.join(parent, "runtime");
  let nestedDirectory;
  let swapped = false;
  const runner = recordingRunner(async (invocation) => {
    nestedDirectory = path.join(invocation.cwd, "nested");
    await mkdir(nestedDirectory);
    await writeFile(path.join(nestedDirectory, "inside.txt"), "inside", "utf8");
    const resultFile = argumentValue(invocation.args, "--output-last-message");
    await writeFile(resultFile, codexOutput({ ok: true }), "utf8");
    return successfulProcess();
  });
  const provider = createTestSupervisedCliBrainProvider(
    providerOptions("codex-cli"),
    {
      processRunner: runner,
      commandLocator: recordingLocator(testDescriptor("codex-cli")),
      environment: { OPENAI_API_KEY: "credential" },
      temporaryRoot,
      cleanupFileSystem: cleanupFileSystem({
        async opendir(directory) {
          if (
            !swapped &&
            path.basename(directory) === "nested" &&
            path.basename(path.dirname(directory)).startsWith(".cleanup-")
          ) {
            swapped = true;
            nestedDirectory = directory;
            await rename(nestedDirectory, `${nestedDirectory}-original`);
            await symlink(victimDirectory, nestedDirectory, "junction");
          }
          return opendir(directory);
        },
      }),
    },
  );

  await assert.rejects(provider.generate(brainRequest()), {
    code: "STRUCTURED_PROVIDER_CLEANUP_FAILED",
  });
  assert.equal(await readFile(victimFile, "utf8"), "retain-me");
});

test("cleanup rejects a parent swap after a file check without deleting the replacement", async (t) => {
  const parent = await temporaryDirectory(t, "supervised-cli-cleanup-delete-swap-");
  const victimDirectory = path.join(parent, "victim");
  const victimFile = path.join(victimDirectory, "attack.txt");
  const probe = path.join(parent, "junction-probe");
  await mkdir(victimDirectory);
  await writeFile(victimFile, "retain-me", "utf8");
  try {
    await symlink(victimDirectory, probe, "junction");
    await unlink(probe);
  } catch (error) {
    if (["EPERM", "EACCES"].includes(error?.code)) {
      t.skip("directory junctions are unavailable on this Windows host");
      return;
    }
    throw error;
  }
  const temporaryRoot = path.join(parent, "runtime");
  let nestedDirectory;
  let attackFile;
  let attackStats = 0;
  const runner = recordingRunner(async (invocation) => {
    nestedDirectory = path.join(invocation.cwd, "nested");
    attackFile = path.join(nestedDirectory, "attack.txt");
    await mkdir(nestedDirectory);
    await writeFile(attackFile, "inside", "utf8");
    const resultFile = argumentValue(invocation.args, "--output-last-message");
    await writeFile(resultFile, codexOutput({ ok: true }), "utf8");
    return successfulProcess();
  });
  const provider = createTestSupervisedCliBrainProvider(
    providerOptions("codex-cli"),
    {
      processRunner: runner,
      commandLocator: recordingLocator(testDescriptor("codex-cli")),
      environment: { OPENAI_API_KEY: "credential" },
      temporaryRoot,
      cleanupFileSystem: cleanupFileSystem({
        async lstat(file, options) {
          const details = await lstat(file, options);
          if (
            path.basename(file) === "attack.txt" &&
            path.basename(path.dirname(file)) === "nested" &&
            path.basename(path.dirname(path.dirname(file))).startsWith(".cleanup-")
          ) {
            attackFile = file;
            nestedDirectory = path.dirname(file);
            attackStats += 1;
            if (attackStats === 2) {
              await rename(nestedDirectory, `${nestedDirectory}-original`);
              await symlink(victimDirectory, nestedDirectory, "junction");
            }
          }
          return details;
        },
      }),
    },
  );

  await assert.rejects(provider.generate(brainRequest()), {
    code: "STRUCTURED_PROVIDER_CLEANUP_FAILED",
  });
  assert.equal(await readFile(victimFile, "utf8"), "retain-me");
});

test("Windows production cleanup pins checked entries until same-handle deletion", {
  skip: HOST_TEST_SKIP,
}, async (t) => {
  if (process.platform !== "win32" || process.arch !== "x64") {
    t.skip("production supervised CLI cleanup is Windows x64 only");
    return;
  }
  const managerModule = await privateDirectoryManagerModule();
  const parent = await temporaryDirectory(t, "supervised-cli-native-cleanup-race-");
  const tree = path.join(parent, "tree");
  const checked = path.join(tree, "checked.txt");
  const moved = path.join(tree, "checked-original.txt");
  const victim = path.join(parent, "victim.txt");
  await mkdir(tree);
  await writeFile(checked, "private", "utf8");
  await writeFile(victim, "retain-me", "utf8");

  const session = await managerModule.prepareCleanupTreesByIdentity(
    [await directoryIdentity(tree)],
    {
      maximumEntries: 256,
      maximumDepth: 16,
      maximumBytes: 16 * 1024 * 1024,
      signal: AbortSignal.timeout(30_000),
    },
  );
  await assert.rejects(rename(checked, moved), (error) =>
    ["EPERM", "EACCES", "EBUSY"].includes(error?.code));
  await assert.rejects(writeFile(checked, "mutated", "utf8"), (error) =>
    ["EPERM", "EACCES", "EBUSY"].includes(error?.code));
  assert.equal(await readFile(victim, "utf8"), "retain-me");

  await session.commit();
  await assert.rejects(lstat(tree), { code: "ENOENT" });
  assert.equal(await readFile(victim, "utf8"), "retain-me");
});

test("Windows production cleanup cancellation settles after native handles close", {
  skip: HOST_TEST_SKIP,
}, async (t) => {
  if (process.platform !== "win32" || process.arch !== "x64") {
    t.skip("production supervised CLI cleanup is Windows x64 only");
    return;
  }
  const managerModule = await privateDirectoryManagerModule();
  const parent = await temporaryDirectory(t, "supervised-cli-native-cleanup-cancel-");
  const tree = path.join(parent, "tree");
  const checked = path.join(tree, "checked.txt");
  const moved = path.join(tree, "checked-after-cancel.txt");
  await mkdir(tree);
  await writeFile(checked, "private", "utf8");
  const controller = new AbortController();
  const session = await managerModule.prepareCleanupTreesByIdentity(
    [await directoryIdentity(tree)],
    {
      maximumEntries: 256,
      maximumDepth: 16,
      maximumBytes: 16 * 1024 * 1024,
      signal: controller.signal,
    },
  );

  controller.abort();
  await assert.rejects(session.commit());
  await rename(checked, moved);
  assert.equal(await readFile(moved, "utf8"), "private");
});

test("provider cancellation after native READY completes verified cleanup before releasing the lease", {
  skip: HOST_TEST_SKIP,
}, async (t) => {
  if (process.platform !== "win32" || process.arch !== "x64") {
    t.skip("production supervised CLI cleanup is Windows x64 only");
    return;
  }
  const managerModule = await privateDirectoryManagerModule();
  const parent = await temporaryDirectory(t, "supervised-cli-native-ready-cancel-");
  const temporaryRoot = path.join(parent, "runtime");
  const controller = new AbortController();
  let checkedFile = null;
  const runner = recordingRunner(async (invocation) => {
    const resultFile = argumentValue(invocation.args, "--output-last-message");
    await writeFile(resultFile, codexOutput({ ok: true }), "utf8");
    return successfulProcess();
  });
  const provider = createTestSupervisedCliBrainProvider(
    providerOptions("codex-cli"),
    {
      processRunner: runner,
      commandLocator: recordingLocator(testDescriptor("codex-cli")),
      environment: { OPENAI_API_KEY: "credential" },
      temporaryRoot,
      cleanupFileSystem: cleanupFileSystem({
        async prepareCleanupTrees(roots, options) {
          const session = await managerModule.prepareCleanupTreesByIdentity(
            roots,
            options,
          );
          checkedFile = path.join(roots[0].path, "last-message.json");
          controller.abort();
          return session;
        },
      }),
    },
  );

  await assert.rejects(
    provider.generate(brainRequest({ signal: controller.signal })),
    { code: "STRUCTURED_PROVIDER_CANCELLED" },
  );
  assert.equal(typeof checkedFile, "string");
  await assert.rejects(lstat(checkedFile), { code: "ENOENT" });

  let secondPreflights = 0;
  const secondLocator = recordingLocator(testDescriptor("claude-cli"));
  const second = createTestSupervisedCliBrainProvider(
    providerOptions("claude-cli"),
    {
      processRunner: recordingRunner(async () => successfulProcess(
        Buffer.from(JSON.stringify(claudeEnvelope('{"ok":true}'))),
      )),
      commandLocator: secondLocator,
      environment: { ANTHROPIC_API_KEY: "credential" },
      temporaryRoot,
      cleanupFileSystem: cleanupFileSystem({
        async prepareCleanupTrees(roots, options) {
          secondPreflights += 1;
          return managerModule.prepareCleanupTreesByIdentity(roots, options);
        },
      }),
    },
  );
  assert.equal(await second.generate(brainRequest()), '{"ok":true}');
  assert.equal(secondPreflights, 1);
  assert.equal(secondLocator.calls.length, 1);
});

test("Windows production cleanup preflights every stale tree before deleting any", {
  skip: HOST_TEST_SKIP,
}, async (t) => {
  if (process.platform !== "win32" || process.arch !== "x64") {
    t.skip("production supervised CLI cleanup is Windows x64 only");
    return;
  }
  const managerModule = await privateDirectoryManagerModule();
  const parent = await temporaryDirectory(t, "supervised-cli-native-stale-plan-");
  const safeTree = path.join(parent, "safe-stale");
  const unsafeTree = path.join(parent, "unsafe-stale");
  const victim = path.join(parent, "victim.txt");
  await mkdir(safeTree);
  await mkdir(unsafeTree);
  await writeFile(path.join(safeTree, "evidence.txt"), "retain-safe", "utf8");
  await writeFile(victim, "retain-victim", "utf8");
  await link(victim, path.join(unsafeTree, "untrusted-hardlink.txt"));

  await assert.rejects(
    managerModule.prepareCleanupTreesByIdentity(
      [
        await directoryIdentity(safeTree),
        await directoryIdentity(unsafeTree),
      ],
      {
        maximumEntries: 256,
        maximumDepth: 16,
        maximumBytes: 16 * 1024 * 1024,
        signal: AbortSignal.timeout(30_000),
      },
    ),
    { code: "STRUCTURED_PROVIDER_CLEANUP_FAILED" },
  );
  assert.equal(await readFile(path.join(safeTree, "evidence.txt"), "utf8"), "retain-safe");
  assert.equal(await readFile(victim, "utf8"), "retain-victim");
  assert.equal((await lstat(unsafeTree)).isDirectory(), true);
});

test("an unprovable process reap remains visible when the total deadline expires", async (t) => {
  const parent = await temporaryDirectory(t, "supervised-cli-reap-deadline-");
  let monotonicTime = 50_000;
  let invocationDirectory;
  const runner = recordingRunner(async (invocation) => {
    invocationDirectory = invocation.cwd;
    monotonicTime += 1_001;
    const error = new Error("private process identity");
    error.code = "STRUCTURED_PROVIDER_REAP_FAILED";
    throw error;
  });
  const provider = createTestSupervisedCliBrainProvider(
    { ...providerOptions("codex-cli"), timeoutMs: 1_000 },
    {
      processRunner: runner,
      commandLocator: recordingLocator(testDescriptor("codex-cli")),
      environment: { OPENAI_API_KEY: "credential" },
      temporaryRoot: path.join(parent, "runtime"),
      monotonicClock: () => monotonicTime,
    },
  );

  await assert.rejects(provider.generate(brainRequest()), {
    code: "STRUCTURED_PROVIDER_REAP_FAILED",
  });
  assert.equal((await lstat(invocationDirectory)).isDirectory(), true);
});

test("provider waits within its recovery budget for the Windows runner to settle a local child", async (t) => {
  if (process.platform !== "win32" || process.arch !== "x64") {
    t.skip("the production containment path is Windows x64 only");
    return;
  }
  const parent = await temporaryDirectory(t, "supervised-cli-real-runner-deadline-");
  const temporaryRoot = path.join(parent, "runtime");
  const childStarted = path.join(parent, "real-child-started.txt");
  const descriptor = Object.freeze({
    command: process.execPath,
    prefixArgs: Object.freeze([
      "-e",
      "require('node:fs').writeFileSync(process.argv[1], 'started');" +
        "setInterval(() => {}, 1000)",
      childStarted,
    ]),
  });
  const actualRunner = createTestSupervisedProcessRunner({
    descriptorMaterializer: async (descriptor) => descriptor,
    platform: "win32",
    terminationTimeoutMs: 1_000,
  });
  let runnerSettled = false;
  let resolveRunnerSettled;
  const runnerSettlement = new Promise((resolve) => {
    resolveRunnerSettled = resolve;
  });
  const runner = {
    run(options) {
      const result = actualRunner.run(options);
      void result.then(
        () => {
          runnerSettled = true;
          resolveRunnerSettled();
        },
        () => {
          runnerSettled = true;
          resolveRunnerSettled();
        },
      );
      return result;
    },
  };
  const provider = createTestSupervisedCliBrainProvider(
    { ...providerOptions("codex-cli"), timeoutMs: 4_000 },
    {
      processRunner: runner,
      commandLocator: recordingLocator(descriptor),
      environment: { OPENAI_API_KEY: "credential" },
      temporaryRoot,
    },
  );
  const startedAt = performance.now();

  await assert.rejects(provider.generate(brainRequest()), {
    code: "STRUCTURED_PROVIDER_TIMEOUT",
  });
  const elapsedMs = performance.now() - startedAt;
  assert.equal(await readFile(childStarted, "utf8"), "started");
  assert.ok(elapsedMs >= 3_000, elapsedMs);
  assert.ok(elapsedMs < 8_000, elapsedMs);
  assert.equal(runnerSettled, true);

  const nextLocator = recordingLocator(testDescriptor("claude-cli"));
  const nextRunner = recordingRunner(async () => successfulProcess(
    Buffer.from(JSON.stringify(claudeEnvelope('{"ok":true}'))),
  ));
  const next = createTestSupervisedCliBrainProvider(
    providerOptions("claude-cli"),
    {
      processRunner: nextRunner,
      commandLocator: nextLocator,
      environment: { ANTHROPIC_API_KEY: "credential" },
      temporaryRoot,
    },
  );
  await within(5_000, runnerSettlement);
  assert.equal(runnerSettled, true);
  assert.equal(await next.generate(brainRequest()), '{"ok":true}');
  assert.equal(nextLocator.calls.length, 1);
  assert.equal(nextRunner.calls.length, 1);
});

test("a never-settling process stays handled and permanently blocks close and cross-kind routing", async (t) => {
  const parent = await temporaryDirectory(t, "supervised-cli-never-settles-");
  const temporaryRoot = path.join(parent, "runtime");
  const processStarted = deferred();
  const unhandled = [];
  const onUnhandled = (error) => unhandled.push(error);
  process.on("unhandledRejection", onUnhandled);
  t.after(() => process.off("unhandledRejection", onUnhandled));
  const provider = createTestSupervisedCliBrainProvider(
    { ...providerOptions("codex-cli"), timeoutMs: 1_000 },
    {
      processRunner: recordingRunner(async () => {
        processStarted.resolve();
        return new Promise(() => {});
      }),
      commandLocator: recordingLocator(testDescriptor("codex-cli")),
      environment: { OPENAI_API_KEY: "credential" },
      temporaryRoot,
    },
  );
  const publicResult = assert.rejects(
    provider.generate(brainRequest()),
    { code: "STRUCTURED_PROVIDER_REAP_FAILED" },
  );
  await within(1_000, processStarted.promise);
  await within(3_000, publicResult);

  await assert.rejects(
    within(250, provider.close()),
    { code: "STRUCTURED_PROVIDER_CLEANUP_FAILED" },
  );
  const nextLocator = recordingLocator(testDescriptor("claude-cli"));
  const nextRunner = recordingRunner(async () => successfulProcess(
    Buffer.from(JSON.stringify(claudeEnvelope('{"ok":true}'))),
  ));
  const next = createTestSupervisedCliBrainProvider(
    providerOptions("claude-cli"),
    {
      processRunner: nextRunner,
      commandLocator: nextLocator,
      environment: { ANTHROPIC_API_KEY: "credential" },
      temporaryRoot,
    },
  );
  for (let attempt = 0; attempt < 2; attempt += 1) {
    await assert.rejects(next.generate(brainRequest()), {
      code: "STRUCTURED_PROVIDER_CLEANUP_FAILED",
    });
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  assert.equal(nextLocator.calls.length, 0);
  assert.equal(nextRunner.calls.length, 0);
  assert.deepEqual(unhandled, []);
});

test("close fences a generation paused before root admission and retries after it settles", async (t) => {
  const parent = await temporaryDirectory(t, "supervised-cli-pre-root-close-");
  const temporaryRoot = path.join(parent, "runtime");
  const rootPreparationStarted = deferred();
  const releaseRootPreparation = deferred();
  const locator = recordingLocator(testDescriptor("codex-cli"));
  const runner = recordingRunner(async () => {
    const error = new Error("runner must stay fenced");
    error.code = "STRUCTURED_PROVIDER_PROCESS_FAILED";
    throw error;
  });
  const provider = createTestSupervisedCliBrainProvider(
    providerOptions("codex-cli"),
    {
      processRunner: runner,
      commandLocator: locator,
      environment: { OPENAI_API_KEY: "credential" },
      temporaryRoot,
      rootDirectoryManager: {
        async prepare({ directory, validateLocation }) {
          await validateLocation();
          rootPreparationStarted.resolve();
          await releaseRootPreparation.promise;
          await mkdir(directory, { recursive: true });
          return directoryIdentity(directory);
        },
      },
    },
  );
  const generationOutcome = provider.generate(brainRequest()).then(
    () => null,
    (error) => error,
  );
  await rootPreparationStarted.promise;

  const firstClose = provider.close();
  const concurrentClose = provider.close();
  const closeOutcome = within(250, firstClose).then(
    () => null,
    (error) => error,
  );
  const closeFailure = await closeOutcome;
  releaseRootPreparation.resolve();
  const generationFailure = await within(2_000, generationOutcome);

  assert.strictEqual(concurrentClose, firstClose);
  assert.equal(closeFailure?.code, "STRUCTURED_PROVIDER_CLEANUP_FAILED");
  assert.equal(generationFailure?.code, "STRUCTURED_PROVIDER_UNAVAILABLE");
  assert.equal(locator.calls.length, 0);
  assert.equal(runner.calls.length, 0);

  await within(250, provider.close());
  await assert.rejects(provider.generate(brainRequest()), {
    code: "STRUCTURED_PROVIDER_UNAVAILABLE",
  });
});

test("an expired process recovery keeps sibling admission fenced even after late settlement", async (t) => {
  const parent = await temporaryDirectory(t, "supervised-cli-atomic-root-admission-");
  const temporaryRoot = path.join(parent, "runtime");
  const firstRunnerStarted = deferred();
  const firstRunnerSettlement = deferred();
  const firstController = new AbortController();
  const firstProvider = createTestSupervisedCliBrainProvider(
    { ...providerOptions("codex-cli"), timeoutMs: 1_000 },
    {
      processRunner: recordingRunner(async () => {
        firstRunnerStarted.resolve();
        return firstRunnerSettlement.promise;
      }),
      commandLocator: recordingLocator(testDescriptor("codex-cli")),
      environment: { OPENAI_API_KEY: "credential" },
      temporaryRoot,
    },
  );
  const firstOutcome = firstProvider.generate(
    brainRequest({ signal: firstController.signal }),
  ).then(
    () => null,
    (error) => error,
  );
  await firstRunnerStarted.promise;

  const finalRootBoundaryReached = deferred();
  const releaseFinalRootBoundary = deferred();
  let rootPreparations = 0;
  const nextLocator = recordingLocator(testDescriptor("codex-cli"));
  const nextRunner = recordingRunner(async (invocation) => {
    const resultFile = argumentValue(
      invocation.args,
      "--output-last-message",
    );
    await writeFile(resultFile, codexOutput({ ok: true }), "utf8");
    return successfulProcess();
  });
  const nextProvider = createTestSupervisedCliBrainProvider(
    providerOptions("codex-cli"),
    {
      processRunner: nextRunner,
      commandLocator: nextLocator,
      environment: { OPENAI_API_KEY: "credential" },
      temporaryRoot,
      rootDirectoryManager: {
        async prepare({ directory, validateLocation }) {
          await validateLocation();
          await mkdir(directory, { recursive: true });
          const identity = await directoryIdentity(directory);
          rootPreparations += 1;
          if (rootPreparations === 2) {
            finalRootBoundaryReached.resolve();
            await releaseFinalRootBoundary.promise;
          }
          return identity;
        },
      },
    },
  );
  const blockedOutcome = nextProvider.generate(brainRequest()).then(
    () => null,
    (error) => error,
  );
  await finalRootBoundaryReached.promise;

  const leaseStarted = deferred();
  const releaseLease = deferred();
  const leaseLocator = recordingLocator(testDescriptor("claude-cli"));
  const leaseRunner = recordingRunner(async () => successfulProcess(
    Buffer.from(JSON.stringify(claudeEnvelope('{"ok":true}'))),
  ));
  const leaseProvider = createTestSupervisedCliBrainProvider(
    providerOptions("claude-cli"),
    {
      processRunner: leaseRunner,
      commandLocator: leaseLocator,
      environment: { ANTHROPIC_API_KEY: "credential" },
      temporaryRoot,
      staleInvocationScavenger: async () => {
        leaseStarted.resolve();
        await releaseLease.promise;
      },
    },
  );
  const leaseOutcome = leaseProvider.generate(brainRequest()).then(
    () => null,
    (error) => error,
  );
  await leaseStarted.promise;
  releaseFinalRootBoundary.resolve();
  await new Promise((resolve) => setImmediate(resolve));

  firstController.abort();
  assert.equal(
    (await within(2_000, firstOutcome))?.code,
    "STRUCTURED_PROVIDER_REAP_FAILED",
  );
  releaseLease.resolve();
  assert.equal(
    (await within(2_000, blockedOutcome))?.code,
    "STRUCTURED_PROVIDER_CLEANUP_FAILED",
  );
  assert.equal(
    (await within(2_000, leaseOutcome))?.code,
    "STRUCTURED_PROVIDER_CLEANUP_FAILED",
  );
  assert.equal(nextLocator.calls.length, 0);
  assert.equal(nextRunner.calls.length, 0);
  assert.equal(leaseLocator.calls.length, 0);
  assert.equal(leaseRunner.calls.length, 0);

  firstRunnerSettlement.resolve(successfulProcess());
  await new Promise((resolve) => setImmediate(resolve));
  await assert.rejects(nextProvider.generate(brainRequest()), { code: "STRUCTURED_PROVIDER_CLEANUP_FAILED" });
  assert.equal(nextLocator.calls.length, 0);
  assert.equal(nextRunner.calls.length, 0);
  for (const provider of [firstProvider, nextProvider, leaseProvider]) {
    await assert.rejects(provider.close(), { code: "STRUCTURED_PROVIDER_CLEANUP_FAILED" });
  }
});

test("a reap failure blocks every CLI kind sharing the root before discovery", async (t) => {
  const parent = await temporaryDirectory(t, "supervised-cli-reap-shared-root-");
  const temporaryRoot = path.join(parent, "runtime");
  const failedRunner = recordingRunner(async () => {
    const error = new Error("private process identity");
    error.code = "STRUCTURED_PROVIDER_REAP_FAILED";
    throw error;
  });
  const failed = createTestSupervisedCliBrainProvider(
    providerOptions("codex-cli"),
    {
      processRunner: failedRunner,
      commandLocator: recordingLocator(testDescriptor("codex-cli")),
      environment: { OPENAI_API_KEY: "credential" },
      temporaryRoot,
    },
  );

  await assert.rejects(failed.generate(brainRequest()), {
    code: "STRUCTURED_PROVIDER_REAP_FAILED",
  });

  const nextLocator = recordingLocator(testDescriptor("claude-cli"));
  const nextRunner = recordingRunner(async () => successfulProcess());
  const next = createTestSupervisedCliBrainProvider(
    providerOptions("claude-cli"),
    {
      processRunner: nextRunner,
      commandLocator: nextLocator,
      environment: { ANTHROPIC_API_KEY: "credential" },
      temporaryRoot,
    },
  );

  await assert.rejects(next.generate(brainRequest()), {
    code: "STRUCTURED_PROVIDER_CLEANUP_FAILED",
  });
  assert.equal(nextLocator.calls.length, 0);
  assert.equal(nextRunner.calls.length, 0);
});

test("a critical stale-cleanup failure is not hidden by the total deadline", async (t) => {
  const parent = await temporaryDirectory(t, "supervised-cli-critical-cleanup-");
  let monotonicTime = 70_000;
  const runner = recordingRunner(async () => successfulProcess());
  const provider = createTestSupervisedCliBrainProvider(
    { ...providerOptions("codex-cli"), timeoutMs: 1_000 },
    {
      processRunner: runner,
      commandLocator: recordingLocator(testDescriptor("codex-cli")),
      environment: { OPENAI_API_KEY: "credential" },
      temporaryRoot: path.join(parent, "runtime"),
      monotonicClock: () => monotonicTime,
      staleInvocationScavenger: async () => {
        monotonicTime += 1_001;
        const error = new Error("private cleanup path");
        error.code = "STRUCTURED_PROVIDER_CLEANUP_FAILED";
        throw error;
      },
    },
  );

  await assert.rejects(provider.generate(brainRequest()), {
    code: "STRUCTURED_PROVIDER_CLEANUP_FAILED",
  });
  assert.equal(runner.calls.length, 0);
});

test("cancellation bounds an unresolved Codex result read and cleans the reaped invocation", async (t) => {
  const parent = await temporaryDirectory(t, "supervised-cli-result-cancel-");
  const temporaryRoot = path.join(parent, "runtime");
  let invocationDirectory;
  let readerSignal = null;
  let readerStarted;
  const started = new Promise((resolve) => { readerStarted = resolve; });
  const runner = recordingRunner(async (invocation) => {
    invocationDirectory = invocation.cwd;
    return successfulProcess();
  });
  const provider = createTestSupervisedCliBrainProvider(
    providerOptions("codex-cli"),
    {
      processRunner: runner,
      commandLocator: recordingLocator(testDescriptor("codex-cli")),
      environment: { OPENAI_API_KEY: "credential" },
      temporaryRoot,
      codexResultReader: async (_file, _identity, _maximumBytes, { signal }) => {
        readerSignal = signal;
        readerStarted();
        return new Promise(() => {});
      },
    },
  );
  const controller = new AbortController();
  const cancelled = assert.rejects(
    provider.generate(brainRequest({ signal: controller.signal })),
    { code: "STRUCTURED_PROVIDER_CANCELLED" },
  );
  await started;
  controller.abort();

  await within(2_000, cancelled);
  assert.equal(readerSignal?.aborted, true);
  await assert.rejects(lstat(invocationDirectory), { code: "ENOENT" });
});

test("production provider construction requires a lexical grant and has no replacement seam", () => {
  assert.throws(
    () => new SupervisedCliBrainProvider(providerOptions("codex-cli")),
    /composition grant|composition authority/i,
  );
  assert.throws(
    () => createProductionSupervisedCliBrainProvider(
      providerOptions("codex-cli"),
    ),
    /composition grant|composition authority/i,
  );
  assert.throws(
    () => new SupervisedCliBrainProvider(
      providerOptions("codex-cli"),
      {},
      { processRunner: {}, commandLocator: {} },
    ),
    /Production supervised CLI providers.*replacement dependencies|composition grant/i,
  );
});

test("the first use scavenges only stale verified residues and concurrent calls stay unique", async (t) => {
  const parent = await temporaryDirectory(t, "supervised-cli-scavenge-");
  const temporaryRoot = path.join(parent, "runtime");
  await mkdir(temporaryRoot, { recursive: true });
  const old = new Date(Date.now() - 48 * 60 * 60 * 1_000).toISOString();
  const fresh = new Date().toISOString();
  const residues = [
    ["invocation-codex-cli-stale001", 111, old, true],
    ["invocation-codex-cli-live001", 222, old, true],
    ["invocation-codex-cli-fresh01", 333, fresh, true],
    ["invocation-codex-cli-unknown1", 444, old, false],
  ];
  for (const [name, ownerPid, createdAt, marked] of residues) {
    const directory = path.join(temporaryRoot, name);
    await mkdir(directory);
    if (marked) {
      await writeFile(
        path.join(directory, ".mydashboard-invocation.json"),
        JSON.stringify({ schemaVersion: 1, kind: "codex-cli", ownerPid, createdAt }),
        "utf8",
      );
    }
  }

  let release;
  const released = new Promise((resolve) => { release = resolve; });
  const directories = [];
  const runner = recordingRunner(async (invocation) => {
    directories.push(invocation.cwd);
    const resultFile = argumentValue(invocation.args, "--output-last-message");
    await writeFile(resultFile, codexOutput({ ok: true }), "utf8");
    if (directories.length === 2) release();
    await released;
    return successfulProcess();
  });
  const provider = createTestSupervisedCliBrainProvider(
    providerOptions("codex-cli"),
    {
      processRunner: runner,
      commandLocator: recordingLocator(testDescriptor("codex-cli")),
      environment: { OPENAI_API_KEY: "credential" },
      temporaryRoot,
      isProcessAlive: (processId) => processId === 222,
    },
  );

  assert.deepEqual(
    await Promise.all([provider.generate(brainRequest()), provider.generate(brainRequest())]),
    ['{"ok":true}', '{"ok":true}'],
  );
  assert.equal(new Set(directories).size, 2);
  for (const directory of directories) {
    await assert.rejects(lstat(directory), { code: "ENOENT" });
  }
  const remaining = await readdir(temporaryRoot);
  assert.equal(remaining.includes("invocation-codex-cli-stale001"), false);
  assert.equal(remaining.includes("invocation-codex-cli-live001"), true);
  assert.equal(remaining.includes("invocation-codex-cli-fresh01"), true);
  assert.equal(remaining.includes("invocation-codex-cli-unknown1"), true);
});

test("a staggered provider reaches its isolated runner while the first process remains healthy", async (t) => {
  const parent = await temporaryDirectory(t, "supervised-cli-staggered-concurrency-");
  const temporaryRoot = path.join(parent, "runtime");
  let releaseProcesses;
  const released = new Promise((resolve) => { releaseProcesses = resolve; });
  let firstStarted;
  const firstAtRunner = new Promise((resolve) => { firstStarted = resolve; });
  let secondStarted;
  const secondAtRunner = new Promise((resolve) => { secondStarted = resolve; });
  const invocationDirectories = [];
  const createProvider = (onStart) => createTestSupervisedCliBrainProvider(
    providerOptions("codex-cli"),
    {
      processRunner: recordingRunner(async (invocation) => {
        invocationDirectories.push(invocation.cwd);
        const resultFile = argumentValue(invocation.args, "--output-last-message");
        await writeFile(resultFile, codexOutput({ ok: true }), "utf8");
        onStart();
        await released;
        return successfulProcess();
      }),
      commandLocator: recordingLocator(testDescriptor("codex-cli")),
      environment: { OPENAI_API_KEY: "credential" },
      temporaryRoot,
    },
  );
  const firstProvider = createProvider(firstStarted);
  const secondProvider = createProvider(secondStarted);
  const first = firstProvider.generate(brainRequest());
  await firstAtRunner;
  const second = secondProvider.generate(brainRequest());
  const settled = Promise.allSettled([first, second]);
  let secondAdmission;
  try {
    secondAdmission = await waitForCausalOutcome(
      [
        ["process-started", secondAtRunner],
        ["public-result", second],
      ],
      () => lstat(temporaryRoot),
      "staggered provider runner admission",
    );
  } finally {
    releaseProcesses();
  }
  if (secondAdmission.error) throw secondAdmission.error;
  const outcomes = await within(3_000, settled);

  assert.equal(secondAdmission.name, "process-started");
  assert.deepEqual(outcomes.map(({ status }) => status), [
    "fulfilled",
    "fulfilled",
  ]);
  assert.deepEqual(outcomes.map(({ value }) => value), [
    '{"ok":true}',
    '{"ok":true}',
  ]);
  assert.equal(new Set(invocationDirectories).size, 2);
  for (const directory of invocationDirectories) {
    await assert.rejects(lstat(directory), { code: "ENOENT" });
  }
});

test("stale recovery validates the complete bounded plan before removing evidence", async (t) => {
  const parent = await temporaryDirectory(t, "supervised-cli-stale-plan-");
  const temporaryRoot = path.join(parent, "runtime");
  const staleDirectory = path.join(
    temporaryRoot,
    "invocation-codex-cli-stale-plan",
  );
  const unsafeCleanup = path.join(temporaryRoot, ".cleanup-unsafe-plan");
  await mkdir(staleDirectory, { recursive: true });
  await writeFile(
    path.join(staleDirectory, ".mydashboard-invocation.json"),
    JSON.stringify({
      schemaVersion: 1,
      kind: "codex-cli",
      ownerPid: 42_424,
      createdAt: new Date(Date.now() - 48 * 60 * 60 * 1_000).toISOString(),
    }),
    "utf8",
  );
  await mkdir(unsafeCleanup);
  await writeFile(path.join(unsafeCleanup, "malformed.txt"), "retain", "utf8");
  const rootHandle = await opendir(temporaryRoot);
  const rootEntries = [];
  for await (const entry of rootHandle) rootEntries.push(entry);
  rootEntries.sort((left) => left.name === path.basename(staleDirectory) ? -1 : 1);
  let rootOpenCalls = 0;
  const locator = recordingLocator(testDescriptor("codex-cli"));
  const runner = recordingRunner(async () => successfulProcess());
  const provider = createTestSupervisedCliBrainProvider(
    providerOptions("codex-cli"),
    {
      processRunner: runner,
      commandLocator: locator,
      environment: { OPENAI_API_KEY: "credential" },
      temporaryRoot,
      isProcessAlive: () => false,
      cleanupFileSystem: cleanupFileSystem({
        async opendir(directory) {
          if (path.resolve(directory) !== path.resolve(temporaryRoot)) {
            return opendir(directory);
          }
          rootOpenCalls += 1;
          let index = 0;
          return {
            async read() {
              return rootEntries[index++] ?? null;
            },
            async close() {},
          };
        },
      }),
    },
  );

  await assert.rejects(provider.generate(brainRequest()), {
    code: "STRUCTURED_PROVIDER_CLEANUP_FAILED",
  });
  assert.equal((await lstat(staleDirectory)).isDirectory(), true);
  assert.equal(await readFile(path.join(unsafeCleanup, "malformed.txt"), "utf8"), "retain");
  assert.equal(rootOpenCalls, 1);
  assert.equal(locator.calls.length, 0);
  assert.equal(runner.calls.length, 0);
});

test("stale recovery uses one production preflight for every complete tree before mutation", async (t) => {
  if (process.platform !== "win32" || process.arch !== "x64") {
    t.skip("production supervised CLI cleanup is Windows x64 only");
    return;
  }
  const managerModule = await privateDirectoryManagerModule();
  const parent = await temporaryDirectory(t, "supervised-cli-stale-native-plan-");
  const temporaryRoot = path.join(parent, "runtime");
  const safeDirectory = path.join(
    temporaryRoot,
    "invocation-codex-cli-aaa-safe",
  );
  const unsafeDirectory = path.join(
    temporaryRoot,
    "invocation-codex-cli-zzz-unsafe",
  );
  const victim = path.join(parent, "victim.txt");
  await mkdir(safeDirectory, { recursive: true });
  await mkdir(unsafeDirectory);
  await writeFile(path.join(safeDirectory, "evidence.txt"), "retain-safe", "utf8");
  await writeFile(victim, "retain-victim", "utf8");
  await link(victim, path.join(unsafeDirectory, "untrusted-hardlink.txt"));
  const marker = (ownerPid) => JSON.stringify({
    schemaVersion: 1,
    kind: "codex-cli",
    ownerPid,
    createdAt: new Date(Date.now() - 48 * 60 * 60 * 1_000).toISOString(),
  });
  await writeFile(
    path.join(safeDirectory, ".mydashboard-invocation.json"),
    marker(91_001),
    "utf8",
  );
  await writeFile(
    path.join(unsafeDirectory, ".mydashboard-invocation.json"),
    marker(91_002),
    "utf8",
  );
  const locator = recordingLocator(testDescriptor("codex-cli"));
  const runner = recordingRunner(async () => successfulProcess());
  const provider = createTestSupervisedCliBrainProvider(
    providerOptions("codex-cli"),
    {
      processRunner: runner,
      commandLocator: locator,
      environment: { OPENAI_API_KEY: "credential" },
      temporaryRoot,
      isProcessAlive: () => false,
      cleanupFileSystem: cleanupFileSystem({
        prepareCleanupTrees: managerModule.prepareCleanupTreesByIdentity,
      }),
    },
  );

  await assert.rejects(provider.generate(brainRequest()), {
    code: "STRUCTURED_PROVIDER_CLEANUP_FAILED",
  });
  assert.equal(
    await readFile(path.join(safeDirectory, "evidence.txt"), "utf8"),
    "retain-safe",
  );
  assert.equal(await readFile(victim, "utf8"), "retain-victim");
  assert.equal(locator.calls.length, 0);
  assert.equal(runner.calls.length, 0);
});

test("a stale-scan directory-close failure blocks the root before discovery", async (t) => {
  const parent = await temporaryDirectory(t, "supervised-cli-stale-close-");
  const temporaryRoot = path.join(parent, "runtime");
  await mkdir(temporaryRoot);
  const staleDirectory = path.join(
    temporaryRoot,
    "invocation-codex-cli-close-failure",
  );
  await mkdir(staleDirectory);
  await writeFile(
    path.join(staleDirectory, ".mydashboard-invocation.json"),
    JSON.stringify({
      schemaVersion: 1,
      kind: "codex-cli",
      ownerPid: 83_333,
      createdAt: new Date(Date.now() - 48 * 60 * 60 * 1_000).toISOString(),
    }),
    "utf8",
  );
  const rootHandle = await opendir(temporaryRoot);
  const rootEntries = [];
  for await (const entry of rootHandle) rootEntries.push(entry);
  let rootEntryIndex = 0;
  const locator = recordingLocator(testDescriptor("codex-cli"));
  const runner = recordingRunner(async () => successfulProcess());
  const provider = createTestSupervisedCliBrainProvider(
    providerOptions("codex-cli"),
    {
      processRunner: runner,
      commandLocator: locator,
      environment: { OPENAI_API_KEY: "credential" },
      temporaryRoot,
      isProcessAlive: () => false,
      cleanupFileSystem: cleanupFileSystem({
        async opendir(directory) {
          if (path.resolve(directory) !== path.resolve(temporaryRoot)) {
            return opendir(directory);
          }
          return {
            async read() { return rootEntries[rootEntryIndex++] ?? null; },
            async close() { throw new Error("private close failure"); },
          };
        },
      }),
    },
  );

  await assert.rejects(
    provider.generate(brainRequest()),
    (error) =>
      error?.code === "STRUCTURED_PROVIDER_CLEANUP_FAILED" &&
      !error.message.includes("private close failure") &&
      !error.message.includes(temporaryRoot),
  );
  assert.equal(locator.calls.length, 0);
  assert.equal(runner.calls.length, 0);
  assert.equal((await lstat(staleDirectory)).isDirectory(), true);

  const nextLocator = recordingLocator(testDescriptor("claude-cli"));
  const nextRunner = recordingRunner(async () => successfulProcess());
  const next = createTestSupervisedCliBrainProvider(
    providerOptions("claude-cli"),
    {
      processRunner: nextRunner,
      commandLocator: nextLocator,
      environment: { ANTHROPIC_API_KEY: "credential" },
      temporaryRoot,
    },
  );
  await assert.rejects(next.generate(brainRequest()), {
    code: "STRUCTURED_PROVIDER_CLEANUP_FAILED",
  });
  assert.equal(nextLocator.calls.length, 0);
  assert.equal(nextRunner.calls.length, 0);
});

test("stale scavenging fails closed before mutation when the root exceeds 128 entries", async (t) => {
  const parent = await temporaryDirectory(t, "supervised-cli-scavenge-bound-");
  const temporaryRoot = path.join(parent, "runtime");
  await mkdir(temporaryRoot, { recursive: true });
  const now = Date.now();
  const old = new Date(now - 48 * 60 * 60 * 1_000).toISOString();
  for (let index = 0; index < 129; index += 1) {
    const directory = path.join(
      temporaryRoot,
      `invocation-codex-cli-bounded${String(index).padStart(3, "0")}`,
    );
    await mkdir(directory);
    await writeFile(
      path.join(directory, ".mydashboard-invocation.json"),
      JSON.stringify({
        schemaVersion: 1,
        kind: "codex-cli",
        ownerPid: 10_000 + index,
        createdAt: old,
      }),
      "utf8",
    );
  }
  let processChecks = 0;
  const runner = recordingRunner(async (invocation) => {
    const resultFile = argumentValue(invocation.args, "--output-last-message");
    await writeFile(resultFile, codexOutput({ ok: true }), "utf8");
    return successfulProcess();
  });
  const provider = createTestSupervisedCliBrainProvider(
    providerOptions("codex-cli"),
    {
      processRunner: runner,
      commandLocator: recordingLocator(testDescriptor("codex-cli")),
      environment: { OPENAI_API_KEY: "credential" },
      temporaryRoot,
      clock: () => now,
      isProcessAlive: () => {
        processChecks += 1;
        return false;
      },
    },
  );

  await assert.rejects(provider.generate(brainRequest()), {
    code: "STRUCTURED_PROVIDER_CLEANUP_FAILED",
  });
  assert.equal(runner.calls.length, 0);
  assert.equal(processChecks, 0);
  assert.equal(
    (await readdir(temporaryRoot)).filter((name) =>
      name.startsWith("invocation-codex-cli-bounded")
    ).length,
    129,
  );
});
