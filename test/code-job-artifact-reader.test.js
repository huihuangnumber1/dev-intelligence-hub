import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { createCodeJobArtifactReader } from "../src/adapters/code-job-artifact-reader.js";
import { createCodeReadContext, hasCompleteCodeRead, MAXIMUM_CODE_READ_PAGE_BYTES } from "../src/lib/code-read-context.js";

function fixture(content = "\uFEFF" + "中文😀source\n".repeat(10_000) + "AUDITED_TRUE_TAIL") {
  const buffer = Buffer.from(content);
  const document = { actionId: "read-source", path: "src/DreamCenterSystem.cpp", content, bytes: buffer.length,
    sha256: createHash("sha256").update(buffer).digest("hex") };
  const proof = { jobId: "code-job-reader-test", workspaceRevision: "b".repeat(64), ...document };
  return { context: createCodeReadContext({ ...proof, documents: [document] }), document, proof };
}
async function rpc(reader, method, params = {}) {
  const response = await fetch(reader.url, { method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) });
  assert.equal(response.status, 200);
  return (await response.json()).result;
}
async function tool(reader, name, args) {
  const result = await rpc(reader, "tools/call", { name, arguments: args });
  if (result.isError) throw Object.assign(new Error(result.content[0].text), { code: result.content[0].text });
  return JSON.parse(result.content[0].text);
}
async function readAll(reader, path, length = 4_003) {
  let offset = 0, text = "";
  do {
    const page = await tool(reader, "read_source", { path, offset, length, revision: "current" });
    assert.equal(page.offset, offset);
    text += page.text;
    offset = page.nextOffset;
  } while (offset !== null);
  return text;
}

test("real MCP source pages expose the complete audited UTF8 file beyond 24 and 64 KiB", async (t) => {
  const { context, document, proof } = fixture();
  const reader = await createCodeJobArtifactReader(context);
  t.after(() => reader.close());
  assert.match(reader.url, /^http:\/\/127\.0\.0\.1:\d+\/code-read\/[a-f0-9]{64}$/);
  assert.ok((await rpc(reader, "initialize")).capabilities.tools);
  const tools = (await rpc(reader, "tools/list")).tools;
  assert.deepEqual(tools.map(({ name }) => name), ["read_document", "read_source", "list_directory"]);
  assert.ok(tools.every((entry) => entry.annotations.readOnlyHint && !entry.annotations.destructiveHint));
  assert.deepEqual(JSON.parse(reader.manifestText), { documents: [{ path: document.path, bytes: document.bytes }] });
  assert.equal((await tool(reader, "read_document", { document: "code-read-manifest.json", offset: 0 })).text, reader.manifestText);
  assert.deepEqual((await tool(reader, "list_directory", { path: "" })).entries, [{ path: "src", type: "dir" }]);
  assert.deepEqual((await tool(reader, "list_directory", { path: "src" })).entries, [{ path: document.path, type: "file" }]);
  assert.throws(() => reader.assertComplete(), { code: "CODE_ARTIFACT_READ_INCOMPLETE" });
  assert.equal(await readAll(reader, document.path), document.content);
  reader.assertComplete();
  assert.equal(hasCompleteCodeRead(context, proof), false);
  reader.commit();
  assert.equal(hasCompleteCodeRead(context, proof), true);
  await reader.close();
  assert.equal(hasCompleteCodeRead(context, proof), true);
  await assert.rejects(fetch(reader.url));
});

test("unavailable paths, revisions and write tools cannot read host files or add coverage", async (t) => {
  const { context, document, proof } = fixture("audited source");
  const reader = await createCodeJobArtifactReader(context);
  t.after(() => reader.close());
  for (const path of ["../auth.json", "C:/private/token", "/etc/passwd", "src\\file.cpp", ".git/config"]) {
    await assert.rejects(tool(reader, "read_source", { path, offset: 0 }), { code: "CODE_READ_PATH_INVALID" });
  }
  await assert.rejects(tool(reader, "read_source", { path: "src/unaudited.cpp", offset: 0 }), { code: "CODE_READ_DOCUMENT_NOT_FOUND" });
  await assert.rejects(tool(reader, "read_source", { path: document.path, offset: 0, revision: "head" }), { code: "CODE_READ_REVISION_INVALID" });
  await assert.rejects(tool(reader, "read_source", { path: document.path, offset: 0, jobId: "other" }), { code: "CODE_READ_ARGUMENT_INVALID" });
  await assert.rejects(tool(reader, "write_file", { path: document.path, text: "unsafe" }), { code: "CODE_READ_TOOL_NOT_ALLOWED" });
  reader.commit();
  assert.equal(hasCompleteCodeRead(context, proof), false);
  assert.equal(await readAll(reader, document.path), document.content);
  reader.commit();
  assert.equal(hasCompleteCodeRead(context, proof), true);
  reader.revoke();
  assert.equal(hasCompleteCodeRead(context, proof), false);
});

