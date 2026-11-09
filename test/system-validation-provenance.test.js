import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import test from "node:test";

const execFileAsync = promisify(execFile);
const projectRoot = path.resolve(import.meta.dirname, "..");

async function git(root, ...arguments_) {
  const { stdout } = await execFileAsync("git", arguments_, {
    cwd: root,
    encoding: "utf8",
    windowsHide: true,
  });
  return stdout.trim();
}

async function projectFixtureText(relativePath) {
  return (await readFile(path.join(projectRoot, relativePath), "utf8"))
    .replaceAll("\r\n", "\n")
    .replaceAll("\r", "\n");
}

async function createRepository(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), "mydashboard-validation-"));
  t.after(() => rm(root, { force: true, recursive: true }));
  await git(root, "init", "--quiet");
  await git(root, "config", "user.email", "validation@example.invalid");
  await git(root, "config", "user.name", "Validation Fixture");
  await writeFile(path.join(root, "tracked.txt"), "accepted\n");
  await git(root, "add", "tracked.txt");
  await git(root, "commit", "--quiet", "-m", "fixture");
  return root;
}

async function createValidationFixture(t) {
  const root = await createRepository(t);
  for (const directory of [
    "public",
    "scripts",
    "src",
    "src/adapters",
    "src/domain",
    "src/lib",
    "test/browser",
    "test-support",
  ]) {
    await mkdir(path.join(root, directory), { recursive: true });
  }
  for (const relativePath of [
    "scripts/system-live-validation.mjs",
    "scripts/system-node-test-contract.mjs",
    "scripts/system-ui-artifact-receipt.mjs",
    "scripts/system-validation-command.mjs",
    "scripts/system-validation-environment.mjs",
    "scripts/system-validation-materialization.mjs",
    "scripts/system-validation-provenance.mjs",
    "scripts/validate-system.mjs",
    "src/adapters/git-object-snapshotter.js",
    "src/domain/code-execution-policy.js",
    "src/lib/git-blob-batch.js",
    "src/lib/line-buffer.js",
    "src/lib/managed-process.js",
    "src/lib/preparation-cancellation.js",
    "src/lib/repository-source-state.js",
    "src/lib/runtime-source-identity.js",
    "src/lib/windows-git-implementation.js",
  ]) {
    await writeFile(
      path.join(root, relativePath),
      await projectFixtureText(relativePath),
    );
  }
  await writeFile(
    path.join(root, "scripts/system-live-validation.mjs"),
    [
      "import { computeVersionedRuntimeSourceIdentity } from '../src/lib/runtime-source-identity.js';",
      "let verificationCount = 0;",
      "function same(left, right) { return JSON.stringify(left) === JSON.stringify(right); }",
      "export async function verifyLiveDashboard({ expectedRuntimeSource, expectedLiveService = null }) {",
      "  verificationCount += 1;",
      "  const runtimeSource = await computeVersionedRuntimeSourceIdentity(process.cwd());",
      "  if (!same(runtimeSource, expectedRuntimeSource)) throw new Error('fixture runtime source mismatch');",
      "  const service = {",
      "    processId: 2468,",
      "    instanceId: '12345678-1234-4123-8123-123456789abc',",
      "    startIdentity: 'd'.repeat(64),",
      "    runtimeSource,",
      "  };",
      "  if (expectedLiveService !== null && !same(service, expectedLiveService)) {",
      "    throw new Error('fixture live service mismatch');",
      "  }",
      "  if (process.env.MYDASHBOARD_TEST_REPLACE_LIVE === '1' && expectedLiveService !== null && verificationCount > 1) {",
      "    throw new Error('live dashboard process identity changed during UI validation');",
      "  }",
      "  return service;",
      "}",
      "",
    ].join("\n"),
  );
  await writeFile(path.join(root, ".gitignore"), "validation-artifacts/\n");
  await writeFile(path.join(root, "src/app.js"), "export const ready = true;\n");
  await writeFile(
    path.join(root, "scripts/validate-ui.mjs"),
    await projectFixtureText("test-support/system-ui-validation-fixture.mjs"),
  );
  await writeFile(
    path.join(root, "test/u9-mirrored-pr-end-to-end.mjs"),
    [
      "import test from 'node:test';",
      "test('fixture U9 mirrored PR validation', () => {});",
      "",
    ].join("\n"),
  );
  await writeFile(
    path.join(root, "test/00-u9-priority.mjs"),
    "import \"./u9-mirrored-pr-end-to-end.mjs\";\n",
  );
  await writeFile(
    path.join(root, "test/smoke.test.js"),
    [
      "import assert from 'node:assert/strict';",
      "import { existsSync } from 'node:fs';",
      "import test from 'node:test';",
      "test('fixture passes', () => {});",
      "test('fixture skip', { skip: 'fixture reason' }, () => {});",
      "test('validation reporter options stay outside tested processes', () => {",
      "  assert.equal(process.env.NODE_OPTIONS, undefined);",
      "  assert.equal(process.env.NODE_PATH, undefined);",
      "});",
      "test('validation children inherit no host credentials or profiles', () => {",
      "  for (const name of ['OPENAI_API_KEY', 'ANTHROPIC_API_KEY', 'GH_TOKEN', 'GITHUB_TOKEN', 'NPM_TOKEN', 'MYDASHBOARD_TEST_SECRET']) {",
      "    assert.equal(process.env[name], undefined, name);",
      "  }",
      "  assert.equal(process.env.APPDATA, process.platform === 'win32' ? 'NUL' : '/dev/null');",
      "  if (process.platform === 'win32') {",
      "    assert.equal(process.env.HOME, 'C:\\\\NUL');",
      "    assert.equal(process.env.USERPROFILE, 'C:\\\\NUL');",
      "  } else {",
      "    assert.equal(process.env.HOME, process.env.USERPROFILE);",
      "  }",
      "  assert.equal(process.env.GIT_CONFIG_NOSYSTEM, '1');",
      "  assert.equal(process.env.GIT_TERMINAL_PROMPT, '0');",
      "});",
      "test('validation commands execute from a detached materialized source', () => {",
      `  assert.notEqual(process.cwd().toLowerCase(), ${JSON.stringify(root.toLowerCase())});`,
      "});",
      "",
    ].join("\n"),
  );
  await writeFile(
    path.join(root, "test/smoke-module.test.mjs"),
    [
      "import test from 'node:test';",
      "test('fixture module passes', () => {});",
      "",
    ].join("\n"),
  );
  await writeFile(
    path.join(root, "test/open-source-distribution.mjs"),
    [
      "import assert from 'node:assert/strict';",
      "import { existsSync } from 'node:fs';",
      "import test from 'node:test';",
      "test('distribution validation retains its clean Git source context', () => {",
      "  assert.equal(existsSync('.git'), true);",
      "  assert.equal(process.env.GH_TOKEN, undefined);",
      "  assert.equal(process.env.OPENAI_API_KEY, undefined);",
      "  assert.equal(process.env.APPDATA, process.platform === 'win32' ? 'NUL' : '/dev/null');",
      "  if (process.platform === 'win32') {",
      "    assert.equal(process.env.HOME, 'C:\\\\NUL');",
      "    assert.equal(process.env.USERPROFILE, 'C:\\\\NUL');",
      "  } else {",
      "    assert.equal(process.env.HOME, process.env.USERPROFILE);",
      "  }",
      "});",
      "",
    ].join("\n"),
  );
  for (const fixture of [
    "configuration-form-playwright.mjs",
    "confirmation-history-playwright.mjs",
  ]) {
    await writeFile(
      path.join(root, "test/browser", fixture),
      [
        "import assert from 'node:assert/strict';",
        "assert.equal(process.env.APPDATA, process.platform === 'win32' ? 'NUL' : '/dev/null');",
        "if (process.platform === 'win32') {",
        "  assert.equal(process.env.HOME, 'C:\\\\NUL');",
        "  assert.equal(process.env.USERPROFILE, 'C:\\\\NUL');",
        "} else {",
        "  assert.equal(process.env.HOME, process.env.USERPROFILE);",
        "}",
        "",
      ].join("\n"),
    );
  }
  await writeFile(path.join(root, "package.json"), `${JSON.stringify({
    name: "validation-fixture",
    private: true,
    type: "module",
    files: ["scripts/", "src/"],
    scripts: { test: "node --test test/smoke.test.js" },
  }, null, 2)}\n`);
  await writeFile(path.join(root, "package-lock.json"), `${JSON.stringify({
    name: "validation-fixture",
    lockfileVersion: 3,
    requires: true,
    packages: {
      "": { name: "validation-fixture" },
    },
  }, null, 2)}\n`);
  await git(root, "add", ".");
  await git(root, "commit", "--quiet", "-m", "validation fixture");
  return root;
}

