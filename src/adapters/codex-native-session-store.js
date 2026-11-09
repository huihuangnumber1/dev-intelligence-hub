import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, realpath, rename, unlink } from "node:fs/promises";
import path from "node:path";

import { normalizeSessionKey } from "../lib/session-key.js";
import { parseJsonWithUniqueKeys } from "../lib/strict-json.js";

const THREAD_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;

export function isNativeCodexThreadId(value) {
  return typeof value === "string" && THREAD_ID.test(value);
}

export function nativeCodexHomeIdentity(home) {
  const resolved = path.resolve(home).replace(/^\\\\\?\\/u, "");
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

export function nativeCodexDigest(value) {
  return createHash("sha256").update(value).digest("hex");
}

function invalidReference() {
  return Object.assign(new Error("Native Codex session reference is invalid"), {
    code: "STRUCTURED_PROVIDER_SESSION_RECOVERY_FAILED", statusCode: 500,
  });
}

// References belong to the application; conversation files remain owned by Codex.
// The caller serializes access for the canonical native home and prepares this
// private directory before opening the store. No transcript or auth is copied.
export class CodexNativeSessionStore {
  constructor({ root, nativeHome }) {
    if (!path.isAbsolute(root) || !path.isAbsolute(nativeHome)) throw new TypeError("Native session location is invalid");
    this.root = path.resolve(root);
    this.homeDigest = nativeCodexDigest(nativeCodexHomeIdentity(nativeHome));
  }

  #file(sessionKey) {
    return path.join(this.root, `${nativeCodexDigest(`${this.homeDigest}\n${normalizeSessionKey(sessionKey)}`)}.json`);
  }

  #journal(sessionKey) { return `${this.#file(sessionKey)}.pending`; }

  async #readFile(file, signal, { pending = false } = {}) {
    signal?.throwIfAborted();
    let handle;
    try {
      const before = await lstat(file, { bigint: true });
      if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1n || before.size > 1024n ||
          nativeCodexHomeIdentity(await realpath(file)) !== nativeCodexHomeIdentity(file)) throw invalidReference();
      handle = await open(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
      const opened = await handle.stat({ bigint: true });
      if (before.dev !== opened.dev || before.ino !== opened.ino || before.size !== opened.size) throw invalidReference();
      const buffer = Buffer.alloc(1025);
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
      const text = new TextDecoder("utf-8", { fatal: true }).decode(buffer.subarray(0, bytesRead));
      const after = await handle.stat({ bigint: true });
      if (bytesRead > 1024 || BigInt(bytesRead) !== before.size || after.size !== before.size || after.mtimeNs !== before.mtimeNs) throw invalidReference();
      const value = parseJsonWithUniqueKeys(text);
      if (!value || Object.keys(value).length !== 3 || value.schemaVersion !== 1 ||
          value.homeDigest !== this.homeDigest || !(pending && value.threadId === null) &&
          !isNativeCodexThreadId(value.threadId)) throw invalidReference();
      signal?.throwIfAborted();
      return value;
    } catch (error) {
      if (error?.code === "ENOENT") return null;
      if (signal?.aborted) signal.throwIfAborted();
      throw invalidReference();
    } finally { await handle?.close(); }
  }

  async read({ sessionKey, signal = null }) {
    const journal = await this.#readFile(this.#journal(sessionKey), signal, { pending: true });
    if (journal !== null) {
      // A known thread is sufficient to resume after a failed final publication.
      // An unknown thread requires per-entity maintenance, never a fresh thread.
      if (journal.threadId === null) throw invalidReference();
      return journal.threadId;
    }
    return (await this.#readFile(this.#file(sessionKey), signal))?.threadId ?? null;
  }

  async #writeFile(file, threadId, signal) {
    signal?.throwIfAborted();
    const temporary = path.join(this.root, `.reference-${randomUUID()}.tmp`);
    let handle;
    try {
      handle = await open(temporary, "wx", 0o600);
      await handle.writeFile(JSON.stringify({ schemaVersion: 1, homeDigest: this.homeDigest, threadId }));
      await handle.sync();
      await handle.close();
      handle = null;
      signal?.throwIfAborted();
      await rename(temporary, file);
    } catch (error) {
      if (signal?.aborted) signal.throwIfAborted();
      throw invalidReference();
    } finally {
      await handle?.close();
      await unlink(temporary).catch((error) => { if (error?.code !== "ENOENT") throw invalidReference(); });
    }
  }

  async begin({ sessionKey, threadId = null, signal = null }) {
    if (threadId !== null && !isNativeCodexThreadId(threadId)) throw invalidReference();
    await this.#writeFile(this.#journal(sessionKey), threadId, signal);
  }

  async cancel({ sessionKey }) {
    await unlink(this.#journal(sessionKey)).catch((error) => { if (error?.code !== "ENOENT") throw invalidReference(); });
  }

  async save({ sessionKey, threadId, signal = null }) {
    if (!isNativeCodexThreadId(threadId)) throw invalidReference();
    // Publish the recovered ID to the journal first. If final publication fails,
    // read() can resume that exact native thread. A failed journal update leaves
    // the pre-launch unknown marker, fencing only this entity after restart.
    await this.#writeFile(this.#journal(sessionKey), threadId, signal);
    await this.#writeFile(this.#file(sessionKey), threadId, signal);
    await this.cancel({ sessionKey });
  }
}
