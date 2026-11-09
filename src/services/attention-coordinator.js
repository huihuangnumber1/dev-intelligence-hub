import { normalizeUnifiedDeferredOptions } from "../domain/attention-deferred-contract.js";

function assertReadPort(value, name) {
  if (value !== null && value !== undefined && typeof value.next !== "function") {
    throw new TypeError(`${name}.next must be a function`);
  }
  return value || null;
}

function emptyProjection(externalQueueRevision, externalEnabled) {
  return {
    available: false,
    source: null,
    pendingCount: 0,
    externalEnabled,
    externalQueueRevision,
    item: null,
  };
}

export class AttentionCoordinator {
  #externalNext;
  #internalNext;
  #externalEnabled;

  constructor({ externalQueue = null, internalInbox = null } = {}) {
    const external = assertReadPort(externalQueue, "externalQueue");
    const internal = assertReadPort(internalInbox, "internalInbox");
    this.#externalEnabled = Boolean(external);
    this.#externalNext = external ? external.next.bind(external) : null;
    this.#internalNext = internal ? internal.next.bind(internal) : null;
    Object.freeze(this);
  }

  async next(options) {
    const hasOptions = options !== undefined;
    const deferred = normalizeUnifiedDeferredOptions(options);
    let externalQueueRevision = 0;
    let automaticReviews = {};
    if (this.#externalNext) {
      let external;
      if (hasOptions) {
        external = await this.#externalNext({ deferred: deferred.external });
      } else {
        external = await this.#externalNext();
      }
      externalQueueRevision = Number.isSafeInteger(external?.queueRevision)
        ? external.queueRevision
        : 0;
      if (external?.automaticReviewEnabled === true) {
        automaticReviews = { automaticReviewEnabled: true,
          systemManagedCount: Number.isSafeInteger(external.systemManagedCount) && external.systemManagedCount >= 0
            ? external.systemManagedCount : 0 };
      }
      if (external?.item) {
        return structuredClone({
          available: true,
          source: "external_confirmation",
          pendingCount: Number.isSafeInteger(external.pendingCount)
            ? external.pendingCount
            : 1,
          externalEnabled: true,
          externalQueueRevision,
          item: external.item,
          ...automaticReviews,
        });
      }
    }

    let internal = null;
    if (this.#internalNext) {
      internal = hasOptions
        ? await this.#internalNext({ deferred: deferred.internal })
        : await this.#internalNext();
    }
    if (!internal) {
      return { ...emptyProjection(externalQueueRevision, this.#externalEnabled), ...automaticReviews };
    }
    return structuredClone({
      available: true,
      source: "internal_request",
      pendingCount: 1,
      externalEnabled: this.#externalEnabled,
      externalQueueRevision,
      item: internal,
      ...automaticReviews,
    });
  }
}
