import assert from "node:assert/strict";
import { execFile as execFileCallback, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import { windowsGitImplementationCandidates } from "../src/lib/windows-git-implementation.js";

import { createApplication } from "../src/composition-root.js";
import { digestValue } from "../src/domain/code-executor-contract.js";
import {
  createPullRequestReadFacts,
  createPullRequestReadIdentity,
} from "../src/domain/pull-request-read-facts.js";
import { OperationQueue } from "../src/lib/operation-queue.js";
import { StateStore } from "../src/lib/state-store.js";
import {
  CODE_JOB_STATE_KEY,
  CodeJobStore,
} from "../src/services/code-job-store.js";
import { LocalMemoryJournal } from "../src/services/local-memory-journal.js";
import { MemoryContextRetriever } from
  "../src/services/memory-context-retriever.js";
import { PullRequestExternalActionTransportError } from
  "../src/services/pull-request-external-action-executor.js";
import { createWorkProposalRuntime } from "../src/work-proposal-runtime.js";

const execFile = promisify(execFileCallback);
const PROFILE_IMAGE =
  "node:22-alpine@sha256:c610fcdfb1d5b4740dd70c284ed3cb16bb857e0f7166196e36a5501df7a3aa32";
const PROFILE = Object.freeze({
  kind: "node-test",
  image: PROFILE_IMAGE,
  timeoutMs: 30_000,
});
const ACTION_TITLES = Object.freeze([
  ["External comment", "comment"],
  ["External review", "review"],
  ["External branch update", "update_branch"],
  ["External controlled push", "push"],
  ["External merge", "merge"],
]);
const RESOLVED_CONTENT = "resolved by the sealed high-capability task brain\n";

function locateGit() {
  const result = process.platform === "win32"
    ? spawnSync("where.exe", ["git"], { encoding: "utf8", windowsHide: true })
    : spawnSync("which", ["git"], { encoding: "utf8" });
  if (result.status !== 0) return null;
  const candidate = result.stdout.split(/\r?\n/u).find(Boolean);
  if (!candidate || !path.isAbsolute(candidate)) return null;
  if (process.platform !== "win32") return path.resolve(candidate);
  return windowsGitImplementationCandidates(candidate).find(existsSync) ?? null;
}

async function git(gitCommand, cwd, args) {
  return execFile(gitCommand, ["-c", "core.longpaths=true", ...args], {
    cwd,
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
    timeout: 30_000,
    windowsHide: true,
  });
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

async function directorySnapshot(root) {
  const snapshot = [];
  async function visit(relativeDirectory) {
    const directory = path.join(
      root,
      ...relativeDirectory.split("/").filter(Boolean),
    );
    const entries = await readdir(directory, { withFileTypes: true });
    entries.sort((left, right) => left.name.localeCompare(right.name, "en"));
    for (const entry of entries) {
      const relativePath = relativeDirectory
        ? `${relativeDirectory}/${entry.name}`
        : entry.name;
      const target = path.join(root, ...relativePath.split("/"));
      const stats = await lstat(target);
      if (stats.isDirectory() && !stats.isSymbolicLink()) {
        snapshot.push(`directory:${relativePath}`);
        await visit(relativePath);
      } else {
        assert.equal(stats.isFile(), true, relativePath);
        snapshot.push(`file:${relativePath}:${sha256(await readFile(target))}`);
      }
    }
  }
  await visit("");
  return snapshot;
}

async function createGitFixture(t, gitCommand) {
  const root = await mkdtemp(path.join(tmpdir(), "u9-mirrored-pr-e2e-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const sourceRoot = path.join(root, "source");
  const baseMirrorRoot = path.join(root, "base.git");
  const headMirrorRoot = path.join(root, "head.git");
  await mkdir(path.join(sourceRoot, "src"), { recursive: true });
  await git(gitCommand, sourceRoot, [
    "init",
    "--initial-branch=main",
    "--object-format=sha1",
  ]);
  await git(gitCommand, sourceRoot, ["config", "user.name", "U9 E2E"]);
  await git(gitCommand, sourceRoot, [
    "config",
    "user.email",
    "u9-e2e@example.invalid",
  ]);
  await writeFile(path.join(sourceRoot, "src", "conflict.txt"), "common\n");
  await writeFile(path.join(sourceRoot, "src", "untouched.txt"), "stable\n");
  await git(gitCommand, sourceRoot, ["add", "--all"]);
  await git(gitCommand, sourceRoot, ["commit", "-m", "common ancestor"]);

  await git(gitCommand, sourceRoot, ["switch", "--create", "feature"]);
  await writeFile(path.join(sourceRoot, "src", "conflict.txt"), "head one\n");
  await git(gitCommand, sourceRoot, ["add", "--all"]);
  await git(gitCommand, sourceRoot, ["commit", "-m", "head one"]);
  const headOne = (await git(gitCommand, sourceRoot, ["rev-parse", "HEAD"]))
    .stdout.trim();
  await writeFile(path.join(sourceRoot, "src", "next-head.txt"), "head two\n");
  await git(gitCommand, sourceRoot, ["add", "--all"]);
  await git(gitCommand, sourceRoot, ["commit", "-m", "head two"]);
  const headTwo = (await git(gitCommand, sourceRoot, ["rev-parse", "HEAD"]))
    .stdout.trim();

  await git(gitCommand, sourceRoot, ["switch", "main"]);
  await writeFile(path.join(sourceRoot, "src", "conflict.txt"), "base\n");
  await git(gitCommand, sourceRoot, ["add", "--all"]);
  await git(gitCommand, sourceRoot, ["commit", "-m", "base"]);
  const baseOid = (await git(gitCommand, sourceRoot, ["rev-parse", "HEAD"]))
    .stdout.trim();

  await git(gitCommand, root, [
    "clone",
    "--bare",
    "--no-local",
    "--single-branch",
    "--branch",
    "main",
    sourceRoot,
    baseMirrorRoot,
  ]);
  await git(gitCommand, root, [
    "clone",
    "--bare",
    "--no-local",
    "--single-branch",
    "--branch",
    "feature",
    sourceRoot,
    headMirrorRoot,
  ]);
  return {
    root,
    sourceRoot,
    baseMirrorRoot,
    headMirrorRoot,
    baseOid,
    headOne,
    headTwo,
  };
}

class TestGuard {
  #operations = new OperationQueue();

  async acquire() {}

  run(operation) {
    return this.#operations.enqueue(operation);
  }

  async close() {}
}

function guardFactory() {
  return new TestGuard();
}

async function archiveTerminalJobs({ statePath, clock, jobIds, compactionId }) {
  const store = new StateStore(statePath);
  const jobs = new CodeJobStore({
    store,
    exclusiveLease: new TestGuard(),
    operationQueue: new OperationQueue(),
    clock,
  });
  const recovered = await jobs.recover();
  const before = await store.read(CODE_JOB_STATE_KEY, null);
  assert.ok(before);
  assert.equal(recovered.revision, before.revision);
  assert.deepEqual(
    new Set(before.jobs.map(({ jobId }) => jobId)),
    new Set(jobIds),
  );
  assert.equal(before.jobs.every(({ status }) => status === "completed"), true);
  const targetThroughSequence = Math.max(
    ...before.jobs.map(({ sequence }) => sequence),
  );
  const compacted = await jobs.compactTerminalPrefix({
    compactionId,
    expectedRevision: before.revision,
    targetThroughSequence,
    preArchiveDigest: before.archive.digest,
  });
  assert.equal(compacted.status, "applied");
  assert.equal(compacted.receipt.archived, jobIds.length);
  assert.equal(compacted.receipt.targetThroughSequence, targetThroughSequence);
  assert.match(compacted.receipt.postArchiveDigest, /^[a-f0-9]{64}$/u);
  const after = await store.read(CODE_JOB_STATE_KEY, null);
  assert.equal(after.jobs.length, 0);
  assert.equal(after.archive.jobCount, jobIds.length);
  assert.equal(after.archive.digest, compacted.receipt.postArchiveDigest);
  return { compacted, after };
}

async function readMemoryRecords(journal, recordIds) {
  const orderedIds = [...new Set(recordIds)].sort();
  const items = [];
  for (let index = 0; index < orderedIds.length; index += 20) {
    items.push(...journal.readRecords({
      recordIds: orderedIds.slice(index, index + 20),
    }).items);
  }
  return items;
}

async function readCompleteWorkLedgerTimeline(workLedgerView) {
  const items = [];
  let cursor;
  do {
    const page = await workLedgerView.listTimeline({
      limit: 100,
      ...(cursor === undefined ? {} : { cursor }),
    });
    items.push(...page.items);
    cursor = page.nextCursor ?? undefined;
  } while (cursor !== undefined);
  return items;
}

function archivedProjection(details) {
  return details.map(({ job, changePackage }) => ({ job, changePackage }))
    .sort((left, right) => left.job.jobId.localeCompare(right.job.jobId, "en"));
}

class FixedSandbox {
  runs = [];

  getProfileFingerprint(profileId) {
    return profileId === "node-tests" ? digestValue(PROFILE) : null;
  }

  async run(request) {
    this.runs.push(structuredClone({
      profileId: request.profileId,
      executionId: request.executionId,
      actionId: request.actionId,
    }));
    return {
      exitCode: 0,
      signal: null,
      stdout: "TAP version 13\nok 1 - fixed test\n1..1\n# tests 1\n# pass 1\n# fail 0\n# cancelled 0\n# skipped 0\n# todo 0",
      stderr: "",
      durationMs: 1,
      imageId: `sha256:${"a".repeat(64)}`,
      profileFingerprint: digestValue(PROFILE),
      timedOut: false,
    };
  }

  async cleanup() {}
}

function textResponse(value) {
  return {
    ok: true,
    status: 200,
    body: new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(JSON.stringify(value)));
        controller.close();
      },
    }),
  };
}

function workDecision(intent, summary = intent.summary) {
  return {
    schemaVersion: 1,
    confidence: 96,
    summary,
    intent,
  };
}

function currentChildren(context) {
  return context.requirements.coordination?.directChildren ?? [];
}

function childByTitle(context, title) {
  return currentChildren(context).find(({ work }) => work.title === title);
}

function actionBase(context, source, type, reason) {
  return {
    schemaVersion: 1,
    type,
    sourceTaskId: source.taskId,
    sourceTaskRevision: source.taskRevision ?? source.revision,
    expectedGraphRevision: context.requirements.graph.revision,
    reason,
  };
}

function orchestrate(context, action, summary) {
  return workDecision({
    schemaVersion: 1,
    type: "orchestrate",
    summary,
    reason: action.reason,
    action,
  }, summary);
}

function deliverableContract(deliverableId, kind, description) {
  return {
    revision: 1,
    acceptanceCriteria: [{
      criterionId: "verified",
      description: "The trusted system evidence satisfies this task.",
    }],
    expectedDeliverables: [{
      deliverableId,
      kind,
      description,
      required: true,
    }],
  };
}

