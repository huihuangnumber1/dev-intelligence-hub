import assert from "node:assert/strict";
import test from "node:test";

import { createChangePackage } from "../src/domain/change-package-contract.js";
import { normalizeCodeJobBrowserProjection } from "../src/domain/code-job-browser-projection.js";
import {
  createDeliveryEvidenceTarget,
  normalizeDeliveryEvidenceTarget,
} from "../src/domain/delivery-evidence-contract.js";
import {
  createWorkProposalResult,
  normalizeBoundWorkProposal,
} from "../src/domain/work-proposal-contract.js";
import { DeliveryEvidenceService } from "../src/services/delivery-evidence-service.js";

const TASK_ID = "task-42";
const ROLE_ID = "developer";
const CREATED_AT = "2026-08-06T01:00:00.000Z";
const UPDATED_AT = "2026-08-06T01:05:00.000Z";
const CHANGE_JOB_ID = `code-job-${"1".repeat(55)}`;
const TEST_JOB_ID = `code-job-${"2".repeat(55)}`;

function sha(character) {
  return character.repeat(64);
}

function acceptanceContract(overrides = {}) {
  return {
    revision: 7,
    acceptanceCriteria: [
      { criterionId: "done", description: "交付物可由权威来源验证" },
    ],
    expectedDeliverables: [
      {
        deliverableId: "implementation",
        kind: "change-package",
        description: "可应用的代码变更包",
        required: true,
      },
      {
        deliverableId: "verification",
        kind: "test-report",
        description: "终态测试报告",
        required: true,
      },
      {
        deliverableId: "review",
        kind: "review-report",
        description: "已发布的评审结果",
        required: true,
      },
    ],
    ...overrides,
  };
}

function evidenceTarget(deliverableId, {
  taskId = TASK_ID,
  roleId = ROLE_ID,
  contract = acceptanceContract(),
} = {}) {
  return createDeliveryEvidenceTarget({
    taskId,
    roleId,
    acceptanceContract: contract,
    deliverableId,
  });
}

function proposal({
  proposalId,
  kind,
  target,
  operation = "verify",
  taskId = TASK_ID,
  roleId = ROLE_ID,
} = {}) {
  return normalizeBoundWorkProposal({
    proposalId,
    policyVersion: 1,
    kind,
    requestedBy: { roleId, workItemId: taskId },
    source: { assignmentId: "assignment-42", eventId: "event-42" },
    binding: {
      repository: "acme/widgets",
      workspaceId: "widgets-local",
      ...(target === null ? {} : { evidenceTarget: target }),
    },
    payload: kind === "code_action_proposal"
      ? { operation, objective: "验证交付结果" }
      : { verdict: "comment", body: "评审已完成" },
  });
}

function terminalJob({
  jobId,
  proposal: boundProposal,
  operation,
  status = "completed",
  grantDigest,
  memoryDigest,
  taskId = TASK_ID,
  roleId = ROLE_ID,
} = {}) {
  const projection = {
    jobId,
    status,
    revision: 4,
    proposalId: boundProposal.proposalId,
    proposalContentDigest: boundProposal.contentDigest,
    grantDigest,
    requestedBy: { roleId, workItemId: taskId },
    subject: { id: "github:acme/widgets:pull-request:42" },
    repository: "acme/widgets",
    workspaceId: "widgets-local",
    operation,
    objective: "完成受信任的交付工作",
    acceptanceCriteria: ["权威产物可验证"],
    evidence: ["work-item:task-42"],
    summary: "交付工作已完成",
    reason: "当前岗位被分配了此任务",
    allowedActions: ["complete"],
    writablePaths: operation === "modify" ? ["src/**"] : [],
    requiredProfiles: operation === "verify" ? ["node-tests"] : [],
    turn: 1,
    pendingActionType: null,
    observationCount: 1,
    latestObservation: {
      actionType: "complete",
      status: status === "completed" ? "succeeded" : "failed",
      recordedAt: UPDATED_AT,
    },
    terminalResult: { kind: status, recordedAt: UPDATED_AT },
    memoryProjection: {
      recordId: `memory-${memoryDigest}`,
      projectedAt: UPDATED_AT,
    },
    pause: null,
    uncertainty: null,
    createdAt: CREATED_AT,
    updatedAt: UPDATED_AT,
  };
  normalizeCodeJobBrowserProjection(projection);
  return projection;
}

