import { githubEntitySessionKey, normalizeSessionKey } from "./session-key.js";
import { normalizeReviewReadTarget } from "../domain/review-read-target.js";

// Scheduling identity is shared across roles/models. It never replaces the
// separate authorization-scoped session identity used for native history.
export function normalizeAdmissionEntityKey(value) {
  const key = normalizeSessionKey(value, "admissionEntityKey");
  const github = /^github:(pull_request|issue):(.+)#([1-9][0-9]*)$/u.exec(key);
  if (!github) return key;
  return githubEntitySessionKey({ kind: github[1], repository: github[2], number: Number(github[3]) });
}

export function admissionEntityKeyForRequest({ admissionEntityKey = null, sessionKey = null, reviewTarget = null } = {}) {
  const explicit = admissionEntityKey === null ? null : normalizeAdmissionEntityKey(admissionEntityKey);
  const session = sessionKey === null ? null : normalizeAdmissionEntityKey(sessionKey);
  if (reviewTarget !== null) {
    const target = normalizeReviewReadTarget(reviewTarget);
    const reference = githubEntitySessionKey({
      kind: "pull_request", repository: target.gitTarget.baseRepository, number: target.pullRequestNumber,
    });
    if ((explicit !== null && explicit !== reference) || (session?.startsWith("github:") && session !== reference)) {
      throw new TypeError("Admission entity differs from the bound review target");
    }
    return reference;
  }
  if (explicit !== null && session?.startsWith("github:") && explicit !== session) {
    throw new TypeError("Admission entity differs from the bound session entity");
  }
  return explicit ?? session;
}
