import { normalizeAbortSignal } from "../lib/structured-provider-request.js";
import { normalizePullRequestExecutionBinding, samePullRequestExecutionBinding } from "../domain/pull-request-execution-binding.js";
import { samePullRequestGitTarget } from "../domain/git-tool-contract.js";
import { normalizePullRequestReadFacts, projectPullRequestReadFactsContext } from "../domain/pull-request-read-facts.js";
import { cloneWorkProposalValue, assertWorkProposalExactKeys } from "../domain/work-proposal-contract.js";
import { currentWorkItemEvent, currentWorkItemExecutionBinding } from "./work-ledger-pr-source.js";
import { createReviewSourceFailure as failure, withReviewSourceFailure } from "../domain/review-source-failure.js";

export function createLedgerReviewTaskReader(ledger) {
  if (typeof ledger?.readItemForReconciliation !== "function") throw new TypeError("Invalid review task reader");
  return Object.freeze({ async read({ taskId }) {
    const item = await ledger.readItemForReconciliation({ itemId: taskId });
    if (!item || item.currentTarget?.type !== "role" || item.sourceQuarantine != null) return null;
    const inputBinding = currentWorkItemExecutionBinding(item);
    return inputBinding === null ? null : { taskId: item.itemId, taskRevision: item.revision, roleId: item.currentTarget.id,
      status: item.status, inputBinding, event: currentWorkItemEvent(item) };
  } });
}

// Parent-only access to the complete feedback snapshot. A CLI receives only the
// read documents made from this result, never ledger or credential access.
export class BoundReviewFeedbackReader {
  #tasks;
  #facts;
  #authority;
  constructor({ taskReader, ledger, factsReader, inputAuthorityVerifier } = {}) {
    this.#tasks = taskReader ?? createLedgerReviewTaskReader(ledger);
    if (typeof this.#tasks?.read !== "function" || typeof factsReader?.refresh !== "function" ||
        typeof inputAuthorityVerifier?.verify !== "function") throw new TypeError("Invalid bound review feedback ports");
    this.#facts = factsReader;
    this.#authority = inputAuthorityVerifier;
  }
  async read(value, options = {}) {
    return this.#read(value, options, true);
  }
  async readCurrent(value, options = {}) {
    return this.#read(value, options, false);
  }
  async #read(value, options, requireDigest) {
    const signal = normalizeAbortSignal(options.signal ?? null);
    signal?.throwIfAborted();
    return withReviewSourceFailure(async () => {
      const request = cloneWorkProposalValue(value);
      assertWorkProposalExactKeys(request, ["taskId", "gitTarget", "pullRequestNumber", ...(requireDigest ? ["materialDigest"] : [])]);
      if (typeof request.taskId !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:/#-]{0,191}$/.test(request.taskId) ||
          (requireDigest && (typeof request.materialDigest !== "string" || !/^[a-f0-9]{64}$/.test(request.materialDigest)))) throw failure("PR_REVIEW_READ_ARGUMENT_INVALID");
      const task = await this.#tasks.read({ taskId: request.taskId });
      signal?.throwIfAborted();
      if (!task || task.taskId !== request.taskId || !["pr-engineer", "pr-reviewer"].includes(task.roleId) ||
          ["paused", "cancelled", "superseded"].includes(task.status)) throw failure("PR_REVIEW_READ_FEEDBACK_UNAVAILABLE");
      const binding = normalizePullRequestExecutionBinding(task.inputBinding);
      if (binding.schemaVersion !== 2 || binding.pullRequestNumber !== request.pullRequestNumber ||
          !samePullRequestGitTarget(binding.gitTarget, request.gitTarget)) throw failure("PR_REVIEW_READ_HEAD_CHANGED");
      const verify = async () => {
        const current = await this.#authority.verify(binding);
        signal?.throwIfAborted();
        if (!samePullRequestExecutionBinding(current, binding)) throw failure("PR_REVIEW_READ_HEAD_CHANGED");
      };
      await verify();
      const facts = normalizePullRequestReadFacts(await this.#facts.refresh({ executionBinding: binding, event: task.event },
        signal === null ? undefined : { signal }));
      signal?.throwIfAborted();
      if (!samePullRequestExecutionBinding(facts.identity.executionBinding, binding) ||
          (requireDigest && projectPullRequestReadFactsContext(facts).materialDigest !== request.materialDigest)) throw failure("PR_REVIEW_READ_MATERIAL_CHANGED");
      await verify();
      return facts;
    }, { signal, code: "PR_REVIEW_READ_FEEDBACK_UNAVAILABLE" });
  }
}
