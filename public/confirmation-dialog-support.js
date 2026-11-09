const MAX_DEFERRED_CONFIRMATION_KEYS = 32;
const MAX_DEFERRED_CONFIRMATION_ID_LENGTH = 128;
const SHA1 = /^[a-f0-9]{40}$/;
const SHA256 = /^[a-f0-9]{64}$/;
const EXTERNAL_CONFIRMATION_ID =
  /^[A-Za-z0-9](?:[A-Za-z0-9._-]{0,126}[A-Za-z0-9])?$/;
const INTERNAL_CONFIRMATION_ID = /^attention-[a-f0-9]{64}$/;
const deferredConfirmationKinds = Object.freeze({
  external: Object.freeze({ binding: SHA256, id: EXTERNAL_CONFIRMATION_ID }),
  internal: Object.freeze({ binding: SHA256, id: INTERNAL_CONFIRMATION_ID }),
  responsibility: Object.freeze({ binding: SHA1 }),
  review: Object.freeze({ binding: SHA1 }),
});

export function shouldCloseExternalConfirmation(previous, current, automaticReviewEnabled = false) {
  if (!current || current.id !== previous?.id) return false;
  if (["completed", "stale", "rejected", "executing"].includes(current.status)) return true;
  if (current.status !== "pending") return false;
  if (SHA256.test(current.approvalBindingDigest || "") &&
      current.approvalBindingDigest !== previous.approvalBindingDigest) return true;
  return automaticReviewEnabled === true && current.kind === "github.work-proposal-review" &&
    current.display?.payload?.action?.type === "pull_request_review";
}

export function createExternalConfirmationReconciler({ readItem, getCurrent, onResolved }) {
  return createConfirmationReconciler({ readItem, getCurrent, onResolved,
    itemId: item => item.id,
    shouldClose: (previous, current, captured) => shouldCloseExternalConfirmation(previous, current, captured.automaticReviewEnabled) });
}

export function createInternalConfirmationReconciler({ readItem, getCurrent, onResolved }) {
  return createConfirmationReconciler({ readItem, getCurrent, onResolved,
    itemId: item => item.requestId,
    shouldClose: (previous, current) => Boolean(current && current.requestId === previous.requestId &&
      ["answered", "rejected", "archived"].includes(current.status)) });
}

function createConfirmationReconciler({ readItem, getCurrent, onResolved, itemId, shouldClose }) {
  let latestRead = 0;
  return async function reconcile() {
    const captured = getCurrent();
    if (!captured || captured.submitting) return false;
    const read = ++latestRead;
    let item;
    try { item = await readItem(itemId(captured.item)); }
    catch { return false; }
    const current = getCurrent();
    if (read !== latestRead || !current || current.submitting ||
        current.owner !== captured.owner || current.key !== captured.key ||
        current.requestSequence !== captured.requestSequence) return false;
    if (!shouldClose(captured.item, item, current)) return false;
    return onResolved(captured.owner);
  };
}

function isDeferredConfirmationKey(value) {
  if (typeof value !== "string") return false;
  const parts = value.split("\u0000");
  if (parts.length !== 3) return false;
  const [kind, id, binding] = parts;
  if (!Object.hasOwn(deferredConfirmationKinds, kind)) return false;
  const definition = deferredConfirmationKinds[kind];
  return (
    id.length > 0 &&
    id.length <= MAX_DEFERRED_CONFIRMATION_ID_LENGTH &&
    (!definition.id || definition.id.test(id)) &&
    definition.binding.test(binding)
  );
}

export function parseDeferredConfirmationKeys(serialized) {
  let keys;
  try {
    keys = JSON.parse(serialized);
  } catch {
    return [];
  }
  if (
    !Array.isArray(keys) ||
    keys.length > MAX_DEFERRED_CONFIRMATION_KEYS ||
    keys.some((key) => !isDeferredConfirmationKey(key))
  ) {
    return [];
  }
  return [...new Set(keys)];
}

function storableDeferredConfirmationKeys(keys) {
  if (keys === null || keys === undefined || !keys[Symbol.iterator]) return [];
  const stored = [];
  const seen = new Set();
  for (const key of keys) {
    if (!isDeferredConfirmationKey(key) || seen.has(key)) continue;
    seen.add(key);
    stored.push(key);
    if (stored.length === MAX_DEFERRED_CONFIRMATION_KEYS) break;
  }
  return stored;
}

export function createSessionDeferredConfirmationStore({
  getStorage,
  storageKey,
}) {
  function withStorage(operation, fallback) {
    try {
      const storage = getStorage();
      return storage ? operation(storage) : fallback;
    } catch {
      return fallback;
    }
  }

  return Object.freeze({
    load() {
      return withStorage(
        (storage) => parseDeferredConfirmationKeys(storage.getItem(storageKey)),
        [],
      );
    },

    save(keys) {
      return withStorage(
        (storage) => {
          storage.setItem(
            storageKey,
            JSON.stringify(storableDeferredConfirmationKeys(keys)),
          );
          return true;
        },
        false,
      );
    },

    clear() {
      return withStorage(
        (storage) => {
          storage.removeItem(storageKey);
          return true;
        },
        false,
      );
    },
  });
}

export function createConfirmationDialogOwnership() {
  let nextOwner = 0;
  let activeOwner = null;
  let submissionOwner = null;

  function isOwner(owner) {
    return Number.isSafeInteger(owner) && owner > 0;
  }

  function ownsSubmission(owner) {
    return (
      isOwner(owner) &&
      activeOwner === owner &&
      submissionOwner === owner
    );
  }

  function close(owner) {
    if (!isOwner(owner) || activeOwner !== owner) return false;
    activeOwner = null;
    if (submissionOwner === owner) submissionOwner = null;
    return true;
  }

  return Object.freeze({
    open() {
      activeOwner = ++nextOwner;
      submissionOwner = null;
      return activeOwner;
    },

    current() {
      return activeOwner;
    },

    ownsSubmission,

    beginSubmission(owner) {
      if (
        !isOwner(owner) ||
        activeOwner !== owner ||
        submissionOwner !== null
      ) {
        return false;
      }
      submissionOwner = owner;
      return true;
    },

    finishSubmission(owner) {
      if (!ownsSubmission(owner)) return false;
      submissionOwner = null;
      return true;
    },

    close,

    handleCloseEvent({ dialogOpen } = {}) {
      if (dialogOpen !== false || !isOwner(activeOwner)) return false;
      return close(activeOwner);
    },
  });
}
