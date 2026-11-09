import { isDeepStrictEqual } from "node:util";
import { normalizeWorkflowEvent } from "../domain/workflow-events.js";

export class AutomaticRoleHandoffReader {
  #afterSubjectId = null;
  constructor({ ledger, github, account, clock = () => new Date() }) {
    Object.assign(this, { ledger, github, account, clock });
  }

  async read({ events }) {
    const candidates = await this.ledger.readAutomaticRoleHandoffCandidates({ events, afterSubjectId: this.#afterSubjectId });
    const handoffs = [];
    for (const candidate of candidates) {
      const event = candidate.event, target = event.payload.gitTarget;
      this.#afterSubjectId = event.subject.id;
      if (target.sourceAccountId.toLowerCase() !== this.account.toLowerCase() ||
          event.payload.author?.toLowerCase() !== this.account.toLowerCase()) continue;
      try {
        const facts = await this.github.readPullRequestRoleHandoffFacts({ repository: event.subject.repository,
          number: event.subject.number, account: this.account });
        if (facts.state !== "open" || facts.isDraft !== false || facts.reviewDecision !== "APPROVED" ||
            facts.author.toLowerCase() !== this.account.toLowerCase() || !isDeepStrictEqual(facts.gitTarget, target) ||
            !isDeepStrictEqual([...facts.assignees].map(x => x.toLowerCase()).sort(),
              [...(event.payload.assignees ?? [])].map(x => x.toLowerCase()).sort())) continue;
        // Facts are read outside the ledger/router leases. Intake compares the
        // sealed subject/root revisions again before transferring responsibility.
        handoffs.push(normalizeWorkflowEvent({ schemaVersion: 1, eventType: "pull_request.role_handoff",
          occurredAt: new Date(this.clock()).toISOString(), source: event.source, subject: event.subject,
          payload: { ...event.payload, roleHandoffProof: candidate.proofDigest } }));
      } catch {
        // A failed observation does not establish a new responsibility.
      }
    }
    return handoffs;
  }
}