function actionContract() {
  return {
    revision: 1,
    acceptanceCriteria: [{
      criterionId: "owner-confirmed",
      description: "The external action reaches its own owner confirmation.",
    }],
    expectedDeliverables: [],
  };
}

function decompose(context, {
  childKey,
  title,
  capability,
  dependsOn = [],
  acceptanceContract,
}) {
  const current = context.requirements.currentTask;
  const reason = `Create ${title} in the shared PR graph.`;
  return orchestrate(context, {
    ...actionBase(context, current, "decompose", reason),
    childKey,
    work: { title, description: `${title} is bound to the current PR Head.` },
    capability,
    dependsOn: dependsOn.map((entry) => ({
      taskId: entry.taskId,
      revision: entry.taskRevision ?? entry.revision,
    })),
    acceptanceContract,
  }, reason);
}

function decideDelivery(context, child) {
  const delivery = child.deliverables.find(({ state }) => state === "submitted");
  const reason = `Accept verified delivery for ${child.work.title}.`;
  return orchestrate(context, {
    ...actionBase(context, child, "accept_delivery", reason),
    submittedDeliveryRevision: delivery.submittedDeliveryRevision,
  }, reason);
}

function completeWork(summary, evidence = []) {
  return workDecision({
    schemaVersion: 1,
    type: "complete",
    summary,
    reason: "The current trusted graph and evidence satisfy this work item.",
    outcome: "done",
    evidence,
  }, summary);
}

function askOwnerForHead(headRefOid) {
  return workDecision({
    schemaVersion: 1,
    type: "ask_user",
    summary: "Confirm the PR engineer may continue on this exact Head.",
    reason: "The owner must choose before the autonomous employee continues.",
    question: `Continue the mirrored PR workflow on Head ${headRefOid}?`,
    choices: [
      {
        id: "continue",
        label: "Continue",
        description: "Continue only on the displayed immutable Head.",
      },
      {
        id: "stop",
        label: "Stop",
        description: "Keep the work paused without external side effects.",
      },
    ],
  });
}

function orchestratorDecision(context, state) {
  const currentHead = context.requirements.source.headRefOid;
  if (state.consultedHead !== currentHead) {
    if (
      context.code?.decisionContext?.source === "attention" &&
      context.code.decisionContext.outcome === "answered" &&
      context.code.decisionContext.value?.answer?.choiceId === "continue"
    ) {
      state.consultedHead = currentHead;
    } else {
      return askOwnerForHead(currentHead);
    }
  }
  if (currentHead === state.headTwo) {
    const stalePush = childByTitle(context, "Reject old controlled commit");
    if (!stalePush) {
      return decompose(context, {
        childKey: "head-two-stale-push",
        title: "Reject old controlled commit",
        capability: "pr-review",
        acceptanceContract: actionContract(),
      });
    }
    if (state.oldEvidenceRejected && stalePush.status !== "completed") {
      const reason = "The trusted evidence verifier rejected this stale Head action.";
      return orchestrate(context, {
        ...actionBase(
          context,
          stalePush,
          stalePush.status === "paused" ? "resume" : "pause",
          reason,
        ),
      }, reason);
    }
    const merge = childByTitle(context, "Merge verified Head 2");
    if (!merge) {
      return decompose(context, {
        childKey: "head-two-merge",
        title: "Merge verified Head 2",
        capability: "pr-review",
        acceptanceContract: actionContract(),
      });
    }
    if (merge?.status === "completed") {
      return completeWork("The mirrored PR reached a verified terminal outcome.");
    }
    return completeWork("Wait for the Head 2 action boundary.");
  }

  const resolution = childByTitle(context, "Resolve mirrored conflict");
  if (!resolution) {
    return decompose(context, {
      childKey: "resolve-conflict",
      title: "Resolve mirrored conflict",
      capability: "development",
      acceptanceContract: deliverableContract(
        "implementation",
        "change-package",
        "Sealed conflict resolution change package.",
      ),
    });
  }
  if (resolution.deliverables.some(({ state }) => state === "submitted")) {
    return decideDelivery(context, resolution);
  }
  if (resolution.status !== "completed") {
    return completeWork("Wait for the conflict resolution delivery.");
  }

  const verification = childByTitle(context, "Verify mirrored resolution");
  if (!verification) {
    return decompose(context, {
      childKey: "verify-resolution",
      title: "Verify mirrored resolution",
      capability: "testing",
      dependsOn: [resolution],
      acceptanceContract: deliverableContract(
        "verification",
        "test-report",
        "Fixed-profile verification report.",
      ),
    });
  }
  if (verification.deliverables.some(({ state }) => state === "submitted")) {
    return decideDelivery(context, verification);
  }
  if (verification.status !== "completed") {
    return completeWork("Wait for the fixed verification delivery.");
  }

  const forged = childByTitle(context, "Reject forged controlled commit");
  if (!forged) {
    return decompose(context, {
      childKey: "forged-push",
      title: "Reject forged controlled commit",
      capability: "pr-review",
      dependsOn: [verification],
      acceptanceContract: actionContract(),
    });
  }
  for (const [title, action] of ACTION_TITLES) {
    if (!childByTitle(context, title)) {
      return decompose(context, {
        childKey: `external-${action}`,
        title,
        capability: "pr-review",
        dependsOn: [verification],
        acceptanceContract: actionContract(),
      });
    }
  }
  return completeWork("Wait for the current Head action confirmations.");
}

function evidenceFor(context, kind) {
  const descriptor = context.code?.authoritativeEvidence?.find(
    ({ evidence }) => evidence.kind === kind,
  );
  assert.ok(descriptor, `missing trusted ${kind} evidence`);
  return descriptor.evidence;
}

function submitDelivery(context, deliverableId, kind) {
  const current = context.requirements.currentTask;
  return workDecision({
    schemaVersion: 1,
    type: "submit_delivery",
    taskId: current.taskId,
    expectedTaskRevision: current.revision,
    expectedGraphRevision: context.requirements.graph.revision,
    contractRevision: current.acceptanceContract.revision,
    deliverableId,
    summary: `Trusted ${kind} evidence is ready.`,
    reason: "The controlled executor and fixed profile produced this evidence.",
    evidence: [evidenceFor(context, kind)],
    artifact: null,
  });
}

function codeAction(operation, objective) {
  return workDecision({
    schemaVersion: 1,
    type: "propose_code_action",
    summary: objective,
    reason: "A bounded trusted Code Job is required.",
    operation,
    objective,
    acceptanceCriteria: ["The fixed node test profile passes."],
    evidence: ["The PR facts and shared graph require this action."],
  });
}

function externalAction(type, controlledCommitEvidenceId) {
  const action = {
    comment: {
      type,
      body: "The mirrored conflict was resolved and verified.",
    },
    review: {
      type,
      verdict: "approve",
      body: "The fixed-Head evidence is acceptable.",
    },
    update_branch: { type },
    push: { type, controlledCommitEvidenceId },
    merge: { type, method: "squash" },
  }[type];
  return workDecision({
    schemaVersion: 1,
    type: "propose_github_pull_request_action",
    summary: `Prepare the ${type} action.`,
    reason: "The current fixed-Head workflow reached this owner boundary.",
    action,
    evidence: ["shared graph and controlled execution evidence"],
  });
}

function roleDecision(model, context, state) {
  if (model === "routine-orchestrator") {
    return orchestratorDecision(context, state);
  }
  const title = context.requirements.currentTask.work.title;
  if (model === "routine-tester") {
    if (context.code?.decisionContext?.source === "proposal") {
      return submitDelivery(context, "verification", "test-report");
    }
    return codeAction("verify", "Verify the fixed PR Head with the sealed profile.");
  }
  if (model === "routine-developer") {
    assert.equal(title, "Resolve mirrored conflict");
    if (context.code?.decisionContext?.source === "proposal") {
      return submitDelivery(context, "implementation", "change-package");
    }
    return codeAction("modify", "Resolve only the prepared conflict path.");
  }
  assert.equal(model, "routine-pr-engineer");
  if (context.requirements.currentTask.parentTaskId === null) {
    return workDecision({
      schemaVersion: 1,
      type: "handoff",
      summary: "Hand the fixed-Head PR source root to the command orchestrator.",
      reason: "The PR engineer admitted the exact source before shared planning.",
      capability: "coordination",
      brief: "Plan and coordinate the mirrored conflict through verified delivery.",
      evidence: ["exact PR source binding admitted by the PR engineer"],
    });
  }
  if (title === "Reject forged controlled commit") {
    return externalAction(
      "push",
      `controlled-git-commit-${"f".repeat(64)}`,
    );
  }
  if (title === "Reject old controlled commit") {
    if (state.oldEvidenceRejected) {
      return completeWork(
        "The old controlled commit was rejected before external authority.",
        ["controlled-commit-evidence-invalid"],
      );
    }
    return externalAction("push", state.controlledCommitEvidenceId);
  }
  if (title === "Merge verified Head 2") return externalAction("merge");
  const entry = ACTION_TITLES.find(([candidate]) => candidate === title);
  assert.ok(entry, `unexpected PR engineer task: ${title}`);
  return externalAction(entry[1], state.controlledCommitEvidenceId);
}

function codeBrainDecision(context) {
  const actionTypes = context.observations.map(({ actionType }) => actionType);
  let action;
  if (!actionTypes.includes("read_text")) {
    action = { type: "read_text", path: "src/conflict.txt" };
  } else if (
    context.task.operation === "modify" &&
    !actionTypes.includes("write_text")
  ) {
    action = {
      type: "write_text",
      path: "src/conflict.txt",
      content: RESOLVED_CONTENT,
    };
  } else if (context.capabilities.requiredProfilesRemaining > 0) {
    action = { type: "run_profile" };
  } else {
    action = {
      type: "complete",
      outcome: "verified",
      evidence: ["node-tests"],
    };
  }
  return {
    schemaVersion: 1,
    confidence: 98,
    summary: "Choose the next bounded semantic code action.",
    reason: "The sealed observations determine the next safe step.",
    action,
  };
}