function codeResult(boundProposal, job, sequence, outcome = undefined) {
  return createWorkProposalResult({
    proposal: boundProposal,
    sequence,
    transition: {
      status: outcome ?? (job.status === "completed" ? "succeeded" : "failed"),
      summary: "本地代码任务已形成终态结果",
      evidence: [
        `confirmation:${boundProposal.proposalId}`,
        `code-job:${job.jobId}`,
        `code-job-status:${job.status}`,
        `memory:${job.memoryProjection.recordId}`,
      ],
    },
    downstreamRef: `confirmation-${boundProposal.proposalId}`,
    at: UPDATED_AT,
  });
}

function reviewResult(boundProposal, sequence) {
  return createWorkProposalResult({
    proposal: boundProposal,
    sequence,
    transition: {
      status: "succeeded",
      summary: "GitHub 评审已发布",
      evidence: ["review:42"],
    },
    downstreamRef: "github-review-42",
    at: UPDATED_AT,
  });
}

function supportsProposalKind(proposalKind, evidenceKind) {
  return proposalKind === "code_action_proposal"
    ? ["change-package", "test-report"].includes(evidenceKind)
    : ["review-report", "github-review"].includes(evidenceKind);
}

function queryTarget(boundProposal, query) {
  let target;
  try {
    target = normalizeDeliveryEvidenceTarget(boundProposal.binding.evidenceTarget);
  } catch {
    return false;
  }
  const [deliverable] = target.deliverables;
  return (
    boundProposal.requestedBy.workItemId === query.taskId &&
    boundProposal.requestedBy.roleId === query.roleId &&
    target.taskId === query.taskId &&
    target.roleId === query.roleId &&
    target.contractRevision === query.contractRevision &&
    target.contractDigest === query.contractDigest &&
    query.kinds.includes(deliverable.kind) &&
    supportsProposalKind(boundProposal.kind, deliverable.kind)
  );
}

function reference(value, key) {
  return typeof value === "string" ? value : value[key];
}

