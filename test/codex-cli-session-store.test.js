import assert from "node:assert/strict";
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  appendFile,
  link,
  stat,
  truncate,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { CodexCliSessionStore } from "../src/adapters/codex-cli-session-store.js";

test("capture verification preserves missing or changed history and accepts an archived prefix", async (t) => {
  const parent = await temporaryDirectory(t, "codex-session-verify-");
  const root = path.join(parent, "store");
  const home = path.join(parent, "home");
  await mkdir(path.join(home, "sessions"), { recursive: true });
  const rollout = path.join(home, "sessions", "rollout-thread-1.jsonl");
  await writeFile(rollout, "original history\n");
  const store = new CodexCliSessionStore({ root });
  const input = { sessionKey: "github:issue:owner/repo#1", sessionId: "thread-1", codexHome: home };
  assert.equal(await store.verifyCapture(input), null);
  await store.capture(input);
  assert.deepEqual(await store.verifyCapture(input), { profileBytes: Buffer.byteLength("original history\n") });
  const [entry] = await readdir(root);
  const saved = path.join(root, entry, "profile", "sessions", path.basename(rollout));
  await appendFile(saved, "later turn\n");
  assert.ok(await store.verifyCapture(input));
  await writeFile(saved, "different history\n");
  assert.equal(await store.verifyCapture(input), null);
  assert.equal(await readFile(rollout, "utf8"), "original history\n");
  await rm(saved);
  assert.equal(await store.verifyCapture(input), null);
});

test("capture verification rejects linked files and storage overflow without removing history", async (t) => {
  const parent = await temporaryDirectory(t, "codex-session-verify-bound-");
  const root = path.join(parent, "store");
  const home = path.join(parent, "home");
  await mkdir(path.join(home, "sessions"), { recursive: true });
  const rollout = path.join(home, "sessions", "rollout-thread-1.jsonl");
  await writeFile(rollout, "original history");
  const store = new CodexCliSessionStore({ root });
  const input = { sessionKey: "github:issue:owner/repo#1", sessionId: "thread-1", codexHome: home };
  await store.capture(input);
  const alias = path.join(parent, "alias.jsonl");
  await link(rollout, alias);
  await assert.rejects(store.verifyCapture(input), /linked file/u);
  await rm(alias);
  await truncate(rollout, 512 * 1024 * 1024 + 1);
  await assert.rejects(store.verifyCapture(input), /storage limit/u);
  assert.equal((await stat(rollout)).size, 512 * 1024 * 1024 + 1);
  await truncate(rollout, Buffer.byteLength("original history"));
  assert.equal(await readFile(rollout, "utf8"), "original history");
});