function memoryDecision(context) {
  const current = context.records.filter(({ recordId, labels }) =>
    labels.authority === "raw" &&
    labels.lifecycle === "current" &&
    context.citableRecordIds.includes(recordId)
  );
  const parsed = current.map((record) => {
    let content = null;
    try {
      content = JSON.parse(record.content);
    } catch {
      // The structured answer below only uses JSON-backed authoritative records.
    }
    return { record, content };
  });
  const confirmation = parsed.find(({ record, content }) =>
    record.source.kind === "confirmation" &&
    content?.status === "completed" &&
    content.action?.type === "pull_request_merge"
  );
  const externalResult = parsed.find(({ record, content }) =>
    record.source.kind === "external-result" &&
    content?.status === "completed" &&
    content.actionType === "pull_request_merge" &&
    content.confirmationId === confirmation?.content?.confirmationId
  );
  const decision = parsed.find(({ record, content }) =>
    record.source.kind === "work-decision" &&
    content?.decision?.source === "proposal" &&
    content.decision.value?.kind ===
      "github_pull_request_action_proposal" &&
    content.decision.value.evidence?.includes(
      `confirmation:${confirmation?.content?.confirmationId}`,
    ) &&
    content.decision.value.evidence?.includes(
      `receipt:${externalResult?.content?.receipt?.id}`,
    )
  )?.record;
  const consultationRequest = parsed.find(({ record, content }) =>
    record.source.kind === "consultation-request" &&
    content?.details?.intentType === "ask_user" &&
    content.details.consultationRequest?.question
  )?.record;
  const consultationResult = parsed.find(({ record, content }) =>
    record.source.kind === "consultation-result" &&
    content?.details?.answer?.choiceId === "continue"
  )?.record;
  const ciObservation = parsed.find(({ record, content }) =>
    record.source.kind === "work-item" &&
    content?.pullRequestObservation?.ciStatus === "SUCCESS"
  )?.record;
  if ([
    decision,
    confirmation?.record,
    externalResult?.record,
    consultationRequest,
    consultationResult,
    ciObservation,
  ].some(
    (record) => record === undefined,
  )) {
    return { schemaVersion: 1, status: "insufficient_evidence", claims: [] };
  }
  return {
    schemaVersion: 1,
    status: "answered",
    claims: [
      {
        statement: "The current merge decision binds its exact confirmation and receipt.",
        citationIds: [decision.recordId],
      },
      {
        statement: "The owner confirmed the exact merge action on the current Head.",
        citationIds: [confirmation.record.recordId],
      },
      {
        statement: "The external merge completed with an opaque receipt.",
        citationIds: [externalResult.record.recordId],
      },
      {
        statement: "The PR employee asked the owner before continuing on the current Head.",
        citationIds: [consultationRequest.recordId],
      },
      {
        statement: "The owner explicitly chose to continue the current-Head workflow.",
        citationIds: [consultationResult.recordId],
      },
      {
        statement: "The current PR observation records successful CI.",
        citationIds: [ciObservation.recordId],
      },
    ],
  };
}

function createBrainFetch(state) {
  return async (url, options) => {
    const body = JSON.parse(options.body);
    const userContext = JSON.parse(body.messages[1].content);
    state.brainCalls.push({
      url,
      model: body.model,
      context: structuredClone(userContext),
    });
    let response;
    if (body.model.startsWith("strong-")) {
      response = userContext.requirements
        ? roleDecision(
            `routine-${userContext.requirements.roleId}`,
            userContext,
            state,
          )
        : codeBrainDecision(userContext);
    } else if (body.model === "memory-model") {
      response = memoryDecision(userContext);
    } else {
      response = roleDecision(body.model, userContext, state);
    }
    return url.endsWith("/api/chat")
      ? textResponse({ message: { content: JSON.stringify(response) } })
      : textResponse({ choices: [{ message: { content: JSON.stringify(response) } }] });
  };
}

function externalActionOid(marker) {
  return marker.repeat(40);
}

function initialObservation(input) {
  const actionEvidence = {
    pull_request_comment: { kind: "marker_records", records: [] },
    pull_request_review: { kind: "marker_records", records: [] },
    pull_request_update_branch: { kind: "head_commit", commit: null },
    pull_request_push: { kind: "head_ref" },
    pull_request_merge: { kind: "merge_state", merge: null },
  }[input.action.type];
  return {
    schemaVersion: 1,
    actorAccountId: input.actorAccountId,
    gitTarget: structuredClone(input.action.inputBinding.gitTarget),
    state: "open",
    actionEvidence,
  };
}

function completedObservation(input) {
  const observation = initialObservation(input);
  const { action } = input;
  if (action.type === "pull_request_comment") {
    observation.actionEvidence.records = [{
      marker: input.marker,
      actorAccountId: input.actorAccountId,
      body: action.body,
      reviewEvent: "COMMENT",
      headOid: action.inputBinding.gitTarget.headRefOid,
      receipt: { id: "comment-mirror-42" },
    }];
  } else if (action.type === "pull_request_review") {
    observation.actionEvidence.records = [{
      marker: input.marker,
      actorAccountId: input.actorAccountId,
      body: action.body,
      reviewEvent: action.reviewEvent,
      headOid: action.inputBinding.gitTarget.headRefOid,
      receipt: { id: "review-mirror-42" },
    }];
  } else if (action.type === "pull_request_update_branch") {
    const oid = externalActionOid("7");
    observation.gitTarget.headRefOid = oid;
    observation.actionEvidence.commit = {
      oid,
      parents: [action.expectedHeadOid, action.expectedBaseOid],
      receipt: { id: oid },
    };
  } else if (action.type === "pull_request_push") {
    observation.gitTarget.headRefOid = action.controlledCommitEvidence.commit.oid;
  } else {
    observation.state = "merged";
    observation.actionEvidence.merge = {
      marker: input.marker,
      actorAccountId: input.actorAccountId,
      expectedHeadOid: action.expectedHeadOid,
      method: action.method,
      receipt: { id: "merge-mirror-42" },
    };
  }
  return observation;
}

function createFakeTransport() {
  const observations = new Map();
  let responseLost = false;
  const calls = [];
  return {
    calls,
    async observe(input) {
      calls.push({ method: "observe", input: structuredClone(input) });
      return structuredClone(
        observations.get(input.marker) ?? initialObservation(input),
      );
    },
    async perform(input) {
      calls.push({ method: "perform", input: structuredClone(input) });
      observations.set(input.marker, completedObservation(input));
      if (!responseLost) {
        responseLost = true;
        throw new PullRequestExternalActionTransportError(
          "GITHUB_RESPONSE_LOST",
          "unknown",
        );
      }
      return { accepted: true };
    },
  };
}

function approval(item, requestId) {
  return {
    requestId,
    expectedQueueRevision: item.queueRevision,
    expectedItemRevision: item.itemRevision,
    displayedPayloadDigest: item.displayedPayloadDigest,
    approvalBindingDigest: item.approvalBindingDigest,
  };
}

function routingRule() {
  return {
    id: "u9-pr-to-pr-engineer",
    source: "root",
    enabled: true,
    priority: 100,
    fallback: false,
    condition: {
      op: "equals",
      path: "eventType",
      value: "pull_request.updated",
    },
    targets: [{ type: "role", id: "pr-engineer" }],
    onMatch: "stop",
  };
}

function role({ model, intents, taskBrain = false, workerId }) {
  return {
    name: model,
    mission: `Advance the mirrored PR as ${model}.`,
    enabled: true,
    scheduleMinutes: 5,
    initialPaused: false,
    permissions: { allowedIntents: intents },
    ...(workerId === undefined ? {} : { workerId }),
    brain: {
      provider: "routine",
      model,
      remoteData: { requirements: false, code: false, memory: false },
    },
    ...(taskBrain
      ? {
          taskBrain: {
            provider: "strong",
            model: `strong-${model}`,
            remoteData: { requirements: true, code: true, memory: false },
          },
        }
      : {}),
  };
}

function applicationConfig(fixture, gitCommand) {
  return {
    refreshMinutes: 10,
    trackedRepositories: [],
    prResponsibility: {},
    brain: { enabled: false },
    dingtalk: { enabled: false },
    workflowRouting: {
      schemaVersion: 1,
      enabled: true,
      maxHops: 8,
      rules: [routingRule()],
    },
    githubActions: {
      enabled: true,
      actorAccountId: "runtime-user",
      tokenEnv: "GH_TOKEN",
      ghCommand: process.execPath,
      enabledActions: ["comment", "review", "update_branch", "push", "merge"],
    },
    workCoordination: {
      enabled: true,
      intakeLimit: 20,
      workLimit: 20,
      dispatchLimit: 20,
      attentionLimit: 20,
      proposalLimit: 20,
      conditionLimit: 20,
      codeJobLimit: 20,
      codeJobMemoryLimit: 20,
      codeJobMaximumTurns: 12,
      codeJobObservationLimit: 12,
      leaseDurationMs: 60_000,
      resolveTimeoutMs: 5_000,
      decisionTimeoutMs: 5_000,
      maxAttempts: 3,
      retryBaseMs: 1_000,
      retryMaxMs: 2_000,
      factMaximumAgeMs: 60_000,
      policy: {
        version: 2,
        capabilityRoles: {
          coordination: "orchestrator",
          development: "developer",
          testing: "tester",
          "pr-review": "pr-engineer",
        },
        githubReviewRoles: ["pr-engineer"],
        codeActionRoles: ["developer", "tester"],
        codeOperationsByRole: {
          developer: ["modify"],
          tester: ["verify"],
        },
        workspaceByRepository: {
          "acme/runtime-test": "mirror-workspace",
        },
      },
    },
    memory: {
      enabled: true,
      maximumRecords: 2_000,
      maximumStateBytes: 16 * 1024 * 1024,
      answering: {
        enabled: true,
        brain: {
          provider: "routine",
          model: "memory-model",
          remoteData: { requirements: false, code: false, memory: false },
        },
        localBrain: {
          provider: "routine",
          model: "memory-model",
          remoteData: { requirements: false, code: false, memory: false },
        },
        maximumRecords: 20,
        maximumContextBytes: 112 * 1024,
        maximumConcurrent: 1,
      },
    },
    codeExecutor: {
      enabled: true,
      gitCommand,
      gitTimeoutMs: 30_000,
      conflictPreparation: {
        enabled: true,
        baseMirrorsByRepository: {
          "acme/runtime-test": fixture.baseMirrorRoot,
        },
        headMirrorsByRepository: {
          "contributor/runtime-test": fixture.headMirrorRoot,
        },
      },
      docker: {
        executable: process.execPath,
        host: "npipe:////./pipe/u9-e2e-unused",
      },
      workspaces: [{
        id: "mirror-workspace",
        sourceRoot: fixture.sourceRoot,
        writablePaths: ["src"],
        gitHeadSnapshot: true,
      }],
      profiles: { "node-tests": PROFILE },
      requiredProfilesByWorkspace: { "mirror-workspace": ["node-tests"] },
    },
    changePackages: {
      enabled: true,
      gitCommand,
      gitTimeoutMs: 30_000,
    },
    brainProviders: {
      routine: {
        kind: "ollama",
        baseUrl: "http://127.0.0.1:11434",
      },
      strong: {
        kind: "openai-compatible",
        baseUrl: "https://ark.example/api/coding/v3",
        apiKeyEnv: "ARK_TOKEN",
        remote: true,
      },
    },
    employees: {
      prReviewer: { enabled: false },
      roles: {
        orchestrator: role({
          model: "routine-orchestrator",
          intents: ["ask_user", "orchestrate", "complete"],
          taskBrain: true,
          workerId: "employee-orchestrator",
        }),
        "pr-engineer": role({
          model: "routine-pr-engineer",
          intents: [
            "handoff",
            "propose_code_action",
            "submit_delivery",
            "propose_github_pull_request_action",
            "complete",
          ],
          taskBrain: true,
          workerId: "employee-pr-engineer",
        }),
        developer: role({
          model: "routine-developer",
          intents: ["propose_code_action", "submit_delivery", "complete"],
          taskBrain: true,
          workerId: "employee-developer",
        }),
        tester: role({
          model: "routine-tester",
          intents: ["propose_code_action", "submit_delivery", "complete"],
          taskBrain: true,
          workerId: "employee-tester",
        }),
      },
    },
  };
}

