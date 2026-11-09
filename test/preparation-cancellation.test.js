import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import test from "node:test";
import { preparationSignal, throwIfPreparationAborted, withPreparationCancellation,
  withoutPreparationCancellation, watchPreparationProcess } from "../src/lib/preparation-cancellation.js";

test("preparation cancellation is isolated across async sessions and cleanup exits the cancelled scope", async () => {
  const first = new AbortController(), second = new AbortController();
  first.abort();
  assert.throws(() => withPreparationCancellation(first.signal, async () => {}), { code: "CODE_PREPARATION_ABORTED" });
  await Promise.all([withPreparationCancellation(second.signal, async () => {
    await new Promise(resolve => setImmediate(resolve));
    assert.strictEqual(preparationSignal(), second.signal);
    second.abort();
    assert.throws(throwIfPreparationAborted, { code: "CODE_PREPARATION_ABORTED" });
    await withoutPreparationCancellation(async () => {
      await new Promise(resolve => setImmediate(resolve));
      assert.equal(preparationSignal(), null);
      throwIfPreparationAborted();
    });
    assert.strictEqual(preparationSignal(), second.signal);
  }), (async () => {
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(preparationSignal(), null);
  })()]);
  assert.equal(preparationSignal(), null);
});

test("cancellation asks only its owned preparation child to stop and leaves exit settlement with the caller", async t => {
  const controller = new AbortController();
  const child = spawn(process.execPath, ["-e", "process.stdout.write('ready');setInterval(()=>{},1000)"],
    { windowsHide: true, stdio: ["ignore", "pipe", "ignore"] });
  const closed = once(child, "close");
  t.after(async () => { if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL"); await closed; });
  await once(child.stdout, "data");
  await withPreparationCancellation(controller.signal, async () => {
    const release = watchPreparationProcess(child);
    controller.abort();
    await closed;
    assert.equal(release(), true);
    assert.ok(child.exitCode !== null || child.signalCode !== null);
    assert.throws(throwIfPreparationAborted, { code: "CODE_PREPARATION_ABORTED" });
  });
});
