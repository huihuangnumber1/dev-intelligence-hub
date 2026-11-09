import assert from "node:assert/strict";
import test from "node:test";
import { ConfirmationQueue } from "../src/services/confirmation-queue.js";
import { OperationQueue } from "../src/lib/operation-queue.js";
import { ReviewHandoffReconciler } from "../src/services/review-handoff-reconciler.js";
import { normalizeConfirmationState } from "../src/domain/confirmation-contract.js";

const selection = { workType: "testing", responsiblePerson: { login: "tester-one", product: "qt" } };
function fixture() {
  let state = null;
  let executions = 0;
  const store = { async read(_key, fallback) { return structuredClone(state ?? fallback); }, async write(_key, value) { state = structuredClone(value); } };
  const executor = { async execute() { executions++; return { status: "applied", receipt: { id: "review-42" } }; }, async reconcile() { return { status: "applied", receipt: { id: "review-42" } }; } };
  const create = () => new ConfirmationQueue({ store, executor, exclusiveLease: { run: (fn) => fn() }, operationQueue: new OperationQueue(), reviewHandoffPolicy: { testingOwnersByProduct: { qt: ["tester-one", "tester-two"] } } });
  return { create, executor, get executions() { return executions; }, state: () => structuredClone(state) };
}
function plan(overrides = {}) {
  const actor = { provider: "github", accountId: "owner" };
  const target = { provider: "github", resourceId: "acme/project#42", version: "a".repeat(40) };
  const action = { type: "pull_request_review", reviewEvent: "APPROVE", body: "Reviewed" };
  return { id: "review-handoff-42", kind: "github.work-proposal-review", requestedBy: { roleId: "pr-engineer", workItemId: "work-42" }, actor, target, action, display: { title: "Review", summary: "Review summary", actionLabel: "Publish", evidence: [], payload: { actor, target, action } }, ...overrides };
}
function request(item, extra = {}) {
  return { requestId: "approve-request-42", expectedQueueRevision: item.queueRevision, expectedItemRevision: item.itemRevision, displayedPayloadDigest: item.displayedPayloadDigest, approvalBindingDigest: item.approvalBindingDigest, ...extra };
}

test("approved handoff survives a lost browser response and restart before local dispatch", async () => {
  const f = fixture();
  let queue = f.create();
  await queue.recover();
  const item = await queue.enqueue(plan());
  await queue.approve(item.id, request(item, { reviewHandoff: selection }));
  assert.deepEqual(f.state().items[0].reviewHandoff.selection, selection);
  queue = f.create();
  await queue.recover();
  const pending = await queue.readReviewHandoffs();
  assert.equal(pending.length, 1);
  assert.equal(pending[0].request.responsiblePerson.login, "tester-one");
  assert.equal(pending[0].request.pullRequest.number, 42);
  assert.equal(f.executions, 1);
});

test('automatic approval assigns configured QA without creating a local testing request across restart', async () => {
  const f = fixture();
  let queue = f.create(); await queue.recover();
  const item = await queue.enqueue(plan());
  await queue.approve(item.id, request(item, { requestId: `auto-review-v1-${'a'.repeat(48)}`, reviewHandoff: selection }));
  queue = f.create(); await queue.recover();
  const [pending] = await queue.readReviewHandoffs();
  assert.equal(pending.request.kind, 'review_testing_assignment');
  assert.deepEqual(pending.request.responsiblePerson, selection.responsiblePerson);
  let assigned = 0;
  const reconciler = new ReviewHandoffReconciler({ confirmations: queue,
    ownerWorkRequests: { submit: async () => assert.fail('external QA handoff must not create local test work') },
    testingOwnersByProduct: { qt: ['tester-one'] },
    githubAssignee: { assignAssignee() { assert.fail('automatic handoff must use the current-Head assignment path'); }, async assignReviewOutcome(input) {
      assigned++; assert.equal(input.testingOwnerLogin, 'tester-one'); return { assigneeLogin: 'tester-one' };
    } },
  });
  assert.equal((await reconciler.runCycle())[0].status, 'completed');
  const handoff = f.state().items[0].reviewHandoff;
  assert.equal(handoff.deliveryKind, 'assignment_only');
  assert.equal(handoff.workItemId, null);
  assert.equal(handoff.roleId, null);
  assert.equal(handoff.assignedLogin, 'tester-one');
  queue = f.create(); await queue.recover();
  assert.deepEqual(await queue.readReviewHandoffs(), []);
  assert.equal(assigned, 1);
  assert.equal(f.executions, 1);
});

