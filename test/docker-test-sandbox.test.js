import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import {
  DockerSandboxError,
  DockerTestSandbox,
} from "../src/adapters/docker-test-sandbox.js";
import { digestValue } from "../src/domain/code-executor-contract.js";
import { ManagedProcessError } from "../src/lib/managed-process.js";

const image =
  "node:22-alpine@sha256:c610fcdfb1d5b4740dd70c284ed3cb16bb857e0f7166196e36a5501df7a3aa32";
const dockerExecutable =
  "C:\\Program Files\\Docker\\Docker\\resources\\bin\\docker.exe";
const dockerHost = "npipe:////./pipe/dockerDesktopLinuxEngine";

class FakeRunner {
  constructor(results) {
    this.results = [...results];
    this.calls = [];
  }

  async run(invocation) {
    this.calls.push(invocation);
    const result = this.results.shift();
    if (result instanceof Error) throw result;
    return result;
  }
}

function result({ exitCode = 0, stdout = "", stderr = "" } = {}) {
  return {
    exitCode,
    stdout,
    stderr,
    durationMs: 2,
    signal: null,
  };
}

async function fixture(
  t,
  results,
  {
    profile = { kind: "node-test", image, timeoutMs: 30_000 },
  } = {},
) {
  const root = await mkdtemp(path.join(tmpdir(), "docker-sandbox-test-"));
  const workspacePath = path.join(root, "workspace");
  await mkdir(workspacePath);
  t.after(() => rm(root, { recursive: true, force: true }));
  const plannedResults =
    typeof results === "function" ? results({ root, workspacePath }) : results;
  const processRunner = new FakeRunner(plannedResults);
  const sandbox = new DockerTestSandbox({
    dockerExecutable,
    dockerHost,
    allowedWorkspaceRoot: root,
    profiles: { "node-tests": profile },
    processRunner,
    sourceEnvironment: {
      SystemRoot: "C:\\Windows",
      WINDIR: "C:\\Windows",
      GH_TOKEN: "must-not-leak",
      NODE_OPTIONS: "--require malicious.js",
    },
  });
  return { root, sandbox, processRunner, workspacePath };
}

function request(paths) {
  return {
    profileId: "node-tests",
    executionId: "run-one",
    actionId: "action-one",
    ...paths,
  };
}

function expectedContainerName(executionId = "run-one", actionId = "action-one") {
  const digest = createHash("sha256")
    .update(`${executionId}:${actionId}`)
    .digest("hex")
    .slice(0, 24);
  return `mydashboard-${digest}`;
}

function hostValueVariants({ root, workspacePath }) {
  return [
    ...new Set(
      [workspacePath, root, dockerExecutable, dockerHost].flatMap((value) => {
        const slashNormalized = value.replaceAll("\\", "/");
        return [
          value,
          slashNormalized,
          value.replaceAll("\\", "\\\\").replaceAll("/", "\\/"),
          slashNormalized.replaceAll("/", "\\/"),
        ];
      }),
    ),
  ];
}

function assertHostValuesRedacted(output, values) {
  const normalizedOutput = output.toLowerCase();
  for (const value of values) {
    assert.equal(normalizedOutput.includes(value.toLowerCase()), false);
  }
}

function probeProcessFailure(paths) {
  return new ManagedProcessError("PROCESS_START_FAILED", "stopped", {
    details: {
      exitCode: null,
      signal: null,
      stdout: hostValueVariants(paths)
        .map((value, index) => `host-${index}=${value}`)
        .join("\n"),
      stderr: "container=/workspace/test/app.test.js",
      durationMs: 12,
      truncated: false,
    },
  });
}

async function assertProbeFailureRedaction(t, expectedCode, results) {
  const setup = await fixture(t, results);
  let failure;
  await assert.rejects(
    setup.sandbox.run(request({ workspacePath: setup.workspacePath })),
    (error) => {
      failure = error;
      return error instanceof DockerSandboxError && error.code === expectedCode;
    },
  );
  assertHostValuesRedacted(
    JSON.stringify(failure.details),
    hostValueVariants(setup),
  );
  assert.match(failure.details.stderr, /container=\/workspace\/test\/app\.test\.js/);
}