function validationEnvironment() {
  const environment = {
    ...process.env,
  };
  delete environment.NODE_TEST_CONTEXT;
  return environment;
}

async function readOnlyValidationReport(root) {
  const runs = await readdir(path.join(root, "validation-artifacts/runs"), {
    withFileTypes: true,
  });
  const runDirectories = runs.filter((entry) => entry.isDirectory());
  assert.equal(runDirectories.length, 1);
  const relativePath =
    `validation-artifacts/runs/${runDirectories[0].name}/system-validation.json`;
  const report = JSON.parse(await readFile(path.join(root, relativePath), "utf8"));
  assert.equal(runDirectories[0].name, report.runId);
  return { relativePath, report };
}

async function loadProvenanceModule() {
  try {
    return await import("../scripts/system-validation-provenance.mjs");
  } catch (error) {
    assert.fail(`validation provenance module is unavailable: ${error.message}`);
  }
}

test("captures an exact, path-free source identity from a clean Git repository", async (t) => {
  const root = await createRepository(t);
  const expectedHeadOid = await git(root, "rev-parse", "--verify", "HEAD^{commit}");
  const expectedTreeOid = await git(root, "rev-parse", "--verify", "HEAD^{tree}");
  const { captureRepositoryState } = await loadProvenanceModule();

  const state = await captureRepositoryState(root);

  assert.deepEqual({
    ...state,
    headLogDigest: "<verified>",
  }, {
    schemaVersion: 1,
    headOid: expectedHeadOid,
    treeOid: expectedTreeOid,
    clean: true,
    changeCount: 0,
    statusDigest: createHash("sha256").update("").digest("hex"),
    headLogDigest: "<verified>",
  });
  assert.match(state.headLogDigest, /^[a-f0-9]{64}$/u);
  assert.equal(JSON.stringify(state).includes(root), false);
});

