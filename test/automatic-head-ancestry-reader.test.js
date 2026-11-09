import assert from "node:assert/strict";
import test from "node:test";
import { AutomaticHeadAncestryReader, consumeHeadAncestryCredential } from "../src/services/automatic-head-ancestry-reader.js";
import { normalizeWorkflowEvent } from "../src/domain/workflow-events.js";

const clone = structuredClone, a = "a".repeat(40), b = "b".repeat(40), account = "runtime-user";
function fixture(count = 1) {
  let now = Date.parse("2026-11-09T01:00:00.000Z");
  const roots = [], events = [], calls = [], credentials = [];
  const target = headRefOid => ({ schemaVersion: 1, provider: "github", sourceAccountId: account,
    baseRepository: "acme/repo", baseRefName: "main", baseRefOid: "d".repeat(40),
    headRepository: "acme/repo", headRefName: "feature", headRefOid });
  for (let n = 1; n <= count; n++) {
    const event = normalizeWorkflowEvent({ schemaVersion: 1, eventType: "pull_request.observed",
      occurredAt: "2026-11-09T01:00:00.000Z", source: { provider: "github", scopeId: "github-dashboard" },
      subject: { id: `github:pr:acme/repo#${n}`, repository: "acme/repo", number: n },
      payload: { author: account, assignees: [account], relation: "authored", state: "open", isDraft: false,
        actionState: "action_now", nextAction: "address_review", headRefOid: b, gitTargetAvailable: true, gitTarget: target(b) } });
    const old = clone(event); old.payload.headRefOid = a; old.payload.gitTarget.headRefOid = a;
    roots.push({ itemId: `work-item-${n.toString(16).padStart(64, "0")}`, kind: "source_root", revision: 5,
      currentTarget: { type: "role", id: "developer" }, status: "blocked", statusReason: "pr_source_left_scope_pending_settlement",
      ownerId: null, leaseId: null, leaseUntil: null, activeIntentId: null, sourceQuarantine: null,
      source: { identity: { targetRoleId: "developer" }, workKey: `pr-work-${n.toString(16).padStart(64, "0")}`,
        inputRevision: 4, authorityEpoch: 1, pendingRevision: null, scope: { kind: "automatic", active: false },
        current: { event: old, inputDigest: "e".repeat(64), headRefOid: a }, revisions: [{ occurredAt: "2026-11-09T00:00:00.000Z" }] } });
    events.push(clone(event));
  }
  const f = { roots, events, calls, credentials, ancestor: () => true, liveHook: () => {}, recordHook: null };
  const ports = {
    ledger: {
      async readCandidates({ events: supplied, afterItemId }) {
        const ordered = roots.filter(root => supplied.some(e => e.subject.id === root.source.current.event.subject.id));
        const found = afterItemId ? ordered.findIndex(root => root.itemId > afterItemId) : 0, start = found < 0 ? 0 : found;
        return { items: [...ordered.slice(start), ...ordered.slice(0, start)].slice(0, 2)
          .map(root => ({ root: clone(root), event: supplied.find(e => e.subject.id === root.source.current.event.subject.id) })) };
      },
      async readItemForReconciliation({ itemId }) { return clone(roots.find(root => root.itemId === itemId)); },
    },
    github: {
      async readPullRequestRoleHandoffFacts(identity) {
        calls.push({ kind: "live", ...identity });
        const event = events.find(e => e.subject.number === identity.number);
        const facts = { state: "open", isDraft: false, author: account, assignees: [account], gitTarget: clone(event.payload.gitTarget) };
        f.liveHook(facts, calls.filter(c => c.kind === "live" && c.number === identity.number).length);
        return facts;
      },
      async isCommitAncestor(input) { calls.push({ kind: "ancestry", ...input }); return f.ancestor(input); },
    },
    async record(credential) {
      credentials.push(credential);
      if (f.recordHook) return f.recordHook(credential);
      return consumeHeadAncestryCredential(credential);
    }, account, clock: () => new Date(now),
  };
  f.reader = new AutomaticHeadAncestryReader(ports); f.ports = ports;
  f.read = () => f.reader.read({ events }); f.advance = ms => { now += ms; };
  return f;
}

