import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { cp, lstat, mkdir, readdir, realpath } from "node:fs/promises";
import path from "node:path";
import { normalizeWorkspacePath } from "../domain/code-execution-policy.js";

export async function windowsTestFileDigest(file) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest("hex");
}

// Directory identity covers names and bytes, independent of installation paths,
// timestamps and ACLs. The same format is used by deployment preparation.
export async function windowsTestResourceDigest(sourcePath, kind) {
  const root = path.resolve(sourcePath);
  if ((await realpath(root)).toLowerCase() !== root.toLowerCase()) throw new Error("Resource path contains a link");
  const entries = [];
  let bytes = 0;
  async function visit(file, relative) {
    const stats = await lstat(file);
    if (stats.isSymbolicLink()) throw new Error("Resource links are forbidden");
    if (stats.isDirectory()) {
      for (const child of await readdir(file)) await visit(path.join(file, child), relative ? `${relative}/${child}` : child);
    } else if (stats.isFile()) {
      if (relative) normalizeWorkspacePath(relative);
      bytes += stats.size;
      if (bytes > 256 * 1024 * 1024 || entries.length >= 20_000) throw new Error("Resource snapshot exceeds its limit");
      entries.push({ path: relative, size: stats.size, sha256: await windowsTestFileDigest(file) });
    } else throw new Error("Unsupported resource entry");
  }
  const stats = await lstat(root);
  if (stats.isSymbolicLink() || (kind === "file" ? !stats.isFile() : kind !== "directory" || !stats.isDirectory())) throw new Error("Resource kind mismatch");
  await visit(root, "");
  entries.sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
  return kind === "file" ? entries[0].sha256 : createHash("sha256").update(JSON.stringify({ schemaVersion: 1, entries })).digest("hex");
}

export async function copyWindowsTestResources(resources, destination) {
  await mkdir(destination, { recursive: true });
  const names = new Set();
  for (const resource of resources) {
    if (typeof resource.name !== "string" || !/^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/u.test(resource.name) || names.has(resource.name)) throw new Error("Unsafe resource mount name");
    names.add(resource.name);
    if (await windowsTestResourceDigest(resource.sourcePath, resource.kind) !== resource.sha256) throw new Error("Configured resource digest changed");
    const target = path.join(destination, resource.name);
    await cp(resource.sourcePath, target, { recursive: resource.kind === "directory", errorOnExist: true, force: false,
      filter: async file => { if ((await lstat(file)).isSymbolicLink()) throw new Error("Resource copy contains a link"); return true; } });
    if (await windowsTestResourceDigest(target, resource.kind) !== resource.sha256) throw new Error("Copied resource digest mismatch");
  }
}
