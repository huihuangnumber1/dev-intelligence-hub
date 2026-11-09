import { maintenanceAttentionCode } from "../domain/maintenance-attention.js";
import {
  assertAttentionAllowedKeys,
  attentionDigest,
  attentionError,
  cloneAttentionValue,
  normalizeAttentionBrowserResponse,
  normalizeAttentionRequest,
  normalizeAttentionTimestamp,
  safeAttentionInteger,
} from "../domain/attention-contract.js";
import {
  normalizeInternalDeferredOptions,
} from "../domain/attention-deferred-contract.js";
import { OperationQueue } from "../lib/operation-queue.js";
import {
  ATTENTION_INBOX_STATE_KEY,
  ATTENTION_STATE_LIMITS,
  archiveAttentionItem,
  attentionStateBytes,
  createAttentionItem,
  defaultAttentionState,
  normalizeAttentionState,
  projectAttentionReceipt,
  projectAttentionRequest,
  resolveAttentionItem,
} from "./attention-inbox-state.js";

const STATE_KEY = ATTENTION_INBOX_STATE_KEY;
const MAX_OUTBOX_BATCH = 100;

function inboxError(code, message, statusCode = 400) {
  return attentionError(code, message, statusCode);
}

function validateDependency(value, methods, name) {
  if (
    !value ||
    methods.some((method) => typeof value[method] !== "function")
  ) {
    throw new TypeError(`${name} is invalid`);
  }
}

function currentAuthority(value) {
  if (value === undefined || value === null) return async () => true;
  if (typeof value.isAttentionRequestCurrent === "function") {
    return value.isAttentionRequestCurrent.bind(value);
  }
  validateDependency(value, ["isCurrent"], "authority");
  return value.isCurrent.bind(value);
}