test("handoff is durable before external execution and immutable on duplicate approval", async () => {
  const f = fixture();
  f.executor.execute = async () => {
    assert.deepEqual(f.state().items[0].reviewHandoff.selection, selection);
    return { status: "applied", receipt: { id: "review-42" } };
  };
  const queue = f.create(); await queue.recover();
  const item = await queue.enqueue(plan());
  const input = request(item, { reviewHandoff: selection });
  await queue.approve(item.id, input);
  await queue.approve(item.id, input);
  await assert.rejects(queue.approve(item.id, { ...input, reviewHandoff: { ...selection, responsiblePerson: { login: "tester-two", product: "qt" } } }), { code: "CONFIRMATION_HANDOFF_CONFLICT" });
});

test("reject, non-Review, unconfigured people and missing testing owner cannot authorize handoff", async () => {
  const f = fixture(); const queue = f.create(); await queue.recover();
  const item = await queue.enqueue(plan());
  await assert.rejects(queue.reject(item.id, request(item, { reviewHandoff: selection })));
  await assert.rejects(queue.approve(item.id, request(item, { reviewHandoff: { ...selection, responsiblePerson: { product: "qt", login: "stranger" } } })));
  await assert.rejects(queue.approve(item.id, request(item, { reviewHandoff: { workType: "testing", responsiblePerson: null } })));
  const other = await queue.enqueue(plan({ id: "not-review", kind: "local.code-job-create" }));
  await assert.rejects(queue.approve(other.id, request(other, { reviewHandoff: selection })));
  assert.equal(f.executions, 0);
});

test("old clients work without handoff and cannot attach one after publication", async () => {
  const f = fixture(); const queue = f.create(); await queue.recover();
  const item = await queue.enqueue(plan());
  await queue.approve(item.id, request(item));
  assert.deepEqual(await queue.readReviewHandoffs(), []);
  await assert.rejects(queue.approve(item.id, request(item, { reviewHandoff: selection })), { code: "CONFIRMATION_HANDOFF_CONFLICT" });
});

test("own-PR development handoff preserves the trusted actor without requiring an external reviewer", async () => {
  const f = fixture(); const queue = f.create(); await queue.recover();
  const item = await queue.enqueue(plan());
  const development = { workType: "development", responsiblePerson: { login: "OWNER", product: "qt" } };
  await queue.approve(item.id, request(item, { reviewHandoff: development }));
  const [pending] = await queue.readReviewHandoffs();
  assert.equal(pending.request.schemaVersion, 4);
  assert.deepEqual(pending.request.responsiblePerson, development.responsiblePerson);
  assert.equal(f.executions, 1);
});

test("development handoff cannot nominate a different identity", async () => {
  const f = fixture(); const queue = f.create(); await queue.recover();
  const item = await queue.enqueue(plan());
  await assert.rejects(queue.approve(item.id, request(item, {
    reviewHandoff: { workType: "development", responsiblePerson: { login: "tester-one", product: "qt" } },
  })), { code: "INVALID_REVIEW_HANDOFF" });
  assert.equal(f.executions, 0);
});

test("local submit success followed by acknowledgement crash recovers the same idempotent task", async () => {
  const f = fixture(); let queue = f.create(); await queue.recover();
  const item = await queue.enqueue(plan());
  await queue.approve(item.id, request(item, { reviewHandoff: selection }));
  const requests = new Map(); let calls = 0;
  const ownerWorkRequests = { async submit(value) {
    calls++;
    if (!requests.has(value.requestId)) requests.set(value.requestId, { phase: "intaken", workItemId: "work-testing-42", assignment: { target: { id: "tester" } } });
    return requests.get(value.requestId);
  } };
  const crashing = new ReviewHandoffReconciler({ confirmations: { readReviewHandoffs: queue.readReviewHandoffs.bind(queue), recordReviewHandoff: async () => { throw new Error("power loss"); } }, ownerWorkRequests });
  assert.equal((await crashing.runCycle())[0].diagnosticCode, "REVIEW_HANDOFF_ACK_FAILED");
  queue = f.create(); await queue.recover();
  const recovered = new ReviewHandoffReconciler({ confirmations: queue, ownerWorkRequests });
  await Promise.all([recovered.runCycle(), recovered.runCycle()]);
  assert.equal(requests.size, 1); assert.equal(calls, 2); assert.equal(f.executions, 1);
  const completed = await queue.get(item.id);
  assert.equal(completed.reviewHandoff.status, "completed");
  assert.equal(completed.reviewHandoff.workItemId, "work-testing-42");
  assert.equal((await queue.list({})).items[0].reviewHandoff.status, "completed");
});

