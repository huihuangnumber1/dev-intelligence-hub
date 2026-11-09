import { isDeepStrictEqual } from 'node:util';
import { automaticReviewEligibility } from '../domain/automatic-review-policy.js';
import { pullRequestGitTargetFromEvent } from '../domain/git-tool-contract.js';
import { normalizeWorkflowEvent } from '../domain/workflow-events.js';

// Complete host snapshots can reconnect a returning PR to its last accepted
// Head. Emit ordinary causal input, then lifecycle reentry; ledger cutover still
// owns settlement, current authority and whether the root may resume.
export class AutomaticReviewReentryReader {
  #cursor = null;

  constructor({ ledger, account, github = null, automaticReview = true, automaticOwnPrRepair = false }) {
    Object.assign(this, { ledger, account, github, automaticReview, automaticOwnPrRepair });
  }

  async read({ events }) {
    const current = new Map(events.filter(event => event.source.provider === 'github' &&
      ((this.automaticReview && automaticReviewEligibility({ ...event.payload, kind: 'pull_request' }, this.account, event.occurredAt) === null) ||
        this.#ownConflictEvent(event)))
      .map(event => [event.subject.id, event]));
    if (current.size === 0) return [];
    const readPage = () => this.ledger.listItems({ roleId: 'pr-engineer', status: 'blocked', order: 'newest', limit: 100,
      ...(this.#cursor === null ? {} : { cursor: this.#cursor }) });
    let page;
    try { page = await readPage(); }
    catch (error) {
      if (this.#cursor === null || error?.code !== 'WORK_LEDGER_CURSOR_INVALID') throw error;
      this.#cursor = null;
      page = await readPage();
    }
    this.#cursor = page.nextCursor ?? null;
    const recovered = [];
    for (const item of page.items) {
      const source = item.source, previous = source?.current?.event;
      if (item.kind !== 'source_root' || item.status !== 'blocked' || item.statusReason !== 'pr_source_left_scope' ||
          item.currentTarget?.id !== 'pr-engineer' || item.ownerId !== null || item.leaseId !== null ||
          item.activeIntentId !== null || item.sourceQuarantine !== null || item.graph.deliveries.length !== 0 ||
          source?.scope?.kind !== 'automatic' || source.scope.active !== false || source.pendingRevision !== null) continue;
      if (previous?.eventType !== 'pull_request.left_scope') {
        const lifecycle = source.revisions.find(revision => revision.eventId === source.scope.lastLifecycleEventId);
        if (lifecycle?.disposition !== 'accepted' || lifecycle.authorityEpochChanged !== true ||
            !(lifecycle.revision < source.activeRevision)) continue;
      }
      const event = current.get(previous.subject.id);
      if (!event || event.source.scopeId !== previous.source.scopeId ||
          event.subject.repository !== previous.subject.repository || event.subject.number !== previous.subject.number ||
          Date.parse(event.occurredAt) <= Date.parse(previous.occurredAt) ||
          Date.parse(event.occurredAt) < Date.parse(source.revisions.at(-1).occurredAt) ||
          event.payload.headRefOid === source.current.headRefOid) continue;
      const before = pullRequestGitTargetFromEvent(previous), after = pullRequestGitTargetFromEvent(event);
      if (!before || !after || !['provider', 'sourceAccountId', 'baseRepository']
        .every(key => before[key] === after[key]) || after.sourceAccountId.toLowerCase() !== this.account.toLowerCase()) continue;
      if (this.#ownConflictEvent(event) && (!await this.#verifyOwnConflict(event, after) ||
          typeof this.ledger.canReconnectOwnPullRequest !== 'function' ||
          !await this.ledger.canReconnectOwnPullRequest({ itemId: item.itemId, expectedRevision: item.revision, event }))) continue;
      const latest = await this.ledger.readItemForReconciliation({ itemId: item.itemId });
      if (!isDeepStrictEqual(latest, item)) continue;
      recovered.push(normalizeWorkflowEvent({ schemaVersion: 1, eventType: 'pull_request.updated',
        occurredAt: event.occurredAt, source: event.source, subject: event.subject,
        payload: { ...event.payload, changedFields: ['headRefOid'], previousHeadRefOid: source.current.headRefOid } }),
      normalizeWorkflowEvent({ schemaVersion: 1, eventType: 'pull_request.created',
        occurredAt: event.occurredAt, source: event.source, subject: event.subject, payload: event.payload }));
    }
    return recovered;
  }

  #ownConflictEvent(event) {
    const payload = event.payload;
    return this.automaticOwnPrRepair && payload.relation === 'authored' &&
      payload.author?.toLowerCase() === this.account.toLowerCase() &&
      payload.state === 'open' && payload.isDraft === false &&
      payload.actionState === 'action_now' && payload.nextAction === 'resolve_conflict' && payload.gitTargetAvailable === true;
  }

  async #verifyOwnConflict(event, target) {
    if (typeof this.github?.readPullRequestRoleHandoffFacts !== 'function') return false;
    try {
      const facts = await this.github.readPullRequestRoleHandoffFacts({ repository: event.subject.repository,
        number: event.subject.number, account: this.account });
      return facts.state === 'open' && facts.isDraft === false &&
        facts.author.toLowerCase() === this.account.toLowerCase() && isDeepStrictEqual(facts.gitTarget, target) &&
        isDeepStrictEqual(facts.assignees.map(login => login.toLowerCase()).sort(),
          (event.payload.assignees ?? []).map(login => login.toLowerCase()).sort());
    } catch {
      return false;
    }
  }
}
