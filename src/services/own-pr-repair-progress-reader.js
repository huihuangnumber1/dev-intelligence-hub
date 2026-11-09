import { AUTOMATIC_OWN_PR_REPAIR_STATE_KEY, normalizeAutomaticOwnPrRepairState } from "./automatic-own-pr-repair.js";

const SHA = /^[a-f0-9]{40,64}$/;
const DIGEST = /^[a-f0-9]{64}$/;
const MAX_COMPARISONS = 8;
const MAX_CACHED_ANCESTORS = 128;
const comparisonKey = (item, row) => `${item.repo}\0${row.commitOid}\0${item.headRefOid}`;

function covered(item, publications) {
  if (publications.some(row => row.feedbackDigest === item.reviewFeedbackDigest)) return true;
  const fingerprints = item.reviewFeedbackFingerprints;
  if (!Array.isArray(fingerprints) || !fingerprints.length || !fingerprints.every(value => DIGEST.test(value))) return false;
  const consumed = new Set(publications.flatMap(row => row.feedbackFingerprints ?? []));
  return fingerprints.every(value => consumed.has(value));
}

export class OwnPrRepairProgressReader {
  constructor({ store, github }) {
    this.store = store;
    this.github = github;
    this.verifiedAncestors = new Set();
    this.lastComparedKey = null;
  }

  async enrich(items, { signal } = {}) {
    // A cached projection never establishes current publication authority.
    const fresh = items.map(({ reviewRepairProgress: _previous, ...item }) => item);
    let published;
    try {
      published = normalizeAutomaticOwnPrRepairState(await this.store.read(AUTOMATIC_OWN_PR_REPAIR_STATE_KEY,
        { schemaVersion: 1, repairs: [], published: [] })).published;
    } catch {
      signal?.throwIfAborted();
      return fresh;
    }
    if (typeof this.github.isCommitAncestor !== "function") return fresh;
    const groups = [];
    for (const item of fresh) {
      signal?.throwIfAborted();
      if (item.kind !== "pull_request" || item.relation !== "authored" ||
          typeof item.author !== "string" || typeof item.currentUser !== "string" || item.author.toLowerCase() !== item.currentUser.toLowerCase() ||
          item.reviewFeedbackAvailable !== true || !Number.isSafeInteger(item.reviewFeedbackCount) || item.reviewFeedbackCount < 1 ||
          !DIGEST.test(item.reviewFeedbackDigest) || !SHA.test(item.headRefOid)) continue;
      const candidates = published.filter(row => row.repository === item.repo && row.number === item.number &&
        (row.feedbackDigest === item.reviewFeedbackDigest ||
          row.feedbackFingerprints?.some(value => item.reviewFeedbackFingerprints?.includes(value))))
        .sort((a, b) => Number(b.feedbackDigest === item.reviewFeedbackDigest) - Number(a.feedbackDigest === item.reviewFeedbackDigest));
      groups.push({ item, candidates });
    }
    const pending = [...new Set(groups.flatMap(({ item, candidates }) => candidates.map(row => comparisonKey(item, row))))]
      .filter(key => !this.verifiedAncestors.has(key));
    const start = pending.length ? (pending.indexOf(this.lastComparedKey) + 1) % pending.length : 0;
    const scheduled = Array.from({ length: Math.min(MAX_COMPARISONS, pending.length) },
      (_, index) => pending[(start + index) % pending.length]);
    const allowed = new Set(scheduled);
    this.lastComparedKey = scheduled.at(-1) ?? this.lastComparedKey;
    const ancestry = new Map();
    for (const { item, candidates } of groups) {
      signal?.throwIfAborted();
      const verified = [];
      for (const row of candidates) {
        const key = comparisonKey(item, row);
        if (!ancestry.has(key)) {
          if (this.verifiedAncestors.has(key)) {
            ancestry.set(key, true);
          } else {
            if (!allowed.has(key)) continue;
            try {
              ancestry.set(key, await this.github.isCommitAncestor({ repository: item.repo,
                ancestorOid: row.commitOid, headRefOid: item.headRefOid }, { signal }) === true);
              // Successful fixed-OID ancestry cannot change; failures must be retried.
              if (ancestry.get(key)) {
                this.verifiedAncestors.add(key);
                if (this.verifiedAncestors.size > MAX_CACHED_ANCESTORS) {
                  this.verifiedAncestors.delete(this.verifiedAncestors.values().next().value);
                }
              }
            } catch {
              signal?.throwIfAborted();
              ancestry.set(key, false);
            }
          }
        }
        if (!ancestry.get(key)) continue;
        verified.push(row);
        if (covered(item, verified)) {
          item.reviewRepairProgress = { status: "published", headRefOid: item.headRefOid,
            feedbackDigest: item.reviewFeedbackDigest, commitOids: [...new Set(verified.map(value => value.commitOid))] };
          break;
        }
      }
    }
    return fresh;
  }
}
