import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import * as confirmationDialogSupport from "../public/confirmation-dialog-support.js";

const testDirectory = path.dirname(fileURLToPath(import.meta.url));

async function sources() {
  const [html, app] = await Promise.all([
    readFile(path.resolve(testDirectory, "../public/index.html"), "utf8"),
    readFile(path.resolve(testDirectory, "../public/app.js"), "utf8"),
  ]);
  return { html, app };
}

test("stored confirmation deferrals deduplicate without reordering valid keys", () => {
  const parse = confirmationDialogSupport.parseDeferredConfirmationKeys;
  assert.equal(typeof parse, "function");
  const external = `external\u0000confirmation-1\u0000${"a".repeat(64)}`;
  const responsibility = `responsibility\u0000pull-request-1\u0000${"b".repeat(40)}`;
  const internal = `internal\u0000attention-${"c".repeat(64)}\u0000${"d".repeat(64)}`;
  const review = `review\u0000review-job-1\u0000${"e".repeat(40)}`;

  assert.deepEqual(
    parse(JSON.stringify([
      external,
      responsibility,
      external,
      internal,
      review,
    ])),
    [external, responsibility, internal, review],
  );
});

test("stored confirmation deferrals reject malformed or oversized containers", () => {
  const parse = confirmationDialogSupport.parseDeferredConfirmationKeys;
  const head = "a".repeat(40);

  assert.deepEqual(parse("{"), []);
  assert.deepEqual(parse(JSON.stringify({ key: "value" })), []);
  assert.deepEqual(parse(JSON.stringify([null])), []);
  assert.deepEqual(
    parse(JSON.stringify(
      Array.from(
        { length: 33 },
        (_, index) => `review\u0000review-${index}\u0000${head}`,
      ),
    )),
    [],
  );
});

test("stored confirmation deferrals reject invalid key kinds, shapes, ids, and bindings", () => {
  const parse = confirmationDialogSupport.parseDeferredConfirmationKeys;
  const sha1 = "a".repeat(40);
  const sha256 = "b".repeat(64);
  const invalidKeys = [
    "external",
    `unknown\u0000item-1\u0000${sha256}`,
    `toString\u0000item-1\u0000${sha256}`,
    "external\u0000item-1",
    `external\u0000item-1\u0000${sha256}\u0000payload`,
    `external\u0000\u0000${sha256}`,
    `review\u0000${"x".repeat(129)}\u0000${sha1}`,
    `external\u0000confirmation-1\u0000${"c".repeat(63)}`,
    `internal\u0000attention-${"d".repeat(64)}\u0000${sha1}`,
    `responsibility\u0000pull-request-1\u0000${sha256}`,
    `review\u0000review-1\u0000${"g".repeat(40)}`,
  ];

  for (const key of invalidKeys) {
    assert.deepEqual(parse(JSON.stringify([key])), [], key);
  }
});

test("the session deferral store writes key-only state and clears it explicitly", () => {
  const createStore =
    confirmationDialogSupport.createSessionDeferredConfirmationStore;
  assert.equal(typeof createStore, "function");
  const values = new Map();
  const storage = {
    getItem(key) {
      return values.get(key) ?? null;
    },
    setItem(key, value) {
      values.set(key, value);
    },
    removeItem(key) {
      values.delete(key);
    },
  };
  const store = createStore({
    getStorage: () => storage,
    storageKey: "test.deferred-confirmations",
  });
  const valid = `external\u0000confirmation-1\u0000${"a".repeat(64)}`;
  const invalid = `external\u0000confirmation-1\u0000${"b".repeat(40)}`;

  assert.equal(
    store.save([
      invalid,
      valid,
      { key: valid, payload: { body: "must not persist" }, approved: true },
      valid,
    ]),
    true,
  );
  assert.equal(
    values.get("test.deferred-confirmations"),
    JSON.stringify([valid]),
  );
  assert.deepEqual(store.load(), [valid]);
  assert.equal(store.clear(), true);
  assert.equal(values.has("test.deferred-confirmations"), false);
});

