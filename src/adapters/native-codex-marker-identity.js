import { constants } from "node:fs";
import { lstat, open, readdir } from "node:fs/promises";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import { parseJsonWithUniqueKeys } from "../lib/strict-json.js";
import { githubEntitySessionKey } from "../lib/session-key.js";
import { NATIVE_ADVISORY_INSTRUCTION } from "../lib/codex-app-server-policy.js";
import { preparePrEmployeeAnalysis } from "./ollama-pr-employee-reviewer.js";
import { nativeCodexDigest } from "./codex-native-session-store.js";

const UUID = "[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}";
const INVOCATION = new RegExp(`^(?:invocation|probe)-${UUID}$`);
const ADMISSION_ENTITY = new RegExp(`^(?:[a-f0-9]{64}|${UUID})$`);

export async function readNativeJsonArtifact(file, maximum) {
  let handle;
  try {
    const before = await lstat(file, { bigint: true });
    if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1n || before.size > BigInt(maximum)) return null;
    handle = await open(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    const opened = await handle.stat({ bigint: true });
    if (opened.dev !== before.dev || opened.ino !== before.ino || opened.size !== before.size) return null;
    const buffer = Buffer.alloc(maximum + 1);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    if (bytesRead !== Number(opened.size)) return null;
    const bytes = buffer.subarray(0, bytesRead);
    return { value: parseJsonWithUniqueKeys(new TextDecoder("utf8", { fatal: true }).decode(bytes)), digest: nativeCodexDigest(bytes) };
  } catch { return null; }
  finally { await handle?.close(); }
}

async function readArtifact(file, maximum) {
  return (await readNativeJsonArtifact(file, maximum))?.value ?? null;
}

function legacyTriageIdentity(wire) {
  try {
    if (wire?.instruction !== NATIVE_ADVISORY_INSTRUCTION || !Array.isArray(wire.messages) || wire.messages.length !== 2 ||
        wire.messages[1].role !== "user") return null;
    const expected = preparePrEmployeeAnalysis({ workMode: "triage" });
    if (!isDeepStrictEqual(wire.schema, expected.schema) || !isDeepStrictEqual(wire.messages[0], expected.messages[0])) return null;
    const context = parseJsonWithUniqueKeys(wire.messages[1].content);
    if (context.workMode !== "triage" || typeof context.repository !== "string" ||
        !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(context.repository) ||
        context.id !== `github:pr:${context.repository}#${context.number}` ||
        !isDeepStrictEqual(Object.keys(context).sort(), Object.keys(expected.context).sort())) return null;
    return nativeCodexDigest(githubEntitySessionKey({ kind: "pull_request", repository: context.repository, number: context.number }));
  } catch { return null; }
}

// Identity only: this does not certify process termination or grant action
// authority. Unknown invocations retain a capacity slot and their entity lock.
export async function readUnknownNativeInvocations({ root, prefix, clock = Date.now, signal = null }) {
  signal?.throwIfAborted();
  try {
    const info = await lstat(root);
    if (!info.isDirectory() || info.isSymbolicLink()) return null;
    const entries = [];
    for (const name of await readdir(root)) {
      if (!name.startsWith(prefix) || !name.endsWith(".json")) continue;
      const file = path.join(root, name), marker = await readArtifact(file, 4096);
      if (!marker || !INVOCATION.test(marker.invocation ?? "") ||
          !Number.isSafeInteger(marker.createdAt) || marker.createdAt < 0 || marker.createdAt > clock()) return null;
      const directory = path.join(root, marker.invocation), invocation = await lstat(directory);
      if (!invocation.isDirectory() || invocation.isSymbolicLink()) return null;
      const keys = Object.keys(marker).sort().join(",");
      let entity = null;
      if (marker.schemaVersion === 2 && keys === "createdAt,entity,invocation,schemaVersion" &&
          ADMISSION_ENTITY.test(marker.entity ?? "")) entity = marker.entity;
      if (marker.schemaVersion === 1 && keys === "createdAt,invocation,schemaVersion") {
        entity = legacyTriageIdentity(await readArtifact(path.join(directory, "task.json"), 1024 * 1024));
      }
      if (entity === null) return null;
      entries.push({ file, entity });
    }
    signal?.throwIfAborted();
    return entries;
  } catch { signal?.throwIfAborted(); return null; }
}