function sameValue(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function responsePortError(expected) {
  return inboxError(
    "INVALID_ATTENTION_RESPONSE",
    `该端口只接受 ${expected} 回答`,
  );
}

function capacityError() {
  return inboxError(
    "ATTENTION_CAPACITY_EXCEEDED",
    "内部请示队列已达到本地容量上限",
    507,
  );
}

function normalizeCursor(value = {}) {
  const error = inboxError(
    "INVALID_ATTENTION_CURSOR",
    "内部请示 outbox 游标无效",
  );
  assertAttentionAllowedKeys(
    value,
    ["afterSequence", "limit"],
    [],
    error,
  );
  return {
    afterSequence: safeAttentionInteger(
      Object.hasOwn(value, "afterSequence") ? value.afterSequence : 0,
      "afterSequence",
      { error },
    ),
    limit: safeAttentionInteger(
      Object.hasOwn(value, "limit") ? value.limit : 50,
      "limit",
      {
        minimum: 1,
        maximum: MAX_OUTBOX_BATCH,
        error,
      },
    ),
  };
}

export class AttentionInbox {
  constructor({
    store,
    exclusiveLease,
    operationQueue = new OperationQueue(),
    clock = () => new Date(),
    authority,
  } = {}) {
    validateDependency(store, ["read", "write"], "store");
    validateDependency(exclusiveLease, ["run"], "exclusiveLease");
    validateDependency(operationQueue, ["enqueue"], "operationQueue");
    if (typeof clock !== "function") throw new TypeError("clock must be a function");
    this.store = store;
    this.exclusiveLease = exclusiveLease;
    this.operationQueue = operationQueue;
    this.clock = clock;
    this.isCurrent = currentAuthority(authority);
    this.areCurrent = typeof authority?.areAttentionRequestsCurrent === "function"
      ? authority.areAttentionRequestsCurrent.bind(authority)
      : (bindings) => Promise.all(bindings.map((binding) => this.isCurrent(binding)));
    this.readRetirement = typeof authority?.readAttentionRequestRetirement === "function"
      ? authority.readAttentionRequestRetirement.bind(authority)
      : async () => null;
    this.retryMaintenance = typeof authority?.retrySystemMaintenanceQuestions === "function"
      ? authority.retrySystemMaintenanceQuestions.bind(authority) : async () => ({ retried: 0 });
    this.state = defaultAttentionState();
    this.ready = false;
  }

  recover() {
    return this.operationQueue.enqueue(() =>
      this.exclusiveLease.run(async () => {
        const durable = await this.store.read(STATE_KEY, defaultAttentionState());
        const recovered = normalizeAttentionState(durable);
        this.state = recovered;
        this.ready = true;
        return { revision: recovered.revision };
      }),
    );
  }

  create(value) {
    const request = normalizeAttentionRequest(value);
    const contentDigest = attentionDigest(request);
    const producerBindingDigest = attentionDigest({
      requestKey: request.requestKey,
      producer: request.producer,
    });
    return this.#mutate(async (state) => {
      const existing = state.items.find(
        (item) => item.producerBindingDigest === producerBindingDigest,
      );
      if (existing) {
        if (existing.contentDigest !== contentDigest) {
          throw inboxError(
            "ATTENTION_REQUEST_CONFLICT",
            "同一生产者 requestKey 已绑定不同内容",
            409,
          );
        }
        return {
          state,
          value: projectAttentionReceipt(existing, {
            includeProducerBinding: true,
          }),
          write: false,
        };
      }
      if (state.items.length >= ATTENTION_STATE_LIMITS.maximumItems) {
        throw capacityError();
      }
      const revision = state.revision + 1;
      const at = this.#nextTimestamp(state);
      const item = createAttentionItem(request, revision, at);
      const candidate = {
        ...state,
        revision,
        items: [...state.items, item],
      };
      this.#assertCapacity(candidate);
      return {
        state: candidate,
        value: projectAttentionReceipt(item, {
          includeProducerBinding: true,
        }),
        write: true,
      };
    });
  }

  readStatus(input) {
    return this.#query(() => {
      const error = inboxError("INVALID_ATTENTION_REQUEST", "内部请示状态查询无效");
      assertAttentionAllowedKeys(input, ["requestId"], ["requestId"], error);
      if (!/^attention-[a-f0-9]{64}$/.test(input.requestId)) throw error;
      const item = this.state.items.find(entry => entry.requestId === input.requestId);
      return item ? { requestId: item.requestId, status: item.status } : null;
    });
  }

  next(options) {
    return this.#query(async () => {
      const { deferred } = normalizeInternalDeferredOptions(options);
      const deferredBindings = new Set(
        deferred.map(
          (entry) => `${entry.requestId}\u0000${entry.contentDigest}`,
        ),
      );
      const candidates = this.state.items
        .filter(
          (entry) =>
            entry.status === "pending" &&
            maintenanceAttentionCode(entry) === null &&
            !deferredBindings.has(
              `${entry.requestId}\u0000${entry.contentDigest}`,
            ),
        )
        .sort(
          (left, right) =>
            left.timeline[0].revision - right.timeline[0].revision,
        );
      for (const item of candidates) {
        if (await this.#isCurrent(item)) return projectAttentionRequest(item);
      }
      return null;
    });
  }

  answer(value) {
    const response = normalizeAttentionBrowserResponse(value);
    if (!new Set(["text", "choice"]).has(response.answer.type)) {
      return Promise.reject(responsePortError("text 或 choice"));
    }
    return this.#resolve(response);
  }

  listMaintenance() {
    return this.#query(async () => {
      const candidates = this.state.items.filter((item) => item.status === "pending" && maintenanceAttentionCode(item) !== null);
      const current = await this.areCurrent(candidates.map((item) => ({
        requestKey: item.requestKey, producer: cloneAttentionValue(item.producer),
      })));
      const visible = candidates.filter((_item, index) => current[index] === true);
      return {
        items: visible.slice(0, 100).map((item) => ({ ...projectAttentionRequest(item), maintenanceCode: maintenanceAttentionCode(item) })),
        total: visible.length,
      };
    });
  }

  reject(value) {
    const response = normalizeAttentionBrowserResponse(value);
    if (response.answer.type !== "reject") {
      return Promise.reject(responsePortError("reject"));
    }
    return this.#resolve(response);
  }

  later(value) {
    const response = normalizeAttentionBrowserResponse(value);
    if (response.answer.type !== "later") {
      return Promise.reject(responsePortError("later"));
    }
    return this.#query(async () => {
      const item = this.#boundItem(this.state, response);
      if (item.status !== "pending") {
        throw inboxError(
          "ATTENTION_RESPONSE_CONFLICT",
          "内部请示已经处理，不能稍后回答",
          409,
        );
      }
      await this.#requireCurrent(item);
      return projectAttentionReceipt(item);
    });
  }

  archiveRetired() {
    return this.#mutate(async (state) => {
      let candidate = state;
      let archived = 0;
      for (const item of state.items) {
        if (item.status !== "pending") continue;
        const retirement = await this.readRetirement({
          requestKey: item.requestKey,
          producer: cloneAttentionValue(item.producer),
        });
        if (retirement === null) continue;
        const revision = candidate.revision + 1;
        const retired = archiveAttentionItem(item, retirement, revision, this.#nextTimestamp(candidate));
        candidate = {
          ...candidate, revision,
          items: candidate.items.map((entry) => entry.requestId === item.requestId ? retired : entry),
        };
        archived += 1;
      }
      if (archived > 0) this.#assertCapacity(candidate);
      return { state: candidate, value: { archived }, write: archived > 0 };
    });
  }

  retrySystemQuestions(options = {}) {
    const { limit } = normalizeCursor(options);
    // Keep answer persistence and automatic retirement mutually exclusive.
    // The ledger never calls the inbox while holding its mutation lease.
    return this.#mutate(async state => ({ state, write: false,
      value: await this.retryMaintenance({ limit,
        requestKeys: state.items.filter(item => item.status === "pending" && /^work-intent-[a-f0-9]{64}$/.test(item.requestKey))
          .map(item => item.requestKey) }),
    }));
  }

  readOutbox(options = {}) {
    return this.#query(() => {
      const { afterSequence, limit } = normalizeCursor(options);
      const highWatermark = this.state.nextOutboxSequence - 1;
      if (afterSequence > highWatermark) {
        throw inboxError(
          "INVALID_ATTENTION_CURSOR",
          "内部请示 outbox 游标超过高水位",
        );
      }
      const items = this.state.outbox
        .filter((entry) => entry.sequence > afterSequence)
        .slice(0, limit)
        .map(cloneAttentionValue);
      return {
        items,
        nextSequence: items.at(-1)?.sequence ?? afterSequence,
        highWatermark,
        oldestAvailableSequence: this.state.outbox[0]?.sequence ?? null,
      };
    });
  }

  #resolve(response) {
    return this.#mutate(async (state) => {
      const item = this.#boundItem(state, response, { allowTerminal: true });
      if (item.status !== "pending") {
        if (
          response.expectedRevision === item.result.requestRevision &&
          sameValue(response.answer, item.result.answer)
        ) {
          return {
            state,
            value: projectAttentionReceipt(item),
            write: false,
          };
        }
        throw inboxError(
          "ATTENTION_RESPONSE_CONFLICT",
          "内部请示已经由不同回答处理",
          409,
        );
      }
      await this.#requireCurrent(item);
      if (response.answer.type === "choice") {
        const validChoice = item.choices.some(
          (choice) => choice.id === response.answer.choiceId,
        );
        if (!validChoice) {
          throw inboxError(
            "ATTENTION_CHOICE_INVALID",
            "回答引用了未展示的选项",
            409,
          );
        }
      }
      if (state.outbox.length >= ATTENTION_STATE_LIMITS.maximumOutboxItems) {
        throw capacityError();
      }
      const revision = state.revision + 1;
      const at = this.#nextTimestamp(state);
      const resolved = resolveAttentionItem(
        item,
        response.answer,
        revision,
        at,
        state.nextOutboxSequence,
      );
      const candidate = {
        ...state,
        revision,
        nextOutboxSequence: state.nextOutboxSequence + 1,
        items: state.items.map((entry) =>
          entry.requestId === item.requestId ? resolved.item : entry,
        ),
        outbox: [...state.outbox, resolved.outbox],
      };
      this.#assertCapacity(candidate);
      return {
        state: candidate,
        value: projectAttentionReceipt(resolved.item),
        write: true,
      };
    });
  }

  #boundItem(state, response, { allowTerminal = false } = {}) {
    const item = state.items.find(
      (entry) => entry.requestId === response.requestId,
    );
    if (!item) {
      throw inboxError(
        "ATTENTION_REQUEST_NOT_FOUND",
        "内部请示不存在",
        404,
      );
    }
    if (item.status === "archived") {
      throw inboxError("ATTENTION_REQUEST_STALE", "原任务已经结束，该请示已归档", 409);
    }
    if (item.contentDigest !== response.contentDigest) {
      throw inboxError(
        "ATTENTION_CONTENT_CONFLICT",
        "内部请示显示内容已经变化",
        409,
      );
    }
    const expected = allowTerminal && item.result
      ? item.result.requestRevision
      : item.revision;
    if (response.expectedRevision !== expected) {
      throw inboxError(
        "ATTENTION_REVISION_CONFLICT",
        "内部请示版本已经变化",
        409,
      );
    }
    return item;
  }

  #isCurrent(item) {
    return this.isCurrent({
      requestKey: item.requestKey,
      producer: cloneAttentionValue(item.producer),
    });
  }

  async #requireCurrent(item) {
    if (await this.#isCurrent(item)) return;
    throw inboxError(
      "ATTENTION_REQUEST_STALE",
      "原任务已经结束或变化，不能继续回答该请示",
      409,
    );
  }

  #query(operation) {
    return this.operationQueue.enqueue(() => {
      this.#assertReady();
      return operation();
    });
  }

  #mutate(operation) {
    return this.operationQueue.enqueue(() => {
      this.#assertReady();
      return this.exclusiveLease.run(async () => {
        const durable = normalizeAttentionState(
          await this.store.read(STATE_KEY, defaultAttentionState()),
        );
        this.#acceptDurableState(durable);
        const change = await operation(durable);
        if (!change.write) return change.value;
        const candidate = normalizeAttentionState(change.state);
        await this.store.write(STATE_KEY, candidate);
        this.state = candidate;
        return change.value;
      });
    });
  }

  #acceptDurableState(durable) {
    if (durable.revision < this.state.revision) {
      throw inboxError(
        "ATTENTION_STATE_ROLLBACK",
        "内部请示持久化状态发生回退",
        500,
      );
    }
    if (
      durable.revision === this.state.revision &&
      !sameValue(durable, this.state)
    ) {
      throw inboxError(
        "ATTENTION_STATE_FORKED",
        "内部请示持久化状态发生分叉",
        500,
      );
    }
    this.state = durable;
  }

  #assertReady() {
    if (!this.ready) {
      throw inboxError(
        "ATTENTION_INBOX_NOT_READY",
        "内部请示队列尚未完成恢复",
        503,
      );
    }
  }

  #nextTimestamp(state) {
    const error = inboxError(
      "ATTENTION_CLOCK_INVALID",
      "内部请示时钟无效",
      500,
    );
    const at = normalizeAttentionTimestamp(this.clock(), error);
    if (state.revision > 0) {
      const latest = state.items.find((item) => item.revision === state.revision);
      if (!latest || Date.parse(at) < Date.parse(latest.updatedAt)) {
        throw error;
      }
    }
    return at;
  }

  #assertCapacity(candidate) {
    if (
      candidate.items.length > ATTENTION_STATE_LIMITS.maximumItems ||
      candidate.outbox.length > ATTENTION_STATE_LIMITS.maximumOutboxItems ||
      attentionStateBytes(candidate) > ATTENTION_STATE_LIMITS.maximumStateBytes
    ) {
      throw capacityError();
    }
  }
}
