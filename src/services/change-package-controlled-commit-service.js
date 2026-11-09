import { createHash } from "node:crypto";

import {
  createChangePackageControlledCommitReceipt,
  normalizeChangePackageControlledCommitReceipt,
  normalizeChangePackageControlledCommitRequest,
  sameChangePackageControlledCommitReceipt,
} from "../domain/change-package-controlled-commit.js";
import { normalizeChangePackageManifest, hasChangePackageChanges } from "../domain/change-package-contract.js";
import { isHeadRepairExecutionSource } from "../domain/code-execution-source.js";
import { digestValue } from "../domain/code-executor-contract.js";
import {
  normalizeControlledCommitEvidence,
} from "../domain/controlled-commit-evidence.js";
import { OperationQueue } from "../lib/operation-queue.js";

export const CHANGE_PACKAGE_CONTROLLED_COMMIT_STATE_KEY =
  "change-package-controlled-commits";
const STATE_KEY = CHANGE_PACKAGE_CONTROLLED_COMMIT_STATE_KEY;
const MAX_DELIVERIES = 1_000;
const EVIDENCE_ID = /^controlled-git-commit-[a-f0-9]{64}$/u;
const STATUSES = new Set(["intent", "evidence", "committed"]);

function isEmptyRepairPackage(request, manifest) {
  return isHeadRepairExecutionSource(request.executionSource) && !hasChangePackageChanges(manifest);
}

export class ChangePackageControlledCommitServiceError extends Error {
  constructor(code, message, { cause } = {}) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = "ChangePackageControlledCommitServiceError";
    this.code = code;
  }
}

function serviceError(code, message, cause) {
  return new ChangePackageControlledCommitServiceError(code, message, { cause });
}

function exact(value, keys, message) {
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Object.prototype
  ) {
    throw serviceError("INVALID_CONTROLLED_COMMIT_DELIVERY", message);
  }
  const actual = Reflect.ownKeys(value);
  if (
    actual.length !== keys.length ||
    keys.some((key) => !actual.includes(key)) ||
    actual.some((key) => {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      return typeof key !== "string" ||
        !descriptor?.enumerable ||
        !("value" in descriptor);
    })
  ) {
    throw serviceError("INVALID_CONTROLLED_COMMIT_DELIVERY", message);
  }
  return value;
}

function denseArray(value, maximum, message) {
  if (
    !Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Array.prototype ||
    value.length > maximum ||
    Reflect.ownKeys(value).length !== value.length + 1
  ) {
    throw serviceError("INVALID_CONTROLLED_COMMIT_DELIVERY", message);
  }
  return value.map((entry, index) => {
    const descriptor = Object.getOwnPropertyDescriptor(value, `${index}`);
    if (!descriptor?.enumerable || !("value" in descriptor)) {
      throw serviceError("INVALID_CONTROLLED_COMMIT_DELIVERY", message);
    }
    return entry;
  });
}

function methodDescriptor(value, name) {
  let owner = value;
  while (owner !== null && owner !== Object.prototype) {
    const descriptor = Object.getOwnPropertyDescriptor(owner, name);
    if (descriptor) return descriptor;
    owner = Object.getPrototypeOf(owner);
  }
  return null;
}

function requirePort(value, methods, name) {
  if (!value || (typeof value !== "object" && typeof value !== "function")) {
    throw new TypeError(`${name} does not implement its required contract`);
  }
  return Object.freeze(Object.fromEntries(methods.map((method) => {
    const descriptor = methodDescriptor(value, method);
    if (!descriptor || !("value" in descriptor) ||
        typeof descriptor.value !== "function") {
      throw new TypeError(`${name} does not implement its required contract`);
    }
    return [method, (...args) => Reflect.apply(descriptor.value, value, args)];
  })));
}

function requestProjection(request) {
  return {
    eventId: request.eventId,
    eventDigest: request.eventDigest,
    packageId: request.packageId,
    packageDigest: request.packageDigest,
    executionSource: structuredClone(request.executionSource),
    recordedAt: request.recordedAt,
  };
}