test("temporary dispatch failure persists diagnostics and retries after restart", async () => {
  const f = fixture(); let queue = f.create(); await queue.recover();
  const item = await queue.enqueue(plan());
  await queue.approve(item.id, request(item, { reviewHandoff: selection }));
  await new ReviewHandoffReconciler({ confirmations: queue, ownerWorkRequests: { async submit() { throw Object.assign(new Error("paused"), { code: "ROLE_PAUSED" }); } } }).runCycle();
  assert.equal((await queue.get(item.id)).reviewHandoff.diagnosticCode, "ROLE_PAUSED");
  queue = f.create(); await queue.recover();
  await new ReviewHandoffReconciler({ confirmations: queue, ownerWorkRequests: { async submit() { return { phase: "intaken", workItemId: "work-testing-42", assignment: { target: { id: "tester" } } }; } } }).runCycle();
  assert.equal((await queue.get(item.id)).reviewHandoff.status, "completed");
  assert.equal(f.executions, 1);
});

test("handoff recovery rotates beyond a full page of unacknowledged failures", async () => {
  const f = fixture(); const queue = f.create(); await queue.recover();
  for (let index = 0; index < 26; index++) {
    const item = await queue.enqueue(plan({ id: `review-${index}` }));
    await queue.approve(item.id, request(item, { requestId: `approve-${index}`, reviewHandoff: selection }));
  }
  const firstPage = await queue.readReviewHandoffs();
  assert.equal(firstPage.length, 25);
  const nextPage = await queue.readReviewHandoffs({ afterId: firstPage.at(-1).id });
  assert.equal(nextPage[0].id, "review-25");
  assert.equal(new Set(nextPage.map((item) => item.id)).size, 25);
});

test("unknown, rejected and stale Reviews never create follow-up tasks", async () => {
  const f = fixture();
  f.executor.execute = async () => ({ status: "unknown", code: "GITHUB_MARKER_ABSENT" });
  const queue = f.create(); await queue.recover();
  const item = await queue.enqueue(plan());
  const failed = await queue.approve(item.id, request(item, { reviewHandoff: selection }));
  assert.deepEqual(await queue.readReviewHandoffs(), []);
  await queue.reject(item.id, request(failed, { requestId: "reject-request-42" }));
  assert.deepEqual(await queue.readReviewHandoffs(), []);
  f.executor.execute = async () => ({ status: "stale", code: "HEAD_CHANGED" });
  const stale = await queue.enqueue(plan({ id: "review-stale-43" }));
  await queue.approve(stale.id, request(stale, { reviewHandoff: selection }));
  assert.deepEqual(await queue.readReviewHandoffs(), []);
});

test("persisted handoff cannot predate approval or claim completion before Review completion", async () => {
  const f = fixture(); const queue = f.create(); await queue.recover();
  const item = await queue.enqueue(plan());
  const pending = f.state();
  await queue.approve(item.id, request(item, { reviewHandoff: selection }));
  pending.items[0].reviewHandoff = f.state().items[0].reviewHandoff;
  assert.throws(() => normalizeConfirmationState(pending));
  const executing = f.state();
  executing.items[0].status = "executing";
  executing.items[0].receipt = null;
  executing.items[0].execution.outcome = "unknown";
  Object.assign(executing.items[0].reviewHandoff, { status: "completed", workItemId: "work-42", roleId: "tester" });
  assert.throws(() => normalizeConfirmationState(executing));
});