test("Head ancestry producer seals two live reads around immutable OIDs and never exports its one-use credential", async () => {
  const f = fixture(), events = await f.read();
  assert.deepEqual(f.calls.map(c => c.kind), ["live", "ancestry", "live"]);
  assert.equal(f.calls[1].ancestorOid, a); assert.equal(f.calls[1].headRefOid, b);
  assert.deepEqual(events.map(e => e.eventType), ["pull_request.updated", "pull_request.created"]);
  assert.equal(Object.hasOwn(events[0].payload, "previousHeadRefOid"), false);
  assert.match(events[0].payload.headAncestryProof, /^head-ancestry-[a-f0-9]{64}$/);
  assert.equal(consumeHeadAncestryCredential(f.credentials[0]), null);
  assert.equal(consumeHeadAncestryCredential({ ...f.credentials[0] }), null);
  assert.equal(consumeHeadAncestryCredential(JSON.parse(JSON.stringify(f.credentials[0]))), null);
  assert.equal(Object.keys(f.reader).length, 0, "transport and writer cannot be replaced through public fields");
});

for (const variant of ["false", "unavailable", "owner", "account", "head", "base", "closed", "root-change"]) {
  test(`Head ancestry producer rejects an unproven or moving authority window (${variant})`, async () => {
    const f = fixture();
    if (variant === "false") f.ancestor = () => false;
    if (variant === "unavailable") f.ancestor = () => { throw Object.assign(new Error("Unavailable"), { code: "REMOTE_UNAVAILABLE" }); };
    f.liveHook = (facts, read) => {
      if (read !== 2) return;
      if (variant === "owner") facts.assignees = ["somebody"];
      if (variant === "account") facts.gitTarget.sourceAccountId = "somebody";
      if (variant === "head") facts.gitTarget.headRefOid = "c".repeat(40);
      if (variant === "base") facts.gitTarget.baseRefOid = "c".repeat(40);
      if (variant === "closed") facts.state = "closed";
      if (variant === "root-change") f.roots[0].revision++;
    };
    assert.deepEqual(await f.read(), []); assert.equal(f.credentials.length, 0);
  });
}

test("failed proof consumption burns the credential and a failed write only retries after its bounded cooldown", async () => {
  const f = fixture();
  f.recordHook = credential => { assert.ok(consumeHeadAncestryCredential(credential)); throw Object.assign(new Error("Write failed"), { code: "WORK_LEDGER_STATE_WRITE_FAILED" }); };
  assert.deepEqual(await f.read(), []);
  assert.equal(consumeHeadAncestryCredential(f.credentials[0]), null);
  await f.read(); assert.equal(f.credentials.length, 1);
  f.advance(60_001); await f.read(); assert.equal(f.credentials.length, 2);
  assert.equal(f.reader.readDiagnostics().lastFailure, "WORK_LEDGER_STATE_WRITE_FAILED");
});

test("two-candidate budget rotates past unprovable heads and revision noise cannot bypass negative caching", async () => {
  const f = fixture(5);
  f.ancestor = ({ headRefOid }) => headRefOid === "c".repeat(40);
  f.events[4].payload.headRefOid = "c".repeat(40); f.events[4].payload.gitTarget.headRefOid = "c".repeat(40);
  for (let round = 0; round < 3; round++) {
    const start = f.calls.length; await f.read(); assert.ok(f.calls.length - start <= 6);
  }
  assert.equal(f.credentials.length, 1, "later provable candidate gets an opportunity within three reads");
  const count = f.calls.length;
  for (const root of f.roots) { root.revision++; root.source.inputRevision++; }
  await f.read(); await f.read(); await f.read();
  assert.equal(f.calls.length, count, "observation-only revisions do not defeat the cooldown");
  f.events[0].payload.gitTarget.baseRefOid = "f".repeat(40);
  await f.read(); await f.read(); await f.read();
  assert.ok(f.calls.length > count, "a real target input change gets fresh verification immediately");
});

test("concurrent snapshots cannot duplicate a credential for the same fixed input", async () => {
  const f = fixture();
  const results = await Promise.all([f.read(), f.read()]);
  assert.equal(results.flat().length, 2); assert.equal(f.credentials.length, 1);
});
