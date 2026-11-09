import assert from "node:assert/strict";
import test from "node:test";
import { createCiRepairEvidence } from '../src/domain/ci-repair-evidence.js';
import { cloneWorkProposalValue } from '../src/domain/work-proposal-contract.js';

import { createConflictPreparationBinding } from "../src/domain/conflict-preparation-binding.js";
import {
  codeExecutionSourceAllowsWrite,
  codeExecutionSourceWritablePaths,
  createConflictCodeExecutionSource,
  createReviewRepairCodeExecutionSource,
  normalizeCodeExecutionSource,
  sameCodeExecutionSource,
} from "../src/domain/code-execution-source.js";

test("CI repair keeps its own failed-check provenance on a fixed Head without inventing Review feedback", () => {
  const binding = inputBinding();
  const material = { schemaVersion: 1, repository: binding.repository, number: binding.pullRequestNumber,
    headRefOid: binding.headRefOid, headRefName: binding.gitTarget.headRefName,
    checks: [{ kind: 'status_context', name: 'QuickTest', url: 'https://ci.example/job/QuickTest/12/', conclusion: 'FAILURE' }], diagnostics: [] };
  const source = { schemaVersion: 1, kind: 'ci_repair', inputBinding: binding,
    ciEvidence: createCiRepairEvidence(material),
    writeScope: { mode: 'configured_paths', paths: ['src', 'test'] } };
  const normalized = normalizeCodeExecutionSource(source);
  assert.equal(normalized.kind, 'ci_repair');
  assert.deepEqual(normalized.ciEvidence, source.ciEvidence);
  assert.equal(Object.hasOwn(normalized, 'reviewFeedbackDigest'), false);
  assert.equal(Object.hasOwn(normalized, 'preparationBinding'), false);
  assert.equal(codeExecutionSourceAllowsWrite(normalized, 'src/fix.cpp'), true);
  assert.equal(codeExecutionSourceAllowsWrite(normalized, 'unrelated/file.cpp'), false);
  for (const field of ['repository', 'headRefOid', 'headRefName', 'number']) {
    const changed = structuredClone(source);
    changed.ciEvidence[field] = field === 'number' ? 43 : field === 'headRefOid' ? 'e'.repeat(40) : field === 'repository' ? 'other/repo' : 'other';
    const { contentDigest, triggerDigest, ...body } = changed.ciEvidence;
    changed.ciEvidence = createCiRepairEvidence(body);
    assert.throws(() => normalizeCodeExecutionSource(changed));
  }
  assert.throws(() => normalizeCodeExecutionSource({ ...source, kind: 'review_repair' }));
});

test("CI source identity survives canonical proposal key ordering without accepting changed diagnostics", () => {
  const binding = inputBinding();
  const material = { schemaVersion: 1, repository: binding.repository, number: binding.pullRequestNumber,
    headRefOid: binding.headRefOid, headRefName: binding.gitTarget.headRefName,
    checks: [{ kind: 'status_context', name: 'QuickTest', url: null, conclusion: 'FAILURE' }],
    diagnostics: [{ check: 'QuickTest', state: 'unavailable',
      failures: [{ message: 'Missing fixture', file: 'test.cpp', line: 42 }] }] };
  const source = { schemaVersion: 1, kind: 'ci_repair', inputBinding: binding,
    ciEvidence: createCiRepairEvidence(material), writeScope: { mode: 'configured_paths', paths: ['src'] } };
  assert.equal(sameCodeExecutionSource(source, cloneWorkProposalValue(source)), true);
  const zeroMaterial = structuredClone(material);
  zeroMaterial.diagnostics[0].failures[0].line = -0;
  const zeroSource = { ...source, ciEvidence: createCiRepairEvidence(zeroMaterial) };
  assert.equal(sameCodeExecutionSource(zeroSource, cloneWorkProposalValue(zeroSource)), true,
    "canonical JSON stores negative zero as zero");
  const changed = structuredClone(material);
  changed.diagnostics[0].failures[0].line += 1;
  assert.equal(sameCodeExecutionSource(source, { ...source, ciEvidence: createCiRepairEvidence(changed) }), false);
  const ordered = structuredClone(material);
  ordered.diagnostics[0].failures.push({ message: 'Other fixture', file: 'other.cpp', line: 1 });
  const reordered = structuredClone(ordered);
  reordered.diagnostics[0].failures.reverse();
  assert.equal(sameCodeExecutionSource({ ...source, ciEvidence: createCiRepairEvidence(ordered) },
    { ...source, ciEvidence: createCiRepairEvidence(reordered) }), false);
  assert.equal(sameCodeExecutionSource(source, { ...source, ciEvidence: { ...source.ciEvidence, contentDigest: '0'.repeat(64) } }), false);
});

