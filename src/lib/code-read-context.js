import { createHash } from "node:crypto";
import { CodeExecutionPolicy } from "../domain/code-execution-policy.js";

const contexts = new WeakMap();
const SHA256 = /^[a-f0-9]{64}$/;
const pathPolicy = new CodeExecutionPolicy();
export const MAXIMUM_CODE_READ_PAGE_BYTES = 48 * 1024;

function failure(code) {
  return Object.assign(new Error(code), { code });
}

function safePath(value, { allowRoot = false } = {}) {
  if (typeof value !== "string" || Buffer.byteLength(value, "utf8") > 1_024 || /[\\\u0000-\u001f\u007f]/u.test(value)) {
    throw failure("CODE_READ_PATH_INVALID");
  }
  try {
    return pathPolicy.assertAccessible(value, { allowRoot });
  } catch {
    throw failure("CODE_READ_PATH_INVALID");
  }
}

function identifier(value) {
  return typeof value === "string" && value.length > 0 && value.length <= 256 &&
    !/[\u0000-\u001f\u007f]/u.test(value);
}

function stateFor(context) {
  const state = context && typeof context === "object" ? contexts.get(context) : null;
  if (!state) throw failure("CODE_READ_CONTEXT_INVALID");
  return state;
}

// Only the audit reader creates these handles. No host paths, source text or
// write authority survive serialization into model/browser input.
export function createCodeReadContext({ jobId, workspaceRevision, documents } = {}) {
  if (!identifier(jobId) || typeof workspaceRevision !== "string" || !SHA256.test(workspaceRevision) || !Array.isArray(documents)) {
    throw failure("CODE_READ_CONTEXT_INVALID");
  }
  const files = new Map();
  const actions = new Set();
  for (const supplied of documents) {
    if (!supplied || typeof supplied !== "object" || Array.isArray(supplied)) throw failure("CODE_READ_DOCUMENT_INVALID");
    const document = { ...supplied };
    if (
        Object.keys(document).some((key) => !["actionId", "path", "sha256", "bytes", "content"].includes(key)) ||
        !identifier(document.actionId) || typeof document.sha256 !== "string" || !SHA256.test(document.sha256) ||
        !Number.isSafeInteger(document.bytes) || document.bytes < 0 || typeof document.content !== "string") {
      throw failure("CODE_READ_DOCUMENT_INVALID");
    }
    const path = safePath(document.path);
    const bytes = Buffer.from(document.content, "utf8");
    // ignoreBOM retains the leading U+FEFF; round-tripping also rejects lone
    // surrogate input that Buffer would otherwise silently replace.
    const decoded = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
    if (decoded !== document.content || bytes.length !== document.bytes ||
        createHash("sha256").update(bytes).digest("hex") !== document.sha256) {
      throw failure("CODE_READ_DOCUMENT_INVALID");
    }
    if (files.has(path) || actions.has(document.actionId)) throw failure("CODE_READ_DOCUMENT_DUPLICATE");
    files.set(path, Object.freeze({ ...document, path }));
    actions.add(document.actionId);
  }
  const context = Object.freeze({});
  contexts.set(context, { jobId, workspaceRevision, files, proofs: new Map(), invocation: null });
  return context;
}

export function isCodeReadContext(value) {
  return value !== null && typeof value === "object" && contexts.has(value);
}

export function describeCodeReadContext(context) {
  return { documents: [...stateFor(context).files.values()].map(({ path, bytes }) => ({ path, bytes })) };
}

export function revokeCodeReadContext(context) {
  const state = stateFor(context);
  state.proofs.clear();
  state.invocation = null;
}

export function hasCompleteCodeRead(context, { jobId, workspaceRevision, actionId, path, sha256 } = {}) {
  if (!isCodeReadContext(context)) return false;
  const state = contexts.get(context);
  const proof = state.proofs.get(path);
  return Boolean(proof) && identifier(actionId) && typeof sha256 === "string" && SHA256.test(sha256) &&
    state.jobId === jobId && state.workspaceRevision === workspaceRevision &&
    proof?.actionId === actionId && proof?.sha256 === sha256 &&
    proof?.invocation === state.invocation;
}