function createFixture({ testStatus = "completed", includeTestTarget = true } = {}) {
  const changeProposal = proposal({
    proposalId: "change-proposal-42",
    kind: "code_action_proposal",
    operation: "modify",
    target: evidenceTarget("implementation"),
  });
  const testProposal = proposal({
    proposalId: "test-proposal-42",
    kind: "code_action_proposal",
    target: includeTestTarget ? evidenceTarget("verification") : null,
  });
  const reviewProposal = proposal({
    proposalId: "review-proposal-42",
    kind: "github_review_proposal",
    target: evidenceTarget("review"),
  });
  const changeJob = terminalJob({
    jobId: CHANGE_JOB_ID,
    proposal: changeProposal,
    operation: "modify",
    grantDigest: sha("3"),
    memoryDigest: sha("4"),
  });
  const testJob = terminalJob({
    jobId: TEST_JOB_ID,
    proposal: testProposal,
    operation: "verify",
    status: testStatus,
    grantDigest: sha("5"),
    memoryDigest: sha("6"),
  });
  const prepared = createChangePackage({
    job: { id: changeJob.jobId, revision: changeJob.revision, recordDigest: sha("7") },
    proposal: {
      id: changeProposal.proposalId,
      contentDigest: changeProposal.contentDigest,
    },
    grant: { digest: changeJob.grantDigest },
    workspace: {
      id: "widgets-local",
      sourceRevision: sha("8"),
      workspaceRevision: sha("9"),
    },
    passedProfiles: [{
      id: "node-tests",
      configDigest: sha("a"),
      workspaceRevision: sha("9"),
      actionId: "run-node-tests",
      attemptNumber: 1,
      imageId: "sha256:node-test-image",
      artifacts: {
        output: { path: "session/tests/output.json", sha256: sha("b"), bytes: 12 },
        stdout: { path: "session/tests/stdout.log", sha256: sha("c"), bytes: 12 },
        stderr: { path: "session/tests/stderr.log", sha256: sha("d"), bytes: 12 },
      },
    }],
    created: [{ path: "src/delivery.js", content: Buffer.from("export const ready = true;\n") }],
    modified: [],
    deleted: [],
  });
  const changeResult = codeResult(changeProposal, changeJob, 1);
  const testResult = codeResult(testProposal, testJob, 2);
  const publishedReview = reviewResult(reviewProposal, 3);
  const proposals = new Map([
    [changeProposal.proposalId, changeProposal],
    [testProposal.proposalId, testProposal],
    [reviewProposal.proposalId, reviewProposal],
  ]);
  const results = new Map(
    [changeResult, testResult, publishedReview].map((result) => [result.resultId, result]),
  );
  const sources = new Map([
    [changeJob.jobId, {
      job: changeJob,
      archived: false,
      changePackage: {
        status: "ready",
        receipt: {
          packageId: prepared.manifest.packageId,
          packageDigest: prepared.manifest.packageDigest,
          deliveredAt: UPDATED_AT,
        },
      },
    }],
    [testJob.jobId, {
      job: testJob,
      archived: false,
      changePackage: { status: "none", receipt: null },
    }],
  ]);
  const calls = { candidates: [], jobReads: [] };
  const changePackageReader = {
    async get(packageId) {
      if (packageId === prepared.manifest.packageId) return prepared.manifest;
      const error = new Error("change package not found");
      error.code = "CHANGE_PACKAGE_NOT_FOUND";
      throw error;
    },
  };
  const codeJobReader = {
    async readDeliveryEvidence(input) {
      calls.jobReads.push(input.jobId);
      input.signal?.throwIfAborted();
      return sources.get(input.jobId) ?? null;
    },
  };
  const proposalResultReader = {
    async getResult(input) {
      input.signal?.throwIfAborted();
      return results.get(reference(input, "resultId")) ?? null;
    },
    async getProposalForEvidence(input) {
      input.signal?.throwIfAborted();
      return proposals.get(reference(input, "proposalId")) ?? null;
    },
    async getResultForProposal(input) {
      input.signal?.throwIfAborted();
      const proposalId = reference(input, "proposalId");
      return [...results.values()].find((result) => result.proposalId === proposalId) ?? null;
    },
    async listEvidenceCandidates(query) {
      query.signal?.throwIfAborted();
      calls.candidates.push({
        taskId: query.taskId,
        roleId: query.roleId,
        contractRevision: query.contractRevision,
        contractDigest: query.contractDigest,
        kinds: [...query.kinds],
        beforeSequence: query.beforeSequence,
        limit: query.limit,
      });
      const matched = [...results.values()]
        .filter((result) => result.sequence < query.beforeSequence)
        .filter((result) => result.outcome === "succeeded")
        .map((result) => ({ result, proposal: proposals.get(result.proposalId) }))
        .filter(({ proposal: candidate }) => candidate && queryTarget(candidate, query))
        .sort((left, right) => right.result.sequence - left.result.sequence);
      const items = matched.slice(0, query.limit);
      return {
        items,
        nextBeforeSequence:
          items.length === query.limit ? items.at(-1).result.sequence : null,
      };
    },
  };
  return {
    service: new DeliveryEvidenceService({
      changePackageReader,
      codeJobReader,
      proposalResultReader,
    }),
    ports: { changePackageReader, codeJobReader, proposalResultReader },
    calls,
    proposals,
    results,
    sources,
    targets: {
      change: evidenceTarget("implementation"),
      test: evidenceTarget("verification"),
      review: evidenceTarget("review"),
    },
    records: {
      change: {
        kind: "change-package",
        referenceId: prepared.manifest.packageId,
        contentDigest: prepared.manifest.packageDigest,
      },
      test: {
        kind: "test-report",
        referenceId: testJob.jobId,
        contentDigest: sha("6"),
      },
      review: {
        kind: "review-report",
        referenceId: publishedReview.resultId,
        contentDigest: publishedReview.contentDigest,
      },
    },
  };
}

function verificationRequest(target, deliverableId, evidence, overrides = {}) {
  return {
    taskId: target.taskId,
    roleId: target.roleId,
    contractRevision: target.contractRevision,
    contractDigest: target.contractDigest,
    deliverableId,
    evidence,
    ...overrides,
  };
}

function catalogRequest(target, kinds, limit = 20) {
  return {
    taskId: target.taskId,
    roleId: target.roleId,
    contractRevision: target.contractRevision,
    contractDigest: target.contractDigest,
    kinds,
    limit,
  };
}

