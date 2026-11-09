import assert from "node:assert/strict";
import { inspect } from "node:util";
import test from "node:test";
import { createReviewSourceFailure, isReviewSourceFailure, normalizeLegacyReviewSourceFailure } from "../src/domain/review-source-failure.js";

test("review source failures retain private causes and immutable bounded public metadata", () => {
  const error = createReviewSourceFailure("PR_REVIEW_READ_FEEDBACK_UNAVAILABLE", new Error("private remote response"));
  assert.equal(isReviewSourceFailure(error), true);
  assert.equal(error.code, "PR_REVIEW_READ_FEEDBACK_UNAVAILABLE");
  assert.equal(error.statusCode, 503);
  assert.equal(error.message, "PR review feedback is unavailable");
  assert.deepEqual(Object.keys(error), ["code", "statusCode"]);
  assert.equal(Object.hasOwn(error, "cause"), false);
  assert.doesNotMatch(inspect(error), /private remote response/);
  assert.throws(() => { error.code = "STRUCTURED_PROVIDER_UNAVAILABLE"; }, TypeError);
  for (const code of ["PR_REVIEW_READ_NEW_FAILURE", "STRUCTURED_PROVIDER_UNAVAILABLE", "toString", null]) {
    assert.throws(() => createReviewSourceFailure(code), TypeError);
  }
});

test("source trust cannot be copied, serialized or forged and legacy compatibility is narrow", () => {
  const error = createReviewSourceFailure("PR_REVIEW_READ_FEEDBACK_UNAVAILABLE");
  for (const forged of [{ ...error }, structuredClone(error), Object.create(error), new Proxy(error, {}),
    { code: "PR_REVIEW_READ_UNAVAILABLE", domain: "source", retryable: true, infrastructure: true },
    Object.assign(new Error("private"), { code: "PR_REVIEW_READ_FEEDBACK_UNAVAILABLE", retryable: true })]) {
    assert.equal(isReviewSourceFailure(forged), false);
    assert.equal(normalizeLegacyReviewSourceFailure(forged), null);
  }
  const legacy = normalizeLegacyReviewSourceFailure(Object.assign(new Error("private legacy body"), {
    code: "PR_REVIEW_READ_HEAD_CHANGED", statusCode: 200, infrastructure: true,
  }));
  assert.equal(isReviewSourceFailure(legacy), true);
  assert.equal(legacy.code, "PR_REVIEW_READ_HEAD_CHANGED");
  assert.equal(legacy.statusCode, 409);
  assert.equal(legacy.message, "PR changed while its review source was being read");
  assert.equal(Object.hasOwn(legacy, "infrastructure"), false);
});
