import assert from "node:assert/strict";
import { link, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { loadNativeReviewSkill } from "../src/lib/native-review-skill.js";

async function home(t) {
  const root = await mkdtemp(path.join(tmpdir(), "review-skill-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

test("native review works without personal skills and records the available scope", async (t) => {
  const root = await home(t);
  const bundle = await loadNativeReviewSkill({ home: root });
  const manifest = JSON.parse(bundle.documents["review-skill/manifest.json"]);
  assert.equal(bundle.name, "dih-pr-review");
  assert.equal(manifest.digest, bundle.digest);
  assert.deepEqual(manifest.sources, ["bundled-background-adapter", "bundled-quick-review"]);
  assert.ok(manifest.unavailable.includes("installed-tiering-not-found"));
  assert.equal(manifest.fullCeWorkflow, false);
  assert.equal((await loadNativeReviewSkill({ home: root })).digest, bundle.digest);
});

test("native review loads current installed tiering and CE personas without pinning a version", async (t) => {
  const root = await home(t);
  const tierPath = path.join(root, ".codex/skills/pr-review-tiering");
  await mkdir(tierPath, { recursive: true });
  await writeFile(path.join(tierPath, "SKILL.md"), "installed tiering v1");
  for (const version of ["3.9.0", "3.10.0"]) {
    const personaPath = path.join(root, ".codex/plugins/cache/compound-engineering-plugin/compound-engineering", version, "skills/ce-code-review/references/personas");
    await mkdir(personaPath, { recursive: true });
    await writeFile(path.join(personaPath, "correctness-reviewer.md"), `correctness ${version}`);
  }
  const first = await loadNativeReviewSkill({ home: root });
  assert.equal(first.documents["review-skill/references/tiering.md"], "installed tiering v1");
  assert.equal(first.documents["review-skill/references/correctness.md"], "correctness 3.10.0");
  assert.ok(JSON.parse(first.documents["review-skill/manifest.json"]).sources.includes("installed-ce-personas"));
  await writeFile(path.join(tierPath, "SKILL.md"), "installed tiering v2");
  assert.notEqual((await loadNativeReviewSkill({ home: root })).digest, first.digest);
});

test("hard-linked optional skill sources are never sent to the model", async (t) => {
  const root = await home(t);
  const tierPath = path.join(root, ".codex/skills/pr-review-tiering");
  await mkdir(tierPath, { recursive: true });
  const secret = path.join(root, "private.txt");
  await writeFile(secret, "private value");
  await link(secret, path.join(tierPath, "SKILL.md"));
  const bundle = await loadNativeReviewSkill({ home: root });
  assert.equal(bundle.documents["review-skill/references/tiering.md"], undefined);
  assert.ok(!JSON.stringify(bundle.documents).includes("private value"));
  assert.ok(JSON.parse(bundle.documents["review-skill/manifest.json"]).unavailable.includes("installed-tiering-source-unavailable"));
});
