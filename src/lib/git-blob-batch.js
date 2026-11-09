import { createHash } from "node:crypto";

export const MAX_BLOBS_PER_BATCH = 128;

export class GitBlobBatchError extends Error {
  constructor(code) {
    super(`Invalid Git blob batch: ${code}`);
    this.name = "GitBlobBatchError";
    this.code = code;
  }
}

// cat-file is a byte protocol: content may contain NULs and newlines. Only
// headers and the single delimiter after each exact-length object are text.
export function parseGitBlobBatch(bytes, oids, {
  objectFormat,
  maxBlobBytes,
  maxTotalBytes,
}) {
  const blobs = new Map();
  let offset = 0;
  let totalBytes = 0;
  for (const expectedOid of oids) {
    const headerEnd = bytes.indexOf(0x0a, offset);
    if (headerEnd === -1) throw new GitBlobBatchError("PROTOCOL_ERROR");
    const match = /^([a-f0-9]{40}|[a-f0-9]{64}) blob (0|[1-9][0-9]*)$/u.exec(
      bytes.subarray(offset, headerEnd).toString("latin1"),
    );
    if (!match || match[1] !== expectedOid) {
      throw new GitBlobBatchError("PROTOCOL_ERROR");
    }
    const size = Number(match[2]);
    if (!Number.isSafeInteger(size) || size > maxBlobBytes) {
      throw new GitBlobBatchError("BLOB_SIZE_LIMIT");
    }
    totalBytes += size;
    if (!Number.isSafeInteger(totalBytes) || totalBytes > maxTotalBytes) {
      throw new GitBlobBatchError("TOTAL_SIZE_LIMIT");
    }
    offset = headerEnd + 1;
    const end = offset + size;
    if (end >= bytes.length || bytes[end] !== 0x0a) {
      throw new GitBlobBatchError("PROTOCOL_ERROR");
    }
    const content = Buffer.from(bytes.subarray(offset, end));
    const actualOid = createHash(objectFormat)
      .update(Buffer.from(`blob ${size}\0`))
      .update(content)
      .digest("hex");
    if (actualOid !== expectedOid) {
      throw new GitBlobBatchError("OBJECT_MISMATCH");
    }
    blobs.set(expectedOid, content);
    offset = end + 1;
  }
  if (offset !== bytes.length) throw new GitBlobBatchError("PROTOCOL_ERROR");
  return blobs;
}