function pullRequestEvent(fixture, {
  headRefOid,
  previousHeadRefOid,
  ciStatus,
  mergeStateStatus,
  nextAction,
  occurredAt,
}) {
  return {
    schemaVersion: 1,
    eventType: "pull_request.updated",
    occurredAt,
    source: { provider: "github", scopeId: "github-account:runtime-user" },
    subject: {
      id: "github:pr:acme/runtime-test#42",
      repository: "acme/runtime-test",
      number: 42,
    },
    payload: {
      title: "Resolve the mirrored conflict",
      headRefOid,
      ...(previousHeadRefOid === undefined ? {} : { previousHeadRefOid }),
      ciStatus,
      mergeStateStatus,
      nextAction,
      changedFields: previousHeadRefOid === undefined
        ? ["ciStatus", "mergeStateStatus"]
        : ["headRefOid", "ciStatus", "mergeStateStatus"],
      gitTargetAvailable: true,
      gitTarget: {
        schemaVersion: 1,
        provider: "github",
        sourceAccountId: "runtime-user",
        baseRepository: "acme/runtime-test",
        baseRefName: "main",
        baseRefOid: fixture.baseOid,
        headRepository: "contributor/runtime-test",
        headRefName: "feature",
        headRefOid,
      },
    },
  };
}

function pullRequestFactsLoader(clock, calls) {
  return {
    async loadPullRequestFacts(input) {
      const identity = createPullRequestReadIdentity(input);
      const conclusion = input.event.payload.ciStatus;
      calls.push({
        headRefOid: input.executionBinding.headRefOid,
        conclusion,
        identityDigest: identity.identityDigest,
      });
      return createPullRequestReadFacts({
        identity,
        observedAt: clock().toISOString(),
        reviewDecision: "REVIEW_REQUIRED",
        comments: [],
        reviews: [],
        reviewThreads: [],
        checks: [{
          kind: "check_run",
          name: "fixed-tests",
          status: "COMPLETED",
          conclusion,
          url: "https://github.com/acme/runtime-test/actions/runs/42",
          startedAt: "2026-08-08T00:00:00.000Z",
          completedAt: "2026-08-08T00:01:00.000Z",
          requirement: "required",
        }],
        truncation: {
          comments: false,
          reviews: false,
          reviewThreads: false,
          checks: false,
          byteBudget: false,
        },
      });
    },
  };
}

async function waitForJob(application, predicate, runHousekeeping, limit = 20) {
  for (let cycle = 0; cycle < limit; cycle += 1) {
    await runHousekeeping();
    const jobs = await application.codeJobReader.listNewest({ limit: 20 });
    const match = jobs.items.find(predicate);
    if (match) {
      // Proposal polling precedes code execution in housekeeping. A job that
      // just finished needs the next poll before its role can submit delivery.
      await runHousekeeping();
      return application.codeJobReader.getDetail({ jobId: match.jobId });
    }
  }
  throw new Error("timed out waiting for the mirrored Code Job");
}

function actionFromQueueItem(item) {
  return item.display.payload.action.type.replace("pull_request_", "");
}

const gitCommand = locateGit();

