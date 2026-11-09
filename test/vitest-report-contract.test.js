import assert from "node:assert/strict";
import test from "node:test";
import { translateVitestReport, matchesVitestDependencyBinding } from "../src/domain/vitest-report-contract.js";
import { createPicassoDockerTestAsset } from "../scripts/test-assets/picasso-vitest-docker-v2.js";
const report = (statuses, success = true) => JSON.stringify({ success, testResults: [{ status: statuses.includes("failed") ? "failed" : "passed", assertionResults: statuses.map((status, index) => ({ status, fullName: `case ${index}\ncontinued` })) }] });
test("actual Vitest report translation preserves mixed outcomes and cannot promote failures", () => {
  const mixed = translateVitestReport(report(["passed", "failed", "pending", "todo"]), 1);
  assert.equal(mixed.exitCode, 1); assert.match(mixed.stdout, /# pass 1\n# fail 1\n# cancelled 0\n# skipped 1\n# todo 1/);
  assert.match(mixed.stdout, /not ok 2/); assert.match(mixed.stdout, /ok 3 .*# SKIP/); assert.match(mixed.stdout, /ok 4 .*# TODO/);
  assert.equal(translateVitestReport(report(["passed"], false), 0).exitCode, 1);
  assert.equal(translateVitestReport(report(["pending", "todo"]), 0).exitCode, 1);
  assert.equal(translateVitestReport(report(["passed"]), 7).exitCode, 7);
  assert.equal(translateVitestReport(report(["passed"]), 0).exitCode, 0);
  assert.equal(translateVitestReport(report(["unknown"]), 0).exitCode, 1);
});
test("missing and malformed reports fail despite process exit zero", () => {
  for (const value of [null, "", "{}", "invalid", "null"]) {
    const result = translateVitestReport(value, 0); assert.equal(result.exitCode, 1); assert.equal(result.stdout, "");
  }
});
test("checked-in asset embeds the tested translator and pins both dependency manifests", () => {
  const packageSha256 = "a".repeat(64), lockSha256 = "b".repeat(64);
  assert.equal(matchesVitestDependencyBinding(packageSha256, lockSha256, packageSha256, lockSha256), true);
  assert.equal(matchesVitestDependencyBinding("c".repeat(64), lockSha256, packageSha256, lockSha256), false);
  assert.equal(matchesVitestDependencyBinding(packageSha256, "c".repeat(64), packageSha256, lockSha256), false);
  const asset = createPicassoDockerTestAsset({ packageSha256, lockSha256 });
  assert.equal(asset.version, 2);
  assert.ok(asset.source.includes(JSON.stringify(translateVitestReport.toString()).slice(1, -1)));
  assert.ok(asset.source.includes(packageSha256)); assert.ok(asset.source.includes(lockSha256));
  assert.throws(() => createPicassoDockerTestAsset({ packageSha256: "unbound", lockSha256 }));
});
