import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { CodexNativeSessionStore } from "../src/adapters/codex-native-session-store.js";

async function fixture(t) {
  const root = await mkdtemp(path.join(tmpdir(), "native-codex-reference-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const references = path.join(root, "references");
  await mkdir(references);
  return { root, references, create: (home = path.join(root, "home")) => new CodexNativeSessionStore({ root: references, nativeHome: home }) };
}

test("native reference survives store recreation and binds one home and entity", async (t) => {
  const f = await fixture(t);
  const key = "github:pull_request:example/repository#42";
  await f.create().save({ sessionKey: key, threadId: "thread-42" });
  assert.equal(await f.create().read({ sessionKey: key }), "thread-42");
  assert.equal(await f.create().read({ sessionKey: `${key}-other` }), null);
  assert.equal(await f.create(path.join(f.root, "different-home")).read({ sessionKey: key }), null);
  const files = await readdir(f.references);
  assert.equal(files.length, 1);
  const text = await readFile(path.join(f.references, files[0]), "utf8");
  assert.deepEqual(Object.keys(JSON.parse(text)).sort(), ["homeDigest", "schemaVersion", "threadId"]);
  assert.ok(!text.includes(key));
  assert.ok(!text.includes(f.root));
});

test("native reference rejects malformed state instead of silently starting another conversation", async (t) => {
  const f = await fixture(t);
  await f.create().save({ sessionKey: "entity", threadId: "thread-42" });
  const [file] = await readdir(f.references);
  await writeFile(path.join(f.references, file), '{"threadId":"other","threadId":"thread-42"}');
  await assert.rejects(f.create().read({ sessionKey: "entity" }), { code: "STRUCTURED_PROVIDER_SESSION_RECOVERY_FAILED" });
  await assert.rejects(f.create().save({ sessionKey: "entity", threadId: "../../unrelated" }), { code: "STRUCTURED_PROVIDER_SESSION_RECOVERY_FAILED" });
});

test("native reference replacement leaves only the current thread reference", async (t) => {
  const f = await fixture(t);
  await f.create().save({ sessionKey: "entity", threadId: "thread-42" });
  await f.create().save({ sessionKey: "entity", threadId: "thread-43" });
  assert.equal(await f.create().read({ sessionKey: "entity" }), "thread-43");
  assert.equal((await readdir(f.references)).length, 1);
});

test("an interrupted unknown thread fences only its own entity across store recreation", async (t) => {
  const f = await fixture(t);
  await f.create().begin({ sessionKey: "interrupted-entity" });
  await assert.rejects(f.create().read({ sessionKey: "interrupted-entity" }), { code: "STRUCTURED_PROVIDER_SESSION_RECOVERY_FAILED" });
  assert.equal(await f.create().read({ sessionKey: "other-entity" }), null);
  // Maintenance can restore the verified native ID without copying its history.
  await f.create().save({ sessionKey: "interrupted-entity", threadId: "recovered-native-thread" });
  assert.equal(await f.create().read({ sessionKey: "interrupted-entity" }), "recovered-native-thread");
});

test("failed final reference publication retains the known thread journal for exact resume", async (t) => {
  const f = await fixture(t);
  await f.create().save({ sessionKey: "entity", threadId: "thread-42" });
  const [file] = await readdir(f.references);
  await rm(path.join(f.references, file));
  await mkdir(path.join(f.references, file));
  await assert.rejects(f.create().save({ sessionKey: "entity", threadId: "thread-43" }), { code: "STRUCTURED_PROVIDER_SESSION_RECOVERY_FAILED" });
  assert.equal(await f.create().read({ sessionKey: "entity" }), "thread-43");
  assert.equal(await f.create().read({ sessionKey: "unrelated" }), null);
});