test(
  "a real mirrored PR crosses composition, conflict execution, confirmations, restart, new Head, and cited memory",
  {
    skip: gitCommand === null ? "trusted Git is unavailable" : false,
    timeout: 300_000,
  },
  async (t) => {
    const fixture = await createGitFixture(t, gitCommand);
    const immutableBefore = await Promise.all([
      directorySnapshot(fixture.sourceRoot),
      directorySnapshot(fixture.baseMirrorRoot),
      directorySnapshot(fixture.headMirrorRoot),
    ]);
    const sandbox = new FixedSandbox();
    const transport = createFakeTransport();
    const state = {
      headTwo: fixture.headTwo,
      consultedHead: null,
      controlledCommitEvidenceId: null,
      oldEvidenceRejected: false,
      brainCalls: [],
    };
    const factCalls = [];
    const credentialCalls = [];
    const dataRoot = path.join(fixture.root, "application-data");
    let now = Date.parse("2026-08-08T01:00:00.000Z");
    const clock = () => new Date(now);
    const advance = () => {
      now += 60_000;
    };
    const config = applicationConfig(fixture, gitCommand);
    assert.equal(
      config.workCoordination.policy.capabilityRoles.development,
      "developer",
    );
    assert.equal(
      config.workCoordination.policy.capabilityRoles["pr-review"],
      "pr-engineer",
    );
    const developerRole = config.employees.roles.developer;
    const prEngineerRole = config.employees.roles["pr-engineer"];
    const testerRole = config.employees.roles.tester;
    assert.ok(developerRole);
    assert.notEqual(developerRole.workerId, prEngineerRole.workerId);
    assert.notEqual(developerRole.taskBrain.model, prEngineerRole.taskBrain.model);
    assert.notEqual(developerRole.workerId, testerRole.workerId);
    assert.notEqual(developerRole.taskBrain.model, testerRole.taskBrain.model);
    assert.deepEqual(config.workCoordination.policy.githubReviewRoles, [
      "pr-engineer",
    ]);
    assert.deepEqual(config.workCoordination.policy.codeActionRoles, [
      "developer",
      "tester",
    ]);
    const brainFetch = createBrainFetch(state);
    let application = null;
    let proposalRuntime = null;

    const startApplication = async () => {
      const app = await createApplication({
        config,
        versionedConfiguration: false,
        store: new StateStore(path.join(dataRoot, "state")),
        operationsRuntimeFactory: () => Object.freeze({}),
        codeExecutorDependencies: {
          runtimeRoot: path.join(dataRoot, "code-executor"),
          sourceBaseRoot: fixture.root,
          sandbox,
        },
        changePackageRuntimeDependencies: {
          dataDirectory: path.join(dataRoot, "change-package-state"),
          packageRoot: path.join(dataRoot, "change-packages"),
          createGuard: guardFactory,
          clock,
        },
        codeJobRuntimeDependencies: {
          dataDirectory: path.join(dataRoot, "code-job-state"),
          createGuard: guardFactory,
          clock,
        },
        confirmationRuntimeDependencies: {
          dataDirectory: path.join(dataRoot, "confirmation-state"),
          createGuard: guardFactory,
          clock,
        },
        workflowRoutingDependencies: { createGuard: guardFactory, clock },
        workLedgerDependencies: { createGuard: guardFactory, clock },
        attentionInboxDependencies: { createGuard: guardFactory, clock },
        workProposalDependencies: {
          createGuard: guardFactory,
          clock,
          idFactory: () => `lease-${now}`,
        },
        memoryRuntimeDependencies: { createGuard: guardFactory },
        memoryAnswerDependencies: {
          brainDependencies: { fetch: brainFetch },
        },
        workCoordinationDependencies: {
          clock,
          brainDependencies: {
            fetch: brainFetch,
            environment: { ARK_TOKEN: "fake-ark-token" },
          },
        },
        prEngineerExclusiveGuardFactory: guardFactory,
        pullRequestFactsLoaderFactory: () =>
          pullRequestFactsLoader(clock, factCalls),
        githubCredentialSourceFactory: async () => Object.freeze({
          async acquire() {
            credentialCalls.push("requested");
            return Object.freeze({
              async use(callback) {
                return callback("fake-github-token");
              },
              async release() {},
            });
          },
        }),
        pullRequestExternalActionDependencies: {
          transport,
        },
        workProposalRuntimeFactory: async (options) => {
          proposalRuntime = await createWorkProposalRuntime(options);
          return proposalRuntime;
        },
      });
      return app;
    };
    application = await startApplication();
    t.after(async () => application?.close());

    const roleCycles = [];
    const runRole = async (roleId) => {
      const result = await application.workCoordination.runCycle({
        trigger: `u9:${roleId}`,
        includeWork: true,
        roleId,
      });
      roleCycles.push({ roleId, work: result.stages.work });
      advance();
      return result;
    };
    const runHousekeeping = async () => {
      const result = await application.workCoordination.runCycle({
        trigger: "u9:housekeeping",
        includeWork: false,
      });
      advance();
      return result;
    };
    const answerOwnerConsultation = async (expectedHead) => {
      let request = await application.attentionBrowser.next();
      if (request === null) {
        await runHousekeeping();
        request = await application.attentionBrowser.next();
      }
      assert.ok(request);
      assert.equal(request.type, "ask_user");
      assert.match(request.question, new RegExp(expectedHead));
      const answered = await application.attentionBrowser.answer({
        requestId: request.requestId,
        expectedRevision: request.revision,
        contentDigest: request.contentDigest,
        answer: { type: "choice", choiceId: "continue" },
      });
      assert.equal(answered.status, "answered");
      state.consultedHead = expectedHead;
      await runHousekeeping();
      return { request, answered };
    };

    await application.workflowRouting.ingest({
      event: pullRequestEvent(fixture, {
        headRefOid: fixture.headOne,
        ciStatus: "FAILURE",
        mergeStateStatus: "DIRTY",
        nextAction: "resolve_conflict",
        occurredAt: clock().toISOString(),
      }),
    });
    await runHousekeeping();
    await runRole("pr-engineer");
    await runHousekeeping();
    await runRole("orchestrator");
    const headOneConsultation = await answerOwnerConsultation(fixture.headOne);
    await runRole("orchestrator");
    await runRole("developer");
    await runHousekeeping();
    let next = await application.confirmationQueue.next();
    assert.equal(next.pendingCount, 1);
    assert.equal(next.item.kind, "local.code-job-create");
    assert.equal(
      next.item.display.payload.action.grant.executionSource.kind,
      "conflict_preparation",
    );
    assert.deepEqual(
      next.item.display.payload.action.grant.writablePaths,
      ["src/conflict.txt"],
    );
    const createdResolution = await application.confirmationQueue.approve(
      next.item.id,
      approval(next.item, "approve-u9-resolution-job"),
    );
    assert.equal(createdResolution.status, "completed");

    const resolutionDetail = await waitForJob(
      application,
      ({ jobId, status }) =>
        jobId === createdResolution.receipt.id && status === "completed",
      runHousekeeping,
    );
    assert.equal(resolutionDetail.job.status, "completed");
    assert.equal(resolutionDetail.job.operation, "modify");
    assert.equal(resolutionDetail.changePackage.status, "ready");
    assert.ok(resolutionDetail.changePackage.receipt.controlledCommit);
    state.controlledCommitEvidenceId =
      resolutionDetail.changePackage.receipt.controlledCommit.evidenceId;
    assert.match(
      state.controlledCommitEvidenceId,
      /^controlled-git-commit-[a-f0-9]{64}$/u,
    );
    assert.deepEqual(
      resolutionDetail.observations.map(({ actionType }) => actionType),
      ["read_text", "write_text", "run_profile", "complete"],
    );
    assert.equal(
      state.brainCalls
        .filter(({ model }) => model.startsWith("strong-"))
        .every(({ url }) =>
          url === "https://ark.example/api/coding/v3/chat/completions"),
      true,
    );
    assert.equal(
      state.brainCalls.some(({ model, context }) =>
        model === "strong-routine-developer" &&
        context.requirements?.roleId === "developer"),
      true,
    );
    assert.equal(sandbox.runs.length, 1);

    await runRole("developer");
    await runRole("orchestrator");
    await runRole("orchestrator");
    await runRole("tester");
    await runHousekeeping();
    next = await application.confirmationQueue.next();
    assert.ok(next.item, `missing verification confirmation: ${JSON.stringify(roleCycles.slice(-4))}`);
    assert.equal(next.item.kind, "local.code-job-create");
    const createdVerification = await application.confirmationQueue.approve(
      next.item.id,
      approval(next.item, "approve-u9-verification-job"),
    );
    assert.equal(createdVerification.status, "completed");
    const verificationDetail = await waitForJob(
      application,
      ({ jobId, status }) =>
        jobId === createdVerification.receipt.id && status === "completed",
      runHousekeeping,
    );
    assert.equal(verificationDetail.job.operation, "verify");
    assert.deepEqual(
      verificationDetail.observations.map(({ actionType }) => actionType),
      ["read_text", "run_profile", "complete"],
    );
    assert.equal(sandbox.runs.length, 2);
    await runRole("tester");
    await runRole("orchestrator");

    await runRole("orchestrator");
    for (let index = 0; index < ACTION_TITLES.length; index += 1) {
      await runRole("orchestrator");
    }
    const credentialsBeforeForgery = credentialCalls.length;
    const transportBeforeForgery = transport.calls.length;
    const actionCycle = await runRole("pr-engineer");
    assert.equal(actionCycle.stages.work.result.staged, ACTION_TITLES.length + 1);
    assert.equal(actionCycle.stages.dispatch.result.blocked, 1);
    assert.equal(actionCycle.stages.dispatch.result.delivered, ACTION_TITLES.length);
    assert.equal(
      actionCycle.stages.dispatch.result.items.find(
        ({ status }) => status === "blocked",
      ).code,
      "controlled-commit-evidence-invalid",
    );
    assert.equal(credentialCalls.length, credentialsBeforeForgery);
    assert.equal(transport.calls.length, transportBeforeForgery);
    assert.equal((await application.confirmationQueue.next()).item, null);
    await runHousekeeping();
    next = await application.confirmationQueue.next();
    assert.equal(next.pendingCount, ACTION_TITLES.length);
    const responseLostAction = actionFromQueueItem(next.item);
    const unknownAction = await application.confirmationQueue.approve(
      next.item.id,
      approval(next.item, `approve-u9-${responseLostAction}-lost-response`),
    );
    assert.equal(unknownAction.status, "failed");
    assert.equal(unknownAction.failure.outcome, "unknown");
    assert.equal(
      transport.calls.filter(({ method }) => method === "perform").length,
      1,
    );

    await application.close();
    application = await startApplication();
    const recoveredAction = await application.confirmationQueue.get(
      unknownAction.id,
    );
    assert.equal(recoveredAction.status, "completed");
    assert.equal(
      transport.calls.filter(({ method }) => method === "perform").length,
      1,
    );

    const approvedActions = [responseLostAction];
    let deferredOldAction = null;
    while (true) {
      next = await application.confirmationQueue.next(
        deferredOldAction === null
          ? undefined
          : {
              deferred: [{
                id: deferredOldAction.id,
                approvalBindingDigest:
                  deferredOldAction.approvalBindingDigest,
              }],
            },
      );
      if (next.item === null) break;
      const actionType = actionFromQueueItem(next.item);
      if (deferredOldAction === null && actionType !== "push") {
        deferredOldAction = next.item;
        continue;
      }
      const result = await application.confirmationQueue.approve(
        next.item.id,
        approval(next.item, `approve-u9-${actionType}`),
      );
      assert.equal(result.status, "completed");
      approvedActions.push(actionType);
    }
    assert.ok(deferredOldAction);
    assert.ok(approvedActions.includes("push"));
    const oldConfirmation = {
      item: await application.confirmationQueue.get(deferredOldAction.id),
    };
    assert.equal(new Set([
      ...approvedActions,
      actionFromQueueItem(oldConfirmation.item),
    ]).size, ACTION_TITLES.length);
    await runHousekeeping();
    await runHousekeeping();
    await application.memoryProjector.runCycle();
    const oldHeadJournal = new LocalMemoryJournal({
      store: application.store,
      exclusiveLease: { async run(operation) { return operation(); } },
    });
    await oldHeadJournal.recover();
    const oldHeadSearches = await Promise.all([
      application.memorySearch.search({
        q: state.controlledCommitEvidenceId,
        repository: "acme/runtime-test",
        limit: 20,
      }),
      application.memorySearch.search({
        q: "external-result",
        repository: "acme/runtime-test",
        limit: 20,
      }),
      application.memorySearch.search({
        q: "consultation-request",
        repository: "acme/runtime-test",
        limit: 20,
      }),
      application.memorySearch.search({
        q: "consultation-result",
        repository: "acme/runtime-test",
        limit: 20,
      }),
    ]);
    const oldHeadCandidateIds = [...new Set(oldHeadSearches.flatMap(
      ({ items }) => items.map(({ id }) => id),
    ))];
    const oldHeadCurrentEntries = [];
    for (let index = 0; index < oldHeadCandidateIds.length; index += 20) {
      oldHeadCurrentEntries.push(...oldHeadJournal.readRecords({
        recordIds: oldHeadCandidateIds.slice(index, index + 20),
      }).items.map((entry) => ({
        ...entry,
        content: JSON.parse(entry.record.content),
      })));
    }
    const oldPushDecisionCurrent = oldHeadCurrentEntries.find(
      ({ record, content, labels }) =>
        record.source.kind === "work-decision" &&
        labels.lifecycle === "current" &&
        content.authority?.inputBinding?.headRefOid === fixture.headOne &&
        content.decision?.value?.evidence?.includes(
          `controlled-commit:${state.controlledCommitEvidenceId}`,
        ),
    );
    const oldPushConfirmationCurrent = oldHeadCurrentEntries.find(
      ({ record, content, labels }) =>
        record.source.kind === "confirmation" &&
        labels.lifecycle === "current" &&
        content.action?.type === "pull_request_push" &&
        content.action.inputBinding.headRefOid === fixture.headOne,
    );
    const oldPushExternalCurrent = oldHeadCurrentEntries.find(
      ({ record, content, labels }) =>
        record.source.kind === "external-result" &&
        labels.lifecycle === "current" &&
        content.actionType === "pull_request_push" &&
        content.confirmationId ===
          oldPushConfirmationCurrent?.content.confirmationId,
    );
    assert.ok(oldPushDecisionCurrent);
    assert.ok(oldPushConfirmationCurrent);
    assert.ok(oldPushExternalCurrent);
    const oldConsultationRequestCurrent = oldHeadCurrentEntries.find(
      ({ record, content, labels }) =>
        record.source.kind === "consultation-request" &&
        labels.lifecycle === "current" &&
        content.authority?.inputBinding?.headRefOid === fixture.headOne &&
        content.details?.consultationRequest?.question.includes(fixture.headOne),
    );
    const oldConsultationResultCurrent = oldHeadCurrentEntries.find(
      ({ record, content, labels }) =>
        record.source.kind === "consultation-result" &&
        labels.lifecycle === "current" &&
        content.authority?.inputBinding?.headRefOid === fixture.headOne &&
        content.details?.questionRef === headOneConsultation.request.requestId,
    );
    assert.ok(oldConsultationRequestCurrent);
    assert.ok(oldConsultationResultCurrent);
    const oldHeadMemoryIds = {
      decision: oldPushDecisionCurrent.record.recordId,
      confirmation: oldPushConfirmationCurrent.record.recordId,
      externalResult: oldPushExternalCurrent.record.recordId,
    };
    const oldConsultationMemoryIds = [
      oldConsultationRequestCurrent.record.recordId,
      oldConsultationResultCurrent.record.recordId,
    ];
    const callsBeforeNewHead = {
      credentials: credentialCalls.length,
      transport: transport.calls.length,
      performs: transport.calls.filter(({ method }) => method === "perform").length,
    };

    await application.workflowRouting.ingest({
      event: pullRequestEvent(fixture, {
        headRefOid: fixture.headTwo,
        previousHeadRefOid: fixture.headOne,
        ciStatus: "SUCCESS",
        mergeStateStatus: "CLEAN",
        nextAction: "merge",
        occurredAt: clock().toISOString(),
      }),
    });
    await application.workCoordination.intake();
    const refreshedOldConfirmation = await application.confirmationQueue.get(
      oldConfirmation.item.id,
    );
    const staleOldAction = await application.confirmationQueue.approve(
      refreshedOldConfirmation.id,
      approval(
        refreshedOldConfirmation,
        "reject-stale-u9-action-by-head-change",
      ),
    );
    assert.equal(staleOldAction.status, "stale");
    assert.equal(credentialCalls.length, callsBeforeNewHead.credentials);
    assert.equal(transport.calls.length, callsBeforeNewHead.transport);
    assert.equal(
      transport.calls.filter(({ method }) => method === "perform").length,
      callsBeforeNewHead.performs,
    );

    for (let cycle = 0; cycle < 10; cycle += 1) {
      await runHousekeeping();
      await application.workCoordination.intake();
      const root = (await application.workLedgerView.listItems({ limit: 50 }))
        .items.find(({ source }) => source?.kind === "pull_request");
      if (root?.source.current.headRefOid === fixture.headTwo) break;
    }
    let root = (await application.workLedgerView.listItems({ limit: 50 }))
      .items.find(({ source }) => source?.kind === "pull_request");
    assert.equal(root.source.current.headRefOid, fixture.headTwo);
    assert.equal(root.source.headRevision, 2);

    await runRole("orchestrator");
    const headTwoConsultation = await answerOwnerConsultation(fixture.headTwo);
    await runRole("orchestrator");
    const oldEvidenceCycle = await runRole("pr-engineer");
    assert.equal(oldEvidenceCycle.stages.dispatch.result.blocked, 1);
    assert.equal(
      oldEvidenceCycle.stages.dispatch.result.items[0].code,
      "controlled-commit-evidence-invalid",
    );
    state.oldEvidenceRejected = true;
    const beforeOldEvidenceBoundary = {
      credentials: credentialCalls.length,
      transport: transport.calls.length,
    };
    assert.deepEqual(beforeOldEvidenceBoundary, {
      credentials: callsBeforeNewHead.credentials,
      transport: callsBeforeNewHead.transport,
    });

    await runRole("orchestrator");
    await runRole("orchestrator");
    await runRole("pr-engineer");
    await runRole("orchestrator");
    await runRole("pr-engineer");
    await runHousekeeping();
    next = await application.confirmationQueue.next();
    assert.equal(next.pendingCount, 1);
    assert.equal(actionFromQueueItem(next.item), "merge");
    assert.equal(
      next.item.display.payload.action.inputBinding.headRefOid,
      fixture.headTwo,
    );
    const merged = await application.confirmationQueue.approve(
      next.item.id,
      approval(next.item, "approve-u9-head-two-merge"),
    );
    assert.equal(merged.status, "completed");
    for (let cycle = 0; cycle < 5; cycle += 1) {
      await runHousekeeping();
      await runRole("orchestrator");
      root = (await application.workLedgerView.listItems({ limit: 50 }))
        .items.find(({ source }) => source?.kind === "pull_request");
      if (root.status === "completed") break;
    }
    const finalItems = await application.workLedgerView.listItems({ limit: 50 });
    assert.equal(
      root.status,
      "completed",
      JSON.stringify(finalItems.items.map((item) => ({
        title: item.assignment.work?.title ?? item.event.payload.title,
        status: item.status,
        statusReason: item.statusReason,
        headRevision: item.assignment.graphTask?.sourceBinding?.headRevision ??
          item.source?.headRevision,
      }))),
    );
    assert.equal(root.source.current.headRefOid, fixture.headTwo);

    await application.memoryProjector.runCycle();
    const memoryQueries = await Promise.all([
      "work-decision",
      "confirmation",
      "external-result",
      "consultation-request",
      "consultation-result",
      state.controlledCommitEvidenceId,
      "SUCCESS",
    ].map((q) => application.memorySearch.search({
      q,
      repository: "acme/runtime-test",
      limit: 100,
    })));
    const candidateIds = [...new Set(memoryQueries.flatMap(({ items }) =>
      items.map(({ id }) => id)
    ))];
    assert.ok(candidateIds.length > 0);
    const memoryJournal = new LocalMemoryJournal({
      store: application.store,
      exclusiveLease: { async run(operation) { return operation(); } },
    });
    await memoryJournal.recover();
    const hydratedEntries = [];
    for (let index = 0; index < candidateIds.length; index += 20) {
      hydratedEntries.push(...memoryJournal.readRecords({
        recordIds: candidateIds.slice(index, index + 20),
      }).items);
    }
    const memoryEntries = hydratedEntries.map((entry) => ({
      ...entry,
      content: JSON.parse(entry.record.content),
    }));
    const findMemory = (description, predicate) => {
      const found = memoryEntries.find(predicate);
      assert.ok(found, description);
      return found;
    };
    const oldHeadIds = Object.values(oldHeadMemoryIds);
    const oldHeadExactEntries = memoryJournal.readRecords({
      recordIds: oldHeadIds,
    }).items.map((entry) => ({
      ...entry,
      content: JSON.parse(entry.record.content),
    }));
    assert.deepEqual(
      oldHeadExactEntries.map(({ record }) => record.source.kind),
      ["work-decision", "confirmation", "external-result"],
    );
    assert.ok(oldHeadExactEntries.every(({ content }) =>
      content.authority?.inputBinding?.headRefOid === fixture.headOne ||
      content.inputBinding?.headRefOid === fixture.headOne ||
      content.action?.inputBinding?.headRefOid === fixture.headOne
    ));
    assert.ok(oldHeadExactEntries.every(({ labels }) =>
        labels.authority === "raw" && labels.lifecycle === "obsolete"
    ));

    const mergeConfirmation = findMemory(
      "current-Head merge confirmation memory is missing",
      ({ record, content }) =>
        record.source.kind === "confirmation" &&
        content.status === "completed" &&
        content.action?.type === "pull_request_merge" &&
        content.action.inputBinding.headRefOid === fixture.headTwo,
    );
    const mergeExternalResult = findMemory(
      "current-Head merge external result memory is missing",
      ({ record, content }) =>
        record.source.kind === "external-result" &&
        content.status === "completed" &&
        content.actionType === "pull_request_merge" &&
        content.inputBinding?.headRefOid === fixture.headTwo &&
        content.confirmationId === mergeConfirmation.content.confirmationId,
    );
    const mergeDecision = findMemory(
      "current-Head merge decision memory is missing",
      ({ record, content }) =>
        record.source.kind === "work-decision" &&
        content.authority?.inputBinding?.headRefOid === fixture.headTwo &&
        content.decision?.source === "proposal" &&
        content.decision.value?.evidence?.includes(
          `confirmation:${mergeConfirmation.content.confirmationId}`,
        ) &&
        content.decision.value.evidence?.includes(
          `receipt:${mergeExternalResult.content.receipt?.id}`,
        ),
    );
    assert.equal(mergeDecision.content.workItemRevision > 0, true);
    assert.equal(
      mergeDecision.content.decision.contentDigest,
      digestValue({
        source: mergeDecision.content.decision.source,
        referenceId: mergeDecision.content.decision.referenceId,
        outcome: mergeDecision.content.decision.outcome,
        value: mergeDecision.content.decision.value,
        observedAt: mergeDecision.content.decision.observedAt,
      }),
    );
    assert.deepEqual(Object.keys(mergeExternalResult.content.receipt), ["id"]);
    assert.deepEqual(
      mergeExternalResult.content.actor,
      mergeConfirmation.content.actor,
    );
    assert.deepEqual(
      mergeExternalResult.content.target,
      mergeConfirmation.content.target,
    );
    assert.doesNotMatch(
      `${mergeConfirmation.record.content}${mergeExternalResult.record.content}`,
      /credential|authorization|localPath|absolutePath|headers?/iu,
    );
    const consultationRequestMemory = findMemory(
      "current-Head consultation request memory is missing",
      ({ record, content }) =>
        record.source.kind === "consultation-request" &&
        content.authority?.inputBinding?.headRefOid === fixture.headTwo &&
        content.details?.consultationRequest?.question.includes(fixture.headTwo),
    );
    const consultationResultMemory = findMemory(
      "current-Head consultation result memory is missing",
      ({ record, content }) =>
        record.source.kind === "consultation-result" &&
        content.authority?.inputBinding?.headRefOid === fixture.headTwo &&
        content.details?.questionRef === headTwoConsultation.request.requestId &&
        content.details?.answer?.choiceId === "continue",
    );
    const oldConsultationEntries = memoryJournal.readRecords({
      recordIds: oldConsultationMemoryIds,
    }).items;
    assert.ok(oldConsultationEntries.every(({ labels }) =>
      labels.lifecycle === "obsolete"
    ));
    const ciMemory = findMemory(
      "current successful CI observation memory is missing",
      ({ record, content }) =>
        record.source.kind === "work-item" &&
        content.sourceAuthority?.executionBinding?.headRefOid === fixture.headTwo &&
        content.pullRequestObservation?.headRefOid === fixture.headTwo &&
        content.pullRequestObservation?.ciStatus === "SUCCESS",
    );
    const selectedMemory = [
      mergeDecision,
      mergeConfirmation,
      mergeExternalResult,
      consultationRequestMemory,
      consultationResultMemory,
      ciMemory,
    ];
    assert.ok(selectedMemory.every(({ labels }) =>
      labels.authority === "raw" && labels.lifecycle === "current"
    ));
    const selectedIds = selectedMemory.map(({ record }) => record.recordId);
    assert.equal(new Set(selectedIds).size, selectedIds.length);
    const obsoleteRetriever = new MemoryContextRetriever({
      memorySearch: {
        async search() {
          return {
            items: oldHeadIds.map((id) => ({ id })),
            nextCursor: null,
            totalMatched: oldHeadIds.length,
            indexHealthy: true,
          };
        },
      },
      contextReader: {
        readRecords: (value) => memoryJournal.readRecords(value),
      },
      maximumRecords: 20,
      maximumContextBytes: 112 * 1024,
    });
    const obsoleteContext = await obsoleteRetriever.retrieve({
      question: "Can the old Head push still authorize a conclusion?",
      retrieval: { kind: "query", filters: { query: "" } },
    });
    assert.deepEqual(obsoleteContext.recordIds, oldHeadIds);
    assert.deepEqual(obsoleteContext.citableRecordIds, []);
    const question = "What happened to the mirrored conflict PR?";
    const selectedRetriever = new MemoryContextRetriever({
      memorySearch: {
        async search() {
          return {
            items: selectedIds.map((id) => ({ id })),
            nextCursor: null,
            totalMatched: selectedIds.length,
            indexHealthy: true,
          };
        },
      },
      contextReader: {
        readRecords: (value) => memoryJournal.readRecords(value),
      },
      maximumRecords: 20,
      maximumContextBytes: 112 * 1024,
    });
    const selectedContext = await selectedRetriever.retrieve({
      question,
      retrieval: { kind: "query", filters: { query: "" } },
    });
    assert.deepEqual(selectedContext.recordIds, selectedIds);
    assert.deepEqual(selectedContext.citableRecordIds, selectedIds);
    const answer = await application.memoryAnswer.answer({
      schemaVersion: 1,
      question,
      mode: "local",
      retrieval: {
        kind: "context",
        contextDigest: selectedContext.contextDigest,
        recordIds: selectedContext.recordIds,
      },
    });
    assert.equal(answer.status, "answered");
    assert.equal(answer.claims.length, selectedIds.length);
    assert.deepEqual(
      new Set(answer.citations.map(({ recordId }) => recordId)),
      new Set(selectedIds),
    );
    assert.equal(
      answer.citations.every(({ labels }) =>
        labels.authority === "raw" && labels.lifecycle === "current"
      ),
      true,
    );

    const finalCodeJobIds = (await application.codeJobReader.list({
      limit: 20,
    })).items.map(({ jobId }) => jobId);
    assert.ok(finalCodeJobIds.length > 0);
    const finalCodeJobDetails = await Promise.all(
      finalCodeJobIds.map((jobId) => application.codeJobReader.getDetail({ jobId })),
    );
    const finalCodeJobMemoryRecordIds = finalCodeJobDetails.map(
      ({ job }) => job.memoryProjection.recordId,
    );
    const selectedCitationBindings = selectedMemory.map(({ record, labels }) => ({
      recordId: record.recordId,
      contentDigest: record.contentDigest,
      labels,
    }));
    const oldHeadCitationBindings = oldHeadExactEntries.map(({ record, labels }) => ({
      recordId: record.recordId,
      contentDigest: record.contentDigest,
      labels,
    }));
    const memoryRecordIdsBeforeFinalArchive = [
      ...selectedIds,
      ...oldHeadIds,
      ...finalCodeJobMemoryRecordIds,
    ];
    const stateBeforeFinalArchive = {
      assignments: await application.workflowRouting.listAssignments({ limit: 50 }),
      graph: await application.workGraphView.getSnapshot(),
      ledger: await application.workLedgerView.listItems({ limit: 50 }),
      timeline: await readCompleteWorkLedgerTimeline(application.workLedgerView),
      confirmationHistory: await application.confirmationQueue.historyReader.list({
        limit: 50,
      }),
      memoryRecords: await readMemoryRecords(
        memoryJournal,
        memoryRecordIdsBeforeFinalArchive,
      ),
      codeJobs: archivedProjection(finalCodeJobDetails),
      brainCalls: structuredClone(state.brainCalls),
      sandboxRuns: structuredClone(sandbox.runs),
      transportCalls: structuredClone(transport.calls),
      credentialCalls: structuredClone(credentialCalls),
      factCalls: structuredClone(factCalls),
      sourceTrees: await Promise.all([
        directorySnapshot(fixture.sourceRoot),
        directorySnapshot(fixture.baseMirrorRoot),
        directorySnapshot(fixture.headMirrorRoot),
      ]),
    };
    const graphTaskByTitle = (title) => {
      const taskState = stateBeforeFinalArchive.graph.taskStates.find(
        ({ work }) => work.title === title,
      );
      assert.ok(taskState, `missing persisted graph task state for ${title}`);
      const task = stateBeforeFinalArchive.graph.graph.tasks.find(
        ({ taskId }) => taskId === taskState.taskId,
      );
      assert.ok(task, `missing persisted graph task for ${title}`);
      return { task, taskState };
    };
    const rootTask = graphTaskByTitle("Resolve the mirrored conflict");
    const resolvedConflict = graphTaskByTitle("Resolve mirrored conflict");
    const verifiedResolution = graphTaskByTitle("Verify mirrored resolution");
    const prTaskTitlesByHead = [
      {
        headRevision: 1,
        headRefOid: fixture.headOne,
        titles: [
          "Reject forged controlled commit",
          ...ACTION_TITLES.map(([actionTitle]) => actionTitle),
        ],
      },
      {
        headRevision: 2,
        headRefOid: fixture.headTwo,
        titles: ["Reject old controlled commit", "Merge verified Head 2"],
      },
    ];
    const prTasksByHead = prTaskTitlesByHead.map(({ titles, ...head }) => ({
      ...head,
      tasks: titles.map((title) => graphTaskByTitle(title).task),
    }));
    assert.deepEqual(rootTask.task.responsibility, {
      type: "role",
      id: "orchestrator",
    });
    assert.deepEqual(resolvedConflict.task.responsibility, {
      type: "role",
      id: "developer",
    });
    assert.deepEqual(verifiedResolution.task.responsibility, {
      type: "role",
      id: "tester",
    });
    assert.deepEqual(verifiedResolution.task.dependsOn, [
      resolvedConflict.task.taskId,
    ]);
    for (const { tasks } of prTasksByHead) {
      for (const task of tasks) {
        assert.deepEqual(task.responsibility, {
          type: "role",
          id: "pr-engineer",
        });
      }
    }
    assert.equal(resolvedConflict.taskState.statusReason, "pr_head_superseded");
    assert.equal(verifiedResolution.taskState.statusReason, "pr_head_superseded");
    const timelineFor = (taskId) => stateBeforeFinalArchive.timeline
      .filter((entry) => entry.itemId === taskId);
    const timelineEntries = (task, type) => timelineFor(task.taskId)
      .filter((entry) => entry.type === type);
    const assertExclusiveTimelineActor = (task, type, expectedActorId) => {
      const entries = timelineEntries(task, type);
      assert.ok(entries.length > 0, `${task.taskId} has no ${type} history`);
      assert.deepEqual(
        entries.map(({ actorId }) => actorId),
        Array(entries.length).fill(expectedActorId),
      );
      return entries;
    };
    const initialHandoffs = timelineEntries(rootTask.task, "handed_off");
    assert.equal(initialHandoffs.length, 1);
    const [initialHandoff] = initialHandoffs;
    assert.equal(initialHandoff.actorId, "work-intent-dispatcher");
    assert.deepEqual(initialHandoff.details.fromTarget, {
      type: "role",
      id: "pr-engineer",
    });
    assert.deepEqual(initialHandoff.details.toTarget, {
      type: "role",
      id: "orchestrator",
    });
    const initialPrClaims = timelineEntries(rootTask.task, "claimed").filter(
      ({ sequence }) => sequence < initialHandoff.sequence,
    );
    assert.deepEqual(
      initialPrClaims.map(({ actorId }) => actorId),
      ["employee-pr-engineer"],
    );
    const initialPrHandoffs = timelineEntries(rootTask.task, "intent_staged")
      .filter(({ sequence, details }) =>
        sequence < initialHandoff.sequence && details.intentType === "handoff"
      );
    assert.equal(initialPrHandoffs.length, 1);
    assert.equal(initialPrClaims[0].sequence < initialPrHandoffs[0].sequence, true);
    assert.deepEqual(initialPrHandoffs[0].details.requestedBy, {
      roleId: "pr-engineer",
      workerId: "employee-pr-engineer",
    });

    const deliveryHistory = (task) => task.deliveries.map((delivery) => ({
      deliverableId: delivery.deliverableId,
      revision: delivery.revision,
      contractRevision: delivery.contractRevision,
      status: delivery.status,
    }));
    for (const proof of [
      {
        task: resolvedConflict.task,
        actorId: "employee-developer",
        submission: {
          contractRevision: 1,
          deliverableId: "implementation",
          deliveryRevision: 1,
        },
        history: [
          {
            deliverableId: "implementation",
            revision: 1,
            contractRevision: 1,
            status: "submitted",
          },
          {
            deliverableId: "implementation",
            revision: 2,
            contractRevision: 1,
            status: "accepted",
          },
        ],
      },
      {
        task: verifiedResolution.task,
        actorId: "employee-tester",
        submission: {
          contractRevision: 1,
          deliverableId: "verification",
          deliveryRevision: 1,
        },
        history: [
          {
            deliverableId: "verification",
            revision: 1,
            contractRevision: 1,
            status: "submitted",
          },
          {
            deliverableId: "verification",
            revision: 2,
            contractRevision: 1,
            status: "accepted",
          },
        ],
      },
    ]) {
      assertExclusiveTimelineActor(proof.task, "claimed", proof.actorId);
      const submissions = assertExclusiveTimelineActor(
        proof.task,
        "graph_delivery_submitted",
        proof.actorId,
      );
      assert.deepEqual(submissions.map(({ details }) => details), [
        proof.submission,
      ]);
      assert.equal(
        assertExclusiveTimelineActor(
          proof.task,
          "graph_delivery_accepted",
          "employee-orchestrator",
        ).length,
        1,
      );
      assert.deepEqual(deliveryHistory(proof.task), proof.history);
    }
    const [resolutionSubmitted, resolutionAccepted] =
      resolvedConflict.task.deliveries;
    assert.equal(resolutionDetail.job.jobId, createdResolution.receipt.id);
    assert.deepEqual(resolutionDetail.job.requestedBy, {
      roleId: "developer",
      workItemId: resolvedConflict.task.taskId,
    });
    assert.equal(
      resolutionDetail.changePackage.receipt.packageId,
      `change-package-${resolutionDetail.changePackage.receipt.packageDigest}`,
    );
    assert.equal(
      resolutionDetail.changePackage.receipt.controlledCommit.evidenceId,
      state.controlledCommitEvidenceId,
    );
    const submittedChangePackageEvidence = resolutionSubmitted.evidence.filter(
      ({ kind }) => kind === "change-package",
    );
    assert.deepEqual(submittedChangePackageEvidence, [{
      kind: "change-package",
      referenceId: resolutionDetail.changePackage.receipt.packageId,
      contentDigest: resolutionDetail.changePackage.receipt.packageDigest,
    }]);
    assert.deepEqual(resolutionAccepted.evidence, resolutionSubmitted.evidence);

    const [verificationSubmitted, verificationAccepted] =
      verifiedResolution.task.deliveries;
    assert.equal(verificationDetail.job.jobId, createdVerification.receipt.id);
    assert.deepEqual(verificationDetail.job.requestedBy, {
      roleId: "tester",
      workItemId: verifiedResolution.task.taskId,
    });
    assert.match(
      verificationDetail.job.memoryProjection.recordId,
      /^memory-[a-f0-9]{64}$/u,
    );
    const submittedTestReportEvidence = verificationSubmitted.evidence.filter(
      ({ kind }) => kind === "test-report",
    );
    assert.deepEqual(submittedTestReportEvidence, [{
      kind: "test-report",
      referenceId: verificationDetail.job.jobId,
      contentDigest: verificationDetail.job.memoryProjection.recordId.slice(
        "memory-".length,
      ),
    }]);
    assert.deepEqual(verificationAccepted.evidence, verificationSubmitted.evidence);

    const allDeliverySubmissions = stateBeforeFinalArchive.timeline.filter(
      ({ type }) => type === "graph_delivery_submitted",
    );
    assert.deepEqual(
      allDeliverySubmissions.map(({ itemId }) => itemId).sort(),
      [resolvedConflict.task.taskId, verifiedResolution.task.taskId].sort(),
    );
    const [testerAcceptance] = timelineEntries(
      verifiedResolution.task,
      "graph_delivery_accepted",
    );
    const prReevaluationRecords = [];
    for (const { headRevision, headRefOid, tasks } of prTasksByHead) {
      for (const task of tasks) {
        const claims = assertExclusiveTimelineActor(
          task,
          "claimed",
          "employee-pr-engineer",
        );
        const staged = assertExclusiveTimelineActor(
          task,
          "intent_staged",
          "employee-pr-engineer",
        );
        assert.equal(claims.length, staged.length);
        for (let index = 0; index < claims.length; index += 1) {
          assert.equal(claims[index].sequence < staged[index].sequence, true);
        }
        assert.equal(
          [...claims, ...staged].every(
            ({ sequence }) => sequence > testerAcceptance.sequence,
          ),
          true,
        );
        assert.deepEqual(
          staged.map(({ details }) => details.requestedBy),
          Array(staged.length).fill({
            roleId: "pr-engineer",
            workerId: "employee-pr-engineer",
          }),
        );
        assert.deepEqual(
          staged.map(({ details }) => ({
            headRevision: details.inputBinding.headRevision,
            headRefOid: details.inputBinding.headRefOid,
          })),
          Array(staged.length).fill({ headRevision, headRefOid }),
        );
        prReevaluationRecords.push(...claims, ...staged);
      }
    }
    prReevaluationRecords.sort((left, right) => left.sequence - right.sequence);
    assert.deepEqual(
      new Set(prReevaluationRecords
        .filter(({ type }) => type === "intent_staged")
        .map(({ details }) => details.inputBinding.headRevision)),
      new Set([1, 2]),
    );

    const confirmationBinding = ([title, roleId, kind, status]) => ({
      kind,
      status,
      requestedBy: {
        roleId,
        workItemId: graphTaskByTitle(title).task.taskId,
      },
    });
    const expectedConfirmationBindings = [
      ["Resolve mirrored conflict", "developer", "local.code-job-create", "completed"],
      ["Verify mirrored resolution", "tester", "local.code-job-create", "completed"],
      ["External comment", "pr-engineer", "github.pull-request-comment", "completed"],
      ["External review", "pr-engineer", "github.work-proposal-review", "completed"],
      ["External branch update", "pr-engineer", "github.pull-request-update-branch", "completed"],
      ["External controlled push", "pr-engineer", "github.pull-request-push", "completed"],
      ["External merge", "pr-engineer", "github.pull-request-merge", "stale"],
      ["Merge verified Head 2", "pr-engineer", "github.pull-request-merge", "completed"],
    ].map(confirmationBinding).toSorted((left, right) =>
      left.requestedBy.workItemId.localeCompare(right.requestedBy.workItemId, "en")
    );
    const confirmationItems = stateBeforeFinalArchive.confirmationHistory.items;
    assert.deepEqual(
      confirmationItems.map(({ kind, status, requestedBy }) => ({
        kind,
        status,
        requestedBy,
      })).toSorted((left, right) =>
        left.requestedBy.workItemId.localeCompare(
          right.requestedBy.workItemId,
          "en",
        )
      ),
      expectedConfirmationBindings,
    );
    const confirmationByTaskId = new Map(
      confirmationItems.map((item) => [item.requestedBy.workItemId, item]),
    );
    assert.equal(
      confirmationByTaskId.get(resolvedConflict.task.taskId).id,
      createdResolution.id,
    );
    assert.equal(
      confirmationByTaskId.get(verifiedResolution.task.taskId).id,
      createdVerification.id,
    );
    const prReevaluationTimelineIds = new Set(
      prReevaluationRecords.map(({ timelineId }) => timelineId),
    );
    await application.close();
    const finalCompaction = await archiveTerminalJobs({
      statePath: path.join(dataRoot, "state"),
      clock,
      jobIds: finalCodeJobIds,
      compactionId: "u9-final-terminal-prefix",
    });
    assert.equal(finalCompaction.after.archive.throughSequence > 0, true);
    application = await startApplication();
    assert.deepEqual(state.brainCalls, stateBeforeFinalArchive.brainCalls);
    const archivedDetails = await Promise.all(finalCodeJobIds.map((jobId) =>
      application.codeJobReader.getDetail({ jobId })
    ));
    assert.equal(
      archivedDetails.every(({ archived }) => archived === true),
      true,
    );
    assert.equal(
      archivedDetails.every(({ historyAvailable, observations }) =>
        historyAvailable === false && observations.length === 0
      ),
      true,
    );
    assert.ok(finalCodeJobDetails.some(({ terminalDetail }) => terminalDetail?.completionReport));
    for (const { job, terminalDetail } of archivedDetails) {
      const original = finalCodeJobDetails.find(({ job: before }) => before.jobId === job.jobId);
      const report = original.terminalDetail?.completionReport;
      assert.deepEqual(terminalDetail, report ? {
        schemaVersion: 1,
        outcome: original.terminalDetail.outcome,
        completedActionId: original.terminalDetail.completedActionId,
        workspaceRevision: original.terminalDetail.workspaceRevision,
        evidence: original.terminalDetail.evidence,
        completionReport: report,
      } : null);
    }
    assert.deepEqual(
      archivedProjection(archivedDetails),
      stateBeforeFinalArchive.codeJobs,
    );
    const liveJobsAfterArchive = await application.codeJobReader.list({ limit: 20 });
    assert.equal(liveJobsAfterArchive.total, 0);
    assert.deepEqual(liveJobsAfterArchive.items, []);
    assert.deepEqual(
      await application.workflowRouting.listAssignments({ limit: 50 }),
      stateBeforeFinalArchive.assignments,
    );
    assert.deepEqual(
      await application.workGraphView.getSnapshot(),
      stateBeforeFinalArchive.graph,
    );
    assert.deepEqual(
      await application.workLedgerView.listItems({ limit: 50 }),
      stateBeforeFinalArchive.ledger,
    );
    const recoveredTimeline = await readCompleteWorkLedgerTimeline(
      application.workLedgerView,
    );
    assert.deepEqual(recoveredTimeline, stateBeforeFinalArchive.timeline);
    assert.deepEqual(
      recoveredTimeline.filter(({ timelineId }) =>
        prReevaluationTimelineIds.has(timelineId)
      ),
      prReevaluationRecords,
    );
    assert.deepEqual(
      await application.confirmationQueue.historyReader.list({ limit: 50 }),
      stateBeforeFinalArchive.confirmationHistory,
    );

    const recoveredMemoryJournal = new LocalMemoryJournal({
      store: application.store,
      exclusiveLease: new TestGuard(),
    });
    await recoveredMemoryJournal.recover();
    assert.deepEqual(
      await readMemoryRecords(
        recoveredMemoryJournal,
        memoryRecordIdsBeforeFinalArchive,
      ),
      stateBeforeFinalArchive.memoryRecords,
    );
    const recoveredSelected = recoveredMemoryJournal.readRecords({
      recordIds: selectedIds,
    }).items;
    assert.deepEqual(
      recoveredSelected.map(({ record, labels }) => ({
        recordId: record.recordId,
        contentDigest: record.contentDigest,
        labels,
      })),
      selectedCitationBindings,
    );
    const recoveredOldHead = recoveredMemoryJournal.readRecords({
      recordIds: oldHeadIds,
    }).items;
    assert.deepEqual(
      recoveredOldHead.map(({ record, labels }) => ({
        recordId: record.recordId,
        contentDigest: record.contentDigest,
        labels,
      })),
      oldHeadCitationBindings,
    );
    const recoveredObsoleteRetriever = new MemoryContextRetriever({
      memorySearch: {
        async search() {
          return {
            items: oldHeadIds.map((id) => ({ id })),
            nextCursor: null,
            totalMatched: oldHeadIds.length,
            indexHealthy: true,
          };
        },
      },
      contextReader: {
        readRecords: (value) => recoveredMemoryJournal.readRecords(value),
      },
      maximumRecords: 20,
      maximumContextBytes: 112 * 1024,
    });
    const recoveredObsoleteContext = await recoveredObsoleteRetriever.retrieve({
      question: "Can the old Head push still authorize a conclusion?",
      retrieval: { kind: "query", filters: { query: "" } },
    });
    assert.deepEqual(recoveredObsoleteContext.citableRecordIds, []);
    const recoveredSelectedRetriever = new MemoryContextRetriever({
      memorySearch: {
        async search() {
          return {
            items: selectedIds.map((id) => ({ id })),
            nextCursor: null,
            totalMatched: selectedIds.length,
            indexHealthy: true,
          };
        },
      },
      contextReader: {
        readRecords: (value) => recoveredMemoryJournal.readRecords(value),
      },
      maximumRecords: 20,
      maximumContextBytes: 112 * 1024,
    });
    const recoveredSelectedContext = await recoveredSelectedRetriever.retrieve({
      question,
      retrieval: { kind: "query", filters: { query: "" } },
    });
    assert.equal(recoveredSelectedContext.contextDigest, selectedContext.contextDigest);
    const recoveredAnswer = await application.memoryAnswer.answer({
      schemaVersion: 1,
      question,
      mode: "local",
      retrieval: {
        kind: "context",
        contextDigest: recoveredSelectedContext.contextDigest,
        recordIds: recoveredSelectedContext.recordIds,
      },
    });
    assert.deepEqual(
      recoveredAnswer.citations.map(({ recordId, contentDigest, labels }) => ({
        recordId,
        contentDigest,
        labels,
      })),
      selectedCitationBindings,
    );
    assert.equal(
      state.brainCalls.length,
      stateBeforeFinalArchive.brainCalls.length + 1,
    );
    assert.deepEqual(
      state.brainCalls.slice(0, stateBeforeFinalArchive.brainCalls.length),
      stateBeforeFinalArchive.brainCalls,
    );
    const originalMemoryCall = stateBeforeFinalArchive.brainCalls.findLast(
      ({ model }) => model === "memory-model",
    );
    assert.ok(originalMemoryCall);
    assert.deepEqual(state.brainCalls.at(-1), originalMemoryCall);
    assert.deepEqual(sandbox.runs, stateBeforeFinalArchive.sandboxRuns);
    assert.deepEqual(transport.calls, stateBeforeFinalArchive.transportCalls);
    assert.deepEqual(credentialCalls, stateBeforeFinalArchive.credentialCalls);
    assert.deepEqual(factCalls, stateBeforeFinalArchive.factCalls);
    assert.deepEqual(await Promise.all([
      directorySnapshot(fixture.sourceRoot),
      directorySnapshot(fixture.baseMirrorRoot),
      directorySnapshot(fixture.headMirrorRoot),
    ]), stateBeforeFinalArchive.sourceTrees);

    assert.equal(
      factCalls.some(({ conclusion }) => conclusion === "FAILURE"),
      true,
    );
    assert.equal(
      factCalls.some(({ conclusion }) => conclusion === "SUCCESS"),
      true,
    );
    const prContexts = state.brainCalls
      .filter(({ model, context }) =>
        model === "strong-routine-pr-engineer" &&
        context.requirements?.roleId === "pr-engineer")
      .map(({ context }) => context.code?.pullRequest)
      .filter(Boolean);
    assert.equal(
      prContexts.some(({ checks }) => checks[0].conclusion === "FAILURE"),
      true,
    );
    assert.equal(
      prContexts.some(({ checks }) => checks[0].conclusion === "SUCCESS"),
      true,
    );
    assert.equal(
      transport.calls.filter(({ method }) => method === "perform").length,
      5,
    );
    assert.equal(
      transport.calls.every(({ input }) =>
        input.action.inputBinding.repository === "acme/runtime-test"),
      true,
    );
    assert.equal(
      state.brainCalls.every(({ url }) =>
        url.startsWith("http://127.0.0.1:11434/") ||
        url.startsWith("https://ark.example/api/coding/v3/")),
      true,
    );
    assert.deepEqual(await Promise.all([
      directorySnapshot(fixture.sourceRoot),
      directorySnapshot(fixture.baseMirrorRoot),
      directorySnapshot(fixture.headMirrorRoot),
    ]), immutableBefore);
    assert.equal(
      (await readFile(path.join(fixture.sourceRoot, "src", "conflict.txt"), "utf8")),
      "base\n",
    );
    assert.ok(proposalRuntime);
  },
);
