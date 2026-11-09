import { randomBytes } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { canonicalJsonDigest } from "../lib/canonical-json-digest.js";
import { normalizeWorkflowEvent } from "../domain/workflow-events.js";
import { createHeadAncestryReceipt, headAncestryEvent, headAncestryReentryEvent } from "../domain/head-ancestry-receipt.js";

const credentials = new WeakMap();
const MAX_ATTEMPTS = 2, MAX_CACHE = 128, RETRY_MS = 60_000;
const OWN_ACTIONS = new Set(["address_review", "fix_ci", "resolve_conflict"]);

// This capability is never serialized or returned by a reader/model port.
// Every attempt consumes it, including a stale input or failed persistence.
export function consumeHeadAncestryCredential(credential) {
  const receipt = credential && credentials.get(credential);
  if (!receipt) return null;
  credentials.delete(credential);
  return receipt;
}

export class AutomaticHeadAncestryReader {
  #ledger; #github; #record; #account; #clock; #cursor = null; #cache = new Map();
  #diagnostics = { attempts: 0, stored: 0, lastFailure: null };
  constructor({ ledger, github, record, account, clock = () => new Date() }) {
    this.#ledger = ledger; this.#github = github; this.#record = record;
    this.#account = account.toLowerCase(); this.#clock = clock;
  }
  readDiagnostics() { return { ...this.#diagnostics, cacheEntries: this.#cache.size }; }

  async read({ events }) {
    const current = new Map(events.filter(event => this.#eligible(event)).map(event => [event.subject.id, event]));
    if (!current.size) return [];
    const page = await this.#ledger.readCandidates({ events: [...current.values()], afterItemId: this.#cursor });
    const output = [];
    let attempts = 0;
    for (const { root, event } of page.items) {
      this.#cursor = root.itemId;
      const source = root.source;
      if (!event || !this.#candidate(root, event)) continue;
      const key = canonicalJsonDigest({ itemId: root.itemId, inputDigest: source.current.inputDigest, authorityEpoch: source.authorityEpoch,
        scope: source.scope, status: root.status, statusReason: root.statusReason, activeIntentId: root.activeIntentId,
        ownerId: root.ownerId, leaseId: root.leaseId, decision: root.decisionContext?.contentDigest ?? null,
        account: this.#account, payload: event.payload });
      const now = new Date(this.#clock()).getTime(), cached = this.#cache.get(key);
      if (cached && cached.until > now) { if (cached.events) output.push(...cached.events); continue; }
      if (attempts >= MAX_ATTEMPTS) continue;
      attempts++;
      this.#diagnostics.attempts = Math.min(Number.MAX_SAFE_INTEGER, this.#diagnostics.attempts + 1);
      // Install a bounded negative entry before I/O; concurrent snapshots cannot
      // duplicate the same remote proof or writer attempt.
      this.#remember(key, { until: now + RETRY_MS, events: null });
      try {
        const target = event.payload.gitTarget;
        const identity = { repository: event.subject.repository, number: event.subject.number, account: this.#account };
        const before = await this.#github.readPullRequestRoleHandoffFacts(identity);
        if (!this.#matches(before, event)) continue;
        if (await this.#github.isCommitAncestor({ repository: identity.repository,
          ancestorOid: source.current.headRefOid, headRefOid: target.headRefOid }) !== true) continue;
        const after = await this.#github.readPullRequestRoleHandoffFacts(identity);
        if (!this.#matches(after, event) || !isDeepStrictEqual(before, after)) continue;
        const latest = await this.#ledger.readItemForReconciliation({ itemId: root.itemId });
        if (!isDeepStrictEqual(root, latest)) continue;
        // A separate host event carries a receipt. Do not rewrite an observed
        // created/updated event or invent its previousHeadRefOid.
        const { previousHeadRefOid: _previous, headAncestryProof: _proof, ...payload } = event.payload;
        const bridge = normalizeWorkflowEvent({ schemaVersion: 1, eventType: "pull_request.updated", source: event.source,
          subject: event.subject, occurredAt: event.occurredAt, payload: { ...payload, changedFields: ["headRefOid"] } });
        const receipt = createHeadAncestryReceipt({ schemaVersion: 1, nonce: randomBytes(16).toString("hex"),
          rootItemId: root.itemId, rootRevision: root.revision, sourceWorkKey: source.workKey,
          sourceInputRevision: source.inputRevision, sourceInputDigest: source.current.inputDigest,
          authorityEpoch: source.authorityEpoch, ancestorHeadRefOid: source.current.headRefOid,
          event: bridge, recordedAt: new Date(this.#clock()).toISOString() });
        const credential = Object.freeze({}); credentials.set(credential, receipt);
        const stored = await this.#record(credential);
        if (!stored) continue;
        this.#diagnostics.stored = Math.min(Number.MAX_SAFE_INTEGER, this.#diagnostics.stored + 1);
        const emitted = [headAncestryEvent(stored), headAncestryReentryEvent(stored)];
        this.#remember(key, { until: now + RETRY_MS, events: emitted });
        output.push(...emitted);
      } catch (error) {
        this.#diagnostics.lastFailure = /^[A-Z][A-Z0-9_]{1,127}$/.test(error?.code) ? error.code : "HEAD_ANCESTRY_PROOF_UNAVAILABLE";
        // Unavailable refs, ambiguous ancestry, stale authority or a failed
        // optional receipt write preserve the original conservative path.
      }
    }
    return output;
  }

  #remember(key, entry) {
    this.#cache.set(key, entry);
    if (this.#cache.size > MAX_CACHE) this.#cache.delete(this.#cache.keys().next().value);
  }
  #eligible(event) {
    const p = event.payload;
    return event.source.provider === "github" && p.relation === "authored" && p.author?.toLowerCase() === this.#account &&
      p.assignees?.some(login => login.toLowerCase() === this.#account) && p.state === "open" && p.isDraft === false &&
      p.actionState === "action_now" && OWN_ACTIONS.has(p.nextAction) && p.gitTargetAvailable === true &&
      p.gitTarget?.sourceAccountId.toLowerCase() === this.#account;
  }
  #candidate(root, event) {
    const source = root.source, old = source?.current?.event, before = old?.payload?.gitTarget, target = event.payload.gitTarget;
    return root.kind === "source_root" && root.currentTarget?.id === "developer" &&
      source?.identity?.targetRoleId === "developer" && source.scope.kind === "automatic" && source.scope.active === false &&
      ["blocked", "waiting_external"].includes(root.status) && root.ownerId === null && root.leaseId === null &&
      root.leaseUntil === null && root.sourceQuarantine === null && source.pendingRevision === null &&
      event.source.scopeId === old.source.scopeId && event.subject.repository === old.subject.repository &&
      event.subject.number === old.subject.number && target.headRefOid !== source.current.headRefOid &&
      Date.parse(event.occurredAt) >= Date.parse(source.revisions.at(-1).occurredAt) && before &&
      ["provider", "sourceAccountId", "baseRepository", "baseRefName", "headRepository", "headRefName"]
        .every(key => before[key] === target[key]);
  }
  #matches(facts, event) {
    return facts.state === "open" && facts.isDraft === false && facts.author.toLowerCase() === this.#account &&
      facts.assignees.some(login => login.toLowerCase() === this.#account) &&
      isDeepStrictEqual(facts.gitTarget, event.payload.gitTarget) &&
      isDeepStrictEqual(facts.assignees.map(x => x.toLowerCase()).sort(), event.payload.assignees.map(x => x.toLowerCase()).sort());
  }
}