test("rejects a nested directory as the repository root", async (t) => {
  const root = await createRepository(t);
  const nestedRoot = path.join(root, "nested-package");
  await mkdir(nestedRoot);
  const { captureRepositoryState } = await loadProvenanceModule();

  await assert.rejects(
    captureRepositoryState(nestedRoot),
    /supplied root is not the Git repository root/u,
  );
});

test("reports dirty source without exposing changed paths", async (t) => {
  const root = await createRepository(t);
  await writeFile(path.join(root, "tracked.txt"), "changed\n");
  await writeFile(path.join(root, "untracked-secret-name.txt"), "fixture\n");
  const { captureRepositoryState } = await loadProvenanceModule();

  const state = await captureRepositoryState(root);

  assert.equal(state.clean, false);
  assert.equal(state.changeCount, 2);
  assert.match(state.statusDigest, /^[a-f0-9]{64}$/u);
  assert.equal(JSON.stringify(state).includes("untracked-secret-name.txt"), false);
  assert.equal(JSON.stringify(state).includes(root), false);
});

test("acceptance rejects dirty or changed source state", async () => {
  const { assertStableCleanRepository } = await loadProvenanceModule();
  const clean = {
    schemaVersion: 1,
    headOid: "1".repeat(40),
    treeOid: "2".repeat(40),
    clean: true,
    changeCount: 0,
    statusDigest: "3".repeat(64),
    headLogDigest: "6".repeat(64),
  };

  assert.doesNotThrow(() => assertStableCleanRepository(clean, clean));
  assert.throws(
    () => assertStableCleanRepository({ ...clean, clean: false, changeCount: 1 }, clean),
    /repository was not clean when validation started/u,
  );
  assert.throws(
    () => assertStableCleanRepository(clean, { ...clean, clean: false, changeCount: 1 }),
    /repository was not clean when validation finished/u,
  );
  assert.throws(
    () => assertStableCleanRepository(clean, { ...clean, headOid: "4".repeat(40) }),
    /repository HEAD changed during validation/u,
  );
  assert.throws(
    () => assertStableCleanRepository(clean, { ...clean, treeOid: "5".repeat(40) }),
    /repository tree changed during validation/u,
  );
});

