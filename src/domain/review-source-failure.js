import { types as utilTypes } from "node:util";

// Source identity belongs to the reader. This bounded catalog also owns the
// public metadata; callers cannot supply messages, retry policy or HTTP bodies.
const DEFINITIONS = new Map([
  ["PR_REVIEW_READ_INCOMPLETE", [503, "PR review did not finish reading the complete change set", true]],
  ["PR_REVIEW_READ_UNAVAILABLE", [503, "PR review source is unavailable", true]],
  ["PR_REVIEW_READ_REFERENCED_MATERIAL_UNAVAILABLE", [503, "PR review referenced material is unavailable", true]],
  ["PR_REVIEW_READ_HEAD_CHANGED", [409, "PR changed while its review source was being read", true]],
  ["PR_REVIEW_READ_MATERIAL_CHANGED", [409, "PR review materials changed while they were being read", true]],
  ["PR_REVIEW_READ_FEEDBACK_UNAVAILABLE", [503, "PR review feedback is unavailable"]],
  ...[
    "PR_REVIEW_READ_ACCOUNT_CHANGED", "PR_REVIEW_READ_ARGUMENT_INVALID", "PR_REVIEW_READ_CONTENT_INVALID",
    "PR_REVIEW_READ_DESCRIPTION_INVALID", "PR_REVIEW_READ_DIFF_INCOMPLETE", "PR_REVIEW_READ_DIFF_INVALID",
    "PR_REVIEW_READ_DOCUMENT_INVALID", "PR_REVIEW_READ_FILES_INCOMPLETE", "PR_REVIEW_READ_FILES_INVALID",
    "PR_REVIEW_READ_METHOD_NOT_ALLOWED", "PR_REVIEW_READ_NOT_DIRECTORY", "PR_REVIEW_READ_NOT_FILE",
    "PR_REVIEW_READ_PATH_INVALID", "PR_REVIEW_READ_RANGE_INVALID", "PR_REVIEW_READ_REVISION_INVALID",
    "PR_REVIEW_READ_TOOL_NOT_ALLOWED", "OWN_PR_REPAIR_ORIGINAL_FEEDBACK_INVALID", "OWN_PR_REPAIR_ORIGINAL_FEEDBACK_UNAVAILABLE",
  ].map(code => [code, [503, code]]),
]);

// Membership cannot survive serialization, property copying or prototype
// forgery. Causes remain private even when an error is inspected or logged.
const FAILURES = new WeakMap();

export function createReviewSourceFailure(code, cause) {
  const definition = DEFINITIONS.get(code);
  if (!definition) throw new TypeError("Unknown PR review source failure");
  const [statusCode, message] = definition;
  const error = Object.assign(new Error(message), { code, statusCode });
  FAILURES.set(error, cause);
  return Object.freeze(error);
}

export function isReviewSourceFailure(error) {
  return FAILURES.has(error);
}

// Compatibility for errors accepted before readers carried trusted identity.
// Only the historical codes marked above qualify; prefixes and extra fields
// never confer source identity or recovery authority.
export function normalizeLegacyReviewSourceFailure(error) {
  if (!utilTypes.isNativeError(error)) return null;
  const code = Object.getOwnPropertyDescriptor(error, "code")?.value;
  return DEFINITIONS.get(code)?.[2] === true ? createReviewSourceFailure(code, error) : null;
}

export async function withReviewSourceFailure(operation, { signal = null, code = "PR_REVIEW_READ_UNAVAILABLE" } = {}) {
  try {
    signal?.throwIfAborted();
    return await operation();
  } catch (cause) {
    signal?.throwIfAborted();
    throw isReviewSourceFailure(cause) ? cause : createReviewSourceFailure(code, cause);
  }
}
