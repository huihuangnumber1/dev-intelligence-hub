import { createHash, randomUUID } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import {
  chmod,
  copyFile,
  lstat,
  mkdir,
  open,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import path from "node:path";

import { normalizeSessionKey } from "../lib/session-key.js";

// Codex's SQLite and JSON index files contain paths into the transient
// invocation profile. Only active rollout files can be resumed from a new
// isolated CODEX_HOME instance.
const PROFILE_ENTRY = /^sessions$/u;
const MAX_SESSION_ID_BYTES = 128;
const MAX_PROFILE_FILES = 20_000;
export const CODEX_SESSION_PROFILE_MAX_BYTES = 512 * 1024 * 1024;
const MAX_PROFILE_BYTES = CODEX_SESSION_PROFILE_MAX_BYTES;
const INVALID_CONTROL = /[\u0000-\u001f\u007f]/u;

function text(value, name, maximumBytes) {
  if (
    typeof value !== "string" ||
    !value.trim() ||
    INVALID_CONTROL.test(value) ||
    Buffer.byteLength(value, "utf8") > maximumBytes
  ) {
    throw new TypeError(`${name} is invalid`);
  }
  return value;
}

function absolutePath(value, name) {
  if (typeof value !== "string" || !path.isAbsolute(value)) {
    throw new TypeError(`${name} is invalid`);
  }
  return path.resolve(value);
}

function pathsOverlap(left, right) {
  const contains = (parent, child) => {
    const relative = path.relative(parent, child);
    return relative === "" || (
      relative !== ".." &&
      !relative.startsWith(`..${path.sep}`) &&
      !path.isAbsolute(relative)
    );
  };
  return contains(left, right) || contains(right, left);
}

function protectedRootPaths(value) {
  if (!Array.isArray(value) || value.some((entry) => !path.isAbsolute(entry))) {
    throw new TypeError("Codex session protected roots are invalid");
  }
  return value.map((entry) => path.resolve(entry));
}

function directoryManager(value) {
  if (value === null) return null;
  if (typeof value !== "object" || typeof value.prepare !== "function") {
    throw new TypeError("Codex session directory manager is invalid");
  }
  return Object.freeze({ prepare: value.prepare.bind(value) });
}

function throwIfAborted(signal) {
  signal?.throwIfAborted();
}

function digest(value) {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function copyBudget() {
  return { files: 0, bytes: 0 };
}

async function copyTree(source, destination, signal, budget) {
  throwIfAborted(signal);
  const details = await lstat(source);
  throwIfAborted(signal);
  if (details.isSymbolicLink()) {
    throw new Error("Codex session profile contains a symbolic link");
  }
  if (details.isDirectory()) {
    await mkdir(destination, { recursive: true, mode: 0o700 });
    const names = await readdir(source);
    for (const name of names) {
      await copyTree(
        path.join(source, name),
        path.join(destination, name),
        signal,
        budget,
      );
    }
    return;
  }
  if (!details.isFile()) {
    throw new Error("Codex session profile contains an unsupported entry");
  }
  budget.files += 1;
  budget.bytes += details.size;
  if (budget.files > MAX_PROFILE_FILES || budget.bytes > MAX_PROFILE_BYTES) {
    throw new Error("Codex session profile exceeds its storage limit");
  }
  await mkdir(path.dirname(destination), { recursive: true, mode: 0o700 });
  await copyFile(source, destination, fsConstants.COPYFILE_FICLONE);
}

async function copyProfile(source, destination, signal) {
  const budget = copyBudget();
  let names;
  try {
    names = await readdir(source);
  } catch (error) {
    if (error?.code === "ENOENT") return budget;
    throw error;
  }
  for (const name of names) {
    if (!PROFILE_ENTRY.test(name)) continue;
    await copyTree(
      path.join(source, name),
      path.join(destination, name),
      signal,
      budget,
    );
  }
  return budget;
}

async function profileContainsSession(directory, sessionId, signal, budget) {
  throwIfAborted(signal);
  let details;
  try {
    details = await lstat(directory);
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
  if (details.isSymbolicLink()) {
    throw new Error("Codex session profile contains a symbolic link");
  }
  if (details.isFile()) {
    budget.files += 1;
    if (budget.files > MAX_PROFILE_FILES) {
      throw new Error("Codex session profile exceeds its storage limit");
    }
    return path.basename(directory).includes(sessionId) &&
      path.extname(directory).toLowerCase() === ".jsonl";
  }
  if (!details.isDirectory()) {
    throw new Error("Codex session profile contains an unsupported entry");
  }
  for (const name of await readdir(directory)) {
    if (await profileContainsSession(
      path.join(directory, name),
      sessionId,
      signal,
      budget,
    )) return true;
  }
  return false;
}

async function privateDirectory(directory) {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  if (process.platform !== "win32") await chmod(directory, 0o700);
}

async function moveIfPresent(source, destination) {
  try {
    await rename(source, destination);
    return true;
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
}

function sameFile(left, right) {
  return right.isFile() && !right.isSymbolicLink() && right.nlink === 1 &&
    left.dev === right.dev && left.ino === right.ino &&
    left.size === right.size && left.mtimeMs === right.mtimeMs && left.ctimeMs === right.ctimeMs;
}

async function checkedEntry(file) {
  const details = await lstat(file);
  const resolved = await realpath(file);
  const canonical = (value) => process.platform === "win32" ? value.toLowerCase() : value;
  if (details.isSymbolicLink() || canonical(resolved) !== canonical(path.resolve(file))) {
    throw new Error("Codex session verification encountered an unsafe path");
  }
  if (details.isFile() && details.nlink !== 1) {
    throw new Error("Codex session verification encountered a linked file");
  }
  return details;
}

async function sessionFiles(directory, signal, budget, files = []) {
  throwIfAborted(signal);
  const details = await checkedEntry(directory);
  if (++budget.entries > MAX_PROFILE_FILES || budget.depth > 16) {
    throw new Error("Codex session profile exceeds its verification limit");
  }
  if (details.isFile()) {
    budget.bytes += details.size;
    if (budget.bytes > MAX_PROFILE_BYTES) throw new Error("Codex session profile exceeds its storage limit");
    files.push({ path: directory, details });
  } else if (details.isDirectory()) {
    budget.depth++;
    for (const name of await readdir(directory)) {
      await sessionFiles(path.join(directory, name), signal, budget, files);
    }
    budget.depth--;
  } else {
    throw new Error("Codex session profile contains an unsupported entry");
  }
  return files;
}

// A newer capture may append turns. Every byte of the retained file must still
// exist as an unchanged prefix before that older temporary copy can be removed.
async function archivedPrefix(source, saved, signal) {
  const before = source.details;
  const savedBefore = await checkedEntry(saved);
  if (!savedBefore.isFile() || savedBefore.size < before.size || savedBefore.size > MAX_PROFILE_BYTES) return false;
  let sourceHandle;
  let savedHandle;
  try {
    const flags = fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0);
    sourceHandle = await open(source.path, flags);
    savedHandle = await open(saved, flags);
    if (!sameFile(before, await sourceHandle.stat()) || !sameFile(savedBefore, await savedHandle.stat())) return false;
    const sourceBytes = Buffer.alloc(64 * 1024);
    const savedBytes = Buffer.alloc(sourceBytes.length);
    for (let position = 0; position < before.size;) {
      throwIfAborted(signal);
      const length = Math.min(sourceBytes.length, before.size - position);
      const left = await sourceHandle.read(sourceBytes, 0, length, position);
      const right = await savedHandle.read(savedBytes, 0, length, position);
      if (left.bytesRead !== length || right.bytesRead !== length ||
          !sourceBytes.subarray(0, length).equals(savedBytes.subarray(0, length))) return false;
      position += length;
    }
    return sameFile(before, await sourceHandle.stat()) &&
      sameFile(savedBefore, await savedHandle.stat()) &&
      sameFile(before, await checkedEntry(source.path)) &&
      sameFile(savedBefore, await checkedEntry(saved));
  } finally {
    await sourceHandle?.close();
    await savedHandle?.close();
  }
}

export class CodexCliSessionStore {
  #root;
  #protectedRoots;
  #directoryManager;
  #clock;

  constructor({
    root,
    protectedRoots = [],
    directoryManager: manager = null,
    clock = Date.now,
  } = {}) {
    this.#root = absolutePath(root, "Codex session root");
    this.#protectedRoots = protectedRootPaths(protectedRoots);
    this.#directoryManager = directoryManager(manager);
    if (typeof clock !== "function") throw new TypeError("clock is invalid");
    this.#clock = clock;
    this.#assertRootLocation();
    Object.freeze(this);
  }

  #assertRootLocation() {
    if (this.#protectedRoots.some((entry) => pathsOverlap(this.#root, entry))) {
      throw new Error("Codex session root overlaps a protected root");
    }
  }

  async #prepareRoot(signal) {
    this.#assertRootLocation();
    if (this.#directoryManager === null) {
      await privateDirectory(this.#root);
      return;
    }
    await this.#directoryManager.prepare({
      directory: this.#root,
      signal,
      validateLocation: () => this.#assertRootLocation(),
    });
  }

  async stage({ sessionKey, codexHome, signal = null } = {}) {
    const key = normalizeSessionKey(sessionKey);
    const home = absolutePath(codexHome, "codexHome");
    throwIfAborted(signal);
    await this.#prepareRoot(signal);
    const entry = path.join(this.#root, digest(key));
    let metadata;
    try {
      metadata = JSON.parse(await readFile(path.join(entry, "metadata.json"), "utf8"));
    } catch (error) {
      if (error?.code === "ENOENT") return Object.freeze({ sessionId: null });
      throw error;
    }
    if (
      metadata === null ||
      typeof metadata !== "object" ||
      Array.isArray(metadata) ||
      metadata.sessionKey !== key
    ) {
      throw new Error("Codex session metadata is invalid");
    }
    const sessionId = text(
      metadata.sessionId,
      "sessionId",
      MAX_SESSION_ID_BYTES,
    );
    if (!await profileContainsSession(
      path.join(entry, "profile", "sessions"),
      sessionId,
      signal,
      { files: 0 },
    )) {
      await rm(entry, { recursive: true, force: true });
      return Object.freeze({ sessionId: null });
    }
    await privateDirectory(home);
    await copyProfile(path.join(entry, "profile"), home, signal);
    return Object.freeze({ sessionId });
  }

  async capture({ sessionKey, sessionId, codexHome, signal = null } = {}) {
    const key = normalizeSessionKey(sessionKey);
    const id = text(sessionId, "sessionId", MAX_SESSION_ID_BYTES);
    const home = absolutePath(codexHome, "codexHome");
    throwIfAborted(signal);
    await this.#prepareRoot(signal);
    const keyDigest = digest(key);
    const target = path.join(this.#root, keyDigest);
    const stage = path.join(this.#root, `.${keyDigest}.stage-${randomUUID()}`);
    const backup = path.join(this.#root, `.${keyDigest}.backup-${randomUUID()}`);
    await privateDirectory(path.join(stage, "profile"));
    try {
      const profile = await copyProfile(
        home,
        path.join(stage, "profile"),
        signal,
      );
      await writeFile(
        path.join(stage, "metadata.json"),
        `${JSON.stringify({
          schemaVersion: 1,
          sessionKey: key,
          sessionId: id,
          capturedAt: new Date(this.#clock()).toISOString(),
          profileBytes: profile.bytes,
        })}\n`,
        { encoding: "utf8", mode: 0o600 },
      );
      const backedUp = await moveIfPresent(target, backup);
      try {
        await rename(stage, target);
      } catch (error) {
        if (backedUp) await rename(backup, target);
        throw error;
      }
      if (backedUp) await rm(backup, { recursive: true, force: true });
      return Object.freeze({ profileBytes: profile.bytes });
    } finally {
      await rm(stage, { recursive: true, force: true });
    }
  }

  async verifyCapture({ sessionKey, sessionId, codexHome, signal = null } = {}) {
    const key = normalizeSessionKey(sessionKey);
    const id = text(sessionId, "sessionId", MAX_SESSION_ID_BYTES);
    const home = absolutePath(codexHome, "codexHome");
    this.#assertRootLocation();
    if (pathsOverlap(home, this.#root)) throw new Error("Codex session verification roots overlap");
    throwIfAborted(signal);
    try {
      const entry = path.join(this.#root, digest(key));
      const metadataFile = path.join(entry, "metadata.json");
      const details = await checkedEntry(metadataFile);
      if (!details.isFile() || details.size > 4096) return null;
      const handle = await open(metadataFile, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0));
      let metadata;
      try {
        if (!sameFile(details, await handle.stat())) return null;
        const bytes = await handle.readFile();
        if (bytes.length > 4096 || !sameFile(details, await handle.stat())) return null;
        metadata = JSON.parse(bytes.toString("utf8"));
      } finally {
        await handle.close();
      }
      if (metadata?.schemaVersion !== 1 || metadata.sessionKey !== key || metadata.sessionId !== id) return null;
      const sourceRoot = path.join(home, "sessions");
      const savedRoot = path.join(entry, "profile", "sessions");
      const budget = { entries: 0, bytes: 0, depth: 0 };
      const files = await sessionFiles(sourceRoot, signal, budget);
      if (!files.some((file) => path.basename(file.path).includes(id) && path.extname(file.path) === ".jsonl")) return null;
      for (const file of files) {
        const saved = path.join(savedRoot, path.relative(sourceRoot, file.path));
        if (!await archivedPrefix(file, saved, signal)) return null;
      }
      throwIfAborted(signal);
      return Object.freeze({ profileBytes: budget.bytes });
    } catch (error) {
      if (error?.code === "ENOENT") return null;
      throw error;
    }
  }
}