test("acceptance detects an A-to-B-to-A HEAD transition through the reflog", async (t) => {
  const root = await createRepository(t);
  const { assertStableCleanRepository, captureRepositoryState } =
    await loadProvenanceModule();
  const started = await captureRepositoryState(root);
  await writeFile(path.join(root, "tracked.txt"), "second commit\n");
  await git(root, "add", "tracked.txt");
  await git(root, "commit", "--quiet", "-m", "second");
  await git(root, "reset", "--hard", "--quiet", started.headOid);
  const finished = await captureRepositoryState(root);

  assert.equal(finished.headOid, started.headOid);
  assert.equal(finished.treeOid, started.treeOid);
  assert.equal(finished.clean, true);
  assert.notEqual(finished.headLogDigest, started.headLogDigest);
  assert.throws(
    () => assertStableCleanRepository(started, finished),
    /repository history changed during validation/u,
  );
});

test("the system validator rejects inherited Node execution hooks", async (t) => {
  const root = await createValidationFixture(t);

  await assert.rejects(
    execFileAsync(process.execPath, ["scripts/validate-system.mjs"], {
      cwd: root,
      encoding: "utf8",
      env: {
        ...validationEnvironment(),
        NODE_PATH: root,
      },
      windowsHide: true,
    }),
  );

  const { report } = await readOnlyValidationReport(root);
  assert.equal(report.status, "failed");
  assert.deepEqual(report.environment.inheritedForbiddenVariables, ["NODE_PATH"]);
  assert.match(report.error, /forbidden Node execution environment: NODE_PATH/u);
  assert.deepEqual(report.steps, []);
});

