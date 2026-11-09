import assert from "node:assert/strict";
import test from "node:test";
import { RoleWorkerDirectory } from "../src/services/role-worker-directory.js";

test('directory preserves an optional bound admission callback and rejects invalid ports',async()=>{
  const worker={roleId:'analyst',workerId:'analyst-worker',async view(){return {enabled:true,paused:false};},async decide(){},
    async withDecisionAdmission(input,operation){assert.equal(this,worker);assert.equal(input.item.itemId,'work-1');return operation();}};
  const resolved=await new RoleWorkerDirectory({workers:[worker],legacyOwnedRoleIds:[]}).resolve({type:'role',id:'analyst'});
  assert.equal(await resolved.withDecisionAdmission({item:{itemId:'work-1'}},async()=>42),42);
  assert.throws(()=>new RoleWorkerDirectory({workers:[{...worker,withDecisionAdmission:true}],legacyOwnedRoleIds:[]}),/admission is invalid/);
});

test("legacy PR ownership is always reserved from the new proactive loop", async () => {
  let legacyDecisionCalls = 0;
  const legacyEmployee = {
    async roleView() {
      return {
        id: "pr-reviewer",
        enabled: true,
        paused: false,
        revision: 0,
      };
    },
    async decide() {
      legacyDecisionCalls += 1;
    },
  };
  const directory = new RoleWorkerDirectory({
    legacyEmployeeRegistry: {
      get(id) {
        return id === "pr-reviewer" ? legacyEmployee : null;
      },
    },
  });

  const worker = await directory.resolve({ type: "role", id: "pr-reviewer" });

  assert.equal(worker.roleId, "pr-reviewer");
  assert.equal(worker.enabled, true);
  assert.equal(worker.paused, true);
  await assert.rejects(
    Promise.resolve().then(() => worker.decide()),
    (error) => error.code === "ROLE_OWNERSHIP_RESERVED",
  );
  assert.equal(legacyDecisionCalls, 0);
});

test("explicit workers expose only dynamic state and a bound decision port", async () => {
  const calls = [];
  const worker = {
    roleId: "requirements-analyst",
    workerId: "requirements-worker-1",
    enabled: true,
    async view() {
      assert.strictEqual(this, worker);
      return { enabled: this.enabled, paused: false };
    },
    async decide(input) {
      assert.strictEqual(this, worker);
      calls.push(input);
      return { ok: true };
    },
  };
  const directory = new RoleWorkerDirectory({
    workers: [worker],
    legacyOwnedRoleIds: [],
  });

  const resolved = await directory.resolve({
    type: "role",
    id: "requirements-analyst",
  });

  assert.deepEqual(
    {
      roleId: resolved.roleId,
      workerId: resolved.workerId,
      enabled: resolved.enabled,
      paused: resolved.paused,
    },
    {
      roleId: "requirements-analyst",
      workerId: "requirements-worker-1",
      enabled: true,
      paused: false,
    },
  );
  assert.deepEqual(await resolved.decide({ itemId: "work-1" }), { ok: true });
  assert.deepEqual(calls, [{ itemId: "work-1" }]);
  assert.equal(Object.isFrozen(resolved), true);
});

test("explicit workers preserve an optional bound availability port", async () => {
  const availabilityCalls = [];
  const worker = {
    roleId: "developer",
    workerId: "developer-worker-1",
    async view() {
      return { enabled: true, paused: false };
    },
    async decide() {
      return { ok: true };
    },
    async checkAvailability(input) {
      assert.strictEqual(this, worker);
      availabilityCalls.push(input);
    },
  };
  const directory = new RoleWorkerDirectory({
    workers: [worker],
    legacyOwnedRoleIds: [],
  });
  const resolved = await directory.resolve({ type: "role", id: "developer" });
  const input = { item: { itemId: "work-1" } };

  await resolved.checkAvailability(input);

  assert.deepEqual(availabilityCalls, [input]);
});

test("unknown, person, and node targets remain available for orchestrator fallback", async () => {
  const directory = new RoleWorkerDirectory({ legacyOwnedRoleIds: [] });

  assert.equal(
    await directory.resolve({ type: "role", id: "missing-role" }),
    null,
  );
  assert.equal(
    await directory.resolve({ type: "person", id: "local-owner" }),
    null,
  );
  assert.equal(
    await directory.resolve({ type: "node", id: "triage" }),
    null,
  );
});

test("directory rejects duplicate ownership and untrusted target accessors", async () => {
  const worker = (roleId) => ({
    roleId,
    workerId: `${roleId}-worker`,
    async view() {
      return { enabled: true, paused: false };
    },
    async decide() {},
  });
  assert.throws(
    () => new RoleWorkerDirectory({ workers: [worker("same"), worker("same")] }),
    /duplicated/,
  );
  assert.throws(
    () => new RoleWorkerDirectory({ workers: [worker("pr-reviewer")] }),
    /legacy-owned/,
  );

  let getterCalls = 0;
  const target = { type: "role" };
  Object.defineProperty(target, "id", {
    enumerable: true,
    get() {
      getterCalls += 1;
      return "pr-reviewer";
    },
  });
  const directory = new RoleWorkerDirectory();
  await assert.rejects(directory.resolve(target), /target is invalid/);
  assert.equal(getterCalls, 0);
});
