const MAX_BATCH = 100;

function bindPort(value, methods, name) {
  if (!value || methods.some((method) => typeof value[method] !== "function")) {
    throw new TypeError(`${name} is invalid`);
  }
  return Object.fromEntries(
    methods.map((method) => [method, value[method].bind(value)]),
  );
}

function cycleLimit(value = {}) {
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Object.prototype
  ) {
    throw new TypeError("runCycle options are invalid");
  }
  const keys = Reflect.ownKeys(value);
  if (keys.some((key) => key !== "limit")) {
    throw new TypeError("runCycle options are invalid");
  }
  const descriptor = Object.getOwnPropertyDescriptor(value, "limit");
  if (descriptor && (!descriptor.enumerable || !("value" in descriptor))) {
    throw new TypeError("runCycle options are invalid");
  }
  const limit = descriptor ? descriptor.value : 50;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_BATCH) {
    throw new TypeError(`limit must be between 1 and ${MAX_BATCH}`);
  }
  return limit;
}

function attentionCursor(summary) {
  if (
    summary === null ||
    typeof summary !== "object" ||
    Array.isArray(summary) ||
    !Number.isSafeInteger(summary.attentionCursor) ||
    summary.attentionCursor < 0
  ) {
    throw new TypeError("ledger attention checkpoint is invalid");
  }
  return summary.attentionCursor;
}

export class AttentionResultReconciler {
  #readOutbox;
  #getSummary;
  #applyAttentionBatch;
  #archiveRetired;
  #retryMaintenance;
  #inFlight = null;

  constructor({ attentionConsumer, attentionMaintenance = null, ledger } = {}) {
    this.#readOutbox = bindPort(
      attentionConsumer,
      ["readOutbox"],
      "attentionConsumer",
    ).readOutbox;
    const ledgerPort = bindPort(
      ledger,
      ["getSummary", "applyAttentionBatch"],
      "ledger",
    );
    this.#getSummary = ledgerPort.getSummary;
    this.#applyAttentionBatch = ledgerPort.applyAttentionBatch;
    this.#retryMaintenance = typeof attentionMaintenance?.retrySystemQuestions === "function"
      ? attentionMaintenance.retrySystemQuestions.bind(attentionMaintenance) : null;
    this.#archiveRetired = attentionMaintenance === null ? null : bindPort(
      attentionMaintenance, ["archiveRetired"], "attentionMaintenance",
    ).archiveRetired;
  }

  runCycle(options = {}) {
    if (this.#inFlight) return this.#inFlight;
    const limit = cycleLimit(options);
    const execution = Promise.resolve().then(() => this.#run(limit));
    const tracked = execution.finally(() => {
      if (this.#inFlight === tracked) this.#inFlight = null;
    });
    this.#inFlight = tracked;
    return tracked;
  }

  async #run(limit) {
    const checkpoint = attentionCursor(await this.#getSummary());
    const batch = await this.#readOutbox({
      afterSequence: checkpoint,
      limit,
    });
    // The inbox read is fully released before acquiring the ledger writer.
    const result = await this.#applyAttentionBatch(batch);
    await this.#retryMaintenance?.({ limit });
    await this.#archiveRetired?.();
    return result;
  }
}
