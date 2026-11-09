import assert from "node:assert/strict";
import test from "node:test";
import { AttentionCoordinator } from "../src/services/attention-coordinator.js";

function externalItem() {
  return {
    id: "github-review-1",
    kind: "github.pull_request.review",
    status: "pending",
    queueRevision: 4,
    itemRevision: 1,
    display: { title: "发布 PR Review" },
  };
}

function internalItem() {
  return {
    requestId: `attention-${"a".repeat(64)}`,
    type: "ask_user",
    question: "以哪个验收口径为准？",
    context: [],
    choices: [],
    revision: 2,
    contentDigest: "b".repeat(64),
    createdAt: "2026-08-02T01:00:00.000Z",
  };
}

test("automatic Review activity remains visible when no human confirmation is waiting", async () => {
  const coordinator = new AttentionCoordinator({ externalQueue: { async next() {
    return { queueRevision: 4, pendingCount: 0, item: null,
      automaticReviewEnabled: true, systemManagedCount: 3 };
  } } });
  const next = await coordinator.next();
  assert.equal(next.item, null);
  assert.equal(next.pendingCount, 0);
  assert.equal(next.systemManagedCount, 3);
  assert.equal(next.automaticReviewEnabled, true);
});

test("external authorization stays first and storage/action ports remain separate", async () => {
  let internalReads = 0;
  const coordinator = new AttentionCoordinator({
    externalQueue: {
      async next() {
        return { queueRevision: 4, pendingCount: 3, item: externalItem() };
      },
      approve() {
        throw new Error("must not be exposed");
      },
    },
    internalInbox: {
      async next() {
        internalReads += 1;
        return internalItem();
      },
      answer() {
        throw new Error("must not be exposed");
      },
    },
  });

  assert.deepEqual(await coordinator.next(), {
    available: true,
    source: "external_confirmation",
    pendingCount: 3,
    externalEnabled: true,
    externalQueueRevision: 4,
    item: externalItem(),
  });
  assert.equal(internalReads, 0);
  assert.deepEqual(Object.keys(coordinator), []);
  assert.equal(coordinator.externalQueue, undefined);
  assert.equal(coordinator.internalInbox, undefined);
  assert.equal(typeof coordinator.approve, "undefined");
  assert.equal(typeof coordinator.answer, "undefined");
});

test("falls through to exactly one internal request when no external action waits", async () => {
  const coordinator = new AttentionCoordinator({
    externalQueue: {
      async next() {
        return { queueRevision: 9, pendingCount: 0, item: null };
      },
    },
    internalInbox: { async next() { return internalItem(); } },
  });

  assert.deepEqual(await coordinator.next(), {
    available: true,
    source: "internal_request",
    pendingCount: 1,
    externalEnabled: true,
    externalQueueRevision: 9,
    item: internalItem(),
  });
});

test("forwards bounded source-specific exclusions and falls through past deferred external work", async () => {
  const externalDeferred = {
    id: "github-review-1",
    approvalBindingDigest: "c".repeat(64),
  };
  const internalDeferred = {
    requestId: `attention-${"d".repeat(64)}`,
    contentDigest: "e".repeat(64),
  };
  const reads = [];
  const coordinator = new AttentionCoordinator({
    externalQueue: {
      async next(options) {
        reads.push({ source: "external", options });
        return { queueRevision: 10, pendingCount: 0, item: null };
      },
    },
    internalInbox: {
      async next(options) {
        reads.push({ source: "internal", options });
        return internalItem();
      },
    },
  });

  const result = await coordinator.next({
    external: [externalDeferred],
    internal: [internalDeferred],
  });

  assert.equal(result.source, "internal_request");
  assert.deepEqual(reads, [
    { source: "external", options: { deferred: [externalDeferred] } },
    { source: "internal", options: { deferred: [internalDeferred] } },
  ]);
});

test("rejects more than 32 aggregate exclusions before reading either source", async () => {
  let reads = 0;
  const coordinator = new AttentionCoordinator({
    externalQueue: { async next() { reads += 1; return null; } },
    internalInbox: { async next() { reads += 1; return null; } },
  });

  await assert.rejects(
    coordinator.next({
      external: Array.from({ length: 32 }, (_, index) => ({
        id: `github-review-${index}`,
        approvalBindingDigest: index.toString(16).padStart(64, "0"),
      })),
      internal: [
        {
          requestId: `attention-${"a".repeat(64)}`,
          contentDigest: "b".repeat(64),
        },
      ],
    }),
    (error) => error.code === "INVALID_ATTENTION_DEFERRED" && error.statusCode === 400,
  );
  assert.equal(reads, 0);
});

test("works with either queue disabled and returns one stable empty projection", async () => {
  const internalOnly = new AttentionCoordinator({
    internalInbox: { async next() { return internalItem(); } },
  });
  assert.equal((await internalOnly.next()).source, "internal_request");

  const externalOnly = new AttentionCoordinator({
    externalQueue: {
      async next() {
        return { queueRevision: 2, pendingCount: 0, item: null };
      },
    },
  });
  assert.deepEqual(await externalOnly.next(), {
    available: false,
    source: null,
    pendingCount: 0,
    externalEnabled: true,
    externalQueueRevision: 2,
    item: null,
  });

  assert.deepEqual(await new AttentionCoordinator().next(), {
    available: false,
    source: null,
    pendingCount: 0,
    externalEnabled: false,
    externalQueueRevision: 0,
    item: null,
  });
});

test("queue failures propagate instead of silently changing authorization priority", async () => {
  let internalRead = false;
  const coordinator = new AttentionCoordinator({
    externalQueue: {
      async next() {
        throw Object.assign(new Error("facts not ready"), { code: "FACTS_NOT_READY" });
      },
    },
    internalInbox: {
      async next() {
        internalRead = true;
        return internalItem();
      },
    },
  });

  await assert.rejects(coordinator.next(), (error) => error.code === "FACTS_NOT_READY");
  assert.equal(internalRead, false);
});

test("constructor rejects objects that are not read-only queue ports", () => {
  assert.throws(
    () => new AttentionCoordinator({ externalQueue: {} }),
    /externalQueue\.next/,
  );
  assert.throws(
    () => new AttentionCoordinator({ internalInbox: {} }),
    /internalInbox\.next/,
  );
});
