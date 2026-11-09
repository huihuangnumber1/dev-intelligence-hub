import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { parseGitBlobBatch } from "../src/lib/git-blob-batch.js";

function object(content, format = "sha1") {
  const oid = createHash(format).update(Buffer.from(`blob ${content.length}\0`)).update(content).digest("hex");
  return { oid, bytes: Buffer.concat([Buffer.from(`${oid} blob ${content.length}\n`), content, Buffer.from("\n")]) };
}

test("blob batches retain opaque bytes and verify SHA-1 and SHA-256 objects", () => {
  for (const objectFormat of ["sha1", "sha256"]) {
    const content = Buffer.from([0, 0xff, 10, 65]);
    const first = object(content, objectFormat);
    const empty = object(Buffer.alloc(0), objectFormat);
    const blobs = parseGitBlobBatch(Buffer.concat([first.bytes, empty.bytes]), [first.oid, empty.oid],
      { objectFormat, maxBlobBytes: 4, maxTotalBytes: 4 });
    assert.deepEqual(blobs.get(first.oid), content);
    assert.deepEqual(blobs.get(empty.oid), Buffer.alloc(0));
  }
});

test("blob batches reject wrong types, order, identities, framing, trailing bytes, and budgets", () => {
  const first = object(Buffer.from("abc"));
  const second = object(Buffer.from("def"));
  const limits = { objectFormat: "sha1", maxBlobBytes: 3, maxTotalBytes: 6 };
  const changedContent = Buffer.from(first.bytes); changedContent[changedContent.length - 2] = 0;
  const cases = [
    [Buffer.from(`${first.oid} tree 3\nabc\n`), [first.oid], {}, "PROTOCOL_ERROR"],
    [Buffer.concat([second.bytes, first.bytes]), [first.oid, second.oid], {}, "PROTOCOL_ERROR"],
    [changedContent, [first.oid], {}, "OBJECT_MISMATCH"],
    [first.bytes.subarray(0, -1), [first.oid], {}, "PROTOCOL_ERROR"],
    [Buffer.concat([first.bytes, Buffer.from("extra")]), [first.oid], {}, "PROTOCOL_ERROR"],
    [Buffer.from(`${first.oid} blob 9007199254740992\n`), [first.oid], {}, "BLOB_SIZE_LIMIT"],
    [first.bytes, [first.oid], { maxBlobBytes: 2 }, "BLOB_SIZE_LIMIT"],
    [Buffer.concat([first.bytes, second.bytes]), [first.oid, second.oid], { maxTotalBytes: 5 }, "TOTAL_SIZE_LIMIT"],
  ];
  for (const [bytes, oids, overrides, code] of cases) {
    assert.throws(() => parseGitBlobBatch(bytes, oids, { ...limits, ...overrides }), error => error.code === code);
  }
});
