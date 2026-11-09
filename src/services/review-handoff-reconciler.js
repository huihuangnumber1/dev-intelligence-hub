import { OperationQueue } from "../lib/operation-queue.js";
import { normalizeAbortSignal, runStructuredProviderRequest } from "../lib/structured-provider-request.js";

function failure(code) {
  return Object.assign(new Error(code), { code });
}

function diagnostic(error, fallback) {
  return typeof error?.code === "string" && /^[A-Z][A-Z0-9_]{0,127}$/.test(error.code) ? error.code : fallback;
}

function bounded(operation, timeoutMs, signal, controller = new AbortController()) {
  return runStructuredProviderRequest({
    controller, timeoutMs, signal, operation,
    cancellationError: () => failure("REVIEW_HANDOFF_CANCELLED"),
    timeoutError: () => failure("REVIEW_HANDOFF_TIMEOUT"),
  });
}

// The confirmation owns the durable intent; the owner-request service owns the
// idempotent local dispatch. A lost acknowledgement replays only local submit.
export class ReviewHandoffReconciler {
  constructor({
    confirmations,
    ownerWorkRequests,
    githubAssignee = null,
    testingOwnersByProduct = null,
    automaticAssignmentsEnabled = true,
    timeoutMs = 10_000,
    cycleTimeoutMs = timeoutMs + 5_000,
  }) {
    if (![timeoutMs, cycleTimeoutMs].every((value) => Number.isSafeInteger(value) && value > 0)) {
      throw new TypeError("handoff deadlines must be positive integers");
    }
    this.confirmations = confirmations;
    this.ownerWorkRequests = ownerWorkRequests;
    if (
      githubAssignee !== null &&
      typeof githubAssignee?.assignAssignee !== "function"
    ) {
      throw new TypeError("githubAssignee must provide assignAssignee");
    }
    this.githubAssignee = githubAssignee;
    this.testingOwners = testingOwnersByProduct;
    this.automaticAssignmentsEnabled = automaticAssignmentsEnabled;
    this.operations = new OperationQueue();
    this.timeoutMs = timeoutMs;
    this.cycleTimeoutMs = cycleTimeoutMs;
    this.inFlight = new Map();
    this.pendingRead = null;
    this.afterId = null;
  }