async function temporaryDirectory(t, prefix) {
  const directory = await mkdtemp(path.join(tmpdir(), prefix));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

test("CodexCliSessionStore persists one isolated profile per entity across restart", async (t) => {
  const parent = await temporaryDirectory(t, "codex-session-store-");
  const root = path.join(parent, "store");
  const sourceHome = path.join(parent, "source-home");
  await mkdir(path.join(sourceHome, "sessions", "2026", "08", "29"), {
    recursive: true,
  });
  await writeFile(
    path.join(
      sourceHome,
      "sessions",
      "2026",
      "08",
      "29",
      "rollout-019cfake-session-id.jsonl",
    ),
    "session transcript",
  );
  await writeFile(path.join(sourceHome, "state_5.sqlite"), "sqlite state");
  await writeFile(
    path.join(sourceHome, "thread_history_1.sqlite"),
    "thread history",
  );
  await mkdir(path.join(sourceHome, "sqlite"));
  await writeFile(path.join(sourceHome, "sqlite", "codex-dev.db"), "thread index");
  await writeFile(path.join(sourceHome, "history.jsonl"), "history index");
  await writeFile(path.join(sourceHome, "session_index.jsonl"), "session index");
  await writeFile(path.join(sourceHome, "auth.json"), "must not persist");
  await writeFile(path.join(sourceHome, "config.toml"), "must not persist");
  const key = "github:pull_request:example/software#24256";
  const store = new CodexCliSessionStore({ root });

  await store.capture({
    sessionKey: key,
    sessionId: "019cfake-session-id",
    codexHome: sourceHome,
  });

  const restoredHome = path.join(parent, "restored-home");
  await mkdir(restoredHome);
  const restarted = new CodexCliSessionStore({ root });
  const restored = await restarted.stage({
    sessionKey: key,
    codexHome: restoredHome,
  });

  assert.equal(restored.sessionId, "019cfake-session-id");
  assert.equal(
    await readFile(
      path.join(
        restoredHome,
        "sessions",
        "2026",
        "08",
        "29",
        "rollout-019cfake-session-id.jsonl",
      ),
      "utf8",
    ),
    "session transcript",
  );
  for (const unsupported of [
    "state_5.sqlite",
    "thread_history_1.sqlite",
    path.join("sqlite", "codex-dev.db"),
    "history.jsonl",
    "session_index.jsonl",
  ]) {
    await assert.rejects(readFile(path.join(restoredHome, unsupported)), {
      code: "ENOENT",
    });
  }
  await assert.rejects(readFile(path.join(restoredHome, "auth.json")), {
    code: "ENOENT",
  });
  await assert.rejects(readFile(path.join(restoredHome, "config.toml")), {
    code: "ENOENT",
  });
});

test("CodexCliSessionStore never shares history between different entities", async (t) => {
  const parent = await temporaryDirectory(t, "codex-session-isolation-");
  const root = path.join(parent, "store");
  const sourceHome = path.join(parent, "source-home");
  await mkdir(path.join(sourceHome, "sessions"), { recursive: true });
  await writeFile(
    path.join(sourceHome, "sessions", "rollout-session-pr-1.jsonl"),
    "PR 1",
  );
  const store = new CodexCliSessionStore({ root });
  await store.capture({
    sessionKey: "github:pull_request:example/software#1",
    sessionId: "session-pr-1",
    codexHome: sourceHome,
  });

  const otherHome = path.join(parent, "other-home");
  await mkdir(otherHome);
  const other = await store.stage({
    sessionKey: "github:pull_request:example/software#2",
    codexHome: otherHome,
  });

  assert.equal(other.sessionId, null);
  await assert.rejects(readFile(path.join(otherHome, "sessions", "rollout.jsonl")), {
    code: "ENOENT",
  });
});

test("CodexCliSessionStore does not resume a rollout retained only in archived_sessions", async (t) => {
  const parent = await temporaryDirectory(t, "codex-session-archive-");
  const root = path.join(parent, "store");
  const sourceHome = path.join(parent, "source-home");
  const sessionId = "archived-session";
  await mkdir(path.join(sourceHome, "archived_sessions", "2026", "08", "31"), {
    recursive: true,
  });
  await writeFile(
    path.join(
      sourceHome,
      "archived_sessions",
      "2026",
      "08",
      "31",
      `rollout-${sessionId}.jsonl`,
    ),
    "archived history",
  );
  const store = new CodexCliSessionStore({ root });
  const sessionKey = "github:issue:example/product#2";

  await store.capture({ sessionKey, sessionId, codexHome: sourceHome });

  const restoredHome = path.join(parent, "restored-home");
  assert.equal(
    (await store.stage({ sessionKey, codexHome: restoredHome })).sessionId,
    null,
  );
  await assert.rejects(
    readFile(path.join(
      restoredHome,
      "archived_sessions",
      "2026",
      "08",
      "31",
      `rollout-${sessionId}.jsonl`,
    )),
    { code: "ENOENT" },
  );
});

test("CodexCliSessionStore preserves older entity sessions", async (t) => {
  const parent = await temporaryDirectory(t, "codex-session-continuity-");
  const root = path.join(parent, "store");
  const sourceHome = path.join(parent, "source-home");
  await mkdir(path.join(sourceHome, "sessions"), { recursive: true });
  const rollout = path.join(sourceHome, "sessions", "rollout-session-1.jsonl");
  await writeFile(rollout, "history");
  const store = new CodexCliSessionStore({ root });
  await store.capture({
    sessionKey: "github:issue:example/product#1",
    sessionId: "session-1",
    codexHome: sourceHome,
  });
  await writeFile(
    path.join(sourceHome, "sessions", "rollout-session-2.jsonl"),
    "history 2",
  );
  await store.capture({
    sessionKey: "github:issue:example/product#2",
    sessionId: "session-2",
    codexHome: sourceHome,
  });

  const restoredHome = path.join(parent, "restored-home");
  await mkdir(restoredHome);
  assert.equal(
    (await store.stage({
      sessionKey: "github:issue:example/product#1",
      codexHome: restoredHome,
    })).sessionId,
    "session-1",
  );
  assert.equal(
    (await store.stage({
      sessionKey: "github:issue:example/product#2",
      codexHome: restoredHome,
    })).sessionId,
    "session-2",
  );
});

test("CodexCliSessionStore resets metadata whose rollout is missing", async (t) => {
  const parent = await temporaryDirectory(t, "codex-session-missing-rollout-");
  const root = path.join(parent, "store");
  const sourceHome = path.join(parent, "source-home");
  await mkdir(path.join(sourceHome, "sessions"), { recursive: true });
  await writeFile(
    path.join(sourceHome, "sessions", "rollout-session-missing.jsonl"),
    "history",
  );
  const store = new CodexCliSessionStore({ root });
  await store.capture({
    sessionKey: "github:issue:example/product#12953",
    sessionId: "session-missing",
    codexHome: sourceHome,
  });
  const [entryName] = await readdir(root);
  await rm(path.join(root, entryName, "profile", "sessions"), {
    recursive: true,
    force: true,
  });

  const restored = await store.stage({
    sessionKey: "github:issue:example/product#12953",
    codexHome: path.join(parent, "restored-home"),
  });

  assert.equal(restored.sessionId, null);
  await assert.rejects(readFile(path.join(root, entryName, "metadata.json")), {
    code: "ENOENT",
  });
});
