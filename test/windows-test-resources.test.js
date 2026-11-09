import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { copyWindowsTestResources, windowsTestResourceDigest } from "../src/adapters/windows-test-resources.js";
import { normalizeWindowsTestProfile } from "../src/domain/windows-test-profile.js";

async function fixture(t) {
  const root = await mkdtemp(path.join(tmpdir(), "fixed-resource-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const source = path.join(root, "toolchain"); await mkdir(source);
  await writeFile(path.join(source, "tool.exe"), "pinned compiler");
  return { root, source, destination: path.join(root, "copies") };
}
test("resource snapshots bind names and bytes and copy independently", async t => {
  const f = await fixture(t);
  const sha256 = await windowsTestResourceDigest(f.source, "directory");
  const resource = { name: "toolchain", kind: "directory", sourcePath: f.source, sha256 };
  await copyWindowsTestResources([resource], f.destination);
  const copied = path.join(f.destination, "toolchain");
  assert.equal(await windowsTestResourceDigest(copied, "directory"), sha256);
  await writeFile(path.join(copied, "tool.exe"), "changed copy");
  assert.equal(await readFile(path.join(f.source, "tool.exe"), "utf8"), "pinned compiler");
  assert.notEqual(await windowsTestResourceDigest(copied, "directory"), sha256);
  await writeFile(path.join(f.source, "added.dll"), "new dependency");
  await assert.rejects(copyWindowsTestResources([resource], path.join(f.root, "second")), /digest changed/);
});
test("resource snapshots reject links, wrong kinds and unsafe mounts", async t => {
  const f = await fixture(t); const linked = path.join(f.root, "linked");
  await symlink(f.source, linked, process.platform === "win32" ? "junction" : "dir");
  await assert.rejects(windowsTestResourceDigest(linked, "directory"), /link/);
  await assert.rejects(windowsTestResourceDigest(f.source, "file"), /kind/);
  const profile = { kind: "windows-test", nodeExecutable: "C:/node/node.exe", nodeSha256: "a".repeat(64), timeoutMs: 1000,
    asset: { schemaVersion: 1, title: "test", description: "test", version: 1, source: "console.log('test')" },
    resources: [{ name: "../outside", sourcePath: "C:/tools", kind: "directory", sha256: "b".repeat(64) }] };
  assert.throws(() => normalizeWindowsTestProfile(profile));
  profile.resources[0].name = "tools";
  assert.equal(normalizeWindowsTestProfile(profile).resources[0].sha256, "b".repeat(64));
  profile.resources.push({ ...profile.resources[0] });
  assert.throws(() => normalizeWindowsTestProfile(profile));
});