test("Docker profiles run pinned Node tests with a read-only, offline boundary", async (t) => {
  const imageId = `sha256:${"a".repeat(64)}`;
  const setup = await fixture(t, [
    result({ stdout: "29.2.1" }),
    result({ stdout: imageId }),
    result({ stdout: "\u001b[32mok\u001b[0m" }),
  ]);

  const output = await setup.sandbox.run(
    request({
      workspacePath: setup.workspacePath,
    }),
  );

  assert.equal(output.exitCode, 0);
  assert.equal(output.stdout, "ok");
  assert.equal(output.imageId, imageId);
  assert.equal(
    output.profileFingerprint,
    setup.sandbox.getProfileFingerprint("node-tests"),
  );
  assert.equal(setup.processRunner.calls.length, 3);
  const invocation = setup.processRunner.calls[2];
  assert.equal(invocation.command.endsWith("docker.exe"), true);
  assert.equal(invocation.args.includes("--test-reporter=tap"), true);
  assert.equal(invocation.args.includes("none"), true);
  assert.equal(invocation.args.includes("--read-only"), true);
  assert.deepEqual(
    invocation.args.slice(
      invocation.args.indexOf("--cap-drop"),
      invocation.args.indexOf("--cap-drop") + 2,
    ),
    ["--cap-drop", "ALL"],
  );
  assert.equal(invocation.args.includes("no-new-privileges"), true);
  assert.equal(invocation.args.includes("--pids-limit"), true);
  assert.equal(invocation.args.includes("--memory"), true);
  assert.equal(invocation.args.includes("--cpus"), true);
  assert.equal(
    invocation.args.some((arg) => arg.includes("target=/workspace") && arg.includes("readonly")),
    true,
  );
  assert.equal(
    invocation.args.some(
      (arg) => arg.includes("source=") && arg.includes("target=/artifacts"),
    ),
    false,
  );
  assert.equal(
    invocation.args.includes(
      "/artifacts:rw,noexec,nosuid,nodev,size=64m,mode=0700,uid=65532,gid=65532",
    ),
    true,
  );
  assert.equal(invocation.args.includes("--pull"), true);
  assert.equal(invocation.args.includes("never"), true);
  assert.deepEqual(invocation.env, {
    SystemRoot: "C:\\Windows",
    WINDIR: "C:\\Windows",
    DOCKER_CLI_HINTS: "false",
  });
  assert.equal(invocation.args.includes("--allow-child-process"), true);
  assert.equal(invocation.args.includes("--allow-fs-read=/tmp"), true);
  assert.equal(invocation.args.includes("--allow-fs-read=/artifacts"), true);
  assert.equal(invocation.args.includes("--allow-worker"), false);
});

test("approved Node script assets are materialized by digest and run read-only", async (t) => {
  const source = [
    'import assert from "node:assert/strict";',
    'assert.equal(2 + 2, 4);',
    'console.log("asset passed");',
  ].join("\n");
  const setup = await fixture(
    t,
    [
      result({ stdout: "29.2.1" }),
      result({ stdout: `sha256:${"b".repeat(64)}` }),
      result({ stdout: "asset passed" }),
    ],
    {
      profile: {
        kind: "node-script",
        image,
        timeoutMs: 30_000,
        asset: {
          schemaVersion: 1,
          title: "Reusable smoke assertion",
          description: "Reusable across code jobs in this workspace.",
          version: 3,
          source,
        },
      },
    },
  );
  const staleFingerprint = "f".repeat(64);
  const staleSourcePath = path.join(
    setup.root,
    ".test-library",
    staleFingerprint,
    "test.mjs",
  );
  await mkdir(path.dirname(staleSourcePath), { recursive: true });
  await writeFile(staleSourcePath, 'console.log("stale");', "utf8");

  const output = await setup.sandbox.run(
    request({ workspacePath: setup.workspacePath }),
  );

  assert.equal(output.exitCode, 0);
  const invocation = setup.processRunner.calls[2];
  const assetMount = invocation.args.find(
    (argument) => argument.includes("target=/test-library") && argument.includes("readonly"),
  );
  assert.ok(assetMount);
  assert.equal(invocation.args.includes("--allow-fs-read=/test-library"), true);
  assert.equal(invocation.args.includes("--test-reporter=tap"), false);
  assert.equal(invocation.args.at(-1), "/test-library/test.mjs");
  assert.equal(invocation.args.includes(source), false);

  const sourcePath = assetMount
    .slice(assetMount.indexOf("source=") + "source=".length)
    .split(",target=")[0];
  assert.equal(await readFile(sourcePath, "utf8"), source);
  await assert.rejects(readFile(staleSourcePath, "utf8"), { code: "ENOENT" });
});

