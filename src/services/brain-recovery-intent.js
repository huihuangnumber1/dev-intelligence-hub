import { requiresBrainMaintenance } from "../domain/brain-failure-recovery.js";
import { legacyBrainRecoveryCode } from "../domain/legacy-brain-recovery.js";
import { hasExactLedgerKeys, ledgerDigest } from "./work-ledger-values.js";

const hostIntents = new WeakMap();

// Only a live host call can grant this capability. Model JSON and clones cannot.
export function createBrainRecoveryIntent(code, intent) {
  if (!requiresBrainMaintenance(code) || !isRetryIntent(intent)) throw new TypeError("Invalid host brain recovery intent");
  hostIntents.set(intent, { code, digest: ledgerDigest(intent) });
  return intent;
}

function isRetryIntent(intent) {
  return intent?.type === "ask_user" && intent.choices?.length === 1 && intent.choices[0].id === "configured-retry";
}

export function hostBrainRecoveryCode(intent) {
  const capability = hostIntents.get(intent);
  return capability && capability.digest === ledgerDigest(intent) ? capability.code : null;
}

function stampCore(outbox, code) {
  return { schemaVersion: 1, code, itemId: outbox.itemId, inputDigest: outbox.inputDigest,
    intentId: outbox.intentId, sourceBinding: outbox.sourceBinding };
}

export function createBrainRecoveryStamp(outbox, code) {
  if (code === null) return null;
  const core = stampCore(outbox, code);
  return { ...core, digest: ledgerDigest(core) };
}

export function validBrainRecoveryStamp(outbox) {
  const stamp = outbox.brainRecovery;
  if (stamp === null) return true;
  if (!hasExactLedgerKeys(stamp, ["schemaVersion", "code", "itemId", "inputDigest", "intentId", "sourceBinding", "digest"]) ||
      !requiresBrainMaintenance(stamp.code) || !isRetryIntent(outbox.intent)) return false;
  const core = stampCore(outbox, stamp.code);
  try {
    return ledgerDigest({ ...core, digest: ledgerDigest(core) }) === ledgerDigest(stamp);
  } catch { return false; }
}

export function brainRecoveryCode(outbox) {
  if (!outbox) return null;
  if (!Object.hasOwn(outbox, "brainRecovery")) return legacyBrainRecoveryCode(outbox.intent);
  return validBrainRecoveryStamp(outbox) ? outbox.brainRecovery?.code ?? null : null;
}

export function sameBrainRecoveryOrigin(existing, candidate) {
  if (Object.hasOwn(existing, "brainRecovery")) {
    return ledgerDigest(existing.brainRecovery) === ledgerDigest(candidate.brainRecovery);
  }
  // Ordinary historical retries retain absence; legacy maintenance cannot lend
  // its origin to a newly staged business intent with identical wording.
  return candidate.brainRecovery === null && brainRecoveryCode(existing) === null;
}
