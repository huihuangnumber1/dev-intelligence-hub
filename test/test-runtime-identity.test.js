import assert from "node:assert/strict";
import test from "node:test";
import { executionIdentityFields, isExecutionIdentityProof, isWindowsRuntimeIdentity, WINDOWS_REGISTRY_READ_CAPABILITY_SID } from "../src/domain/test-runtime-identity.js";

const identity = { schemaVersion: 1, kind: "windows-process", executionId: "session-one", actionId: "action-one",
  pid: 1234, processStartTimeUtcTicks: String(639013000000000000n), executableSha256: "a".repeat(64) };

test("native execution identity requires exact data fields and typed IDs", () => {
  assert.equal(isWindowsRuntimeIdentity(identity), true);
  for (const invalid of [{ ...identity, executionId: 123 }, { ...identity, actionId: null }, { ...identity, pid: 0 }, { ...identity, extra: true }]) {
    assert.equal(isWindowsRuntimeIdentity(invalid), false);
  }
  const hidden = { ...identity };
  Object.defineProperty(hidden, "pid", { value: identity.pid, enumerable: false });
  assert.equal(isWindowsRuntimeIdentity(hidden), false);
  const proof = { runtimeIdentity: identity, assetVersion: 2, verificationKind: "test" };
  assert.equal(isExecutionIdentityProof(proof), true);
  assert.equal(isExecutionIdentityProof({ ...proof, imageId: `sha256:${"b".repeat(64)}` }), false);
  const detached = executionIdentityFields(proof);
  detached.runtimeIdentity.pid += 1;
  assert.equal(identity.pid, 1234);
});

test("Windows isolation evidence rejects claimed or broadened token authority and detaches nested values", () => {
  const isolated = { ...identity, schemaVersion: 2, isolation: { kind: "windows-lpac", appContainerSid: "S-1-15-2-1-2-3-4-5-6-7", integritySid: "S-1-16-4096",
    noAllApplicationPackages: 1, capabilitySids: [WINDOWS_REGISTRY_READ_CAPABILITY_SID], allApplicationPackagesAccessGranted: false } };
  assert.equal(isWindowsRuntimeIdentity(isolated), true);
  for (const isolation of [{ ...isolated.isolation, noAllApplicationPackages: 0 }, { ...isolated.isolation, allApplicationPackagesAccessGranted: true },
    { ...isolated.isolation, integritySid: "S-1-16-8192" }, { ...isolated.isolation, capabilitySids: ["S-1-15-3-1"] }, { ...isolated.isolation, configuredOnly: true }]) {
    assert.equal(isWindowsRuntimeIdentity({ ...isolated, isolation }), false);
  }
  const copied = executionIdentityFields({ runtimeIdentity: isolated, assetVersion: 2, verificationKind: "test" });
  copied.runtimeIdentity.isolation.capabilitySids[0] = "S-1-15-3-1";
  assert.equal(isolated.isolation.capabilitySids[0], WINDOWS_REGISTRY_READ_CAPABILITY_SID);
  const getter = { ...isolated };Object.defineProperty(getter, "schemaVersion", { get() { assert.fail("proof must not evaluate accessors"); }, enumerable: true });
  assert.equal(isWindowsRuntimeIdentity(getter), false);
});