function descriptor(deliverableId, evidence) {
  return { deliverableId, evidence };
}

test("completed change, test, and review results verify with their exact target", async () => {
  const fixture = createFixture();
  const cases = [
    [fixture.targets.change, "implementation", fixture.records.change],
    [fixture.targets.test, "verification", fixture.records.test],
    [fixture.targets.review, "review", fixture.records.review],
  ];
  for (const [target, deliverableId, evidence] of cases) {
    assert.deepEqual(
      await fixture.service.verify(verificationRequest(target, deliverableId, evidence)),
      evidence,
    );
  }
});

test("review evidence rejects every mismatched proposal-result authority link", async () => {
  const fixture = createFixture();
  const boundProposal = fixture.proposals.get("review-proposal-42");
  const validResult = [...fixture.results.values()].find(
    (result) => result.proposalId === boundProposal.proposalId,
  );
  const corruptions = new Map([
    ["proposalId", { ...validResult, proposalId: "other-review-proposal" }],
    [
      "proposalContentDigest",
      { ...validResult, proposalContentDigest: sha("e") },
    ],
    ["kind", { ...validResult, kind: "code_action_proposal" }],
    [
      "requested task",
      {
        ...validResult,
        requestedBy: { ...validResult.requestedBy, workItemId: "task-43" },
      },
    ],
    [
      "requested role",
      {
        ...validResult,
        requestedBy: { ...validResult.requestedBy, roleId: "tester" },
      },
    ],
    [
      "resultId/contentDigest",
      {
        ...validResult,
        resultId: `work-proposal-result-${sha("f")}`,
      },
    ],
  ]);

  for (const [name, result] of corruptions) {
    const proposalResultReader = {
      async getResult() { return result; },
      async getProposalForEvidence() { return boundProposal; },
      async getResultForProposal() { return result; },
      async listEvidenceCandidates() {
        return {
          items: [{ proposal: boundProposal, result }],
          nextBeforeSequence: null,
        };
      },
    };
    const service = new DeliveryEvidenceService({ proposalResultReader });
    const evidence = {
      kind: "review-report",
      referenceId: result.resultId,
      contentDigest: result.contentDigest,
    };
    assert.equal(
      await service.verify(
        verificationRequest(fixture.targets.review, "review", evidence),
      ),
      false,
      name,
    );
    assert.deepEqual(
      await service.listForTask(
        catalogRequest(fixture.targets.review, ["review-report"]),
      ),
      [],
      name,
    );
  }
});

test("failed verify jobs are failure information, never acceptable test reports", async () => {
  const fixture = createFixture({ testStatus: "failed" });
  assert.equal(
    await fixture.service.verify(
      verificationRequest(fixture.targets.test, "verification", fixture.records.test),
    ),
    false,
  );
  assert.deepEqual(
    await fixture.service.listForTask(
      catalogRequest(fixture.targets.test, ["test-report"]),
    ),
    [],
  );
});

test("completed code evidence requires a matching succeeded terminal proposal result", async () => {
  for (const corruption of ["missing", "failed", "wrong-job"]) {
    const fixture = createFixture();
    const original = [...fixture.results.values()].find(
      (result) => result.proposalId === "test-proposal-42",
    );
    fixture.results.delete(original.resultId);
    if (corruption !== "missing") {
      const replacement = createWorkProposalResult({
        proposal: fixture.proposals.get("test-proposal-42"),
        sequence: original.sequence,
        transition: {
          status: corruption === "failed" ? "failed" : "succeeded",
          summary: "不匹配的代码任务结果",
          evidence: [
            `confirmation:test-proposal-42`,
            `code-job:${corruption === "wrong-job" ? CHANGE_JOB_ID : TEST_JOB_ID}`,
            "code-job-status:completed",
            `memory:${fixture.sources.get(TEST_JOB_ID).job.memoryProjection.recordId}`,
          ],
        },
        downstreamRef: "confirmation-test-proposal-42",
        at: UPDATED_AT,
      });
      fixture.results.set(replacement.resultId, replacement);
    }
    assert.equal(
      await fixture.service.verify(
        verificationRequest(fixture.targets.test, "verification", fixture.records.test),
      ),
      false,
      corruption,
    );
  }
});