test("script asset metadata and source are sealed into the profile fingerprint", async (t) => {
  const base = {
    kind: "node-script",
    image,
    timeoutMs: 30_000,
    asset: {
      schemaVersion: 1,
      title: "Reusable test",
      description: "Runs for every bound code job.",
      version: 1,
      source: 'console.log("one");',
    },
  };
  const first = await fixture(t, [], { profile: base });
  const changed = await fixture(t, [], {
    profile: {
      ...base,
      asset: { ...base.asset, version: 2, source: 'console.log("two");' },
    },
  });

  assert.notEqual(
    first.sandbox.getProfileFingerprint("node-tests"),
    changed.sandbox.getProfileFingerprint("node-tests"),
  );
});

test("cached script assets reject source that does not match the profile digest", async (t) => {
  const source = 'console.log("approved");';
  const setup = await fixture(t, [], {
    profile: {
      kind: "node-script",
      image,
      timeoutMs: 30_000,
      asset: {
        schemaVersion: 1,
        title: "Reusable test",
        description: "Rejects a tampered cache entry.",
        version: 1,
        source,
      },
    },
  });
  const sourcePath = path.join(
    setup.root,
    ".test-library",
    setup.sandbox.getProfileFingerprint("node-tests"),
    "test.mjs",
  );
  await mkdir(path.dirname(sourcePath), { recursive: true });
  await writeFile(sourcePath, 'console.log("tampered");', "utf8");

  await assert.rejects(
    setup.sandbox.run(request({ workspacePath: setup.workspacePath })),
    (error) => error instanceof DockerSandboxError &&
      error.code === "INVALID_SANDBOX_REQUEST",
  );
  assert.equal(setup.processRunner.calls.length, 0);
});

test("script library preparation can retry after its cache is repaired", async (t) => {
  const source = 'console.log("approved");';
  const setup = await fixture(
    t,
    [
      result({ stdout: "29.2.1" }),
      result({ stdout: `sha256:${"b".repeat(64)}` }),
      result({ stdout: "approved" }),
    ],
    {
      profile: {
        kind: "node-script",
        image,
        timeoutMs: 30_000,
        asset: {
          schemaVersion: 1,
          title: "Reusable test",
          description: "Retries after an invalid cache entry is repaired.",
          version: 1,
          source,
        },
      },
    },
  );
  const invalidEntry = path.join(setup.root, ".test-library", "invalid");
  await mkdir(path.dirname(invalidEntry), { recursive: true });
  await writeFile(invalidEntry, "invalid", "utf8");

  await assert.rejects(
    setup.sandbox.run(request({ workspacePath: setup.workspacePath })),
    (error) => error instanceof DockerSandboxError &&
      error.code === "INVALID_SANDBOX_REQUEST",
  );
  await rm(invalidEntry);

  const output = await setup.sandbox.run(
    request({ workspacePath: setup.workspacePath }),
  );
  assert.equal(output.exitCode, 0);
  assert.equal(setup.processRunner.calls.length, 3);
});

test("concurrent first runs share one script asset materialization", async (t) => {
  const source = 'console.log("approved");';
  const dockerResult = result({ stdout: `sha256:${"b".repeat(64)}` });
  const setup = await fixture(
    t,
    Array.from({ length: 6 }, () => dockerResult),
    {
      profile: {
        kind: "node-script",
        image,
        timeoutMs: 30_000,
        asset: {
          schemaVersion: 1,
          title: "Reusable concurrent test",
          description: "Shares first-use materialization across code jobs.",
          version: 1,
          source,
        },
      },
    },
  );

  const [first, second] = await Promise.all([
    setup.sandbox.run(request({ workspacePath: setup.workspacePath })),
    setup.sandbox.run({
      ...request({ workspacePath: setup.workspacePath }),
      executionId: "run-two",
      actionId: "action-two",
    }),
  ]);

  assert.equal(first.exitCode, 0);
  assert.equal(second.exitCode, 0);
  const sourcePath = path.join(
    setup.root,
    ".test-library",
    setup.sandbox.getProfileFingerprint("node-tests"),
    "test.mjs",
  );
  assert.equal(await readFile(sourcePath, "utf8"), source);
  assert.equal(setup.processRunner.calls.length, 6);
});

