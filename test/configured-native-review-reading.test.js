import assert from "node:assert/strict";
import { lstat, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { createNativeCodexBrainProvider } from "../src/adapters/native-codex-brain-provider.js";
import { createTestConfiguredBrainRouter } from "../src/services/configured-workforce.js";
import { RoleDecisionEngine } from "../src/services/role-decision-engine.js";

async function assertConfiguredNativeReviewReading(t, patch) {
  const root = await mkdtemp(path.join(tmpdir(), "configured-native-review-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const home = path.join(root, "codex-home");
  await mkdir(home);
  const gitTarget = {
    schemaVersion: 1,
    provider: "github",
    sourceAccountId: "reviewer",
    baseRepository: "acme/repo",
    baseRefName: "main",
    baseRefOid: "a".repeat(40),
    headRepository: "acme/repo",
    headRefName: "feature",
    headRefOid: "b".repeat(40),
  };
  const targets = [];
  const calls = [];
  const inputs=[];
  const skillDocuments = [];
  const registeredSkills = [];
  let completenessChecks = 0;
  let readerCloses = 0;
  const router = createTestConfiguredBrainRouter({
    brainProviders: {
      cli: { kind: "codex-cli", credentialMode: "codex-native-login", timeoutMs: 3000 },
    },
  }, {
    supervisedCliProviderFactory(options) {
      return createNativeCodexBrainProvider(options, {
        environment: { ...process.env, DIH_CODEX_NATIVE_TRANSPORT:'exec', CODEX_HOME: home },
        temporaryRoot: path.join(root, "runtime"),
        commandLocator: {
          async resolve() { return { command: process.execPath, prefixArgs: [] }; },
        },
        rootDirectoryManager: {
          async prepare({ directory, validateLocation, signal }) {
            signal?.throwIfAborted();
            await validateLocation();
            await mkdir(directory).catch((error) => { if (error.code !== "EEXIST") throw error; });
            const stat = await lstat(directory, { bigint: true });
            return { path: await realpath(directory), device: String(stat.dev), inode: String(stat.ino) };
          },
        },
        async reviewReaderFactory(target, options) {
          assert.equal(Object.isFrozen(target), true);
          assert.equal(Object.isFrozen(target.gitTarget), true);
          targets.push(target);
          skillDocuments.push(options.skillDocuments);
          return {
            url: "http://127.0.0.1:12345/scoped-reader",
            diffText: "complete immutable diff",
            manifestText: JSON.stringify({ gitTarget }),
            assertComplete() {
              completenessChecks += 1;
              throw Object.assign(new Error("Incomplete fixture reading"), { code: "PR_REVIEW_READ_INCOMPLETE" });
            },
            close() { readerCloses += 1; },
          };
        },
        processRunner: {
          async run(call) {
            calls.push(call);
            inputs.push(JSON.parse(await readFile(path.join(call.cwd,'task.json'),'utf8')));
            registeredSkills.push(await readFile(path.join(call.cwd, ".agents/skills/dih-pr-review/SKILL.md"), "utf8"));
            await writeFile(call.args[call.args.indexOf("--output-last-message") + 1], JSON.stringify({
              result: JSON.stringify({ intent: { type: "propose_github_review" } }),
            }));
            const stdout = JSON.stringify({ type: "thread.started", thread_id: "configured-review-thread" });
            return { exitCode: 0, signal: null, stdout, stderr: "", stdoutBytes: Buffer.from(stdout), stderrBytes: Buffer.alloc(0) };
          },
        },
      });
    },
  });
  t.after(() => router.close());
  const engine = new RoleDecisionEngine({
    definition: { id: "pr-engineer", name: "PR engineer", mission: "Review assigned PRs", enabled: true, scheduleMinutes: 5 },
    permissions: { allowedIntents: ["propose_github_review"] },
    brain: {
      provider: "cli",
      model: "gpt-6.1-sol",
      reasoningEffort: "high",
      remoteData: { requirements: true, code: true, memory: false },
    },
    brainRouter: router,
  });

  await assert.rejects(engine.decide({
    item: { itemId: "work-item-review", kind: "assignment", event: { eventType: "pull_request.created" } },
    context: {
      requirements: {},
      code: {
        sourceEvent: { subject: { number: 42 } },
        pullRequest: { reviewMaterial: { gitTarget, patch, patchTruncated: true, filesTruncated: true } },
      },
    },
  }), { code: "PR_REVIEW_READ_INCOMPLETE" });

  assert.deepEqual(targets, [{ gitTarget, pullRequestNumber: 42 }]);
  assert.equal(calls.length, 1);
  assert.equal(completenessChecks, 1);
  assert.equal(readerCloses, 1);
  assert.equal(skillDocuments.length, 1);
  assert.equal(registeredSkills[0], skillDocuments[0]["review-skill/SKILL.md"]);
  assert.match(registeredSkills[0], /name: dih-pr-review/u);
  const [call] = calls;
  assert.ok(call.args.includes("mcp_servers.pr_review.required=true"));
  assert.ok(call.args.includes('mcp_servers.pr_review.url="http://127.0.0.1:12345/scoped-reader"'));
  assert.ok(call.args.includes('mcp_servers.pr_review.enabled_tools=["read_document","read_source","list_directory"]'));
  assert.equal(call.maxStdoutBytes, 64 * 1024 * 1024);
  assert.ok(call.args.some((entry, index) => entry === "--enable" && call.args[index + 1] === "multi_agent"));
  assert.ok(call.args.includes("skills.include_instructions=false"));
  assert.ok(call.args.includes("skills.bundled.enabled=false"));
  assert.equal(call.args[call.args.indexOf("--sandbox") + 1], "read-only");
  const [input] = inputs;
  assert.match(input.instruction, /Use \$dih-pr-review/u);
  assert.match(input.messages[0].content, /native \$dih-pr-review/u);
  assert.doesNotMatch(input.messages[0].content, /Apply the bundled quick-pr-review skill below/u);
  assert.match(input.messages[0].content, /Use the pr_review read-only tools/u);
  assert.equal(JSON.parse(input.messages[1].content).code.pullRequest.reviewMaterial.patch, patch);
}

for (const [scenario, patch] of [
  ["small preview", ""],
  ["UTF-8 preview above 64 KiB", "变".repeat(22_000)],
]) {
  test(`configured native PR role requires complete reading of the immutable review target: ${scenario}`, async (t) => {
    await assertConfiguredNativeReviewReading(t, patch);
  });
}
