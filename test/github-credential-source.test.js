import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { getEventListeners } from "node:events";
import {
  lstat,
  mkdir,
  mkdtemp,
  opendir,
  realpath,
  rm,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import {
  createGhLoginCredentialSource,
  createTestGhLoginCredentialSource,
} from "../src/adapters/gh-login-credential-source.js";
import {
  TokenEnvCredentialSource,
} from "../src/adapters/token-env-credential-source.js";
import {
  pinGitHubCliDescriptor,
} from "../src/lib/known-cli-locator.js";
import {
  createCredentialLease,
} from "../src/lib/github-credential-source.js";
import {
  prepareCleanupTreesByIdentity,
  PRODUCTION_PRIVATE_DIRECTORY_MANAGER,
} from "../src/lib/private-directory-manager.js";
import {
  SupervisedProcessRunner,
} from "../src/lib/supervised-process-runner.js";

// PRIVACY_FAKE_CREDENTIAL_SHA256:02255638daaeab21a0201e46ab454b5616c4d4e21e06ae5608194ade5b7646e4
const TOKEN = "ghp_fictionalCredentialValue123456789";
const ACTOR = "owner-login";
const OFFLINE_GH_SOURCE = path.join(
  import.meta.dirname,
  "fixtures",
  "offline-gh-token.cs",
);
const WINDOWS_PRODUCTION_SKIP = process.platform === "win32" && process.arch === "x64"
  ? false
  : "production credential supervision is Windows x64 only";

function failure(code, privateDetail = "private failure detail") {
  return Object.assign(new Error(privateDetail), { code });
}

async function temporaryDirectory(t, prefix) {
  const directory = await mkdtemp(path.join(tmpdir(), prefix));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

async function directoryIdentity(directory) {
  const resolved = await realpath(directory);
  const details = await lstat(resolved, { bigint: true });
  return Object.freeze({
    path: resolved,
    device: details.dev.toString(),
    inode: details.ino.toString(),
  });
}

async function assertEmptyDirectory(directory) {
  const handle = await opendir(directory);
  try {
    assert.equal(await handle.read(), null);
  } finally {
    await handle.close();
  }
}

function setWindowsDirectoryAcl(directory) {
  const systemRoot = process.env.SystemRoot || process.env.WINDIR || "C:\\Windows";
  const executable = path.join(
    systemRoot,
    "System32",
    "WindowsPowerShell",
    "v1.0",
    "powershell.exe",
  );
  const script = `
    $ErrorActionPreference = 'Stop'
    $target = [Text.Encoding]::UTF8.GetString(
      [Convert]::FromBase64String($env:MYDASHBOARD_TEST_ACL_PATH)
    )
    $sid = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value
    $sddl = ('O:{0}G:{0}D:P' -f $sid) +
      ('(A;OICI;FA;;;{0})(A;OICI;FA;;;SY)(A;OICI;FA;;;BA)' -f $sid)
    $security = [Security.AccessControl.DirectorySecurity]::new()
    $sections = [Security.AccessControl.AccessControlSections]::Access -bor
      [Security.AccessControl.AccessControlSections]::Owner -bor
      [Security.AccessControl.AccessControlSections]::Group
    $security.SetSecurityDescriptorSddlForm($sddl, $sections)
    [System.IO.Directory]::SetAccessControl($target, $security)
  `;
  const result = spawnSync(
    executable,
    ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", script],
    {
      encoding: "utf8",
      maxBuffer: 1024 * 1024,
      timeout: 30_000,
      windowsHide: true,
      env: {
        SystemRoot: systemRoot,
        WINDIR: systemRoot,
        MYDASHBOARD_TEST_ACL_PATH: Buffer.from(directory, "utf8").toString("base64"),
      },
    },
  );
  assert.equal(result.status, 0, result.stderr);
}

function compileOfflineGitHubCli(output) {
  const systemRoot = process.env.SystemRoot || process.env.WINDIR || "C:\\Windows";
  const executable = path.join(
    systemRoot,
    "System32",
    "WindowsPowerShell",
    "v1.0",
    "powershell.exe",
  );
  const result = spawnSync(
    executable,
    [
      "-NoLogo",
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      "Add-Type -Path $env:MYDASHBOARD_FIXTURE_SOURCE " +
        "-OutputAssembly $env:MYDASHBOARD_FIXTURE_OUTPUT " +
        "-OutputType ConsoleApplication",
    ],
    {
      encoding: "utf8",
      maxBuffer: 1024 * 1024,
      timeout: 30_000,
      windowsHide: true,
      env: {
        SystemRoot: systemRoot,
        WINDIR: systemRoot,
        MYDASHBOARD_FIXTURE_SOURCE: OFFLINE_GH_SOURCE,
        MYDASHBOARD_FIXTURE_OUTPUT: output,
      },
    },
  );
  assert.equal(result.status, 0, result.stderr);
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return Object.freeze({ promise, resolve, reject });
}

function trackSettlement(promise) {
  let outcome = null;
  void promise.then(
    (value) => { outcome = Object.freeze({ status: "fulfilled", value }); },
    (error) => { outcome = Object.freeze({ status: "rejected", error }); },
  );
  return Object.freeze({ read: () => outcome });
}

async function settlementWithinTurns(tracker, maximumTurns = 20) {
  for (let turn = 0; turn < maximumTurns && tracker.read() === null; turn += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }
  return tracker.read();
}

async function fixture(t, overrides = {}) {
  const parent = await temporaryDirectory(t, "github-credential-source-");
  const runtimeTemporaryRoot = path.join(parent, "private-runtime-temp");
  const repositoryRoot = path.join(parent, "repository");
  await mkdir(runtimeTemporaryRoot);
  await mkdir(repositoryRoot);
  const ghCommand = path.join(
    parent,
    process.platform === "win32" ? "gh.exe" : "gh",
  );
  const descriptor = Object.freeze({
    command: ghCommand,
    prefixArgs: Object.freeze([]),
  });
  const calls = { pin: [], prepare: [], run: [], cleanup: [] };
  const environment = overrides.environment ?? {
    SystemRoot: "C:\\Windows",
    WINDIR: "C:\\Windows",
    USERPROFILE: "C:\\Users\\owner",
    APPDATA: "C:\\Users\\owner\\AppData\\Roaming",
    LOCALAPPDATA: "C:\\Users\\owner\\AppData\\Local",
    GH_TOKEN: "host-gh-secret",
    GITHUB_TOKEN: "host-github-secret",
    GITHUB_REPOSITORY: "private/repository",
    GIT_DIR: "private-git-dir",
    SSH_AUTH_SOCK: "private-agent",
    NODE_OPTIONS: "--require private-model-hook",
    HTTPS_PROXY: "http://private-proxy.invalid",
    OPENAI_API_KEY: "private-model-secret",
    GH_CONFIG_DIR: "C:\\private-gh-config",
    PATH: "C:\\untrusted-bin",
  };
  const privateDirectoryManager = overrides.privateDirectoryManager ?? {
    async prepare({ directory, signal, validateLocation }) {
      if (signal?.aborted) throw failure("ABORT_ERR");
      await validateLocation();
      await mkdir(directory).catch((error) => {
        if (error?.code !== "EEXIST") throw error;
      });
      await validateLocation();
      const identity = await directoryIdentity(directory);
      calls.prepare.push(identity);
      return identity;
    },
  };
  const prepareCleanupTrees = overrides.prepareCleanupTrees ?? (async (roots, options) => {
    calls.cleanup.push({ roots, options });
    let closed = false;
    return Object.freeze({
      async commit() {
        assert.equal(closed, false);
        closed = true;
        for (const identity of roots) {
          assert.deepEqual(await directoryIdentity(identity.path), identity);
          await rm(identity.path, { recursive: true, force: false });
        }
      },
      async close() { closed = true; },
    });
  });
  const processRunner = overrides.processRunner ?? {
    async run(options) {
      calls.run.push(options);
      await assertEmptyDirectory(options.cwd);
      return {
        exitCode: 0,
        signal: null,
        stdout: `${TOKEN}\r\n`,
        stderr: "",
        stdoutBytes: Buffer.from(`${TOKEN}\r\n`, "utf8"),
        stderrBytes: Buffer.alloc(0),
      };
    },
  };
  let uuidSequence = 0;
  const clock = overrides.clock ?? (() => 1_000_000);
  const source = await createTestGhLoginCredentialSource({
    actorAccountId: ACTOR,
    ghCommand,
    runtimeTemporaryRoot,
    protectedRoots: [repositoryRoot],
  }, {
    platform: overrides.platform ?? "win32",
    environment,
    clock,
    randomUUID: overrides.randomUUID ?? (() => {
      uuidSequence += 1;
      return `00000000-0000-4000-8000-${String(uuidSequence).padStart(12, "0")}`;
    }),
    executablePinner: overrides.executablePinner ?? (async (command, options) => {
      calls.pin.push({ command, options });
      return descriptor;
    }),
    processRunner,
    privateDirectoryManager,
    prepareCleanupTrees,
  });
  return {
    calls,
    descriptor,
    ghCommand,
    parent,
    repositoryRoot,
    runtimeTemporaryRoot,
    source,
  };
}

async function acquire(source, overrides = {}) {
  return source.acquire({
    actorAccountId: ACTOR,
    signal: null,
    deadline: Date.now() + 60_000,
    ...overrides,
  });
}

test("credential leases expose a secret for one callback and release idempotently", async () => {
  const lease = createCredentialLease(TOKEN);
  assert.deepEqual(Reflect.ownKeys(lease).sort(), ["release", "use"]);
  assert.equal(JSON.stringify(lease), "{}");
  assert.equal("token" in lease, false);

  const result = await lease.use(async (token) => {
    assert.equal(token, TOKEN);
    return "callback result";
  });
  assert.equal(result, "callback result");
  assert.equal(lease.release(), undefined);
  assert.equal(lease.release(), undefined);
  await assert.rejects(lease.use(() => {}), TypeError);
});

test("credential leases stop exposing the token when the callback fails", async () => {
  const lease = createCredentialLease(TOKEN);
  await assert.rejects(
    lease.use(() => { throw new Error("consumer failed"); }),
    /consumer failed/,
  );
  await assert.rejects(lease.use(() => TOKEN), TypeError);
  assert.equal(JSON.stringify(lease).includes(TOKEN), false);
});

test("token-env reads its fixed own environment field only at acquire", async () => {
  const environment = {};
  const source = new TokenEnvCredentialSource({
    actorAccountId: ACTOR,
    tokenEnv: "MYDASHBOARD_GITHUB_TOKEN",
    environment,
  });
  environment.MYDASHBOARD_GITHUB_TOKEN = TOKEN;

  const lease = await acquire(source);
  delete environment.MYDASHBOARD_GITHUB_TOKEN;
  assert.equal(await lease.use((token) => token === TOKEN), true);
  await assert.rejects(acquire(source), { code: "GITHUB_CREDENTIAL_MISSING" });
});

test("token-env preserves the legacy name, actor, and token validation", async () => {
  assert.throws(
    () => new TokenEnvCredentialSource({
      actorAccountId: ACTOR,
      tokenEnv: "lowercase_token",
      environment: {},
    }),
    TypeError,
  );
  for (const token of ["", " leading", "trailing ", "line\nvalue", "x".repeat(4_097)]) {
    const source = new TokenEnvCredentialSource({
      actorAccountId: ACTOR,
      tokenEnv: "MYDASHBOARD_GITHUB_TOKEN",
      environment: { MYDASHBOARD_GITHUB_TOKEN: token },
    });
    await assert.rejects(acquire(source), { code: "GITHUB_CREDENTIAL_MISSING" });
  }
  const source = new TokenEnvCredentialSource({
    actorAccountId: ACTOR,
    tokenEnv: "MYDASHBOARD_GITHUB_TOKEN",
    environment: { MYDASHBOARD_GITHUB_TOKEN: TOKEN },
  });
  await assert.rejects(
    acquire(source, { actorAccountId: "other-owner" }),
    { code: "GITHUB_ACTOR_MISMATCH" },
  );
});

test("gh-login pins once and invokes only the fixed auth token command", async (t) => {
  const current = await fixture(t);
  assert.equal(current.calls.pin.length, 1);
  assert.equal(current.calls.pin[0].command, current.ghCommand);

  const lease = await acquire(current.source);
  assert.equal(await lease.use((token) => token === TOKEN), true);
  assert.equal(current.calls.run.length, 1);
  const invocation = current.calls.run[0];
  assert.equal(invocation.executable, current.descriptor);
  assert.deepEqual(invocation.args, [
    "auth",
    "token",
    "--hostname",
    "github.com",
    "--user",
    ACTOR,
  ]);
  assert.deepEqual(invocation.input, Buffer.alloc(0));
  assert.equal(invocation.timeoutMs, 15_000);
  assert.equal(invocation.maxStdoutBytes, 4_096);
  assert.equal(invocation.maxStderrBytes, 8_192);
  assert.equal(path.dirname(invocation.cwd), current.runtimeTemporaryRoot);
  assert.notEqual(invocation.cwd, current.repositoryRoot);
  assert.deepEqual(invocation.env, {
    SystemRoot: "C:\\Windows",
    WINDIR: "C:\\Windows",
    USERPROFILE: "C:\\Users\\owner",
    APPDATA: "C:\\Users\\owner\\AppData\\Roaming",
    LOCALAPPDATA: "C:\\Users\\owner\\AppData\\Local",
    GH_PROMPT_DISABLED: "1",
    GH_NO_UPDATE_NOTIFIER: "1",
    GH_PAGER: "cat",
    NO_COLOR: "1",
    TEMP: invocation.cwd,
    TMP: invocation.cwd,
    TMPDIR: invocation.cwd,
  });
  await assert.rejects(lstat(invocation.cwd), { code: "ENOENT" });
  assert.equal(current.calls.cleanup.length, 1);
});

test("gh-login rejects actor injection and protected temporary roots before spawn", async (t) => {
  const current = await fixture(t);
  await assert.rejects(
    acquire(current.source, { actorAccountId: `${ACTOR}\n--hostname evil.invalid` }),
    { code: "GITHUB_ACTOR_MISMATCH" },
  );
  assert.equal(current.calls.run.length, 0);

  await assert.rejects(
    createTestGhLoginCredentialSource({
      actorAccountId: ACTOR,
      ghCommand: current.ghCommand,
      runtimeTemporaryRoot: current.repositoryRoot,
      protectedRoots: [current.repositoryRoot],
    }, {
      platform: "win32",
      environment: {},
      clock: () => 1_000_000,
      randomUUID: () => "00000000-0000-4000-8000-000000000001",
      executablePinner: async () => current.descriptor,
      processRunner: { async run() { throw new Error("must not run"); } },
      privateDirectoryManager: {
        async prepare() { throw new Error("must not prepare"); },
      },
      prepareCleanupTrees: async () => { throw new Error("must not clean"); },
    }),
    { code: "GITHUB_CREDENTIAL_CLEANUP_FAILED" },
  );

  await assert.rejects(
    createTestGhLoginCredentialSource({
      actorAccountId: ACTOR,
      ghCommand: current.ghCommand,
      runtimeTemporaryRoot: path.join(current.repositoryRoot, "private-temp"),
      protectedRoots: [current.repositoryRoot],
    }, {
      platform: "win32",
      environment: {},
      clock: () => 1_000_000,
      randomUUID: () => "00000000-0000-4000-8000-000000000001",
      executablePinner: async () => current.descriptor,
      processRunner: { async run() { throw new Error("must not run"); } },
      privateDirectoryManager: {
        async prepare() { throw new Error("must not prepare"); },
      },
      prepareCleanupTrees: async () => { throw new Error("must not clean"); },
    }),
    { code: "GITHUB_CREDENTIAL_CLEANUP_FAILED" },
  );
});

test("gh-login accepts only one strict UTF-8 token line", async (t) => {
  const valid = [
    Buffer.from(TOKEN),
    Buffer.from(`${TOKEN}\n`),
    Buffer.from(`${TOKEN}\r\n`),
  ];
  const invalid = [
    Buffer.alloc(0),
    Buffer.from(` ${TOKEN}`),
    Buffer.from(`${TOKEN} `),
    Buffer.from(`${TOKEN}\r\nextra`),
    Buffer.from(`${TOKEN}\r\n\r\n`),
    Buffer.from([0xff, 0xfe]),
    Buffer.alloc(4_097, 0x78),
  ];
  for (const stdoutBytes of valid) {
    await t.test(`valid ${stdoutBytes.length} bytes`, async (child) => {
      const current = await fixture(child, {
        processRunner: {
          async run(options) {
            return {
              exitCode: 0,
              signal: null,
              stdout: stdoutBytes.toString("utf8"),
              stderr: "",
              stdoutBytes,
              stderrBytes: Buffer.alloc(0),
            };
          },
        },
      });
      const lease = await acquire(current.source);
      assert.equal(await lease.use((token) => token), TOKEN);
    });
  }
  for (const stdoutBytes of invalid) {
    await t.test(`invalid ${stdoutBytes.length} bytes`, async (child) => {
      const current = await fixture(child, {
        processRunner: {
          async run() {
            return {
              exitCode: 0,
              signal: null,
              stdout: "redacted fixture output",
              stderr: "",
              stdoutBytes,
              stderrBytes: Buffer.alloc(0),
            };
          },
        },
      });
      await assert.rejects(acquire(current.source), (error) =>
        error?.code === "GITHUB_CREDENTIAL_OUTPUT_INVALID" &&
        !error.message.includes(TOKEN) &&
        !JSON.stringify(error).includes(TOKEN));
    });
  }
});

test("gh-login rejects stderr, truncation, and nonzero or missing login without details", async (t) => {
  const cases = [
    {
      result: {
        exitCode: 0,
        signal: null,
        stdoutBytes: Buffer.from(TOKEN),
        stderrBytes: Buffer.from("private stderr"),
      },
      code: "GITHUB_CREDENTIAL_OUTPUT_INVALID",
    },
    {
      result: {
        exitCode: 0,
        signal: null,
        stdoutBytes: Buffer.from(TOKEN),
        stderrBytes: Buffer.alloc(0),
        truncated: true,
      },
      code: "GITHUB_CREDENTIAL_OUTPUT_INVALID",
    },
    {
      result: {
        exitCode: 1,
        signal: null,
        stdoutBytes: Buffer.from("private stdout"),
        stderrBytes: Buffer.from("not logged in"),
      },
      code: "GITHUB_LOGIN_UNAVAILABLE",
    },
    {
      error: failure("STRUCTURED_PROVIDER_PROCESS_EXITED", "private gh stderr"),
      code: "GITHUB_LOGIN_UNAVAILABLE",
    },
  ];
  for (const entry of cases) {
    await t.test(entry.code, async (child) => {
      const current = await fixture(child, {
        processRunner: {
          async run() {
            if (entry.error) throw entry.error;
            return entry.result;
          },
        },
      });
      await assert.rejects(acquire(current.source), (error) =>
        error?.code === entry.code &&
        !error.message.includes("private") &&
        !JSON.stringify(error).includes("private"));
    });
  }
});

test("gh-login maps timeout, cancellation, output limits, and reap uncertainty", async (t) => {
  const mappings = [
    ["STRUCTURED_PROVIDER_TIMEOUT", "GITHUB_CREDENTIAL_TIMEOUT"],
    ["STRUCTURED_PROVIDER_CANCELLED", "GITHUB_CREDENTIAL_CANCELLED"],
    ["STRUCTURED_PROVIDER_OUTPUT_LIMIT", "GITHUB_CREDENTIAL_OUTPUT_INVALID"],
    ["STRUCTURED_PROVIDER_REAP_FAILED", "GITHUB_CREDENTIAL_CLEANUP_FAILED"],
    ["STRUCTURED_PROVIDER_UNAVAILABLE", "GITHUB_CLI_UNAVAILABLE"],
    ["STRUCTURED_PROVIDER_PROCESS_FAILED", "GITHUB_CLI_UNAVAILABLE"],
  ];
  for (const [runnerCode, expectedCode] of mappings) {
    await t.test(`${runnerCode} -> ${expectedCode}`, async (child) => {
      const current = await fixture(child, {
        processRunner: {
          async run() { throw failure(runnerCode, `${TOKEN}-private-detail`); },
        },
      });
      await assert.rejects(acquire(current.source), (error) =>
        error?.code === expectedCode &&
        !error.message.includes(TOKEN) &&
        !JSON.stringify(error).includes(TOKEN));
    });
  }
});

test("gh-login uses the caller's remaining total deadline", async (t) => {
  let now = 1_000_000;
  const current = await fixture(t, {
    clock: () => now,
    processRunner: {
      async run(options) {
        current.calls.run.push(options);
        now += 5_001;
        return {
          exitCode: 0,
          signal: null,
          stdoutBytes: Buffer.from(TOKEN),
          stderrBytes: Buffer.alloc(0),
        };
      },
    },
  });
  await assert.rejects(
    acquire(current.source, { deadline: 1_005_000 }),
    { code: "GITHUB_CREDENTIAL_TIMEOUT" },
  );
  assert.equal(current.calls.run[0].timeoutMs, 5_000);
  assert.equal(current.calls.cleanup.length, 1);
});

test("gh-login recovers and cleans a directory when prepare fails after creation", async (t) => {
  let createdDirectory = null;
  const current = await fixture(t, {
    privateDirectoryManager: {
      async prepare({ directory, validateLocation }) {
        await validateLocation();
        await mkdir(directory);
        createdDirectory = directory;
        await validateLocation();
        throw failure("STRUCTURED_PROVIDER_UNAVAILABLE");
      },
    },
  });

  await assert.rejects(
    acquire(current.source),
    { code: "GITHUB_CLI_UNAVAILABLE" },
  );
  assert.equal(current.calls.run.length, 0);
  assert.equal(current.calls.cleanup.length, 1);
  await assert.rejects(lstat(createdDirectory), { code: "ENOENT" });
});

test("gh-login gives unproven cleanup precedence after prepare cancellation", async (t) => {
  const controller = new AbortController();
  const current = await fixture(t, {
    privateDirectoryManager: {
      async prepare({ directory, validateLocation }) {
        await validateLocation();
        await mkdir(directory);
        controller.abort(new Error(`${TOKEN}-caller-reason`));
        throw failure("ABORT_ERR", TOKEN);
      },
    },
    async prepareCleanupTrees() {
      throw failure("PRIVATE_CLEANUP_FAILURE", TOKEN);
    },
  });

  await assert.rejects(
    acquire(current.source, { signal: controller.signal }),
    (error) => error?.code === "GITHUB_CREDENTIAL_CLEANUP_FAILED" &&
      !error.message.includes(TOKEN) &&
      !JSON.stringify(error).includes(TOKEN),
  );
  assert.equal(current.calls.run.length, 0);
});

test("gh-login caller cancellation bounds uncooperative cleanup preparation", async (t) => {
  const controller = new AbortController();
  const preparationStarted = deferred();
  const preparation = deferred();
  let cleanupSignal = null;
  const current = await fixture(t, {
    async prepareCleanupTrees(_roots, { signal }) {
      cleanupSignal = signal;
      preparationStarted.resolve();
      return preparation.promise;
    },
  });
  const acquisition = acquire(current.source, {
    signal: controller.signal,
    deadline: Date.now() + 10_000,
  });
  const settlement = trackSettlement(acquisition);
  await preparationStarted.promise;

  controller.abort(new Error(`${TOKEN}-caller-reason`));
  const outcome = await settlementWithinTurns(settlement);
  assert.equal(outcome?.status, "rejected");
  assert.equal(outcome?.error?.code, "GITHUB_CREDENTIAL_CLEANUP_FAILED");
  assert.equal(JSON.stringify(outcome.error).includes(TOKEN), false);
  assert.equal(current.calls.run.length, 0);
  assert.equal(cleanupSignal.aborted, true);
  assert.equal(getEventListeners(controller.signal, "abort").length, 0);
  assert.equal(getEventListeners(cleanupSignal, "abort").length, 0);

  preparation.reject(failure("PRIVATE_CLEANUP_PREPARATION_LATE_FAILURE", TOKEN));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(settlement.read(), outcome);
});

test("gh-login shared deadline bounds uncooperative cleanup preparation", async (t) => {
  const now = 1_000_000;
  const preparationStarted = deferred();
  let cleanupSignal = null;
  t.mock.timers.enable({ apis: ["setTimeout"] });
  try {
    const current = await fixture(t, {
      clock: () => now,
      async prepareCleanupTrees(_roots, { signal }) {
        cleanupSignal = signal;
        preparationStarted.resolve();
        return new Promise(() => {});
      },
    });
    const settlement = trackSettlement(acquire(current.source, {
      deadline: now + 50,
    }));
    await preparationStarted.promise;

    t.mock.timers.tick(49);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(settlement.read(), null);

    t.mock.timers.tick(1);
    const outcome = await settlementWithinTurns(settlement);
    assert.equal(outcome?.status, "rejected");
    assert.equal(outcome?.error?.code, "GITHUB_CREDENTIAL_CLEANUP_FAILED");
    assert.equal(current.calls.run.length, 0);
    assert.equal(cleanupSignal.aborted, true);
    assert.equal(getEventListeners(cleanupSignal, "abort").length, 0);
  } finally {
    t.mock.timers.reset();
  }
});

test("gh-login cleanup preparation tolerates startup work taking over five seconds", async (t) => {
  const now = 1_000_000;
  const preparationStarted = deferred();
  const preparationRelease = deferred();
  let cleanupSignal;
  let committed = false;
  const current = await fixture(t, {
    clock: () => now,
    async prepareCleanupTrees(_roots, { signal }) {
      cleanupSignal = signal;
      preparationStarted.resolve();
      await preparationRelease.promise;
      return {
        async commit() { signal.throwIfAborted(); committed = true; },
        async close() {},
      };
    },
  });
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const acquisition = acquire(current.source, { deadline: now + 60_000 });
  const settlement = trackSettlement(acquisition);
  try {
    await preparationStarted.promise;
    t.mock.timers.tick(6_000);
    preparationRelease.resolve();
    const lease = await acquisition;
    lease.release();
    assert.equal(cleanupSignal.aborted, false);
    assert.equal(committed, true);
  } finally {
    preparationRelease.resolve();
    await settlementWithinTurns(settlement);
    t.mock.timers.reset();
  }
});

test("gh-login fixed cleanup cap bounds preparation and closes a late session", async (t) => {
  const now = 1_000_000;
  const preparationStarted = deferred();
  const preparation = deferred();
  let commitCalls = 0;
  let closeCalls = 0;
  let cleanupSignal = null;
  t.mock.timers.enable({ apis: ["setTimeout"] });
  try {
    const current = await fixture(t, {
      clock: () => now,
      async prepareCleanupTrees(_roots, { signal }) {
        cleanupSignal = signal;
        preparationStarted.resolve();
        return preparation.promise;
      },
    });
    const settlement = trackSettlement(acquire(current.source, {
      deadline: now + 60_000,
    }));
    await preparationStarted.promise;

    t.mock.timers.tick(29_999);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(settlement.read(), null);

    t.mock.timers.tick(1);
    const outcome = await settlementWithinTurns(settlement);
    assert.equal(outcome?.status, "rejected");
    assert.equal(outcome?.error?.code, "GITHUB_CREDENTIAL_CLEANUP_FAILED");
    assert.equal(current.calls.run.length, 0);
    assert.equal(cleanupSignal.aborted, true);
    assert.equal(getEventListeners(cleanupSignal, "abort").length, 0);

    preparation.resolve(Object.freeze({
      async commit() { commitCalls += 1; },
      async close() {
        closeCalls += 1;
        throw failure("PRIVATE_CLEANUP_LATE_CLOSE_FAILED", TOKEN);
      },
    }));
    await settlementWithinTurns({ read: () => closeCalls === 1 ? true : null });
    assert.equal(commitCalls, 0);
    assert.equal(closeCalls, 1);
    assert.equal(settlement.read(), outcome);
  } finally {
    t.mock.timers.reset();
  }
});

test("gh-login preserves its cleanup session while a valid credential process takes over five seconds", async (t) => {
  let now = 1_000_000;
  const processStarted = deferred();
  const processRelease = deferred();
  let committed = false;
  let cleanupSignal;
  const current = await fixture(t, {
    clock: () => now,
    async prepareCleanupTrees(roots, { signal }) {
      cleanupSignal = signal;
      return {
        async commit() {
          signal.throwIfAborted();
          for (const identity of roots) {
            assert.deepEqual(await directoryIdentity(identity.path), identity);
            await rm(identity.path, { recursive: true });
          }
          committed = true;
        },
        async close() {},
      };
    },
    processRunner: {
      async run() {
        processStarted.resolve();
        await processRelease.promise;
        return {
          exitCode: 0,
          signal: null,
          stdoutBytes: Buffer.from(`${TOKEN}\n`, "utf8"),
          stderrBytes: Buffer.alloc(0),
        };
      },
    },
  });
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const acquisition = acquire(current.source, { deadline: now + 30_000 });
  try {
    await processStarted.promise;
    now += 6_000;
    t.mock.timers.tick(6_000);
    processRelease.resolve();
    const lease = await acquisition;
    lease.release();
    assert.equal(cleanupSignal.aborted, false);
    assert.equal(committed, true);
    await assertEmptyDirectory(current.runtimeTemporaryRoot);
  } finally {
    processRelease.resolve();
    await acquisition.catch(() => {});
    t.mock.timers.reset();
  }
});

test("gh-login bounds cleanup after waiting for a credential process", async (t) => {
  for (const { name, deadlineMs, cleanupMs } of [
    { name: "cleanup cap", deadlineMs: 60_000, cleanupMs: 30_000 },
    { name: "shared deadline", deadlineMs: 8_000, cleanupMs: 2_000 },
  ]) {
    await t.test(name, async (t) => {
      let now = 1_000_000;
      const processStarted = deferred();
      const processRelease = deferred();
      const commitStarted = deferred();
      let cleanupSignal;
      const current = await fixture(t, {
        clock: () => now,
        async prepareCleanupTrees(_roots, { signal }) {
          cleanupSignal = signal;
          return {
            async commit() {
              signal.throwIfAborted();
              commitStarted.resolve();
              await new Promise((_, reject) => signal.addEventListener(
                "abort", () => reject(signal.reason), { once: true },
              ));
            },
            async close() {},
          };
        },
        processRunner: {
          async run() {
            processStarted.resolve();
            await processRelease.promise;
            return { exitCode: 0, signal: null };
          },
        },
      });
      t.mock.timers.enable({ apis: ["setTimeout"] });
      const acquisition = acquire(current.source, { deadline: now + deadlineMs });
      const settlement = trackSettlement(acquisition);
      try {
        await processStarted.promise;
        now += 6_000;
        t.mock.timers.tick(6_000);
        processRelease.resolve();
        await commitStarted.promise;
        now += cleanupMs - 1;
        t.mock.timers.tick(cleanupMs - 1);
        await new Promise((resolve) => setImmediate(resolve));
        assert.equal(settlement.read(), null);
        assert.equal(cleanupSignal.aborted, false);
        now += 1;
        t.mock.timers.tick(1);
        await assert.rejects(acquisition, { code: "GITHUB_CREDENTIAL_CLEANUP_FAILED" });
        assert.equal(cleanupSignal.aborted, true);
      } finally {
        processRelease.resolve();
        t.mock.timers.reset();
      }
    });
  }
});

test("gh-login production factory constructs from sealed production ports", {
  skip: WINDOWS_PRODUCTION_SKIP,
}, async (t) => {
  const parent = await temporaryDirectory(t, "github-credential-factory-");
  const runtimeTemporaryRoot = path.join(parent, "private-runtime-temp");
  const ghCommand = path.join(parent, "gh.exe");
  await mkdir(runtimeTemporaryRoot);
  setWindowsDirectoryAcl(runtimeTemporaryRoot);
  compileOfflineGitHubCli(ghCommand);

  const source = await createGhLoginCredentialSource({
    actorAccountId: ACTOR,
    ghCommand,
    runtimeTemporaryRoot,
    protectedRoots: [path.resolve(".")],
  });

  assert.equal(typeof source.acquire, "function");
});

test("gh-login production-shaped pipeline runs a controlled executable and recovers post-create failure", {
  skip: WINDOWS_PRODUCTION_SKIP,
}, async (t) => {
  const parent = await temporaryDirectory(t, "github-credential-production-");
  const runtimeTemporaryRoot = path.join(parent, "private-runtime-temp");
  const ghCommand = path.join(parent, "gh.exe");
  await mkdir(runtimeTemporaryRoot);
  setWindowsDirectoryAcl(runtimeTemporaryRoot);
  compileOfflineGitHubCli(ghCommand);

  const supervisedRunner = new SupervisedProcessRunner();
  let failAfterCreate = false;
  let uuidSequence = 0;
  const source = await createTestGhLoginCredentialSource({
    actorAccountId: ACTOR,
    ghCommand,
    runtimeTemporaryRoot,
    protectedRoots: [path.resolve(".")],
  }, {
    platform: process.platform,
    environment: Object.fromEntries(
      ["SystemRoot", "WINDIR", "USERPROFILE", "APPDATA", "LOCALAPPDATA"]
        .flatMap((name) => typeof process.env[name] === "string"
          ? [[name, process.env[name]]]
          : []),
    ),
    clock: () => Date.now(),
    randomUUID: () => {
      uuidSequence += 1;
      return `00000000-0000-4000-8000-${String(uuidSequence).padStart(12, "0")}`;
    },
    executablePinner: pinGitHubCliDescriptor,
    processRunner: Object.freeze({
      run: supervisedRunner.run.bind(supervisedRunner),
    }),
    privateDirectoryManager: Object.freeze({
      async prepare(options) {
        const identity = await PRODUCTION_PRIVATE_DIRECTORY_MANAGER.prepare(options);
        if (failAfterCreate) throw failure("STRUCTURED_PROVIDER_UNAVAILABLE");
        return identity;
      },
    }),
    prepareCleanupTrees: prepareCleanupTreesByIdentity,
  });

  const controller = new AbortController();
  const lease = await acquire(source, {
    signal: controller.signal,
    deadline: Date.now() + 30_000,
  });
  assert.equal(await lease.use((token) => token), TOKEN);
  await assertEmptyDirectory(runtimeTemporaryRoot);

  failAfterCreate = true;
  await assert.rejects(
    acquire(source, {
      signal: controller.signal,
      deadline: Date.now() + 30_000,
    }),
    { code: "GITHUB_CLI_UNAVAILABLE" },
  );
  await assertEmptyDirectory(runtimeTemporaryRoot);
});

test("gh-login cancellation and cleanup uncertainty fail closed", async (t) => {
  const controller = new AbortController();
  const cancelled = await fixture(t, {
    processRunner: {
      async run({ signal }) {
        controller.abort(new Error(`${TOKEN}-caller-reason`));
        assert.equal(signal.aborted, true);
        throw failure("STRUCTURED_PROVIDER_CANCELLED");
      },
    },
  });
  await assert.rejects(
    acquire(cancelled.source, { signal: controller.signal }),
    (error) => error?.code === "GITHUB_CREDENTIAL_CANCELLED" &&
      !error.message.includes(TOKEN),
  );

  const cleanupFailed = await fixture(t, {
    async prepareCleanupTrees() {
      throw failure("PRIVATE_CLEANUP_FAILURE", TOKEN);
    },
  });
  await assert.rejects(
    acquire(cleanupFailed.source),
    (error) => error?.code === "GITHUB_CREDENTIAL_CLEANUP_FAILED" &&
      !error.message.includes(TOKEN) &&
      !JSON.stringify(error).includes(TOKEN),
  );
});