test("profile fingerprints use the sandbox's immutable validated configuration", async (t) => {
  const configuredProfile = {
    kind: "node-test",
    image,
    timeoutMs: 30_000,
  };
  const originalFingerprint = digestValue(configuredProfile);
  const setup = await fixture(t, [], { profile: configuredProfile });

  assert.equal(
    setup.sandbox.getProfileFingerprint("node-tests"),
    originalFingerprint,
  );
  configuredProfile.timeoutMs = 60_000;
  assert.equal(
    setup.sandbox.getProfileFingerprint("node-tests"),
    originalFingerprint,
  );
  assert.equal("profiles" in setup.sandbox, false);

  const changed = await fixture(t, [], {
    profile: { ...configuredProfile },
  });
  assert.notEqual(
    changed.sandbox.getProfileFingerprint("node-tests"),
    originalFingerprint,
  );
  assert.throws(
    () => setup.sandbox.getProfileFingerprint("missing"),
    (error) => error.code === "SANDBOX_PROFILE_NOT_FOUND",
  );
});

test("host paths and Docker endpoints are redacted from completed results", async (t) => {
  const setup = await fixture(t, ({ root, workspacePath }) => [
    result({ stdout: "29.2.1" }),
    result({ stdout: `sha256:${"e".repeat(64)}` }),
    result({
      stdout: `source=${workspacePath}\ncontainer=/workspace/test/app.test.js`,
      stderr: `root=${root.replaceAll("\\", "/")} command=${dockerExecutable}`,
    }),
  ]);

  const output = await setup.sandbox.run(
    request({ workspacePath: setup.workspacePath }),
  );
  assert.match(output.stdout, /container=\/workspace\/test\/app\.test\.js/);
  assertHostValuesRedacted(
    `${output.stdout}\n${output.stderr}`,
    hostValueVariants(setup),
  );
});

test("host paths and Docker endpoints are redacted from process failures", async (t) => {
  const setup = await fixture(t, ({ root, workspacePath }) => [
    result({ stdout: "29.2.1" }),
    result({ stdout: `sha256:${"f".repeat(64)}` }),
    new ManagedProcessError("PROCESS_TIMEOUT", "stopped", {
      details: {
        exitCode: 137,
        signal: "SIGKILL",
        stdout: `workspace=${workspacePath.replaceAll("\\", "\\\\")}`,
        stderr: [
          `mount=${workspacePath.replaceAll("\\", "/")}`,
          `root=${root}`,
          `command=${dockerExecutable.replaceAll("\\", "/")}`,
          `endpoint=${dockerHost}`,
          "container=/workspace/test/app.test.js",
        ].join("\n"),
        durationMs: 12,
        truncated: false,
      },
    }),
    result(),
  ]);

  let interruption;
  await assert.rejects(
    setup.sandbox.run(
      request({ workspacePath: setup.workspacePath }),
    ),
    (error) => {
      interruption = error;
      return error.code === "SANDBOX_TIMEOUT";
    },
  );
  assertHostValuesRedacted(
    JSON.stringify(interruption.details),
    hostValueVariants(setup),
  );
  assert.equal(interruption.cause, undefined);
  assert.match(interruption.details.stderr, /container=\/workspace\/test\/app\.test\.js/);
});

test("host paths and Docker endpoints are redacted from probe failures", async (t) => {
  await assertProbeFailureRedaction(
    t,
    "SANDBOX_UNAVAILABLE",
    (paths) => [probeProcessFailure(paths)],
  );
  await assertProbeFailureRedaction(
    t,
    "SANDBOX_IMAGE_UNAVAILABLE",
    (paths) => [
      result({ stdout: "29.2.1" }),
      probeProcessFailure(paths),
    ],
  );
});