test("the system validator binds a passing report to one clean Git source state", async (t) => {
  const root = await createValidationFixture(t);
  const expectedHeadOid = await git(root, "rev-parse", "--verify", "HEAD^{commit}");
  const expectedTreeOid = await git(root, "rev-parse", "--verify", "HEAD^{tree}");
  const objectFormat = await git(root, "rev-parse", "--show-object-format");
  const emptyTreeOid = createHash(objectFormat)
    .update(Buffer.from("tree 0\0", "utf8"))
    .digest("hex");

  await execFileAsync(process.execPath, ["scripts/validate-system.mjs"], {
    cwd: root,
    encoding: "utf8",
    env: {
      ...validationEnvironment(),
      OPENAI_API_KEY: "must-not-enter-validation",
      ANTHROPIC_API_KEY: "must-not-enter-validation",
      GH_TOKEN: "must-not-enter-validation",
      GITHUB_TOKEN: "must-not-enter-validation",
      NPM_TOKEN: "must-not-enter-validation",
      MYDASHBOARD_TEST_SECRET: "must-not-enter-validation",
    },
    windowsHide: true,
  });

  const { relativePath: reportPath, report } = await readOnlyValidationReport(root);
  assert.equal(
    reportPath,
    `validation-artifacts/runs/${report.runId}/system-validation.json`,
  );
  assert.equal(report.status, "passed");
  assert.match(
    report.runId,
    /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u,
  );
  assert.deepEqual(report.source.started, report.source.finished);
  assert.equal(report.source.stable, true);
  assert.equal(report.source.started.headOid, expectedHeadOid);
  assert.equal(report.source.started.treeOid, expectedTreeOid);
  assert.equal(report.source.started.clean, true);
  assert.equal(report.environment.schemaVersion, 2);
  assert.equal(
    report.environment.policy,
    "isolated-profile-allowlist-v2",
  );
  assert.deepEqual(
    report.environment.forbiddenVariables,
    ["NODE_OPTIONS", "NODE_PATH", "NODE_V8_COVERAGE"],
  );
  assert.deepEqual(report.environment.inheritedForbiddenVariables, []);
  assert.equal(report.environment.credentialVariablesInherited, false);
  assert.equal(report.environment.dependencyInstallationNetwork, "offline");
  assert.deepEqual(report.environment.isolatedVariables, [
    "APPDATA",
    "HOME",
    "LOCALAPPDATA",
    "TEMP",
    "TMP",
    "USERPROFILE",
    "XDG_CACHE_HOME",
    "XDG_CONFIG_HOME",
    "XDG_DATA_HOME",
    "XDG_STATE_HOME",
  ]);
  assert.deepEqual(report.environment.controlledVariables, [
    "GCM_INTERACTIVE",
    "GH_PROMPT_DISABLED",
    "GIT_CONFIG_GLOBAL",
    "GIT_CONFIG_NOSYSTEM",
    "GIT_TERMINAL_PROMPT",
    "NO_COLOR",
    "PLAYWRIGHT_BROWSERS_PATH",
  ]);
  assert.equal(
    report.environment.inheritedVariables.some((name) =>
      /token|key|secret|credential|profile|home|appdata|proxy/iu.test(name)
    ),
    false,
  );
  assert.deepEqual(
    report.steps.find(({ name }) => name === "git diff --check").command,
    {
      executable: "git",
      arguments: ["diff", "--check", emptyTreeOid, expectedHeadOid, "--"],
    },
  );
  assert.deepEqual(
    report.steps.find(({ name }) => name === "syntax:src/app.js").command,
    { executable: "node", arguments: ["--check", "src/app.js"] },
  );
  assert.deepEqual(
    report.steps.find(({ name }) => name === "complete Node test suite").command,
    {
      executable: "node",
      arguments: [
        "--test",
        "--test-concurrency=4",
        "--test-reporter=tap",
        "test/00-u9-priority.mjs",
        "test/smoke-module.test.mjs",
        "test/smoke.test.js",
      ],
    },
  );
  assert.deepEqual(
    report.steps.find(
      ({ name }) => name === "open-source distribution suite",
    ).command,
    {
      executable: "node",
      arguments: [
        "--test",
        "--test-concurrency=1",
        "--test-reporter=tap",
        "test/open-source-distribution.mjs",
      ],
    },
  );
  for (const name of [
    "complete Node test suite",
    "open-source distribution suite",
    "configuration form browser behavior",
    "confirmation history browser behavior",
  ]) {
    assert.deepEqual(
      report.steps.find((step) => step.name === name).environment,
      process.platform === "win32"
        ? {
            APPDATA: "null-device",
            HOME: "null-device",
            USERPROFILE: "null-device",
          }
        : { APPDATA: "null-device" },
    );
  }
  assert.deepEqual(
    report.steps.find(({ name }) => name === "complete Node test suite").testResults,
    {
      summary: {
        tests: 7,
        passed: 6,
        failed: 0,
        cancelled: 0,
        skipped: 1,
        todo: 0,
      },
      cases: [
        {
          identity: "tap:1:fixture U9 mirrored PR validation",
          name: "fixture U9 mirrored PR validation",
          status: "passed",
        },
        {
          identity: "tap:2:fixture module passes",
          name: "fixture module passes",
          status: "passed",
        },
        {
          identity: "tap:3:fixture passes",
          name: "fixture passes",
          status: "passed",
        },
        {
          identity: "tap:4:fixture skip",
          name: "fixture skip",
          status: "skipped",
          reason: "fixture reason",
        },
        {
          identity: "tap:5:validation reporter options stay outside tested processes",
          name: "validation reporter options stay outside tested processes",
          status: "passed",
        },
        {
          identity: "tap:6:validation children inherit no host credentials or profiles",
          name: "validation children inherit no host credentials or profiles",
          status: "passed",
        },
        {
          identity: "tap:7:validation commands execute from a detached materialized source",
          name: "validation commands execute from a detached materialized source",
          status: "passed",
        },
      ],
    },
  );
  const distributionStep = report.steps.find(
    ({ name }) => name === "open-source distribution suite",
  );
  assert.deepEqual(distributionStep.testResults, {
    summary: {
      tests: 1,
      passed: 1,
      failed: 0,
      cancelled: 0,
      skipped: 0,
      todo: 0,
    },
    cases: [{
      identity: "tap:1:distribution validation retains its clean Git source context",
      name: "distribution validation retains its clean Git source context",
      status: "passed",
    }],
  });
  assert.deepEqual(distributionStep.repositorySource, {
    headOid: expectedHeadOid,
    treeOid: expectedTreeOid,
  });
  assert.deepEqual(Object.keys(report.executionSource).sort(), [
    "contentDigest",
    "dependencyInstallation",
    "dependencyLockDigest",
    "fileCount",
    "headOid",
    "schemaVersion",
    "sealed",
    "totalBytes",
    "treeOid",
  ]);
  assert.equal(report.executionSource.headOid, expectedHeadOid);
  assert.equal(report.executionSource.treeOid, expectedTreeOid);
  assert.equal(report.executionSource.sealed, true);
  assert.equal(
    report.steps
      .filter(({ name }) =>
        name !== "git diff --check" &&
        name !== "open-source distribution suite"
      )
      .every(({ executionSourceDigest }) =>
        executionSourceDigest === report.executionSource.contentDigest
      ),
    true,
  );
  assert.equal(distributionStep.executionSourceDigest, undefined);
  assert.equal(
    report.steps.every(({ command, exitCode, signal }) =>
      command === undefined || (exitCode === 0 && signal === null)
    ),
    true,
  );
  assert.equal(JSON.stringify(report).includes(root), false);
});