function normalizeRecord(value) {
  exact(
    value,
    ["request", "status", "evidenceId", "receipt"],
    "controlled commit delivery record 无效",
  );
  let request;
  let receipt;
  try {
    request = normalizeChangePackageControlledCommitRequest(value.request);
    receipt = value.receipt === null
      ? null
      : normalizeChangePackageControlledCommitReceipt(value.receipt);
  } catch (cause) {
    throw serviceError(
      "CONTROLLED_COMMIT_DELIVERY_STATE_CORRUPTED",
      "controlled commit delivery 状态损坏",
      cause,
    );
  }
  const evidenceId = value.evidenceId === null ? null : value.evidenceId;
  if (
    !STATUSES.has(value.status) ||
    (evidenceId !== null &&
      (typeof evidenceId !== "string" || !EVIDENCE_ID.test(evidenceId))) ||
    (value.status === "intent" && (evidenceId !== null || receipt !== null)) ||
    (value.status === "evidence" && (evidenceId === null || receipt !== null)) ||
    (value.status === "committed" &&
      (evidenceId === null || receipt === null ||
        receipt.evidenceId !== evidenceId ||
        receipt.deliveryId !== request.deliveryId))
  ) {
    throw serviceError(
      "CONTROLLED_COMMIT_DELIVERY_STATE_CORRUPTED",
      "controlled commit delivery 状态损坏",
    );
  }
  return {
    request: requestProjection(request),
    status: value.status,
    evidenceId,
    receipt,
  };
}

function defaultState() {
  return { schemaVersion: 1, revision: 0, deliveries: [] };
}

function normalizeState(value) {
  try {
    exact(
      value,
      ["schemaVersion", "revision", "deliveries"],
      "controlled commit delivery state 无效",
    );
    if (
      value.schemaVersion !== 1 ||
      !Number.isSafeInteger(value.revision) ||
      value.revision < 0
    ) {
      throw serviceError(
        "CONTROLLED_COMMIT_DELIVERY_STATE_CORRUPTED",
        "controlled commit delivery 状态损坏",
      );
    }
    const deliveries = denseArray(
      value.deliveries,
      MAX_DELIVERIES,
      "controlled commit delivery state 无效",
    ).map(normalizeRecord);
    const ids = deliveries.map(({ request }) =>
      normalizeChangePackageControlledCommitRequest(request).deliveryId);
    if (
      value.revision < deliveries.length ||
      new Set(ids).size !== ids.length
    ) {
      throw serviceError(
        "CONTROLLED_COMMIT_DELIVERY_STATE_CORRUPTED",
        "controlled commit delivery 状态损坏",
      );
    }
    return { schemaVersion: 1, revision: value.revision, deliveries };
  } catch (cause) {
    if (cause?.code === "CONTROLLED_COMMIT_DELIVERY_STATE_CORRUPTED") {
      throw cause;
    }
    throw serviceError(
      "CONTROLLED_COMMIT_DELIVERY_STATE_CORRUPTED",
      "controlled commit delivery 状态损坏",
      cause,
    );
  }
}

export function normalizeControlledCommitDeliveryPersistedState(value) {
  return normalizeState(value);
}