test("review repair binds the exact PR input and configured prefixes without conflict provenance", () => {
  const source = createReviewRepairCodeExecutionSource({ inputBinding: inputBinding(), writablePaths: ["src", "test"] });
  assert.equal(source.kind, "review_repair");
  assert.equal(Object.hasOwn(source, "preparationBinding"), false);
  assert.deepEqual(source.writeScope, { mode: "configured_paths", paths: ["src", "test"] });
  assert.deepEqual(normalizeCodeExecutionSource(source), source);
  assert.equal(sameCodeExecutionSource(source, { ...source, inputBinding: inputBinding(gitTarget({ headRefOid: "e".repeat(40) })) }), false);
  for (const writablePaths of [[], ["../src"], [".git"], ["src", "src"], ["src\\file.js"], ["a\n.js"]]) {
    assert.throws(() => createReviewRepairCodeExecutionSource({ inputBinding: inputBinding(), writablePaths }));
  }
  const paths = [];
  Object.defineProperty(paths, "0", { enumerable: true, get() { throw new Error("getter invoked"); } });
  assert.throws(() => createReviewRepairCodeExecutionSource({ inputBinding: inputBinding(), writablePaths: paths }),
    (error) => error.code === "INVALID_CODE_EXECUTION_SOURCE");
  assert.throws(() => normalizeCodeExecutionSource({ ...source, preparationBinding: preparationBinding() }));
  assert.throws(() => normalizeCodeExecutionSource({ ...source,
    writeScope: { ...source.writeScope, mode: "exact_files" } }));
  assert.throws(() => normalizeCodeExecutionSource({ ...source, kind: "conflict_preparation" }));
});

test("source write checks preserve configured prefix boundaries and exact conflict files", () => {
  const reviewSource = createReviewRepairCodeExecutionSource({ inputBinding: inputBinding(), writablePaths: ["Source", "Test"] });
  for (const path of ["Source/Systems/Analysis/AnalysisFAZSystem.cpp", "Test/new.test.cpp"]) {
    assert.equal(codeExecutionSourceAllowsWrite(reviewSource, path), true);
  }
  for (const path of ["Sources/a.cpp", "Other/a.cpp", "Source/.git/config", "Source/.env"]) {
    assert.equal(codeExecutionSourceAllowsWrite(reviewSource, path), false);
  }
  assert.throws(() => codeExecutionSourceAllowsWrite(reviewSource, "Source/../Other/a.cpp"));
  assert.throws(() => codeExecutionSourceAllowsWrite({ ...reviewSource,
    writeScope: { ...reviewSource.writeScope, mode: "exact_files" } }, "Source/a.cpp"));

  const conflictSource = createConflictCodeExecutionSource({ inputBinding: inputBinding(), preparationBinding: preparationBinding() });
  assert.equal(codeExecutionSourceAllowsWrite(conflictSource, "src/first.js"), true);
  for (const path of ["src/first.js/child.js", "src/third.js", "src/First.js"]) {
    assert.equal(codeExecutionSourceAllowsWrite(conflictSource, path), false);
  }
  assert.throws(() => codeExecutionSourceAllowsWrite({ ...conflictSource,
    writeScope: { ...conflictSource.writeScope, mode: "configured_paths" } }, "src/first.js/child.js"));
});

function gitTarget(overrides = {}) {
  return {
    schemaVersion: 1,
    provider: "github",
    sourceAccountId: "owner-account",
    baseRepository: "acme/repo",
    baseRefName: "main",
    baseRefOid: "a".repeat(40),
    headRepository: "contributor/repo",
    headRefName: "fix-conflict",
    headRefOid: "b".repeat(40),
    ...overrides,
  };
}

function inputBinding(target = gitTarget()) {
  return {
    schemaVersion: 2,
    kind: "pull_request",
    repository: target.baseRepository,
    pullRequestNumber: 42,
    rootItemId: "github:pr:acme/repo#42",
    workKey: "pr:acme/repo#42",
    inputRevision: 3,
    headRevision: 5,
    headRefOid: target.headRefOid,
    eventId: "github-event-42",
    eventDigest: "c".repeat(64),
    inputDigest: "d".repeat(64),
    gitTarget: target,
  };
}