for (const discoveryFailure of [
  {
    name: "the priority entry is missing",
    prepare: (root) => rm(path.join(root, "test/00-u9-priority.mjs")),
    expectedError: /committed U9 priority test is unavailable/u,
  },
  {
    name: "the mirrored U9 implementation is missing",
    prepare: (root) =>
      rm(path.join(root, "test/u9-mirrored-pr-end-to-end.mjs")),
    expectedError: /committed U9 implementation test is unavailable/u,
  },
  {
    name: "the distribution test is missing",
    prepare: (root) =>
      rm(path.join(root, "test/open-source-distribution.mjs")),
    expectedError: /committed distribution test is unavailable/u,
  },
  {
    name: "the legacy direct U9 path is present",
    prepare: (root) =>
      writeFile(
        path.join(root, "test/u9-mirrored-pr-end-to-end.test.js"),
        "import './u9-mirrored-pr-end-to-end.mjs';\n",
      ),
    expectedError: /legacy direct U9 test path is ambiguous/u,
  },
  {
    name: "the priority entry is empty",
    prepare: (root) =>
      writeFile(path.join(root, "test/00-u9-priority.mjs"), ""),
    expectedError: /committed U9 priority test contents are invalid/u,
  },
  {
    name: "the priority entry imports the wrong implementation",
    prepare: async (root) => {
      await writeFile(
        path.join(root, "test/not-u9.mjs"),
        "export const unrelated = true;\n",
      );
      await writeFile(
        path.join(root, "test/00-u9-priority.mjs"),
        "import \"./not-u9.mjs\";\n",
      );
    },
    expectedError: /committed U9 priority test contents are invalid/u,
  },
]) {
  test(`the system validator fails closed before test execution when ${discoveryFailure.name}`, async (t) => {
    const root = await createValidationFixture(t);
    await discoveryFailure.prepare(root);
    await git(root, "add", "--all");
    await git(root, "commit", "--quiet", "-m", "invalid test discovery fixture");

    await assert.rejects(
      execFileAsync(process.execPath, ["scripts/validate-system.mjs"], {
        cwd: root,
        encoding: "utf8",
        env: validationEnvironment(),
        windowsHide: true,
      }),
    );

    const { report } = await readOnlyValidationReport(root);
    assert.equal(report.status, "failed");
    assert.match(report.error, discoveryFailure.expectedError);
    assert.equal(
      report.steps.some(({ name }) => name === "complete Node test suite"),
      false,
    );
  });
}