test("verification rejects mismatched authority dimensions and legacy targets", async () => {
  const fixture = createFixture();
  const evidence = fixture.records.test;
  const requests = [
    verificationRequest(fixture.targets.test, "verification", {
      ...evidence,
      referenceId: `code-job-${"f".repeat(55)}`,
    }),
    verificationRequest(fixture.targets.test, "verification", evidence, { taskId: "task-43" }),
    verificationRequest(fixture.targets.test, "verification", evidence, { roleId: "tester" }),
    verificationRequest(fixture.targets.test, "implementation", evidence),
    verificationRequest(fixture.targets.test, "verification", evidence, { contractRevision: 8 }),
    verificationRequest(fixture.targets.test, "verification", evidence, { contractDigest: sha("e") }),
    verificationRequest(fixture.targets.test, "verification", { ...evidence, contentDigest: sha("f") }),
  ];
  for (const request of requests) assert.equal(await fixture.service.verify(request), false);

  const legacy = createFixture({ includeTestTarget: false });
  assert.equal(
    await legacy.service.verify(
      verificationRequest(legacy.targets.test, "verification", legacy.records.test),
    ),
    false,
  );
});

test("one evidence record cannot be replayed across duplicate-kind deliverables", async () => {
  const contract = acceptanceContract({
    expectedDeliverables: [
      { deliverableId: "verify_a", kind: "test-report", description: "A", required: true },
      { deliverableId: "verify_b", kind: "test-report", description: "B", required: true },
    ],
  });
  const target = evidenceTarget("verify_a", { contract });
  const boundProposal = proposal({
    proposalId: "duplicate-kind-proposal",
    kind: "code_action_proposal",
    target,
  });
  const job = terminalJob({
    jobId: `code-job-${"7".repeat(55)}`,
    proposal: boundProposal,
    operation: "verify",
    grantDigest: sha("7"),
    memoryDigest: sha("8"),
  });
  const result = codeResult(boundProposal, job, 1);
  const service = new DeliveryEvidenceService({
    codeJobReader: { async readDeliveryEvidence() {
      return { job, archived: false, changePackage: { status: "none", receipt: null } };
    } },
    proposalResultReader: {
      async getResult() { return result; },
      async getProposalForEvidence() { return boundProposal; },
      async getResultForProposal() { return result; },
      async listEvidenceCandidates() { return { items: [], nextBeforeSequence: null }; },
    },
  });
  const evidence = {
    kind: "test-report",
    referenceId: job.jobId,
    contentDigest: sha("8"),
  };
  assert.deepEqual(
    await service.verify(verificationRequest(target, "verify_a", evidence)),
    evidence,
  );
  assert.equal(
    await service.verify(verificationRequest(target, "verify_b", evidence)),
    false,
  );
});

test("catalog returns frozen deliverable descriptors for all authoritative kinds", async () => {
  const fixture = createFixture();
  const records = await fixture.service.listForTask(
    catalogRequest(
      fixture.targets.test,
      ["change-package", "test-report", "review-report"],
      3,
    ),
  );
  assert.deepEqual(records, [
    descriptor("implementation", fixture.records.change),
    descriptor("review", fixture.records.review),
    descriptor("verification", fixture.records.test),
  ]);
  assert.equal(Object.isFrozen(records), true);
  assert.equal(records.every((entry) => Object.isFrozen(entry) && Object.isFrozen(entry.evidence)), true);
});