test("the session deferral store safely falls back when storage is unavailable", () => {
  const createStore =
    confirmationDialogSupport.createSessionDeferredConfirmationStore;
  const valid = `external\u0000confirmation-1\u0000${"a".repeat(64)}`;
  const unavailable = createStore({
    getStorage() {
      throw new Error("storage access denied");
    },
    storageKey: "test.deferred-confirmations",
  });

  assert.deepEqual(unavailable.load(), []);
  assert.equal(unavailable.save([valid]), false);
  assert.equal(unavailable.clear(), false);

  const throwingMethods = createStore({
    getStorage: () => ({
      getItem() {
        throw new Error("read denied");
      },
      setItem() {
        throw new Error("write denied");
      },
      removeItem() {
        throw new Error("remove denied");
      },
    }),
    storageKey: "test.deferred-confirmations",
  });

  assert.deepEqual(throwingMethods.load(), []);
  assert.equal(throwingMethods.save([valid]), false);
  assert.equal(throwingMethods.clear(), false);
});

test("all attention sources share one dialog and one unified next endpoint", async () => {
  const { html, app } = await sources();

  assert.equal((html.match(/<dialog id="confirmation-dialog"/g) || []).length, 1);
  assert.equal((html.match(/<dialog id="task-run-dialog"/g) || []).length, 1);
  assert.match(
    html,
    /<dialog id="detail-dialog" aria-label="详情">/,
  );
  assert.match(
    html,
    /<dialog id="confirmation-dialog" aria-label="待确认操作">/,
  );
  assert.equal((html.match(/id="confirmation-dialog"/g) || []).length, 1);
  assert.match(app, /fetch\(attentionNextUrl\(\)/);
  assert.doesNotMatch(app, /fetch\("\/api\/confirmations\/next"/);
  assert.match(app, /source === "external_confirmation"/);
  assert.match(app, /source === "internal_request"/);
});

test("session deferrals are bounded and sent as exact source bindings", async () => {
  const { app } = await sources();

  assert.match(app, /const MAX_DEFERRED_CONFIRMATIONS = 32/);
  assert.match(app, /function rememberDeferredConfirmation/);
  assert.match(app, /while \(deferredConfirmations\.size > MAX_DEFERRED_CONFIRMATIONS\)/);
  assert.match(app, /params\.append\("deferred", `\$\{source\}:\$\{id\}:\$\{digest\}`\)/);
  assert.match(app, /async function refreshAfterDeferral/);
});

test("session deferrals hydrate, persist, clear before restore, and recover on failure", async () => {
  const { app } = await sources();

  assert.match(app, /createSessionDeferredConfirmationStore/);
  assert.match(
    app,
    /const deferredConfirmations = new Set\(deferredConfirmationStore\.load\(\)\)/,
  );

  const rememberStart = app.indexOf("function rememberDeferredConfirmation");
  const rememberEnd = app.indexOf("\nfunction attentionNextUrl", rememberStart);
  const remember = app.slice(rememberStart, rememberEnd);
  assert.ok(rememberStart >= 0 && rememberEnd > rememberStart);
  assert.match(remember, /deferredConfirmationStore\.save\(deferredConfirmations\)/);

  const restoreStart = app.indexOf("async function restoreDeferredConfirmations");
  const restoreEnd = app.indexOf("\nasync function refreshAfterDeferral", restoreStart);
  const restore = app.slice(restoreStart, restoreEnd);
  assert.ok(restoreStart >= 0 && restoreEnd > restoreStart);
  assert.ok(
    restore.indexOf("deferredConfirmationStore.clear()") <
      restore.indexOf("await refreshConfirmationQueue"),
  );
  assert.match(restore, /catch \(error\)[\s\S]*rememberDeferredConfirmation/);
});

test("deferred confirmations have a visible retry control with failure-safe recovery", async () => {
  const { app } = await sources();

  assert.match(app, /id="confirmation-deferred-restore"/);
  assert.match(app, /重新查看稍后项/);
  assert.match(app, /deferredConfirmations\.size/);
  assert.match(app, /async function restoreDeferredConfirmations/);
  const start = app.indexOf("async function restoreDeferredConfirmations");
  const end = app.indexOf("\nasync function refreshAfterDeferral", start);
  const restore = app.slice(start, end);
  assert.ok(start >= 0 && end > start);
  assert.ok(
    restore.indexOf("deferredConfirmations.clear()") <
      restore.indexOf("await refreshConfirmationQueue"),
  );
  assert.match(restore, /catch \(error\)[\s\S]*rememberDeferredConfirmation/);
  assert.match(restore, /queueMicrotask\(showNextConfirmation\)/);
});

test("internal renderer cannot manufacture an external action control", async () => {
  const { app } = await sources();
  const start = app.indexOf("function showInternalAttention");
  const end = app.indexOf("function showReviewDraftConfirmation", start);
  assert.ok(start >= 0 && end > start);
  const internalRenderer = app.slice(start, end);

  assert.match(internalRenderer, /data-internal-choice/);
  assert.match(internalRenderer, /data-internal-operation="reject"/);
  assert.match(internalRenderer, /data-internal-operation="later"/);
  assert.match(internalRenderer, /escapeHtml\(display\.question/);
  assert.match(internalRenderer, /internalAttentionDisplay\(item\)/);
  assert.doesNotMatch(internalRenderer, /data-external-operation/);
  assert.doesNotMatch(internalRenderer, /\/api\/confirmations\//);
});

test("internal answers bind revision and digest and later is server-validated", async () => {
  const { app } = await sources();
  const start = app.indexOf("async function submitInternalAttention");
  const end = app.indexOf("function handleInternalAttentionClick", start);
  assert.ok(start >= 0 && end > start);
  const submitter = app.slice(start, end);

  assert.match(submitter, /encodeURIComponent\(item\.requestId\)/);
  assert.match(submitter, /expectedRevision:\s*item\.revision/);
  assert.match(submitter, /contentDigest:\s*item\.contentDigest/);
  assert.match(submitter, /operation === "later"/);
  assert.match(submitter, /response\.status === 409/);
  assert.match(submitter, /invalidateConfirmationQueueSnapshot/);
});

test("confirmation center explains the remaining count and each destination", async () => {
  const { app } = await sources();
  const start = app.indexOf("function confirmationPendingMarkup");
  const end = app.indexOf("\nfunction deferredConfirmationMarkup", start);
  const pending = app.slice(start, end);
  const centerStart = app.indexOf("function confirmationCenterView");
  const centerEnd = app.indexOf("\nfunction employeesView", centerStart);
  const center = app.slice(centerStart, centerEnd);

  assert.ok(start >= 0 && end > start);
  assert.ok(centerStart >= 0 && centerEnd > centerStart);
  assert.match(pending, /含当前项/);
  assert.match(pending, /主动工作台账/);
  assert.match(pending, /原任务转为阻塞/);
  assert.match(pending, /只读确认历史/);
  assert.match(center, /还剩.*项/);
  assert.doesNotMatch(center, /pendingCount \|\| 0\} ITEMS/);
});

test("internal attention reports where answer, rejection, and deferral go", async () => {
  const { app } = await sources();
  const renderStart = app.indexOf("function showInternalAttention");
  const renderEnd = app.indexOf("\nfunction setInternalButtonsDisabled", renderStart);
  const renderer = app.slice(renderStart, renderEnd);
  const submitStart = app.indexOf("async function submitInternalAttention");
  const submitEnd = app.indexOf("\nfunction handleInternalAttentionClick", submitStart);
  const submitter = app.slice(submitStart, submitEnd);

  assert.ok(renderStart >= 0 && renderEnd > renderStart);
  assert.ok(submitStart >= 0 && submitEnd > submitStart);
  assert.match(renderer, /含当前项/);
  assert.match(renderer, /主动工作台账/);
  assert.match(submitter, /原任务将重新排队/);
  assert.match(submitter, /原任务将转入“阻塞”/);
  assert.match(submitter, /仍在待确认队列/);
});

test("external actions retain their separate confirmation endpoint", async () => {
  const { app } = await sources();

  assert.match(
    app,
    /`\/api\/confirmations\/\$\{encodeURIComponent\(item\.id\)\}\/\$\{operation\}`/,
  );
  assert.match(app, /approvalBindingDigest:\s*item\.approvalBindingDigest/);
  assert.match(app, /displayedPayloadDigest:\s*item\.displayedPayloadDigest/);
});
