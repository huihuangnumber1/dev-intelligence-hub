import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import {
  beginCodeReadSession, createCodeReadContext, describeCodeReadContext,
  hasCompleteCodeRead, isCodeReadContext, revokeCodeReadContext,
} from "../src/lib/code-read-context.js";

const JOB = "code-job-test";
const REVISION = "a".repeat(64);
function document(content = "source", path = "src/file.cpp", actionId = "read-action") {
  const buffer = Buffer.from(content, "utf8");
  return { actionId, path, content, bytes: buffer.length, sha256: createHash("sha256").update(buffer).digest("hex") };
}
function fixture(documents = [document()]) {
  const context = createCodeReadContext({ jobId: JOB, workspaceRevision: REVISION, documents });
  const proof = { jobId: JOB, workspaceRevision: REVISION, ...documents[0] };
  return { context, proof };
}
function readAll(session, path, length = 24_000) {
  let offset = 0, output = "";
  do {
    const page = session.readDocument(path, offset, length);
    output += page.text;
    offset = page.nextOffset;
  } while (offset !== null);
  return output;
}

test("opaque audit context exposes only repository paths and byte counts", () => {
  const doc = document("\uFEFF中文 source");
  const { context, proof } = fixture([doc]);
  assert.equal(isCodeReadContext(context), true);
  assert.equal(Object.isFrozen(context), true);
  assert.equal(JSON.stringify(context), "{}");
  assert.deepEqual(describeCodeReadContext(context), { documents: [{ path: doc.path, bytes: doc.bytes }] });
  assert.equal(hasCompleteCodeRead(context, proof), false);
  assert.equal(hasCompleteCodeRead(context, { jobId: JOB, workspaceRevision: REVISION }), false);
  assert.equal(isCodeReadContext(structuredClone(context)), false);
  assert.equal(hasCompleteCodeRead({}, proof), false);
  assert.throws(() => beginCodeReadSession({}), { code: "CODE_READ_CONTEXT_INVALID" });
});

test("audit bytes, SHA and valid UTF8 roundtrip are mandatory, including the BOM", () => {
  const doc = document("\uFEFF中文");
  for (const changed of [{ ...doc, bytes: doc.bytes - 3 }, { ...doc, sha256: "b".repeat(64) },
    { ...doc, content: doc.content.slice(1) }, document("unpaired\uD800"), { ...doc, hostPath: "C:/private/file" }]) {
    assert.throws(() => fixture([changed]), { code: "CODE_READ_DOCUMENT_INVALID" });
  }
  for (const path of ["../token", "src/../token", "src//file", "src\\file", "/etc/passwd", "C:/token", "src/\nfile", ".git/config", ".env", ".ssh/id_rsa", "src/file:key", "src/file."]) {
    assert.throws(() => fixture([document("source", path)]), { code: "CODE_READ_PATH_INVALID" });
  }
  assert.throws(() => fixture([doc, { ...doc, actionId: "other" }]), { code: "CODE_READ_DOCUMENT_DUPLICATE" });
  assert.throws(() => fixture([doc, { ...doc, path: "other.cpp" }]), { code: "CODE_READ_DOCUMENT_DUPLICATE" });
});

test("successive pages preserve a BOM, Chinese, emoji and the true tail past 64 KiB", () => {
  const content = "\uFEFF" + "中文😀 source\n".repeat(10_000) + "ACTUAL_TAIL";
  const doc = document(content);
  assert.ok(doc.bytes > 64 * 1024);
  const { context, proof } = fixture([doc]);
  const session = beginCodeReadSession(context);
  assert.equal(readAll(session, doc.path, 2_003), content);
  session.assertComplete();
  assert.equal(hasCompleteCodeRead(context, proof), false);
  session.commit();
  assert.equal(hasCompleteCodeRead(context, proof), true);
  session.close();
  assert.equal(hasCompleteCodeRead(context, proof), true);
  for (const changed of [{ jobId: "other-job" }, { workspaceRevision: "c".repeat(64) }, { actionId: "other-action" }, { path: "other.cpp" }, { sha256: "d".repeat(64) }]) {
    assert.equal(hasCompleteCodeRead(context, { ...proof, ...changed }), false);
  }
});

test("skipped ranges and an unread empty file do not earn complete read proofs", () => {
  const docs = [document("x".repeat(70_000)), document("", "src/empty.cpp", "read-empty")];
  const { context, proof } = fixture(docs);
  const session = beginCodeReadSession(context);
  session.readDocument(docs[0].path, 0, 24_000);
  session.readDocument(docs[0].path, 24_001, 48_000);
  assert.throws(() => session.assertComplete(), { code: "CODE_ARTIFACT_READ_INCOMPLETE" });
  session.commit();
  assert.equal(hasCompleteCodeRead(context, proof), false);
  session.readDocument(docs[0].path, 24_000, 1);
  session.assertComplete([docs[0].path]);
  assert.throws(() => session.assertComplete(), { code: "CODE_ARTIFACT_READ_INCOMPLETE" });
  session.readDocument(docs[1].path, 0);
  session.assertComplete();
  session.commit();
  assert.equal(hasCompleteCodeRead(context, proof), true);
  session.close();
});

test("abort, explicit revoke, uncommitted close and a new invocation invalidate old coverage", () => {
  const { context, proof } = fixture();
  const controller = new AbortController();
  const first = beginCodeReadSession(context, { signal: controller.signal });
  readAll(first, proof.path);
  first.commit();
  assert.equal(hasCompleteCodeRead(context, proof), true);
  controller.abort();
  assert.equal(hasCompleteCodeRead(context, proof), false);
  assert.throws(() => first.commit(), { code: "CODE_READ_SESSION_REVOKED" });
  first.close();
  const second = beginCodeReadSession(context);
  readAll(second, proof.path);
  second.commit();
  const third = beginCodeReadSession(context);
  assert.equal(hasCompleteCodeRead(context, proof), false);
  assert.throws(() => second.commit(), { code: "CODE_READ_SESSION_REVOKED" });
  second.revoke(); // An obsolete invocation cannot revoke its successor.
  readAll(third, proof.path);
  third.commit();
  assert.equal(hasCompleteCodeRead(context, proof), true);
  revokeCodeReadContext(context);
  assert.equal(hasCompleteCodeRead(context, proof), false);
  assert.throws(() => third.commit(), { code: "CODE_READ_SESSION_REVOKED" });
  third.close();
  const fourth = beginCodeReadSession(context);
  readAll(fourth, proof.path);
  fourth.close();
  assert.equal(hasCompleteCodeRead(context, proof), false);
});

test("ranges reject coercion and surrogate splits without losing a character on narrow pages", () => {
  const { context, proof } = fixture([document("😀中文")]);
  const session = beginCodeReadSession(context);
  for (const [offset, length] of [["0", 1], [-1, 1], [1, 1], [99, 1], [0, 0], [0, 48_001]]) {
    assert.throws(() => session.readDocument(proof.path, offset, length), { code: "CODE_READ_RANGE_INVALID" });
  }
  assert.equal(readAll(session, proof.path, 1), "😀中文");
  session.assertComplete();
  session.close();
});