  runCycle({ signal = null, runOperation = (operation) => operation() } = {}) {
    normalizeAbortSignal(signal);
    if (typeof runOperation !== "function") throw new TypeError("runOperation must be a function");
    return this.operations.enqueue(async () => {
      if (signal?.aborted) return [];
      const deadline = performance.now() + this.cycleTimeoutMs;
      if (!this.pendingRead) {
        const read = Promise.resolve().then(() => runOperation(() => this.confirmations.readReviewHandoffs({ afterId: this.afterId })));
        this.pendingRead = read;
        read.then(() => { this.pendingRead = null; }, () => { this.pendingRead = null; });
      }
      const read = this.pendingRead;
      const pending = await bounded(() => read, this.cycleTimeoutMs, signal);
      const results = [];
      for (const item of pending) {
        const remainingMs = deadline - performance.now();
        // Leave the cursor before a deferred item so a slow retry cannot keep
        // giving the next handoff only the tail of this cycle's budget.
        if (signal?.aborted || remainingMs <= 0 || (results.length > 0 && remainingMs < this.timeoutMs)) break;
        this.afterId = item.id;
        // A deadline does not release the submit service's durable lease. Never
        // start a second attempt while the original operation is still settling.
        if (this.inFlight.has(item.request.requestId)) continue;
        const controller = new AbortController();
        const abortFromParent = () => controller.abort(signal.reason);
        signal?.addEventListener("abort", abortFromParent, { once: true });
        if (signal?.aborted) abortFromParent();
        try {
          const outcome = await bounded(() => {
            const attempt = Promise.resolve().then(() => runOperation(() => this.#dispatch(item, controller.signal)));
            this.inFlight.set(item.request.requestId, attempt);
            attempt.then(() => this.inFlight.delete(item.request.requestId), () => this.inFlight.delete(item.request.requestId));
            return attempt;
          }, Math.max(1, Math.min(this.timeoutMs, deadline - performance.now())), signal, controller);
          results.push({ id: item.id, status: outcome.status });
        } catch (error) {
          results.push({ id: item.id, status: "retrying", diagnosticCode: diagnostic(error, "REVIEW_HANDOFF_SUBMIT_FAILED") });
        } finally {
          signal?.removeEventListener("abort", abortFromParent);
        }
      }
      return results;
    });
  }

  async #dispatch(item, signal) {
    let outcome;
    let assignedLogin;
    const authorAssignment = item.automaticReview && ["REQUEST_CHANGES", "COMMENT"].includes(item.automaticReview.reviewEvent) &&
      (item.request.kind === "review_author_assignment" || item.request.workType === "pull_request");
    const testingAssignment = item.automaticReview?.reviewEvent === "APPROVE" && item.request.responsiblePerson &&
      (item.request.kind === "review_testing_assignment" || item.request.workType === "testing");
    const assignmentOnly = Boolean(authorAssignment || testingAssignment);
    try {
      if (item.automaticReview && !this.automaticAssignmentsEnabled) throw failure("REVIEW_HANDOFF_AUTOMATION_DISABLED");
      if (item.request.kind === "review_author_assignment" && (!assignmentOnly ||
          item.request.headRefOid !== item.automaticReview.headRefOid || item.request.reviewEvent !== item.automaticReview.reviewEvent)) {
        throw failure("REVIEW_HANDOFF_ASSIGNMENT_INVALID");
      }
      if (item.request.kind === "review_testing_assignment" && (!testingAssignment ||
          item.request.headRefOid !== item.automaticReview.headRefOid || item.request.reviewEvent !== "APPROVE")) {
        throw failure("REVIEW_HANDOFF_ASSIGNMENT_INVALID");
      }
      if (item.automaticReview?.reviewEvent === "APPROVE" && this.testingOwners !== null) {
        const person = item.request.responsiblePerson;
        if (!person || !this.testingOwners[person.product]?.some((login) => login.toLowerCase() === person.login.toLowerCase())) throw failure("REVIEW_HANDOFF_OWNER_REMOVED");
      }
      const result = assignmentOnly ? null : await this.ownerWorkRequests.submit(item.request, { signal });
      if (!assignmentOnly && (result?.phase !== "intaken" || !result.workItemId || !result.assignment?.target?.id)) {
        throw failure("REVIEW_HANDOFF_NOT_INTAKEN");
      }
      if (item.automaticReview && ["APPROVE", "REQUEST_CHANGES", "COMMENT"].includes(item.automaticReview.reviewEvent)) {
        if (typeof this.githubAssignee?.assignReviewOutcome !== "function") throw failure("REVIEW_HANDOFF_ASSIGNMENT_UNAVAILABLE");
        const assignment = await this.githubAssignee.assignReviewOutcome({
          actorAccountId: item.actorAccountId, repository: item.request.pullRequest.repository,
          pullRequestNumber: item.request.pullRequest.number, ...item.automaticReview,
          testingOwnerLogin: item.request.responsiblePerson?.login || null,
        }, { signal });
        assignedLogin = assignment.assigneeLogin;
      } else if (
        this.githubAssignee !== null &&
        item.request.workType === "testing" &&
        item.request.responsiblePerson
      ) {
        await this.githubAssignee.assignAssignee({
          actorAccountId: item.actorAccountId,
          repository: item.request.pullRequest.repository,
          pullRequestNumber: item.request.pullRequest.number,
          assigneeLogin: item.request.responsiblePerson.login,
        }, { signal });
      }
      outcome = { status: "completed", diagnosticCode: null,
        workItemId: result?.workItemId ?? null, roleId: result?.assignment.target.id ?? null,
        ...(assignmentOnly ? { deliveryKind: "assignment_only" } : {}), ...(assignedLogin ? { assignedLogin } : {}) };
    } catch (error) {
      if (signal.aborted) throw error;
      outcome = { status: ["GITHUB_HANDOFF_HEAD_CHANGED", "GITHUB_HANDOFF_SELF_AUTHORED", "REVIEW_HANDOFF_OWNER_REMOVED", "REVIEW_HANDOFF_AUTOMATION_DISABLED"].includes(error?.code) ? "stale" : "retrying", diagnosticCode: diagnostic(error, "REVIEW_HANDOFF_SUBMIT_FAILED"), workItemId: null, roleId: null };
      if (assignmentOnly) outcome.deliveryKind = "assignment_only";
    }
    // Keep the accepted request ID even if the acknowledgement cannot be saved.
    try {
      await this.confirmations.recordReviewHandoff(item.id, item.request.requestId, outcome);
    } catch (cause) {
      throw Object.assign(failure("REVIEW_HANDOFF_ACK_FAILED"), { cause });
    }
    return outcome;
  }
}