test("unknown profiles and caller fields are rejected before spawn", async (t) => {
  const setup = await fixture(t, []);
  await assert.rejects(
    setup.sandbox.run({
      ...request({
        workspacePath: setup.workspacePath,
      }),
      profileId: "missing",
    }),
    (error) => error.code === "SANDBOX_PROFILE_NOT_FOUND",
  );
  await assert.rejects(
    setup.sandbox.run({
      ...request({
        workspacePath: setup.workspacePath,
      }),
      command: "powershell.exe",
    }),
    (error) => error.code === "INVALID_SANDBOX_REQUEST",
  );
  const inherited = Object.create(
    request({ workspacePath: setup.workspacePath }),
  );
  await assert.rejects(
    setup.sandbox.run(inherited),
    (error) => error.code === "INVALID_SANDBOX_REQUEST",
  );
  await assert.rejects(
    setup.sandbox.run(
      request({ workspacePath: setup.workspacePath, signal: { aborted: false } }),
    ),
    (error) => error.code === "INVALID_SANDBOX_REQUEST",
  );
  await assert.rejects(
    setup.sandbox.run(request({ workspacePath: tmpdir() })),
    (error) => error.code === "INVALID_SANDBOX_REQUEST",
  );
  await assert.rejects(
    setup.sandbox.run(request({ workspacePath: null })),
    (error) => error.code === "INVALID_SANDBOX_REQUEST",
  );
  await assert.rejects(
    setup.sandbox.cleanup(null),
    (error) => error.code === "INVALID_SANDBOX_REQUEST",
  );
  await assert.rejects(
    setup.sandbox.cleanup({
      executionId: "run-one",
      actionId: "action-one",
      command: "whoami",
    }),
    (error) => error.code === "INVALID_SANDBOX_REQUEST",
  );
  assert.equal(setup.processRunner.calls.length, 0);
});

test("an aborted request remains aborted during Docker probes", async (t) => {
  const setup = await fixture(t, [
    new ManagedProcessError("PROCESS_ABORTED", "stopped"),
  ]);
  const controller = new AbortController();
  controller.abort();

  await assert.rejects(
    setup.sandbox.run(
      request({
        workspacePath: setup.workspacePath,
        signal: controller.signal,
      }),
    ),
    (error) => error.code === "SANDBOX_ABORTED",
  );
  assert.equal(setup.processRunner.calls[0].signal, controller.signal);
});

test("Docker daemon and image failures close the sandbox instead of falling back", async (t) => {
  const daemon = await fixture(t, [result({ exitCode: 1, stderr: "offline" })]);
  await assert.rejects(
    daemon.sandbox.run(
      request({
        workspacePath: daemon.workspacePath,
      }),
    ),
    (error) => error.code === "SANDBOX_UNAVAILABLE",
  );
  assert.equal(daemon.processRunner.calls.length, 1);

  const missingImage = await fixture(t, [
    result({ stdout: "29.2.1" }),
    result({ exitCode: 1, stderr: "missing" }),
  ]);
  await assert.rejects(
    missingImage.sandbox.run(
      request({
        workspacePath: missingImage.workspacePath,
      }),
    ),
    (error) => error.code === "SANDBOX_IMAGE_UNAVAILABLE",
  );
  assert.equal(missingImage.processRunner.calls.length, 2);
});