test("the system validator rejects whitespace defects in committed source", async (t) => {
  const root = await createValidationFixture(t);
  await writeFile(
    path.join(root, "src/committed-whitespace.js"),
    "export const committed = true;   \n",
  );
  await git(root, "add", "src/committed-whitespace.js");
  await git(root, "commit", "--quiet", "-m", "committed whitespace defect");

  await assert.rejects(
    execFileAsync(process.execPath, ["scripts/validate-system.mjs"], {
      cwd: root,
      encoding: "utf8",
      env: validationEnvironment(),
      windowsHide: true,
    }),
  );

  const { report } = await readOnlyValidationReport(root);
  assert.equal(report.status, "failed");
  assert.match(report.error, /git diff --check failed/u);
});

test("the system validator records structured failed test identities", async (t) => {
  const root = await createValidationFixture(t);
  await writeFile(
    path.join(root, "test/smoke.test.js"),
    [
      "import assert from 'node:assert/strict';",
      "import test from 'node:test';",
      "test('fixture failure identity', () => assert.equal(true, false));",
      "",
    ].join("\n"),
  );
  await git(root, "add", "test/smoke.test.js");
  await git(root, "commit", "--quiet", "-m", "failing fixture test");

  await assert.rejects(
    execFileAsync(process.execPath, ["scripts/validate-system.mjs"], {
      cwd: root,
      encoding: "utf8",
      env: validationEnvironment(),
      windowsHide: true,
    }),
  );

  const { report } = await readOnlyValidationReport(root);
  const testStep = report.steps.find(
    ({ name }) => name === "complete Node test suite",
  );
  assert.equal(report.status, "failed");
  assert.equal(testStep.status, "failed");
  assert.equal(testStep.testResults.summary.failed, 1);
  assert.deepEqual(
    testStep.testResults.cases.filter(({ status }) => status === "failed"),
    [{
      identity: "tap:3:fixture failure identity",
      name: "fixture failure identity",
      status: "failed",
    }],
  );
});