function addRange(ranges, start, end) {
  let insertion = 0;
  while (insertion < ranges.length && ranges[insertion][1] < start) insertion += 1;
  let through = insertion;
  while (through < ranges.length && ranges[through][0] <= end) {
    start = Math.min(start, ranges[through][0]);
    end = Math.max(end, ranges[through][1]);
    through += 1;
  }
  ranges.splice(insertion, through - insertion, [start, end]);
}

function splitsSurrogate(text, offset) {
  return offset > 0 && offset < text.length &&
    /[\uD800-\uDBFF]/u.test(text[offset - 1]) && /[\uDC00-\uDFFF]/u.test(text[offset]);
}

// The native tool output limit is 65,536 tokens. Bounding the serialized page
// in bytes keeps even byte-fallback tokenization below that limit. This limits
// one transport response, never the number of pages or the file size.
export function pageCodeReadText(text, fields, offset, length = 24_000) {
  if (!Number.isSafeInteger(offset) || offset < 0 || offset > text.length ||
      !Number.isSafeInteger(length) || length < 1 || length > 48_000 || splitsSurrogate(text, offset)) {
    throw failure("CODE_READ_RANGE_INVALID");
  }
  const safeEnd = (end) => splitsSurrogate(text, end) ? end - 1 : end;
  let end = Math.min(text.length, offset + length);
  if (splitsSurrogate(text, end)) end += end === offset + 1 ? 1 : -1;
  const resultAt = (through) => ({ ...fields, offset, nextOffset: through < text.length ? through : null,
    totalLength: text.length, text: text.slice(offset, through) });
  const fits = (through) => Buffer.byteLength(JSON.stringify(resultAt(through)), "utf8") <= MAXIMUM_CODE_READ_PAGE_BYTES;
  if (!fits(end)) {
    let low = offset, high = end;
    while (low < high) {
      const middle = Math.ceil((low + high) / 2);
      if (fits(safeEnd(middle))) low = middle;
      else high = middle - 1;
    }
    end = safeEnd(low);
  }
  if (!fits(end) || (end === offset && offset < text.length)) throw failure("CODE_READ_RANGE_INVALID");
  return resultAt(end);
}

export function beginCodeReadSession(context, { signal = null } = {}) {
  const state = stateFor(context);
  const invocation = Symbol("code-read-invocation");
  state.invocation = invocation;
  state.proofs.clear();
  const reads = new Map();
  let revoked = false;
  let closed = false;
  let committed = false;
  const revoke = () => {
    revoked = true;
    if (state.invocation === invocation) state.proofs.clear();
    signal?.removeEventListener("abort", revoke);
  };
  const assertActive = () => {
    if (signal?.aborted) revoke();
    if (revoked || closed || state.invocation !== invocation) throw failure("CODE_READ_SESSION_REVOKED");
  };
  signal?.addEventListener("abort", revoke, { once: true });
  if (signal?.aborted) revoke();
  const fullyRead = (document) => {
    const ranges = reads.get(document.path);
    return ranges?.length === 1 && ranges[0][0] === 0 && ranges[0][1] === document.content.length;
  };
  return Object.freeze({
    assertActive,
    readDocument(path, offset, length = 24_000) {
      assertActive();
      safePath(path);
      const document = state.files.get(path);
      if (!document) throw failure("CODE_READ_DOCUMENT_NOT_FOUND");
      const result = pageCodeReadText(document.content, { path }, offset, length);
      const end = result.offset + result.text.length;
      const ranges = reads.get(path) ?? [];
      addRange(ranges, offset, end);
      reads.set(path, ranges);
      return result;
    },
    listDocuments() {
      assertActive();
      return describeCodeReadContext(context).documents;
    },
    assertComplete(paths = [...state.files.keys()]) {
      assertActive();
      if (!Array.isArray(paths) || paths.some((path) => !state.files.has(safePath(path)))) {
        throw failure("CODE_READ_DOCUMENT_NOT_FOUND");
      }
      if (paths.some((path) => !fullyRead(state.files.get(path)))) throw failure("CODE_ARTIFACT_READ_INCOMPLETE");
    },
    commit() {
      assertActive();
      state.proofs.clear();
      for (const document of state.files.values()) {
        if (fullyRead(document)) state.proofs.set(document.path, {
          actionId: document.actionId, sha256: document.sha256, invocation,
        });
      }
      committed = true;
    },
    revoke,
    close() {
      if (!committed || signal?.aborted) revoke();
      closed = true;
      signal?.removeEventListener("abort", revoke);
    },
  });
}
