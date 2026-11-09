import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { ConfiguredTestRunner } from "../src/adapters/configured-test-runner.js";

async function fixture(t, { nativeOnly = false } = {}) {
  const root = await mkdtemp(path.join(tmpdir(), "configured-test-runner-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const calls = [];
  const windowsRunner = { getProfileFingerprint: (id) => `windows:${id}`,
    executionDirectory: (executionId, actionId) => path.join(root, `${executionId}-${actionId}`),
    run: async (request) => { calls.push(["windows", "run", request]); return "native-result"; },
    cleanup: async (request) => { calls.push(["windows", "cleanup", request]); } };
  const dockerRunner = { getProfileFingerprint: (id) => `docker:${id}`,
    run: async (request) => { calls.push(["docker", "run", request]); return "docker-result"; },
    cleanup: async () => { calls.push(["docker", "cleanup"]); throw new Error("Docker is offline"); } };
  const profiles = { native: { kind: "windows-test" }, build: { kind: "windows-build" }, ...(nativeOnly ? {} : { docker: { kind: "node-test" }, script: { kind: "node-script" } }) };
  return { root, calls, windowsRunner, dockerRunner, runner: new ConfiguredTestRunner({ dockerRunner: nativeOnly ? null : dockerRunner, windowsRunner, profiles }) };
}

test("configured runner dispatches fixed profiles and fingerprints by their trusted kind", async (t) => {
  const setup = await fixture(t);
  for (const [profileId, target] of [["native", "windows"], ["build", "windows"], ["docker", "docker"], ["script", "docker"]]) {
    assert.equal(setup.runner.getProfileFingerprint(profileId), `${target}:${profileId}`);
    assert.equal(await setup.runner.run({ profileId }), target === "windows" ? "native-result" : "docker-result");
  }
  await assert.rejects(setup.runner.run({ profileId: "unknown" }), { code: "SANDBOX_PROFILE_NOT_FOUND" });
});

test("settled preparation reads delegate only to the configured native runner", async t => {
  const setup = await fixture(t), request = { profileId: 'native', executionId: 'run', actionId: 'action' };
  assert.equal(await setup.runner.readSettledPreparationFailure(request), null);
  setup.windowsRunner.readSettledPreparationFailure = async value => { setup.calls.push(value); return { settled: true }; };
  assert.deepEqual(await setup.runner.readSettledPreparationFailure(request), { settled: true });
  for (const profileId of ['docker', 'script', 'unknown']) {
    assert.equal(await setup.runner.readSettledPreparationFailure({ ...request, profileId }), null);
  }
  assert.deepEqual(setup.calls, [request]);
});

test("durable Windows execution cleanup never depends on an offline Docker daemon", async (t) => {
  const setup = await fixture(t);
  const request = { executionId: "run", actionId: "action" };
  const directory = setup.windowsRunner.executionDirectory(request.executionId, request.actionId);
  await mkdir(directory);
  await writeFile(path.join(directory, "pending.json"), "{}");
  await setup.runner.cleanup(request);
  assert.deepEqual(setup.calls, [["windows", "cleanup", request]]);
});

test("cleanup preserves Docker ownership when no Windows execution exists", async (t) => {
  const setup = await fixture(t);
  await assert.rejects(setup.runner.cleanup({ executionId: "run", actionId: "action" }), /Docker is offline/);
  assert.deepEqual(setup.calls, [["docker", "cleanup"]]);
  const native = await fixture(t, { nativeOnly: true });
  await native.runner.cleanup({ executionId: "run", actionId: "action" });
  assert.equal(native.calls[0][0], "windows");
});

test('profile readiness delegates only to the configured Docker profile', async t => {
  const f = await fixture(t), request = { profileId: 'docker' };
  f.dockerRunner.readProfileReadiness = async value => { f.calls.push(value); return { ready: true }; };
  assert.deepEqual(await f.runner.readProfileReadiness(request), { ready: true });
  for (const profileId of ['native', 'build', 'unknown']) {
    assert.equal(await f.runner.readProfileReadiness({ profileId }), null);
  }
  assert.deepEqual(f.calls, [request]);
});
