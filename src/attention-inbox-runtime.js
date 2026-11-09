import { ProcessExclusiveGuard } from "./lib/process-exclusive-guard.js";
import { AttentionInbox } from "./services/attention-inbox.js";

const GUARD_NAME = "mydashboard-attention-inbox-v1";

function validateGuard(guard) {
  if (
    !guard ||
    typeof guard.acquire !== "function" ||
    typeof guard.run !== "function" ||
    typeof guard.close !== "function"
  ) {
    throw new TypeError("attention inbox guard is invalid");
  }
  return guard;
}

function frozenPort(methods) {
  return Object.freeze(methods);
}

export async function createAttentionInboxRuntime({
  store,
  clock,
  operationQueue,
  authority,
  createGuard = (options) => new ProcessExclusiveGuard(options),
} = {}) {
  if (typeof createGuard !== "function") {
    throw new TypeError("createGuard must be a function");
  }
  const guard = validateGuard(createGuard({ name: GUARD_NAME }));
  let closePromise = null;
  const close = () => {
    closePromise ||= Promise.resolve().then(() => guard.close());
    return closePromise;
  };
  try {
    await guard.acquire();
    const inbox = new AttentionInbox({
      store,
      exclusiveLease: guard,
      ...(clock ? { clock } : {}),
      ...(operationQueue ? { operationQueue } : {}),
      ...(authority ? { authority } : {}),
    });
    await inbox.recover();
    await inbox.archiveRetired();
    return Object.freeze({
      producer: frozenPort({ create: (value) => inbox.create(value) }),
      browser: frozenPort({
        readStatus: (options) => inbox.readStatus(options),
        next: (options) => inbox.next(options),
        listMaintenance: () => inbox.listMaintenance(),
        answer: (value) => inbox.answer(value),
        reject: (value) => inbox.reject(value),
        later: (value) => inbox.later(value),
      }),
      consumer: frozenPort({
        readOutbox: (options) => inbox.readOutbox(options),
      }),
      maintenance: frozenPort({ archiveRetired: () => inbox.archiveRetired(),
        retrySystemQuestions: (options) => inbox.retrySystemQuestions(options) }),
      close,
    });
  } catch (error) {
    try {
      await close();
    } catch {
      // Preserve the startup failure while the guard remains fail closed.
    }
    throw error;
  }
}