test("live UI validation records the exact managed runtime source identity", async (t) => {
  const root = await createValidationFixture(t);
  const expectedHeadOid = await git(root, "rev-parse", "--verify", "HEAD^{commit}");
  const expectedTreeOid = await git(root, "rev-parse", "--verify", "HEAD^{tree}");

  await execFileAsync(
    process.execPath,
    ["scripts/validate-system.mjs", "--with-live-ui"],
    {
      cwd: root,
      encoding: "utf8",
      env: validationEnvironment(),
      windowsHide: true,
    },
  );

  const { report } = await readOnlyValidationReport(root);
  assert.deepEqual(Object.keys(report.liveService).sort(), [
    "instanceId",
    "processId",
    "runtimeSource",
    "startIdentity",
  ]);
  assert.equal(report.liveService.processId, 2468);
  assert.equal(
    report.liveService.instanceId,
    "12345678-1234-4123-8123-123456789abc",
  );
  assert.equal(report.liveService.startIdentity, "d".repeat(64));
  assert.deepEqual(Object.keys(report.liveService.runtimeSource).sort(), [
    "clean",
    "headOid",
    "runtimeByteCount",
    "runtimeDigest",
    "runtimeFileCount",
    "schemaVersion",
    "treeOid",
  ]);
  assert.equal(report.liveService.runtimeSource.schemaVersion, 1);
  assert.equal(report.liveService.runtimeSource.headOid, expectedHeadOid);
  assert.equal(report.liveService.runtimeSource.treeOid, expectedTreeOid);
  assert.equal(report.liveService.runtimeSource.clean, true);
  assert.match(report.liveService.runtimeSource.runtimeDigest, /^[a-f0-9]{64}$/u);
  assert.equal(report.liveService.runtimeSource.runtimeFileCount > 0, true);
  assert.equal(report.liveService.runtimeSource.runtimeByteCount > 0, true);
  assert.equal(report.source.started.headOid, expectedHeadOid);
  assert.equal(report.source.started.treeOid, expectedTreeOid);
  assert.equal(report.uiArtifactReceipt.envelope.runId, report.runId);
  assert.equal(
    report.uiArtifactReceipt.envelope.path,
    `validation-artifacts/runs/${report.runId}/ui-receipt.json`,
  );
  assert.deepEqual(
    report.uiArtifactReceipt.receipt.liveService,
    report.liveService,
  );
  assert.deepEqual(
    report.uiArtifactReceipt.receipt.artifacts.map(({ path: artifactPath }) =>
      artifactPath
    ),
    [
      `validation-artifacts/runs/${report.runId}/ui/results.json`,
      `validation-artifacts/runs/${report.runId}/ui/desktop-1440.png`,
      `validation-artifacts/runs/${report.runId}/ui/mobile-390.png`,
    ],
  );
  assert.deepEqual(
    report.steps.find(
      ({ name }) => name === "live desktop and mobile UI behavior",
    ).command,
    {
      executable: "node",
      arguments: [
        "scripts/validate-ui.mjs",
        "--run-id",
        report.runId,
        "--process-id",
        String(report.liveService.processId),
        "--instance-id",
        report.liveService.instanceId,
        "--start-identity",
        report.liveService.startIdentity,
        "--head-oid",
        report.liveService.runtimeSource.headOid,
        "--tree-oid",
        report.liveService.runtimeSource.treeOid,
        "--runtime-digest",
        report.liveService.runtimeSource.runtimeDigest,
        "--runtime-file-count",
        String(report.liveService.runtimeSource.runtimeFileCount),
        "--runtime-byte-count",
        String(report.liveService.runtimeSource.runtimeByteCount),
      ],
    },
  );
});

test("live UI validation rejects service replacement during browser scenarios", async (t) => {
  const root = await createValidationFixture(t);
  const liveValidationPath = path.join(
    root,
    "scripts/system-live-validation.mjs",
  );
  const liveValidation = await readFile(liveValidationPath, "utf8");
  const replacementSimulation = liveValidation.replace(
    "if (process.env.MYDASHBOARD_TEST_REPLACE_LIVE === '1' && expectedLiveService !== null && verificationCount > 1) {",
    "if (expectedLiveService !== null && verificationCount > 1) {",
  );
  assert.notEqual(replacementSimulation, liveValidation);
  await writeFile(
    liveValidationPath,
    replacementSimulation,
  );
  await git(root, "add", "scripts/system-live-validation.mjs");
  await git(root, "commit", "--quiet", "-m", "simulate live replacement");

  await assert.rejects(
    execFileAsync(
      process.execPath,
      ["scripts/validate-system.mjs", "--with-live-ui"],
      {
        cwd: root,
        encoding: "utf8",
        env: validationEnvironment(),
        windowsHide: true,
      },
    ),
  );

  const { report } = await readOnlyValidationReport(root);
  assert.equal(report.status, "failed");
  assert.equal(report.uiArtifactReceipt, null);
  assert.match(
    report.error,
    /live desktop and mobile UI behavior failed with exit code 1/u,
  );
});

test("the system validator fails before acceptance when tracked source is dirty", async (t) => {
  const root = await createValidationFixture(t);
  await writeFile(path.join(root, "src/app.js"), "export const ready = false;\n");

  await assert.rejects(
    execFileAsync(process.execPath, ["scripts/validate-system.mjs"], {
      cwd: root,
      encoding: "utf8",
      env: validationEnvironment(),
      windowsHide: true,
    }),
  );

  const { report } = await readOnlyValidationReport(root);
  assert.equal(report.status, "failed");
  assert.equal(report.source.started.clean, false);
  assert.match(report.error, /repository was not clean when validation started/u);
  assert.equal(JSON.stringify(report).includes(root), false);
});
