import { isDeepStrictEqual } from "node:util";
import { normalizePullRequestExecutionBinding } from "../domain/pull-request-execution-binding.js";
import { ownReviewFeedbackDigest } from "../adapters/github-own-review-feedback.js";

const SHA256 = /^[a-f0-9]{64}$/;
const HEAD = /^[a-f0-9]{40,64}$/;

function contextError(code, message, cause) {
  return Object.assign(new Error(message, cause === undefined ? {} : { cause }), { code });
}

function stale() {
  return contextError("CODE_REVIEW_REPAIR_CONTEXT_STALE", "Own PR repair feedback no longer matches the current source Head and feedback digest");
}

export function normalizeReviewRepairFeedbackContext(value) {
  try {
    if (!value || Object.getPrototypeOf(value) !== Object.prototype ||
        Object.keys(value).sort().join(",") !== "feedback,headRefOid,reviewFeedbackDigest,schemaVersion" ||
        value.schemaVersion !== 1 || !HEAD.test(value.headRefOid) || !SHA256.test(value.reviewFeedbackDigest) ||
        !Array.isArray(value.feedback?.changeRequests) || !Array.isArray(value.feedback?.threads) ||
        value.feedback.changeRequests.length + value.feedback.threads.length < 1 ||
        ownReviewFeedbackDigest(value.feedback) !== value.reviewFeedbackDigest) throw stale();
    return structuredClone(value);
  } catch (cause) {
    if (cause.code === "CODE_REVIEW_REPAIR_CONTEXT_STALE") throw cause;
    throw stale();
  }
}

export function reviewRepairMessages(value) {
  if (value === undefined) return [];
  const context = normalizeReviewRepairFeedbackContext(value);
  const parts = [];
  let part = "";
  let bytes = 0;
  for (const character of JSON.stringify(context)) {
    const size = Buffer.byteLength(character, "utf8");
    if (bytes + size > 96 * 1024) {
      parts.push(part);
      part = "";
      bytes = 0;
    }
    part += character;
    bytes += size;
  }
  if (part) parts.push(part);
  // Leave room for system, ordinary task, and a possible validation retry.
  if (parts.length > 13) throw Object.assign(new Error("Complete own PR feedback exceeds the structured provider request envelope"), { code: "CODE_BRAIN_CONTEXT_TOO_LARGE", statusCode: 413 });
  return parts.map((content, index) => ({ role: "user", content: `Own PR repair feedback JSON part ${index + 1}/${parts.length}; concatenate all parts in order:\n${content}` }));
}

export class ReviewRepairContextReader {
  constructor({ github, executionContextReader }) {
    if (typeof github?.readOwnPullRequestFeedback !== "function" || typeof executionContextReader?.readPullRequestExecutionContext !== "function") throw new TypeError("review repair context dependencies are invalid");
    this.github = github;
    this.executionContextReader = executionContextReader;
  }

  async read({ job }) {
    const source = job?.grant?.executionSource;
    if (job?.grant?.schemaVersion !== 3 || source?.kind !== "review_repair") throw stale();
    const inputBinding = normalizePullRequestExecutionBinding(source.inputBinding);
    if (inputBinding.schemaVersion !== 2 || !isDeepStrictEqual(inputBinding, job.grant.inputBinding)) throw stale();
    return this.readBinding({ inputBinding });
  }

  async readBinding({ inputBinding: value }) {
    const inputBinding = normalizePullRequestExecutionBinding(value);
    if (inputBinding.schemaVersion !== 2) throw stale();
    let current;
    let live;
    let after;
    try {
      current = await this.executionContextReader.readPullRequestExecutionContext(inputBinding);
      if (!SHA256.test(current.reviewFeedbackDigest)) throw stale();
      live = await this.github.readOwnPullRequestFeedback({ repository: inputBinding.repository, number: inputBinding.pullRequestNumber, account: inputBinding.gitTarget.sourceAccountId });
      after = await this.executionContextReader.readPullRequestExecutionContext(inputBinding);
    } catch (cause) {
      if (cause.code === "CODE_REVIEW_REPAIR_CONTEXT_STALE") throw cause;
      throw contextError("CODE_REVIEW_REPAIR_CONTEXT_UNAVAILABLE", "Unable to read the complete current own PR repair feedback", cause);
    }
    const account = inputBinding.gitTarget.sourceAccountId.toLowerCase();
    if (!isDeepStrictEqual(current.inputBinding, inputBinding) || !isDeepStrictEqual(after.inputBinding, inputBinding) ||
        current.reviewFeedbackDigest !== after.reviewFeedbackDigest ||
        current.author?.toLowerCase() !== account || after.author?.toLowerCase() !== account ||
        live.author?.toLowerCase() !== account || live.currentUser?.toLowerCase() !== account ||
        live.state !== "open" || live.repo?.toLowerCase() !== inputBinding.repository.toLowerCase() ||
        live.number !== inputBinding.pullRequestNumber || live.headRefOid !== inputBinding.headRefOid ||
        live.reviewFeedbackAvailable !== true || !Number.isSafeInteger(live.reviewFeedbackCount) || live.reviewFeedbackCount < 1 ||
        live.reviewFeedbackDigest !== current.reviewFeedbackDigest) throw stale();
    return normalizeReviewRepairFeedbackContext({ schemaVersion: 1, headRefOid: inputBinding.headRefOid, reviewFeedbackDigest: current.reviewFeedbackDigest, feedback: live.feedback });
  }
}
