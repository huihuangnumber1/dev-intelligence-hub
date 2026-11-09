import { isDeepStrictEqual } from "node:util";
import { normalizeWorkflowEvent } from "../domain/workflow-events.js";
import { currentWorkItemExecutionBinding } from "./work-ledger-pr-source.js";

// This host-only reader repairs legacy automatic roots whose frozen exit was
// activated without its lifecycle proof. A fresh GitHub read must confirm exit.
export class AutomaticReviewScopeExitReader {
  #cursor = null;
  constructor({ ledger, github, account, clock = () => new Date() }) {
    Object.assign(this, { ledger, github, account, clock });
  }

  async read({ sourceScopeId }) {
    const readPage = () => this.ledger.listItems({ status: "queued", roleId: "pr-engineer", limit: 10,
      ...(this.#cursor === null ? {} : { cursor: this.#cursor }) });
    let page;
    try { page = await readPage(); }
    catch (error) {
      if (this.#cursor === null || error?.code !== "WORK_LEDGER_CURSOR_INVALID") throw error;
      this.#cursor = null; page = await readPage();
    }
    this.#cursor = page.nextCursor ?? null;
    const events = [];
    for (const item of page.items) {
      const source = item.source, event = source?.current?.event;
      if (item.kind !== "source_root" || item.status !== "queued" || item.activeIntentId !== null ||
          item.leaseId !== null || item.ownerId !== null || item.sourceQuarantine !== null || item.graph.deliveries.length !== 0 ||
          source?.kind !== "pull_request" || source.scope.kind !== "automatic" || source.scope.active !== true ||
          source.pendingRevision !== null || event?.eventType !== "pull_request.left_scope" ||
          event.source.provider !== "github" || event.source.scopeId !== sourceScopeId) continue;
      try {
        const binding = currentWorkItemExecutionBinding(item);
        if (binding?.schemaVersion !== 2 || binding.gitTarget.sourceAccountId.toLowerCase() !== this.account.toLowerCase()) continue;
        await this.ledger.verifyPullRequestExecutionBinding(binding);
        const facts = await this.github.readIncomingReviewRequest({ repository: binding.repository,
          number: binding.pullRequestNumber, account: this.account });
        if (facts?.kind !== "pull_request" || facts.incomingReviewFactsAvailable !== true ||
            !["open", "closed", "merged"].includes(facts.state?.toLowerCase()) ||
            typeof facts.isDraft !== "boolean" ||
            !(facts.reviewRecipient === null || typeof facts.reviewRecipient === "string") ||
            ![null, "assignee"].includes(facts.reviewReceivedVia) ||
            !/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/.test(facts.headRefOid || "")) continue;
        if (facts.state.toLowerCase() === "open" && facts.reviewRecipient?.toLowerCase() === this.account.toLowerCase() &&
            facts.reviewReceivedVia === "assignee") continue;
        const latest = await this.ledger.readItemForReconciliation({ itemId: item.itemId });
        if (!isDeepStrictEqual(latest, item)) continue;
        await this.ledger.verifyPullRequestExecutionBinding(binding);
        const { gitTarget: _oldTarget, ...payload } = event.payload;
        events.push(normalizeWorkflowEvent({ schemaVersion: 1, eventType: "pull_request.left_scope",
          occurredAt: new Date(this.clock()).toISOString(), source: event.source, subject: event.subject,
          payload: { ...payload, state: facts.state.toLowerCase(), headRefOid: facts.headRefOid,
            gitTargetAvailable: false, incomingReviewFactsAvailable: true,
            reviewRecipient: facts.reviewRecipient ?? null, reviewReceivedVia: facts.reviewReceivedVia ?? null } }));
      } catch {
        // Unavailable reads and concurrent changes do not prove scope loss.
      }
    }
    return events;
  }
}