test("test failures remain results while interrupted runs clean residual containers", async (t) => {
  const failedTest = await fixture(t, [
    result({ stdout: "29.2.1" }),
    result({ stdout: `sha256:${"b".repeat(64)}` }),
    result({ exitCode: 1, stderr: "assertion failed" }),
  ]);
  const failed = await failedTest.sandbox.run(
    request({
      workspacePath: failedTest.workspacePath,
    }),
  );
  assert.equal(failed.exitCode, 1);
  assert.equal(failed.stderr, "assertion failed");

  for (const processCode of [
    "PROCESS_TIMEOUT",
    "PROCESS_OUTPUT_LIMIT",
    "PROCESS_ABORTED",
  ]) {
    const interrupted = await fixture(t, [
      result({ stdout: "29.2.1" }),
      result({ stdout: `sha256:${"c".repeat(64)}` }),
      new ManagedProcessError(processCode, "stopped", {
        details: {
          exitCode: 137,
          signal: "SIGKILL",
          stdout: "before stop",
          stderr: "",
          durationMs: 12,
          truncated: processCode === "PROCESS_OUTPUT_LIMIT",
        },
      }),
      result(),
    ]);
    let interruption;
    await assert.rejects(
      interrupted.sandbox.run(
        request({
          workspacePath: interrupted.workspacePath,
        }),
      ),
      (error) => {
        interruption = error;
        return error instanceof DockerSandboxError &&
          error.code ===
          {
            PROCESS_TIMEOUT: "SANDBOX_TIMEOUT",
            PROCESS_OUTPUT_LIMIT: "SANDBOX_OUTPUT_LIMIT",
            PROCESS_ABORTED: "SANDBOX_ABORTED",
          }[processCode];
      },
    );
    assert.equal(interruption.details.stdout, "before stop");
    assert.equal(interruption.details.exitCode, 137);
    assert.equal(interrupted.processRunner.calls.length, 4);
    assert.deepEqual(
      interrupted.processRunner.calls[3].args.slice(-3, -1),
      ["rm", "-f"],
    );
  }
});

test("cleanup proves absence and reports containers that remain", async (t) => {
  const name = expectedContainerName();
  const pending = await fixture(t, [
    result({ stdout: "29.2.1" }),
    result({ stdout: `sha256:${"d".repeat(64)}` }),
    new ManagedProcessError("PROCESS_TIMEOUT", "stopped"),
    result({ exitCode: 1, stderr: "remove failed" }),
    result({ stdout: name }),
  ]);
  let pendingError;
  await assert.rejects(
    pending.sandbox.run(
      request({ workspacePath: pending.workspacePath }),
    ),
    (error) => {
      pendingError = error;
      return error.code === "SANDBOX_TIMEOUT";
    },
  );
  assert.equal(pendingError.details.cleanupPending, true);
  assert.equal(pendingError.details.containerName, name);

  const explicit = await fixture(t, [
    result({ exitCode: 1, stderr: "remove failed" }),
    result({ stdout: name }),
  ]);
  await assert.rejects(
    explicit.sandbox.cleanup({
      executionId: "run-one",
      actionId: "action-one",
    }),
    (error) =>
      error.code === "SANDBOX_CLEANUP_FAILED" &&
      error.details?.cleanupPending === true,
  );

  const absent = await fixture(t, [
    result({ exitCode: 1, stderr: "No such container" }),
    result({ stdout: "" }),
  ]);
  await absent.sandbox.cleanup({
    executionId: "run-one",
    actionId: "action-one",
  });
});

test('profile readiness probes the configured Docker server and exact image without running a container', async t => {
  const f = await fixture(t, [result({ stdout: '29.2.1' }), result({ stdout: `sha256:${'a'.repeat(64)}` })]);
  assert.deepEqual(await f.sandbox.readProfileReadiness({ profileId: 'node-tests' }), {
    schemaVersion: 1, profileId: 'node-tests', profileConfigDigest: f.sandbox.getProfileFingerprint('node-tests'),
    imageId: `sha256:${'a'.repeat(64)}`,
  });
  assert.deepEqual(f.processRunner.calls.map(call => call.args.slice(2)), [
    ['version', '--format', '{{.Server.Version}}'], ['image', 'inspect', '--format', '{{.Id}}', image],
  ]);
  assert.equal(f.processRunner.calls.some(call => call.args.includes('run')), false);
});

for (const [name, responses, code] of [
  ['daemon unavailable', [result({ exitCode: 1 })], 'SANDBOX_UNAVAILABLE'],
  ['image unavailable', [result({ stdout: '29.2.1' }), result({ exitCode: 1 })], 'SANDBOX_IMAGE_UNAVAILABLE'],
]) test(`profile readiness preserves ${name}`, async t => {
  const f = await fixture(t, responses);
  await assert.rejects(f.sandbox.readProfileReadiness({ profileId: 'node-tests' }), { code });
  assert.equal(f.processRunner.calls.some(call => call.args.includes('run')), false);
});
