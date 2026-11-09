import assert from "node:assert/strict";
import test from "node:test";
import { normalizeWorkflowEvent } from "../src/domain/workflow-events.js";
import { createAssignmentWorkItem, createGraphChildWorkItem } from "../src/services/work-ledger-records.js";
import { emptyWorkLedgerState } from "../src/services/work-ledger-state.js";
import { planWorkGraphReviewReplacement } from "../src/services/work-ledger-orchestration-commands.js";

const at = "2026-10-28T01:00:00.000Z", later = "2026-10-28T01:01:00.000Z";
function fixture() {
  const event = normalizeWorkflowEvent({ schemaVersion: 1, eventType: "issue.updated", occurredAt: at,
    source: { provider: "github", scopeId: "github:owner" },
    subject: { id: "github:acme/repo#42", repository: "acme/repo", number: 42 }, payload: { title: "Workflow repair" } });
  const root = createAssignmentWorkItem({ sequence: 1, event, assignment: { assignmentId: "workflow-assignment-review-root",
    eventId: event.eventId, target: { type: "role", id: "orchestrator" }, reason: "Owner requested review" } }, at);
  const contract = { revision: 1, acceptanceCriteria: [{ criterionId: "reviewed", description: "Verified Review evidence" }],
    expectedDeliverables: [{ deliverableId: "review", kind: "review-report", description: "Current Review evidence", required: true }] };
  const definition = { parentItemId: root.itemId, childKey: "original-review", work: { title: "Review", description: "Review bound changes" },
    target: { type: "role", id: "pr-engineer" }, dependsOnItemIds: [], acceptanceContract: contract, parentEvent: event, sourceBinding: null };
  const old = createGraphChildWorkItem(definition, at);
  old.status = "blocked"; old.statusReason = "decision_attempts_exhausted";
  const state = { ...emptyWorkLedgerState(), revision: 1, items: [root, old], intakeCursor: 1, sourceHighWatermark: 1 };
  const input = { authority: { actorId: "employee-orchestrator", scopeRootTaskId: root.itemId }, command: {
    parentTaskId: root.itemId, childKey: "review-reuse-stable", work: definition.work, target: definition.target,
    dependsOnTaskIds: [], acceptanceContract: contract, leaseId: null, expectedGraphRevision: 1,
    expectedTaskRevisions: [{ taskId: root.itemId, revision: root.revision }],
    reviewReplacement: { taskId: old.itemId, expectedTaskRevision: old.revision, reason: "Host verified current Review candidate" },
  } };
  return { state, input, root, old };
}

test("Review replacement cancels and creates in one immutable ledger mutation and retries idempotently", () => {
  const f = fixture(), before = structuredClone(f.state);
  const mutation = planWorkGraphReviewReplacement({ ...f, clock: () => later });
  assert.deepEqual(f.state, before);
  assert.equal(mutation.patch.items.find(item => item.itemId === f.old.itemId).status, "cancelled");
  assert.equal(mutation.patch.items.find(item => item.itemId === f.root.itemId).revision, f.root.revision + 1);
  const replacement = mutation.patch.items.find(item => item.itemId === mutation.result.taskId);
  assert.equal(replacement.status, "queued");
  assert.equal(replacement.currentTarget.id, "pr-engineer");
  assert.equal(replacement.graph.acceptanceContracts[0].expectedDeliverables[0].kind, "review-report");
  assert.deepEqual(mutation.timelineEvents.map(event => event.type), ["cancelled", "graph_child_created", "graph_parent_revised"]);
  const retained = planWorkGraphReviewReplacement({ state: { ...f.state, ...mutation.patch, revision: 2 }, input: f.input, clock: () => later });
  assert.equal(retained.write, false);
  assert.equal(retained.result.taskId, replacement.itemId);
});

test("failed cancellation or creation never mutates the original Review or creates a partial replacement", async (t) => {
  for (const [name, change] of [
    ["active old task", f => { f.old.status = "working"; }],
    ["paused old task", f => { f.old.status = "paused"; }],
    ["stale old revision", f => { f.input.command.reviewReplacement.expectedTaskRevision++; }],
    ["stale graph revision", f => { f.input.command.expectedGraphRevision++; }],
    ["creation parent revision mismatch", f => { f.input.command.expectedTaskRevisions[0].revision++; }],
    ["creation contract downgrade", f => { f.input.command.acceptanceContract.expectedDeliverables[0].kind = "text-report"; }],
    ["pending old intent", f => { f.old.activeIntentId = "pending-intent"; }],
    ["other scope", f => { f.input.authority.scopeRootTaskId = f.old.itemId; }],
    ["active ancestor", f => { f.root.status = "working"; }],
  ]) await t.test(name, () => {
    const f = fixture(); change(f); const before = structuredClone(f.state);
    assert.throws(() => planWorkGraphReviewReplacement({ ...f, clock: () => later }));
    assert.deepEqual(f.state, before);
  });
});