test("catalog rejects action-incompatible code candidates from a broad reader", async () => {
  const fixture = createFixture();
  const mismatch = ({
    proposalId,
    proposalOperation,
    target,
    jobId,
    jobOperation,
    sequence,
  }) => {
    const boundProposal = proposal({
      proposalId,
      kind: "code_action_proposal",
      operation: proposalOperation,
      target,
    });
    const job = terminalJob({
      jobId,
      proposal: boundProposal,
      operation: jobOperation,
      grantDigest: sha("7"),
      memoryDigest: sha("8"),
    });
    return {
      proposal: boundProposal,
      result: codeResult(boundProposal, job, sequence),
    };
  };
  const candidates = [
    mismatch({
      proposalId: "modify-targets-test",
      proposalOperation: "modify",
      target: fixture.targets.test,
      jobId: `code-job-${"3".repeat(55)}`,
      jobOperation: "verify",
      sequence: 5,
    }),
    mismatch({
      proposalId: "verify-targets-change",
      proposalOperation: "verify",
      target: fixture.targets.change,
      jobId: `code-job-${"4".repeat(55)}`,
      jobOperation: "modify",
      sequence: 4,
    }),
  ];
  const service = new DeliveryEvidenceService({
    changePackageReader: fixture.ports.changePackageReader,
    codeJobReader: fixture.ports.codeJobReader,
    proposalResultReader: {
      ...fixture.ports.proposalResultReader,
      async listEvidenceCandidates() {
        return { items: candidates, nextBeforeSequence: null };
      },
    },
  });

  assert.deepEqual(
    await service.listForTask(
      catalogRequest(
        fixture.targets.test,
        ["change-package", "test-report"],
        2,
      ),
    ),
    [],
  );
  assert.deepEqual(fixture.calls.jobReads, []);
});

test("authority filtering happens before limit and pagination crosses irrelevant same-target results", async () => {
  const fixture = createFixture();
  const valid = [...fixture.results.values()].find(
    (result) => result.proposalId === "test-proposal-42",
  );
  fixture.results.delete(valid.resultId);
  for (let index = 0; index < 101; index += 1) {
    const id = `irrelevant-${index}`;
    const boundProposal = proposal({
      proposalId: id,
      kind: "code_action_proposal",
      operation: "modify",
      target: evidenceTarget("verification"),
    });
    const job = terminalJob({
      jobId: `code-job-${(index + 20).toString(16).padStart(55, "0")}`,
      proposal: boundProposal,
      operation: "modify",
      grantDigest: sha("a"),
      memoryDigest: sha("b"),
    });
    const result = codeResult(boundProposal, job, 1000 + index);
    fixture.proposals.set(id, boundProposal);
    fixture.results.set(result.resultId, result);
    fixture.sources.set(job.jobId, {
      job,
      archived: index % 2 === 0,
      changePackage: { status: "none", receipt: null },
    });
  }
  fixture.results.set(valid.resultId, valid);
  const records = await fixture.service.listForTask(
    catalogRequest(fixture.targets.test, ["test-report"], 1),
  );
  assert.deepEqual(records, [descriptor("verification", fixture.records.test)]);
  assert.equal(fixture.calls.candidates.length, 2);
  assert.deepEqual(
    fixture.calls.candidates.map(({ limit }) => limit),
    [100, 100],
  );
});

test("catalog scan rejects an authority source that never exhausts within the durable bound", async () => {
  let calls = 0;
  const service = new DeliveryEvidenceService({
    proposalResultReader: {
      async getResult() { return null; },
      async getProposalForEvidence() { return null; },
      async getResultForProposal() { return null; },
      async listEvidenceCandidates({ beforeSequence }) {
        calls += 1;
        const sequence = beforeSequence - 1;
        return {
          items: [{ proposal: {}, result: { sequence } }],
          nextBeforeSequence: sequence,
        };
      },
    },
  });
  await assert.rejects(
    service.listForTask(
      catalogRequest(evidenceTarget("verification"), ["test-report"], 1),
    ),
    /exceeded its bound/,
  );
  assert.equal(calls, 10);
});

test("catalog exhausts an exact 1000-candidate source without a false bound error", async () => {
  let calls = 0;
  const service = new DeliveryEvidenceService({
    proposalResultReader: {
      async getResult() { return null; },
      async getProposalForEvidence() { return null; },
      async getResultForProposal() { return null; },
      async listEvidenceCandidates({ beforeSequence }) {
        calls += 1;
        const highest = beforeSequence === Number.MAX_SAFE_INTEGER
          ? 1_000
          : beforeSequence - 1;
        const lowest = Math.max(1, highest - 99);
        const items = [];
        for (let sequence = highest; sequence >= lowest; sequence -= 1) {
          items.push({ proposal: {}, result: { sequence } });
        }
        return {
          items,
          nextBeforeSequence: lowest === 1 ? null : lowest,
        };
      },
    },
  });

  assert.deepEqual(
    await service.listForTask(
      catalogRequest(evidenceTarget("verification"), ["test-report"], 1),
    ),
    [],
  );
  assert.equal(calls, 10);
});