function preparationBinding(
  target = gitTarget(),
  conflicts = [
    { path: "src/first.js", mode: "100644" },
    { path: "src/second.js", mode: "100644" },
  ],
) {
  return createConflictPreparationBinding({
    preparation: {
      schemaVersion: 1,
      preparationId: "1".repeat(64),
      status: "conflicted",
      baseCommitOid: target.baseRefOid,
      headCommitOid: target.headRefOid,
      mergeBaseOid: "e".repeat(40),
      resultTreeOid: "f".repeat(40),
      conflicts,
      boundaryDigest: "2".repeat(64),
      evidenceDigest: "3".repeat(64),
      resultObjectDigest: "4".repeat(64),
      materialization: "full-tree",
    },
    gitTarget: target,
  });
}

test("creates one atomic conflict execution source with exact-file scope", () => {
  const pullRequest = inputBinding();
  const preparation = preparationBinding();
  const source = createConflictCodeExecutionSource({
    inputBinding: pullRequest,
    preparationBinding: preparation,
  });

  assert.deepEqual(source, {
    schemaVersion: 1,
    kind: "conflict_preparation",
    inputBinding: pullRequest,
    preparationBinding: preparation,
    writeScope: {
      mode: "exact_files",
      paths: ["src/first.js", "src/second.js"],
    },
  });
  assert.notEqual(source.inputBinding, pullRequest);
  assert.notEqual(source.preparationBinding, preparation);
  assert.deepEqual(codeExecutionSourceWritablePaths(source), [
    "src/first.js",
    "src/second.js",
  ]);
  assert.equal(sameCodeExecutionSource(source, structuredClone(source)), true);
});

test("normalization rejects changed provenance, scope, shape, and legacy PR identity", () => {
  const source = createConflictCodeExecutionSource({
    inputBinding: inputBinding(),
    preparationBinding: preparationBinding(),
  });

  for (const changed of [
    {
      ...source,
      writeScope: { ...source.writeScope, paths: ["src/first.js"] },
    },
    {
      ...source,
      writeScope: {
        ...source.writeScope,
        paths: [...source.writeScope.paths].reverse(),
      },
    },
    { ...source, extra: true },
    { ...source, writeScope: { ...source.writeScope, mode: "configured_paths" } },
    { ...source, kind: "review_repair" },
    {
      ...source,
      preparationBinding: preparationBinding(
        gitTarget({ sourceAccountId: "other-account" }),
      ),
    },
    {
      ...source,
      inputBinding: {
        ...source.inputBinding,
        schemaVersion: 1,
        gitTarget: undefined,
      },
    },
  ]) {
    assert.throws(() => normalizeCodeExecutionSource(changed));
    assert.equal(sameCodeExecutionSource(source, changed), false);
  }

  const accessor = structuredClone(source);
  Object.defineProperty(accessor, "kind", {
    enumerable: true,
    get() {
      throw new Error("must not run");
    },
  });
  assert.throws(() => normalizeCodeExecutionSource(accessor));
  for (const proxy of [
    new Proxy(structuredClone(source), {}),
    {
      ...source,
      writeScope: new Proxy(structuredClone(source.writeScope), {}),
    },
    {
      ...source,
      writeScope: {
        ...source.writeScope,
        paths: new Proxy([...source.writeScope.paths], {}),
      },
    },
  ]) {
    assert.throws(() => normalizeCodeExecutionSource(proxy));
  }
});

test("execution source rejects conflict paths that exceed its durable memory boundary", () => {
  const overlongPath = `${"a".repeat(171)}/${"b".repeat(171)}/${"c".repeat(171)}`;
  const overlongSegment = `${"d".repeat(256)}/value.js`;

  for (const conflictPath of [overlongPath, overlongSegment]) {
    assert.throws(
      () =>
        createConflictCodeExecutionSource({
          inputBinding: inputBinding(),
          preparationBinding: preparationBinding(gitTarget(), [
            { path: conflictPath, mode: "100644" },
          ]),
        }),
      (error) => error?.code === "INVALID_CODE_EXECUTION_SOURCE",
    );
  }
});

test("execution source rejects control characters before they reach durable memory", () => {
  for (const conflictPath of ["src/tab\tname.js", "src/line\nname.js"]) {
    assert.throws(
      () =>
        createConflictCodeExecutionSource({
          inputBinding: inputBinding(),
          preparationBinding: preparationBinding(gitTarget(), [
            { path: conflictPath, mode: "100644" },
          ]),
        }),
      (error) => error?.code === "INVALID_CODE_EXECUTION_SOURCE",
    );
  }
});