function sameValue(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function findRecord(state, deliveryId) {
  return state.deliveries.find(({ request }) =>
    normalizeChangePackageControlledCommitRequest(request).deliveryId ===
      deliveryId) ?? null;
}

function evidenceLookup(request, manifest) {
  return {
    executionSource: request.executionSource,
    manifest,
    createdAt: request.recordedAt,
  };
}

function evidenceRequest(request, manifest, blobs) {
  return { ...evidenceLookup(request, manifest), blobs };
}

function contentSha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

export class ChangePackageControlledCommitService {
  #packageReader;
  #builder;
  #store;
  #exclusiveLease;
  #operationQueue;
  #state = defaultState();
  #ready = false;

  constructor({
    packageReader,
    controlledCommitBuilder,
    store,
    exclusiveLease,
    operationQueue = new OperationQueue(),
  } = {}) {
    this.#packageReader = requirePort(
      packageReader,
      ["get", "readFile"],
      "packageReader",
    );
    this.#builder = requirePort(
      controlledCommitBuilder,
      ["create", "find", "verify", ...(typeof Object.getOwnPropertyDescriptor(controlledCommitBuilder, "readSealed")?.value === "function" ? ["readSealed"] : [])],
      "controlledCommitBuilder",
    );
    this.#store = requirePort(store, ["read", "write"], "store");
    this.#exclusiveLease = requirePort(
      exclusiveLease,
      ["run"],
      "exclusiveLease",
    );
    this.#operationQueue = requirePort(
      operationQueue,
      ["enqueue"],
      "operationQueue",
    );
  }

  delivery() {
    return Object.freeze({ deliver: this.deliver.bind(this) });
  }

  recover() {
    return this.#operationQueue.enqueue(() =>
      this.#exclusiveLease.run(async () => {
        this.#ready = false;
        try {
          await this.#reload();
          this.#ready = true;
          let committed = 0;
          let pending = 0;
          const stalePreparationDeliveryIds = [];
          const emptyChangeDeliveryIds = [];
          for (const original of [...this.#state.deliveries]) {
            const request = normalizeChangePackageControlledCommitRequest(
              original.request,
            );
            const manifest = await this.#loadManifest(request);
            const record = findRecord(this.#state, request.deliveryId);
            // Empty repair packages cannot produce a controlled commit. Retain
            // historical unexecuted intents without blocking unrelated startup.
            if (record.status === "intent" && isEmptyRepairPackage(request, manifest)) {
              emptyChangeDeliveryIds.push(request.deliveryId);
              pending += 1;
              continue;
            }
            let recovered;
            try {
              recovered = record.status === "committed" && this.#builder.readSealed
                ? await this.#verifyCommitted(record, request, manifest, { localOnly: true })
                : await this.#recoverRecord(record, request, manifest);
            } catch (error) {
              // Historical preparation drift is not current delivery authority.
              // deliver() still verifies the record before returning a receipt.
              if (error?.code !== "CONTROLLED_GIT_BOUNDARY_CHANGED") throw error;
              stalePreparationDeliveryIds.push(request.deliveryId);
              pending += 1;
              continue;
            }
            if (recovered.status === "committed") committed += 1;
            else pending += 1;
          }
          return Object.freeze({
            deliveries: this.#state.deliveries.length,
            committed,
            pending,
            ...(emptyChangeDeliveryIds.length > 0 ? { emptyChangeDeliveryIds: Object.freeze(emptyChangeDeliveryIds) } : {}),
            ...(stalePreparationDeliveryIds.length > 0
              ? { stalePreparationDeliveryIds: Object.freeze(stalePreparationDeliveryIds) }
              : {}),
          });
        } catch (error) {
          this.#ready = false;
          throw error;
        }
      }),
    );
  }

  deliver(value) {
    let request;
    try {
      request = normalizeChangePackageControlledCommitRequest(value);
    } catch (cause) {
      return Promise.reject(serviceError(
        "INVALID_CONTROLLED_COMMIT_DELIVERY",
        "controlled commit delivery request 无效",
        cause,
      ));
    }
    return this.#run(async () => {
      const manifest = await this.#loadManifest(request);
      if (isEmptyRepairPackage(request, manifest)) {
        throw serviceError("CONTROLLED_COMMIT_DELIVERY_NO_CHANGES", "代码包没有实际变更，不能创建修复提交");
      }
      let record = findRecord(this.#state, request.deliveryId);
      if (record !== null && !sameValue(record.request, requestProjection(request))) {
        throw serviceError(
          "CONTROLLED_COMMIT_DELIVERY_BINDING_CONFLICT",
          "controlled commit delivery 绑定冲突",
        );
      }
      if (record === null) {
        record = await this.#replace(null, {
          request: requestProjection(request),
          status: "intent",
          evidenceId: null,
          receipt: null,
        });
      }
      record = await this.#recoverRecord(record, request, manifest);
      if (record.status !== "committed") {
        const evidence = await this.#createAfterLookup(request, manifest);
        record = await this.#bindEvidence(record, request, manifest, evidence);
        record = await this.#verifyAndCommit(record, request, manifest);
      }
      return structuredClone(record.receipt);
    });
  }

  #run(operation) {
    return this.#operationQueue.enqueue(() =>
      this.#exclusiveLease.run(async () => {
        this.#assertReady();
        try {
          await this.#reload();
        } catch (error) {
          this.#ready = false;
          throw error;
        }
        return operation();
      }),
    );
  }

  async #recoverRecord(record, request, manifest) {
    if (record.status === "committed") {
      return this.#verifyCommitted(record, request, manifest);
    }
    if (record.status === "evidence") {
      return this.#verifyAndCommit(record, request, manifest);
    }
    const found = await this.#builder.find(evidenceLookup(request, manifest));
    if (found === null) return record;
    const bound = await this.#bindEvidence(record, request, manifest, found);
    return this.#verifyAndCommit(bound, request, manifest);
  }

  async #createAfterLookup(request, manifest) {
    const lookup = evidenceLookup(request, manifest);
    const blobs = await this.#loadBlobs(manifest);
    try {
      return await this.#builder.create(
        evidenceRequest(request, manifest, blobs),
      );
    } catch (failure) {
      const recovered = await this.#builder.find(lookup);
      if (recovered !== null) return recovered;
      throw failure;
    }
  }

  async #bindEvidence(record, request, manifest, value) {
    const evidence = this.#normalizeBoundEvidence(request, manifest, value);
    if (record.status === "evidence") {
      if (record.evidenceId !== evidence.evidenceId) {
        throw serviceError(
          "CONTROLLED_COMMIT_DELIVERY_BINDING_CONFLICT",
          "controlled commit evidence 绑定冲突",
        );
      }
      return record;
    }
    return this.#replace(record, {
      request: requestProjection(request),
      status: "evidence",
      evidenceId: evidence.evidenceId,
      receipt: null,
    });
  }

  async #verifyAndCommit(record, request, manifest) {
    const verified = this.#normalizeBoundEvidence(
      request,
      manifest,
      await this.#builder.verify({ evidenceId: record.evidenceId }),
    );
    const receipt = createChangePackageControlledCommitReceipt(
      requestProjection(request),
      verified,
    );
    return this.#replace(record, {
      request: requestProjection(request),
      status: "committed",
      evidenceId: verified.evidenceId,
      receipt,
    });
  }

  async #verifyCommitted(record, request, manifest, { localOnly = false } = {}) {
    const verified = this.#normalizeBoundEvidence(
      request,
      manifest,
      await (localOnly ? this.#builder.readSealed : this.#builder.verify)({ evidenceId: record.evidenceId }),
    );
    const expected = createChangePackageControlledCommitReceipt(
      requestProjection(request),
      verified,
    );
    if (!sameChangePackageControlledCommitReceipt(expected, record.receipt)) {
      throw serviceError(
        "CONTROLLED_COMMIT_DELIVERY_STATE_CORRUPTED",
        "controlled commit delivery receipt 与 sealed evidence 不一致",
      );
    }
    return record;
  }

  #normalizeBoundEvidence(request, manifest, value) {
    let evidence;
    try {
      evidence = normalizeControlledCommitEvidence(value);
      createChangePackageControlledCommitReceipt(
        requestProjection(request),
        evidence,
      );
    } catch (cause) {
      throw serviceError(
        "CONTROLLED_COMMIT_DELIVERY_EVIDENCE_INVALID",
        "controlled commit evidence 无效",
        cause,
      );
    }
    if (
      !sameValue(evidence.package.job, manifest.job) ||
      !sameValue(evidence.package.proposal, manifest.proposal) ||
      !sameValue(evidence.package.grant, manifest.grant) ||
      evidence.package.changeSetDigest !== digestValue(manifest.changes) ||
      !sameValue(evidence.workspace, manifest.workspace)
    ) {
      throw serviceError(
        "CONTROLLED_COMMIT_DELIVERY_EVIDENCE_INVALID",
        "controlled commit evidence 未绑定 exact manifest",
      );
    }
    return evidence;
  }

  async #loadManifest(request) {
    let manifest;
    try {
      manifest = normalizeChangePackageManifest(
        await this.#packageReader.get(request.packageId),
      );
    } catch (cause) {
      throw serviceError(
        "CONTROLLED_COMMIT_DELIVERY_PACKAGE_UNAVAILABLE",
        "sealed change package 不可用",
        cause,
      );
    }
    if (
      manifest.packageId !== request.packageId ||
      manifest.packageDigest !== request.packageDigest
    ) {
      throw serviceError(
        "CONTROLLED_COMMIT_DELIVERY_BINDING_CONFLICT",
        "sealed change package 与 delivery request 不一致",
      );
    }
    return manifest;
  }

  async #loadBlobs(manifest) {
    const references = new Map();
    for (const change of [
      ...manifest.changes.created,
      ...manifest.changes.modified,
    ]) {
      if (!references.has(change.blob.sha256)) {
        references.set(change.blob.sha256, {
          path: change.path,
          bytes: change.blob.bytes,
        });
      }
    }
    const blobs = [];
    for (const [sha256, reference] of references) {
      const value = await this.#packageReader.readFile({
        packageId: manifest.packageId,
        path: reference.path,
      });
      if (!(Buffer.isBuffer(value) || value instanceof Uint8Array)) {
        throw serviceError(
          "CONTROLLED_COMMIT_DELIVERY_PACKAGE_CORRUPTED",
          "sealed change package blob 无效",
        );
      }
      const content = Buffer.from(value);
      if (
        content.length !== reference.bytes ||
        contentSha256(content) !== sha256
      ) {
        throw serviceError(
          "CONTROLLED_COMMIT_DELIVERY_PACKAGE_CORRUPTED",
          "sealed change package blob 摘要不匹配",
        );
      }
      blobs.push({ sha256, content });
    }
    blobs.sort((left, right) => left.sha256.localeCompare(right.sha256, "en"));
    return blobs;
  }

  async #replace(previous, replacementValue) {
    const replacement = normalizeRecord(replacementValue);
    let deliveries;
    if (previous === null) {
      if (this.#state.deliveries.length >= MAX_DELIVERIES) {
        throw serviceError(
          "CONTROLLED_COMMIT_DELIVERY_CAPACITY",
          "controlled commit delivery 已达到容量上限",
        );
      }
      deliveries = [...this.#state.deliveries, replacement];
    } else {
      const request = normalizeChangePackageControlledCommitRequest(
        previous.request,
      );
      const index = this.#state.deliveries.findIndex((entry) =>
        normalizeChangePackageControlledCommitRequest(entry.request).deliveryId ===
          request.deliveryId);
      if (index < 0) {
        throw serviceError(
          "CONTROLLED_COMMIT_DELIVERY_STATE_CORRUPTED",
          "controlled commit delivery record 丢失",
        );
      }
      deliveries = [...this.#state.deliveries];
      deliveries[index] = replacement;
    }
    const next = normalizeState({
      schemaVersion: 1,
      revision: this.#state.revision + 1,
      deliveries,
    });
    try {
      await this.#store.write(STATE_KEY, next);
      this.#state = next;
    } catch (cause) {
      try {
        await this.#reload();
      } catch {
        this.#ready = false;
        throw cause;
      }
      const request = normalizeChangePackageControlledCommitRequest(
        replacement.request,
      );
      const durable = findRecord(this.#state, request.deliveryId);
      if (durable === null || !sameValue(durable, replacement)) throw cause;
    }
    return findRecord(
      this.#state,
      normalizeChangePackageControlledCommitRequest(replacement.request)
        .deliveryId,
    );
  }

  async #reload() {
    this.#state = normalizeState(
      await this.#store.read(STATE_KEY, defaultState()),
    );
  }

  #assertReady() {
    if (!this.#ready) {
      throw serviceError(
        "CONTROLLED_COMMIT_DELIVERY_NOT_READY",
        "controlled commit delivery 尚未完成恢复",
      );
    }
  }
}