test("archived exact code-job projections remain valid evidence after compaction", async () => {
  const fixture = createFixture();
  fixture.sources.set(TEST_JOB_ID, {
    ...fixture.sources.get(TEST_JOB_ID),
    archived: true,
  });
  assert.deepEqual(
    await fixture.service.verify(
      verificationRequest(fixture.targets.test, "verification", fixture.records.test),
    ),
    fixture.records.test,
  );
  assert.deepEqual(
    await fixture.service.listForTask(
      catalogRequest(fixture.targets.test, ["test-report"], 1),
    ),
    [descriptor("verification", fixture.records.test)],
  );
});

test("authority failures propagate and abort observed during exact read cannot be accepted", async () => {
  const fixture = createFixture();
  const failure = new Error("authoritative store unavailable");
  const unavailable = new DeliveryEvidenceService({
    changePackageReader: fixture.ports.changePackageReader,
    codeJobReader: { async readDeliveryEvidence() { throw failure; } },
    proposalResultReader: fixture.ports.proposalResultReader,
  });
  await assert.rejects(
    unavailable.verify(
      verificationRequest(fixture.targets.test, "verification", fixture.records.test),
    ),
    (error) => error === failure,
  );

  const controller = new AbortController();
  const aborted = new DeliveryEvidenceService({
    changePackageReader: fixture.ports.changePackageReader,
    codeJobReader: { async readDeliveryEvidence(input) {
      const value = await fixture.ports.codeJobReader.readDeliveryEvidence(input);
      controller.abort();
      return value;
    } },
    proposalResultReader: fixture.ports.proposalResultReader,
  });
  await assert.rejects(
    aborted.verify({
      ...verificationRequest(fixture.targets.test, "verification", fixture.records.test),
      signal: controller.signal,
    }),
    (error) => error?.name === "AbortError",
  );

  const packageController = new AbortController();
  let packageSignal;
  const abortedPackage = new DeliveryEvidenceService({
    changePackageReader: {
      async get(packageId, { signal }) {
        packageSignal = signal;
        const manifest = await fixture.ports.changePackageReader.get(packageId);
        packageController.abort();
        return manifest;
      },
    },
    codeJobReader: fixture.ports.codeJobReader,
    proposalResultReader: fixture.ports.proposalResultReader,
  });
  await assert.rejects(
    abortedPackage.verify({
      ...verificationRequest(
        fixture.targets.change,
        "implementation",
        fixture.records.change,
      ),
      signal: packageController.signal,
    }),
    (error) => error?.name === "AbortError",
  );
  assert.equal(packageSignal, packageController.signal);
});


test("adopted publication results require the persistent adoption verifier for catalog and acceptance", async () => {
  const fixture = createFixture();
  const { contentDigest: _oldDigest, ...old } = fixture.proposals.get("review-proposal-42");
  const adopted = normalizeBoundWorkProposal({ ...old, payload: { ...old.payload,
    publicationReuse: { candidateId: "review-publication-candidate-" + "a".repeat(64), materialDigest: "b".repeat(64), coverageDigest: "d".repeat(64) } } });
  fixture.proposals.set(adopted.proposalId, adopted);
  const result = reviewResult(adopted, 4);
  fixture.results.clear(); fixture.results.set(result.resultId, result);
  const evidence = { kind: "review-report", referenceId: result.resultId, contentDigest: result.contentDigest };
  const request = verificationRequest(fixture.targets.review, "review", evidence);
  assert.equal(await fixture.service.verify(request), false, "a succeeded result alone is not an adoption receipt");
  assert.deepEqual(await fixture.service.listForTask(catalogRequest(fixture.targets.review, ["review-report"])), []);
  const calls = [];
  const service = new DeliveryEvidenceService({ ...fixture.ports, publicationAdoptionVerifier: {
    async verifyProposal(input) { calls.push(input); return true; },
  } });
  assert.deepEqual(await service.verify(request), evidence);
  assert.equal((await service.listForTask(catalogRequest(fixture.targets.review, ["review-report"]))).length, 1);
  assert.equal(calls.length, 2);
  assert.equal(calls[0].proposal.contentDigest, adopted.contentDigest);
  assert.equal(calls[0].result.resultId, result.resultId);
  assert.equal(calls[0].authority.contractDigest, fixture.targets.review.contractDigest);
});