test("HTTP access rejects origins, wrong endpoints, non-POST and oversized arguments", async (t) => {
  const { context, proof } = fixture();
  const reader = await createCodeJobArtifactReader(context);
  t.after(() => reader.close());
  assert.equal((await fetch(reader.url)).status, 404);
  assert.equal((await fetch(reader.url, { method: "POST", headers: { origin: "http://evil.test" }, body: "{}" })).status, 404);
  assert.equal((await fetch(reader.url.replace(/code-read\/.+$/, "code-read/wrong"), { method: "POST" })).status, 404);
  assert.equal((await fetch(reader.url, { method: "POST", body: "x".repeat(65 * 1024) })).status, 400);
  assert.equal((await fetch(reader.url, { method: "POST", body: "null" })).status, 400);
  assert.equal((await fetch(reader.url, { method: "POST", body: JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) })).status, 202);
  reader.commit();
  assert.equal(hasCompleteCodeRead(context, proof), false);
});

test("a skipped middle page cannot authorize a write, even when the true tail was read", async (t) => {
  const { context, document, proof } = fixture("x".repeat(70_000) + "TAIL");
  const reader = await createCodeJobArtifactReader(context);
  t.after(() => reader.close());
  await tool(reader, "read_source", { path: document.path, offset: 0, length: 24_000 });
  const last = await tool(reader, "read_source", { path: document.path, offset: 24_001, length: 48_000 });
  assert.equal(last.nextOffset, null);
  assert.match(last.text, /TAIL$/);
  assert.throws(() => reader.assertComplete(), { code: "CODE_ARTIFACT_READ_INCOMPLETE" });
  reader.commit();
  assert.equal(hasCompleteCodeRead(context, proof), false);
});

test("cancellation closes the HTTP server and revokes even committed coverage", async () => {
  const { context, document, proof } = fixture("source");
  const controller = new AbortController();
  const reader = await createCodeJobArtifactReader(context, { signal: controller.signal });
  await readAll(reader, document.path);
  reader.commit();
  assert.equal(hasCompleteCodeRead(context, proof), true);
  controller.abort();
  await reader.close();
  assert.equal(hasCompleteCodeRead(context, proof), false);
  await assert.rejects(fetch(reader.url));
  await assert.rejects(createCodeJobArtifactReader(context, { signal: controller.signal }), { name: "AbortError" });
});

test("high-byte CJK and JSON escaping fit each tool response while retaining exact coverage and tail", async (t) => {
  const content = "\uFEFF" + "鿿".repeat(50_000) + "\\\n\t\"😀".repeat(15_000) + "TRANSPORT_SAFE_TAIL";
  const { context, document, proof } = fixture(content);
  const reader = await createCodeJobArtifactReader(context);
  t.after(() => reader.close());
  const first = await tool(reader, "read_source", { path: document.path, offset: 0, length: 48_000 });
  assert.ok(first.nextOffset > 0 && first.nextOffset < 48_000, "transport bytes determine the actual returned end");
  assert.equal(Buffer.byteLength(JSON.stringify(first)) <= MAXIMUM_CODE_READ_PAGE_BYTES, true);
  reader.commit();
  assert.equal(hasCompleteCodeRead(context, proof), false);
  let offset = first.nextOffset, actual = first.text;
  while (offset !== null) {
    const page = await tool(reader, "read_source", { path: document.path, offset, length: 48_000 });
    assert.ok(Buffer.byteLength(JSON.stringify(page)) <= MAXIMUM_CODE_READ_PAGE_BYTES);
    assert.equal(page.text.includes("\uFFFD"), false);
    actual += page.text;
    offset = page.nextOffset;
  }
  assert.equal(actual, content);
  reader.assertComplete();
  reader.commit();
  assert.equal(hasCompleteCodeRead(context, proof), true);
});

test("a large CJK-path manifest follows the same bounded transport pages", async (t) => {
  const documents = Array.from({ length: 200 }, (_, index) => ({ actionId: `read-${index}`,
    path: `src/${"文".repeat(100)}-${index}.cpp`, content: "a", bytes: 1,
    sha256: createHash("sha256").update("a").digest("hex") }));
  const context = createCodeReadContext({ jobId: "manifest-test", workspaceRevision: "c".repeat(64), documents });
  const reader = await createCodeJobArtifactReader(context);
  t.after(() => reader.close());
  assert.ok(Buffer.byteLength(reader.manifestText) > MAXIMUM_CODE_READ_PAGE_BYTES);
  let offset = 0, actual = "", pages = 0;
  do {
    const page = await tool(reader, "read_document", { document: "code-read-manifest.json", offset, length: 48_000 });
    assert.ok(Buffer.byteLength(JSON.stringify(page)) <= MAXIMUM_CODE_READ_PAGE_BYTES);
    actual += page.text;
    offset = page.nextOffset;
    pages += 1;
  } while (offset !== null);
  assert.ok(pages > 1);
  assert.equal(actual, reader.manifestText);
});
