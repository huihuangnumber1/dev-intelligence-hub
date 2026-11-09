import assert from "node:assert/strict";
import test from "node:test";
import { admissionEntityKeyForRequest, normalizeAdmissionEntityKey } from "../src/lib/model-admission-identity.js";

const reviewTarget = (number, head) => ({
  pullRequestNumber: number,
  gitTarget: { schemaVersion: 1, provider: "github", sourceAccountId: "owner",
    baseRepository: "Owner/Repo", headRepository: "fork/repo", baseRefName: "main", headRefName: "feature",
    baseRefOid: "a".repeat(40), headRefOid: head.repeat(40) },
});

test("canonical PR admission is independent of Head, fork and session policy", () => {
  const expected = "github:pull_request:owner/repo#42";
  assert.equal(admissionEntityKeyForRequest({ reviewTarget: reviewTarget(42, "b") }), expected);
  assert.equal(admissionEntityKeyForRequest({ reviewTarget: reviewTarget(42, "c"), sessionKey: "work-item:item-42" }), expected);
  assert.equal(admissionEntityKeyForRequest({ sessionKey: "github:pull_request:OWNER/REPO#42" }), expected);
  assert.notEqual(admissionEntityKeyForRequest({ reviewTarget: reviewTarget(43, "b") }), expected);
  assert.equal(admissionEntityKeyForRequest({ sessionKey: "code-job:job-42" }), "code-job:job-42");
  assert.equal(admissionEntityKeyForRequest({ admissionEntityKey: "work-item:item-42" }), "work-item:item-42");
});

test("admission cannot override a bound GitHub entity or review target", () => {
  for (const value of [
    { reviewTarget: reviewTarget(42, "b"), admissionEntityKey: "github:pull_request:owner/repo#43" },
    { reviewTarget: reviewTarget(42, "b"), sessionKey: "github:pull_request:owner/repo#43" },
    { admissionEntityKey: "code-job:job-42", sessionKey: "github:pull_request:owner/repo#42" },
  ]) assert.throws(() => admissionEntityKeyForRequest(value), /Admission entity differs/);
  for (const value of ["", "key\nother", "a".repeat(513)]) assert.throws(() => normalizeAdmissionEntityKey(value));
});
