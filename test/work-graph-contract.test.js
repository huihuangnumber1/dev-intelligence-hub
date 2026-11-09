import assert from "node:assert/strict";
import test from "node:test";

import {
  WORK_GRAPH_DEFAULT_LIMITS,
  WorkGraphError,
  createWorkGraphSnapshot,
  deriveParentTaskOutcome,
  getBlockedWorkGraphTasks,
  getParallelReadyWorkGraphTaskIds,
  getReadyWorkGraphTaskIds,
  normalizeWorkGraphDelivery,
  normalizeWorkGraphSnapshot,
  validateWorkGraphTransition,
} from "../src/domain/work-graph-contract.js";

const SHA_A = "a".repeat(64);

function responsibility(id = "developer") {
  return { type: "role", id };
}

function contract(overrides = {}) {
  return {
    revision: 1,
    acceptanceCriteria: [
      { criterionId: "tests-pass", description: "Focused tests pass" },
    ],
    expectedDeliverables: [
      {
        deliverableId: "implementation",
        kind: "change_package",
        description: "Reviewed implementation package",
        required: true,
      },
    ],
    ...overrides,
  };
}

function delivery(overrides = {}) {
  return {
    deliverableId: "implementation",
    revision: 1,
    contractRevision: 1,
    status: "accepted",
    summary: "Implementation and tests are complete",
    evidence: [
      {
        kind: "change_package",
        referenceId: "change-package-1",
        contentDigest: SHA_A,
      },
    ],
    ...overrides,
  };
}

function task(taskId, overrides = {}) {
  return {
    taskId,
    revision: 1,
    parentTaskId: null,
    status: "pending",
    responsibility: responsibility(),
    acceptanceContracts: [contract()],
    deliveries: [],
    dependsOn: [],
    ...overrides,
  };
}

function draft(tasks, overrides = {}) {
  return {
    graphId: "work-item-42",
    revision: 7,
    tasks,
    ...overrides,
  };
}

function hasCode(code) {
  return (error) => error instanceof WorkGraphError && error.code === code;
}

test("delivery summaries preserve multiline Chinese Markdown and existing ASCII reports", () => {
  for (const summary of [
    "Implementation and tests are complete",
    "  ## 复审结果\n\n- 当前 Head 已核对\r\n\t证据：完整差异和原始反馈\r保留产品验证限制  ",
  ]) {
    const normalized = normalizeWorkGraphDelivery(delivery({ summary }));
    assert.equal(normalized.summary, summary);
    assert.ok(Object.isFrozen(normalized));
    const snapshot = createWorkGraphSnapshot(
      draft([task("review", { revision: 2, deliveries: [normalized] })]),
    );
    const restored = normalizeWorkGraphSnapshot(JSON.parse(JSON.stringify(snapshot)));
    assert.deepEqual(restored, snapshot);
    assert.equal(restored.tasks[0].deliveries[0].summary, summary);
  }
});

test("delivery summaries keep the UTF-8 byte limit and reject non-prose controls", () => {
  for (const summary of ["x".repeat(16_384), `${"审".repeat(5_461)}\n`]) {
    assert.equal(Buffer.byteLength(summary, "utf8"), 16_384);
    assert.equal(normalizeWorkGraphDelivery(delivery({ summary })).summary, summary);
    assert.throws(
      () => normalizeWorkGraphDelivery(delivery({ summary: `${summary}x` })),
      hasCode("WORK_GRAPH_INVALID"),
    );
  }
  for (const code of [...Array(32).keys(), 127]) {
    if ([9, 10, 13].includes(code)) continue;
    assert.throws(
      () => normalizeWorkGraphDelivery(delivery({ summary: `Review${String.fromCharCode(code)}complete` })),
      hasCode("WORK_GRAPH_INVALID"),
    );
  }
  for (const summary of ["", " \r\n\t ", null, 42]) {
    assert.throws(
      () => normalizeWorkGraphDelivery(delivery({ summary })),
      hasCode("WORK_GRAPH_INVALID"),
    );
  }
});

test("prose delivery formatting does not relax graph identifiers or other text fields", () => {
  for (const control of ["\n", "\r", "\t"]) {
    assert.throws(
      () => normalizeWorkGraphDelivery(delivery({ deliverableId: `review${control}report` })),
      hasCode("WORK_GRAPH_INVALID"),
    );
    assert.throws(
      () => createWorkGraphSnapshot(draft([task("review", {
        responsibility: responsibility(`PR${control}reviewer`),
      })])),
      hasCode("WORK_GRAPH_INVALID"),
    );
    assert.throws(
      () => createWorkGraphSnapshot(draft([task("review", {
        acceptanceContracts: [contract({ acceptanceCriteria: [
          { criterionId: "review", description: `Review${control}complete` },
        ] })],
      })])),
      hasCode("WORK_GRAPH_INVALID"),
    );
  }
});

test("creates a deterministic schema v1 snapshot without retaining caller data", () => {
  const input = draft([
    task("child-b", { parentTaskId: "root" }),
    task("root", {
      acceptanceContracts: [
        contract({ acceptanceCriteria: [], expectedDeliverables: [] }),
      ],
    }),
    task("child-a", { parentTaskId: "root" }),
  ]);

  const snapshot = createWorkGraphSnapshot(input);
  const reordered = createWorkGraphSnapshot(
    draft([...input.tasks].reverse()),
  );

  assert.equal(snapshot.schemaVersion, 1);
  assert.match(snapshot.contentDigest, /^[a-f0-9]{64}$/);
  assert.deepEqual(snapshot, reordered);
  assert.deepEqual(snapshot.tasks.map(({ taskId }) => taskId), [
    "child-a",
    "child-b",
    "root",
  ]);
  assert.deepEqual(normalizeWorkGraphSnapshot(snapshot), snapshot);
  assert.ok(Object.isFrozen(snapshot));
  assert.ok(Object.isFrozen(snapshot.tasks[0].acceptanceContracts[0]));

  input.tasks[0].responsibility.id = "attacker";
  input.tasks[0].acceptanceContracts[0].acceptanceCriteria[0].description =
    "mutated";
  assert.equal(snapshot.tasks[1].responsibility.id, "developer");
  assert.equal(
    snapshot.tasks[1].acceptanceContracts[0].acceptanceCriteria[0].description,
    "Focused tests pass",
  );
});

test("an empty graph starts at revision zero without aliasing its first write", () => {
  const empty = createWorkGraphSnapshot(draft([], { revision: 0 }));
  const first = createWorkGraphSnapshot(draft([task("first")], { revision: 1 }));

  assert.equal(empty.revision, 0);
  assert.deepEqual(normalizeWorkGraphSnapshot(empty, { expectedRevision: 0 }), empty);
  assert.deepEqual(validateWorkGraphTransition(empty, first), first);
});

test("rejects duplicate ids, dangling references, self dependencies, and cycles", () => {
  assert.throws(
    () => createWorkGraphSnapshot(draft([task("same"), task("same")])),
    hasCode("WORK_GRAPH_INVALID"),
  );
  assert.throws(
    () =>
      createWorkGraphSnapshot(
        draft([task("child", { parentTaskId: "missing" })]),
      ),
    hasCode("WORK_GRAPH_DANGLING_REFERENCE"),
  );
  assert.throws(
    () =>
      createWorkGraphSnapshot(
        draft([task("self", { dependsOn: ["self"] })]),
      ),
    hasCode("WORK_GRAPH_CYCLE"),
  );
  assert.throws(
    () =>
      createWorkGraphSnapshot(
        draft([
          task("one", { dependsOn: ["two"] }),
          task("two", { dependsOn: ["one"] }),
        ]),
      ),
    hasCode("WORK_GRAPH_CYCLE"),
  );
});

test("rejects excessive task count, hierarchy depth, fan-out, and dependencies", () => {
  assert.equal(WORK_GRAPH_DEFAULT_LIMITS.maxTasks, 10_000);
  assert.throws(
    () =>
      createWorkGraphSnapshot(draft([task("one"), task("two")] ), {
        limits: { maxTasks: 1 },
      }),
    hasCode("WORK_GRAPH_LIMIT_EXCEEDED"),
  );
  assert.throws(
    () =>
      createWorkGraphSnapshot(draft([task("one")]), {
        limits: { maxTasks: WORK_GRAPH_DEFAULT_LIMITS.maxTasks + 1 },
      }),
    hasCode("WORK_GRAPH_INVALID"),
  );
  assert.throws(
    () =>
      createWorkGraphSnapshot(
        draft([
          task("root"),
          task("child", { parentTaskId: "root" }),
          task("grandchild", { parentTaskId: "child" }),
        ]),
        { limits: { maxDepth: 1 } },
      ),
    hasCode("WORK_GRAPH_LIMIT_EXCEEDED"),
  );
  assert.throws(
    () =>
      createWorkGraphSnapshot(
        draft([
          task("root"),
          task("one", { parentTaskId: "root" }),
          task("two", { parentTaskId: "root" }),
        ]),
        { limits: { maxFanOut: 1 } },
      ),
    hasCode("WORK_GRAPH_LIMIT_EXCEEDED"),
  );
  assert.throws(
    () =>
      createWorkGraphSnapshot(
        draft([
          task("one"),
          task("two"),
          task("consumer", { dependsOn: ["one", "two"] }),
        ]),
        { limits: { maxDependenciesPerTask: 1 } },
      ),
    hasCode("WORK_GRAPH_LIMIT_EXCEEDED"),
  );
});

test("superseded history does not consume the active fan-out budget", () => {
  const historical = Array.from({ length: 100 }, (_, index) =>
    task(`historical-${index}`, {
      parentTaskId: "root",
      status: "superseded",
    })
  );
  assert.doesNotThrow(() =>
    createWorkGraphSnapshot(
      draft([
        task("root"),
        ...historical,
        task("active-one", { parentTaskId: "root" }),
      ]),
      { limits: { maxFanOut: 1 } },
    )
  );
  assert.throws(
    () =>
      createWorkGraphSnapshot(
        draft([
          task("root"),
          ...historical,
          task("active-one", { parentTaskId: "root" }),
          task("active-two", { parentTaskId: "root" }),
        ]),
        { limits: { maxFanOut: 1 } },
      ),
    hasCode("WORK_GRAPH_LIMIT_EXCEEDED"),
  );
});

test("requires strict options and accepts every existing ledger responsibility target", () => {
  const snapshot = createWorkGraphSnapshot(
    draft([task("one", { responsibility: responsibility("triage-node") })]),
  );
  const nodeTask = task("node-owned", {
    responsibility: { type: "node", id: "requirements-triage" },
  });
  assert.equal(
    createWorkGraphSnapshot(draft([nodeTask])).tasks[0].responsibility.type,
    "node",
  );
  for (const id of ["审查员", "alice@example.com", "PR reviewer"]) {
    assert.equal(
      createWorkGraphSnapshot(
        draft([task(`target-${id.length}`, { responsibility: responsibility(id) })]),
      ).tasks[0].responsibility.id,
      id,
    );
  }
  assert.throws(
    () =>
      createWorkGraphSnapshot(
        draft([task("long-target", { responsibility: responsibility("x".repeat(129)) })]),
      ),
    hasCode("WORK_GRAPH_INVALID"),
  );

  assert.throws(
    () => createWorkGraphSnapshot(draft([task("one")]), null),
    hasCode("WORK_GRAPH_INVALID"),
  );
  assert.throws(
    () => createWorkGraphSnapshot(draft([task("one")]), { extra: true }),
    hasCode("WORK_GRAPH_INVALID"),
  );
  assert.throws(
    () => createWorkGraphSnapshot(draft([task("one")]), { limits: undefined }),
    hasCode("WORK_GRAPH_INVALID"),
  );
  assert.throws(
    () => normalizeWorkGraphSnapshot(snapshot, { extra: true }),
    hasCode("WORK_GRAPH_INVALID"),
  );
  const accessorOptions = {};
  Object.defineProperty(accessorOptions, "limits", {
    enumerable: true,
    get: () => ({}),
  });
  assert.throws(
    () => createWorkGraphSnapshot(draft([task("one")]), accessorOptions),
    hasCode("WORK_GRAPH_INVALID"),
  );
  assert.doesNotThrow(() =>
    createWorkGraphSnapshot(draft([task("one"), task("two")]), {
      limits: { maxFanOut: 1 },
    }),
  );
});

test("rejects sparse arrays, accessors, extra fields, and dangerous keys", () => {
  const sparse = [task("one")];
  sparse.length = 2;
  assert.throws(
    () => createWorkGraphSnapshot(draft(sparse)),
    hasCode("WORK_GRAPH_INVALID"),
  );

  const accessor = task("one");
  Object.defineProperty(accessor, "status", {
    enumerable: true,
    get: () => "pending",
  });
  assert.throws(
    () => createWorkGraphSnapshot(draft([accessor])),
    hasCode("WORK_GRAPH_INVALID"),
  );
  assert.throws(
    () => createWorkGraphSnapshot({ ...draft([task("one")]), extra: true }),
    hasCode("WORK_GRAPH_INVALID"),
  );

  const polluted = JSON.parse(
    '{"taskId":"one","revision":1,"parentTaskId":null,"status":"pending","responsibility":{"type":"role","id":"developer"},"acceptanceContracts":[],"deliveries":[],"dependsOn":[],"__proto__":{"admin":true}}',
  );
  assert.throws(
    () => createWorkGraphSnapshot(draft([polluted])),
    hasCode("WORK_GRAPH_INVALID"),
  );
  assert.equal({}.admin, undefined);
});

test("keeps contract and delivery history revisioned and rejects stale bindings", () => {
  const revised = task("implementation", {
    revision: 3,
    status: "completed",
    acceptanceContracts: [
      contract(),
      contract({
        revision: 2,
        acceptanceCriteria: [
          { criterionId: "tests-pass", description: "All tests pass" },
        ],
      }),
    ],
    deliveries: [
      delivery({ status: "rejected", summary: "Needs rework" }),
      delivery({
        revision: 2,
        contractRevision: 2,
        summary: "Rework accepted",
      }),
    ],
  });
  assert.doesNotThrow(() => createWorkGraphSnapshot(draft([revised])));

  const stale = {
    ...revised,
    status: "in_progress",
    deliveries: [delivery({ contractRevision: 3 })],
  };
  assert.throws(
    () => createWorkGraphSnapshot(draft([stale])),
    hasCode("WORK_GRAPH_STALE_REVISION"),
  );

  const snapshot = createWorkGraphSnapshot(draft([task("one")]));
  assert.throws(
    () => normalizeWorkGraphSnapshot(snapshot, { expectedRevision: 6 }),
    hasCode("WORK_GRAPH_STALE_REVISION"),
  );
});

test("rejects blank prose and graph revisions older than contained tasks", () => {
  assert.throws(
    () =>
      createWorkGraphSnapshot(
        draft([
          task("one", {
            acceptanceContracts: [
              contract({
                acceptanceCriteria: [
                  { criterionId: "tests-pass", description: "   " },
                ],
              }),
            ],
          }),
        ]),
      ),
    hasCode("WORK_GRAPH_INVALID"),
  );
  assert.throws(
    () =>
      createWorkGraphSnapshot(
        draft([
          task("one", {
            revision: 2,
            deliveries: [delivery({ summary: "\t " })],
          }),
        ]),
      ),
    hasCode("WORK_GRAPH_INVALID"),
  );
  assert.throws(
    () =>
      createWorkGraphSnapshot(
        draft([task("one", { revision: 8 })], { revision: 7 }),
      ),
    hasCode("WORK_GRAPH_STALE_REVISION"),
  );
});

test("rejects combined parent-dependency cycles and premature parent completion", () => {
  const groupingContract = contract({
    acceptanceCriteria: [],
    expectedDeliverables: [],
  });
  assert.throws(
    () =>
      createWorkGraphSnapshot(
        draft([
          task("root", { acceptanceContracts: [groupingContract] }),
          task("child", {
            parentTaskId: "root",
            dependsOn: ["root"],
          }),
        ]),
      ),
    hasCode("WORK_GRAPH_CYCLE"),
  );
  assert.throws(
    () =>
      createWorkGraphSnapshot(
        draft([
          task("root", {
            status: "completed",
            acceptanceContracts: [groupingContract],
          }),
          task("child", { parentTaskId: "root" }),
        ]),
      ),
    hasCode("WORK_GRAPH_INVALID"),
  );
  assert.throws(
    () =>
      createWorkGraphSnapshot(
        draft([
          task("foundation"),
          task("consumer", {
            revision: 2,
            status: "completed",
            dependsOn: ["foundation"],
            deliveries: [delivery()],
          }),
        ]),
      ),
    hasCode("WORK_GRAPH_INVALID"),
  );
});

test("validates one-step CAS transitions and append-only task histories", () => {
  const previous = createWorkGraphSnapshot(
    draft([task("implementation")], { revision: 7 }),
  );
  const next = createWorkGraphSnapshot(
    draft(
      [
        task("implementation", {
          revision: 2,
          status: "completed",
          deliveries: [
            delivery({ status: "submitted" }),
            delivery({ revision: 2 }),
          ],
        }),
      ],
      { revision: 8 },
    ),
  );
  assert.deepEqual(validateWorkGraphTransition(previous, next), next);

  const invalidNextSnapshots = [
    createWorkGraphSnapshot(
      draft(
        [task("implementation", { revision: 2, status: "in_progress" })],
        { revision: 9 },
      ),
    ),
    createWorkGraphSnapshot(draft([], { revision: 8 })),
    createWorkGraphSnapshot(
      draft([task("implementation", { status: "in_progress" })], {
        revision: 8,
      }),
    ),
    createWorkGraphSnapshot(
      draft([task("implementation", { revision: 3, status: "in_progress" })], {
        revision: 8,
      }),
    ),
  ];
  for (const invalidNext of invalidNextSnapshots) {
    assert.throws(
      () => validateWorkGraphTransition(previous, invalidNext),
      (error) =>
        error instanceof WorkGraphError &&
        [
          "WORK_GRAPH_STALE_REVISION",
          "WORK_GRAPH_INVALID_TRANSITION",
        ].includes(error.code),
    );
  }

  const validNewTask = createWorkGraphSnapshot(
    draft([task("implementation"), task("new-task")], { revision: 8 }),
  );
  assert.deepEqual(
    validateWorkGraphTransition(previous, validNewTask),
    validNewTask,
  );
  const validImportedActiveTask = createWorkGraphSnapshot(
    draft(
      [task("implementation"), task("active-task", { status: "in_progress" })],
      { revision: 8 },
    ),
  );
  assert.deepEqual(
    validateWorkGraphTransition(previous, validImportedActiveTask),
    validImportedActiveTask,
  );

  const invalidNewTasks = [
    task("new-task", { revision: 2 }),
    task("new-task", { status: "completed", deliveries: [delivery()] }),
    task("new-task", {
      revision: 2,
      acceptanceContracts: [contract(), contract({ revision: 2 })],
    }),
    task("new-task", { deliveries: [delivery()] }),
  ];
  for (const invalidNewTask of invalidNewTasks) {
    const invalidNewTaskSnapshot = createWorkGraphSnapshot(
      draft([task("implementation"), invalidNewTask], { revision: 8 }),
    );
    assert.throws(
      () => validateWorkGraphTransition(previous, invalidNewTaskSnapshot),
      hasCode("WORK_GRAPH_INVALID_TRANSITION"),
    );
  }
});

test("rejects rewritten history and newly appended deliveries for stale contracts", () => {
  const contracts = [
    contract(),
    contract({
      revision: 2,
      acceptanceCriteria: [
        { criterionId: "tests-pass", description: "All tests pass" },
      ],
    }),
  ];
  const previous = createWorkGraphSnapshot(
    draft(
      [
        task("implementation", {
          revision: 2,
          status: "in_progress",
          acceptanceContracts: contracts,
          deliveries: [delivery({ status: "rejected" })],
        }),
      ],
      { revision: 7 },
    ),
  );
  const rewrittenHistory = createWorkGraphSnapshot(
    draft(
      [
        task("implementation", {
          revision: 3,
          status: "in_progress",
          acceptanceContracts: contracts,
          deliveries: [
            delivery({ status: "rejected", summary: "rewritten history" }),
          ],
        }),
      ],
      { revision: 8 },
    ),
  );
  assert.throws(
    () => validateWorkGraphTransition(previous, rewrittenHistory),
    hasCode("WORK_GRAPH_INVALID_TRANSITION"),
  );

  const staleAppend = createWorkGraphSnapshot(
    draft(
      [
        task("implementation", {
          revision: 3,
          status: "in_progress",
          acceptanceContracts: contracts,
          deliveries: [
            delivery({ status: "rejected" }),
            delivery({
              revision: 2,
              contractRevision: 1,
              status: "submitted",
            }),
          ],
        }),
      ],
      { revision: 8 },
    ),
  );
  assert.throws(
    () => validateWorkGraphTransition(previous, staleAppend),
    hasCode("WORK_GRAPH_STALE_REVISION"),
  );

  const currentAppend = createWorkGraphSnapshot(
    draft(
      [
        task("implementation", {
          revision: 3,
          status: "completed",
          acceptanceContracts: contracts,
          deliveries: [
            delivery({ status: "rejected" }),
            delivery({
              revision: 2,
              contractRevision: 2,
              status: "submitted",
            }),
            delivery({ revision: 3, contractRevision: 2 }),
          ],
        }),
      ],
      { revision: 8 },
    ),
  );
  assert.deepEqual(validateWorkGraphTransition(previous, currentAppend), currentAppend);
});

test("new delivery decisions must immediately bind one submitted record", () => {
  const previous = createWorkGraphSnapshot(
    draft([task("implementation")], { revision: 7 }),
  );
  const directDecision = createWorkGraphSnapshot(
    draft(
      [
        task("implementation", {
          revision: 2,
          status: "completed",
          deliveries: [delivery()],
        }),
      ],
      { revision: 8 },
    ),
  );
  assert.throws(
    () => validateWorkGraphTransition(previous, directDecision),
    hasCode("WORK_GRAPH_INVALID_TRANSITION"),
  );

  const mismatchedEvidence = createWorkGraphSnapshot(
    draft(
      [
        task("implementation", {
          revision: 2,
          status: "completed",
          deliveries: [
            delivery({ status: "submitted" }),
            delivery({
              revision: 2,
              evidence: [
                {
                  kind: "change_package",
                  referenceId: "change-package-1",
                  contentDigest: "b".repeat(64),
                },
              ],
            }),
          ],
        }),
      ],
      { revision: 8 },
    ),
  );
  assert.throws(
    () => validateWorkGraphTransition(previous, mismatchedEvidence),
    hasCode("WORK_GRAPH_INVALID_TRANSITION"),
  );
});

test("supports non-terminal requeue while keeping terminal tasks immutable", () => {
  const transition = (fromTask, toTask) => {
    const previous = createWorkGraphSnapshot(
      draft([fromTask], { revision: 7 }),
    );
    const next = createWorkGraphSnapshot(draft([toTask], { revision: 8 }));
    return (options) => validateWorkGraphTransition(previous, next, options);
  };

  assert.doesNotThrow(
    transition(
      task("one"),
      task("one", { revision: 2, status: "in_progress" }),
    ),
  );
  assert.doesNotThrow(
    transition(
      task("one", { status: "in_progress" }),
      task("one", { revision: 2, status: "failed" }),
    ),
  );
  assert.doesNotThrow(
    transition(
      task("one", { status: "in_progress" }),
      task("one", { revision: 2, status: "pending" }),
    ),
  );

  for (const terminalStatus of [
    "completed",
    "failed",
    "cancelled",
    "superseded",
  ]) {
    const terminalTask = task("one", {
      revision: 2,
      status: terminalStatus,
      deliveries: terminalStatus === "completed" ? [delivery()] : [],
    });
    const revived = task("one", {
      ...terminalTask,
      revision: 3,
      status: "in_progress",
    });
    assert.throws(
      transition(terminalTask, revived),
      hasCode("WORK_GRAPH_INVALID_TRANSITION"),
    );
  }

  const completed = task("one", {
    revision: 2,
    status: "completed",
    deliveries: [delivery()],
  });
  const reactivated = { ...completed, revision: 3, status: "pending" };
  assert.doesNotThrow(() =>
    transition(completed, reactivated)({
      terminalReactivationTaskIds: ["one"],
    })
  );
  assert.doesNotThrow(() =>
    transition(
      completed,
      { ...completed, revision: 3, status: "in_progress" },
    )({ terminalReactivationTaskIds: ["one"] })
  );

  const superseded = task("one", {
    revision: 2,
    status: "superseded",
  });
  assert.throws(
    () =>
      transition(
        superseded,
        { ...superseded, revision: 3, status: "pending" },
      )({ terminalReactivationTaskIds: ["one"] }),
    hasCode("WORK_GRAPH_INVALID_TRANSITION"),
  );
  for (const status of ["in_progress", "pending"]) {
    assert.doesNotThrow(() =>
      transition(
        superseded,
        { ...superseded, revision: 3, status },
      )({ supersededReactivationTaskIds: ["one"] })
    );
  }
  assert.throws(
    () =>
      transition(
        superseded,
        {
          ...superseded,
          revision: 3,
          status: "pending",
          responsibility: responsibility("tester"),
        },
      )({ supersededReactivationTaskIds: ["one"] }),
    hasCode("WORK_GRAPH_INVALID_TRANSITION"),
  );
});

test("rejects new tasks below terminal ancestors", () => {
  for (const terminalStatus of ["failed", "cancelled", "superseded"]) {
    assert.throws(
      () =>
        createWorkGraphSnapshot(
          draft(
            [
              task("root", { status: terminalStatus }),
              task("new-child", { parentTaskId: "root" }),
            ],
            { revision: 8 },
          ),
        ),
      hasCode("WORK_GRAPH_INVALID"),
    );
  }

  assert.throws(
    () =>
      createWorkGraphSnapshot(
        draft([
          task("root", {
            status: "completed",
            acceptanceContracts: [
              contract({ acceptanceCriteria: [], expectedDeliverables: [] }),
            ],
          }),
          task("new-child", { parentTaskId: "root" }),
        ]),
      ),
    hasCode("WORK_GRAPH_INVALID"),
  );
});

test("binds parent revisions to child identities without copying child revisions", () => {
  const groupingContract = contract({
    acceptanceCriteria: [],
    expectedDeliverables: [],
  });
  const previous = createWorkGraphSnapshot(
    draft(
      [
        task("root", {
          status: "in_progress",
          acceptanceContracts: [groupingContract],
        }),
        task("child", { parentTaskId: "root" }),
      ],
      { revision: 7 },
    ),
  );
  const childProgress = createWorkGraphSnapshot(
    draft(
      [
        task("root", {
          status: "in_progress",
          acceptanceContracts: [groupingContract],
        }),
        task("child", {
          revision: 2,
          parentTaskId: "root",
          status: "in_progress",
        }),
      ],
      { revision: 8 },
    ),
  );
  assert.deepEqual(
    validateWorkGraphTransition(previous, childProgress),
    childProgress,
  );

  const pureParentBump = createWorkGraphSnapshot(
    draft(
      [
        task("root", {
          revision: 2,
          status: "in_progress",
          acceptanceContracts: [groupingContract],
        }),
        task("child", { parentTaskId: "root" }),
      ],
      { revision: 8 },
    ),
  );
  assert.deepEqual(
    validateWorkGraphTransition(previous, pureParentBump),
    pureParentBump,
  );
});

test("a new child bumps its direct parent but not unchanged ancestors", () => {
  const groupingContract = contract({
    acceptanceCriteria: [],
    expectedDeliverables: [],
  });
  const group = (taskId, overrides = {}) =>
    task(taskId, {
      status: "in_progress",
      acceptanceContracts: [groupingContract],
      ...overrides,
    });
  const previous = createWorkGraphSnapshot(
    draft(
      [
        group("root"),
        group("branch", { parentTaskId: "root" }),
        task("leaf", { parentTaskId: "branch" }),
      ],
      { revision: 7 },
    ),
  );
  const withNewChild = createWorkGraphSnapshot(
    draft(
      [
        group("root"),
        group("branch", { revision: 2, parentTaskId: "root" }),
        task("leaf", { parentTaskId: "branch" }),
        task("new-leaf", { parentTaskId: "branch" }),
      ],
      { revision: 8 },
    ),
  );
  assert.deepEqual(
    validateWorkGraphTransition(previous, withNewChild),
    withNewChild,
  );

  const staleDirectParent = createWorkGraphSnapshot(
    draft(
      [
        group("root"),
        group("branch", { parentTaskId: "root" }),
        task("leaf", { parentTaskId: "branch" }),
        task("new-leaf", { parentTaskId: "branch" }),
      ],
      { revision: 8 },
    ),
  );
  assert.throws(
    () => validateWorkGraphTransition(previous, staleDirectParent),
    hasCode("WORK_GRAPH_INVALID_TRANSITION"),
  );
});

test("enforces delivery revision, evidence, count, and serialized byte limits", () => {
  assert.throws(
    () =>
      createWorkGraphSnapshot(
        draft([
          task("one", {
            revision: 3,
            deliveries: [delivery(), delivery({ revision: 3 })],
          }),
        ]),
      ),
    hasCode("WORK_GRAPH_INVALID"),
  );
  assert.throws(
    () =>
      createWorkGraphSnapshot(
        draft([
          task("one", {
            revision: 2,
            deliveries: [delivery(), delivery({ revision: 2 })],
          }),
        ]),
        { limits: { maxDeliveriesPerTask: 1 } },
      ),
    hasCode("WORK_GRAPH_LIMIT_EXCEEDED"),
  );
  assert.throws(
    () =>
      createWorkGraphSnapshot(
        draft([
          task("one", {
            revision: 2,
            deliveries: [delivery({ summary: "x".repeat(256) })],
          }),
        ]),
        { limits: { maxDeliveryBytesPerTask: 128 } },
      ),
    hasCode("WORK_GRAPH_LIMIT_EXCEEDED"),
  );
  assert.throws(
    () =>
      createWorkGraphSnapshot(
        draft([
          task("one", {
            revision: 2,
            deliveries: [
              delivery({ evidence: [] }),
            ],
          }),
        ]),
      ),
    hasCode("WORK_GRAPH_INVALID"),
  );
});

test("computes blocked, ready, and sibling-parallel leaf tasks", () => {
  const snapshot = createWorkGraphSnapshot(
    draft([
      task("root", {
        status: "in_progress",
        acceptanceContracts: [
          contract({ acceptanceCriteria: [], expectedDeliverables: [] }),
        ],
      }),
      task("foundation", {
        revision: 2,
        parentTaskId: "root",
        status: "completed",
        deliveries: [delivery()],
      }),
      task("api", { parentTaskId: "root", dependsOn: ["foundation"] }),
      task("ui", { parentTaskId: "root", dependsOn: ["foundation"] }),
      task("release", { parentTaskId: "root", dependsOn: ["api", "ui"] }),
    ]),
  );

  assert.deepEqual(getReadyWorkGraphTaskIds(snapshot), ["api", "ui"]);
  assert.deepEqual(getParallelReadyWorkGraphTaskIds(snapshot), ["api", "ui"]);
  assert.deepEqual(getBlockedWorkGraphTasks(snapshot), [
    { taskId: "release", blockingTaskIds: ["api", "ui"] },
  ]);
});

test("paused tasks remain active blockers but are never graph-ready", () => {
  const groupingContract = contract({
    acceptanceCriteria: [],
    expectedDeliverables: [],
  });
  const snapshot = createWorkGraphSnapshot(
    draft([
      task("root", {
        status: "in_progress",
        acceptanceContracts: [groupingContract],
      }),
      task("paused-child", {
        parentTaskId: "root",
        status: "paused",
      }),
      task("ready-child", { parentTaskId: "root" }),
      task("dependent-child", {
        parentTaskId: "root",
        dependsOn: ["paused-child"],
      }),
    ]),
  );

  assert.deepEqual(getReadyWorkGraphTaskIds(snapshot), ["ready-child"]);
  assert.deepEqual(getParallelReadyWorkGraphTaskIds(snapshot), []);
  assert.deepEqual(getBlockedWorkGraphTasks(snapshot), [
    {
      taskId: "dependent-child",
      blockingTaskIds: ["paused-child"],
    },
  ]);
  assert.deepEqual(
    deriveParentTaskOutcome(snapshot, "root").activeTaskIds,
    ["dependent-child", "paused-child", "ready-child"],
  );

  const resumed = createWorkGraphSnapshot(
    draft(
      snapshot.tasks.map((entry) =>
        entry.taskId === "paused-child"
          ? { ...entry, revision: 2, status: "pending" }
          : entry
      ),
      { revision: 8 },
    ),
  );
  assert.deepEqual(validateWorkGraphTransition(snapshot, resumed), resumed);

  assert.throws(
    () =>
      validateWorkGraphTransition(
        createWorkGraphSnapshot(draft([], { revision: 0 })),
        createWorkGraphSnapshot(
          draft([task("new-paused", { status: "paused" })], { revision: 1 }),
        ),
      ),
    hasCode("WORK_GRAPH_INVALID_TRANSITION"),
  );
  assert.throws(
    () =>
      createWorkGraphSnapshot(
        draft([
          task("cancelled-root", { status: "cancelled" }),
          task("paused-child", {
            parentTaskId: "cancelled-root",
            status: "paused",
          }),
        ]),
      ),
    hasCode("WORK_GRAPH_INVALID"),
  );
});

test("pending parents are blocked only until every direct child settles", () => {
  const pendingChild = createWorkGraphSnapshot(
    draft([
      task("root"),
      task("child", { parentTaskId: "root" }),
    ]),
  );
  assert.deepEqual(getReadyWorkGraphTaskIds(pendingChild), ["child"]);
  assert.deepEqual(getBlockedWorkGraphTasks(pendingChild), [
    { taskId: "root", blockingTaskIds: ["child"] },
  ]);

  const completedChild = createWorkGraphSnapshot(
    draft([
      task("root"),
      task("child", {
        revision: 2,
        parentTaskId: "root",
        status: "completed",
        deliveries: [delivery()],
      }),
    ]),
  );
  assert.deepEqual(getReadyWorkGraphTaskIds(completedChild), ["root"]);
  assert.deepEqual(getBlockedWorkGraphTasks(completedChild), []);

  const cancelledChild = createWorkGraphSnapshot(
    draft([
      task("root"),
      task("peer"),
      task("child", {
        revision: 2,
        parentTaskId: "root",
        status: "cancelled",
      }),
    ]),
  );
  assert.deepEqual(getReadyWorkGraphTaskIds(cancelledChild), ["peer", "root"]);
  assert.deepEqual(getParallelReadyWorkGraphTaskIds(cancelledChild), [
    "peer",
    "root",
  ]);
  assert.deepEqual(getBlockedWorkGraphTasks(cancelledChild), []);

  const cancelledDependency = createWorkGraphSnapshot(
    draft([
      task("gate", { revision: 2, status: "cancelled" }),
      task("dependent", { dependsOn: ["gate"] }),
    ]),
  );
  assert.deepEqual(getReadyWorkGraphTaskIds(cancelledDependency), []);
  assert.deepEqual(getParallelReadyWorkGraphTaskIds(cancelledDependency), []);
  assert.deepEqual(getBlockedWorkGraphTasks(cancelledDependency), [
    { taskId: "dependent", blockingTaskIds: ["gate"] },
  ]);
});

test("superseded prerequisites are satisfied without waiving parent deliverables", () => {
  const groupingContract = contract({
    acceptanceCriteria: [],
    expectedDeliverables: [],
  });
  const tasks = [
    task("gate", { revision: 2, status: "superseded" }),
    task("root", {
      dependsOn: ["gate"],
      acceptanceContracts: [groupingContract],
    }),
    task("child", {
      revision: 2,
      parentTaskId: "root",
      status: "superseded",
    }),
  ];
  const snapshot = createWorkGraphSnapshot(draft(tasks));

  assert.deepEqual(getReadyWorkGraphTaskIds(snapshot), ["root"]);
  assert.deepEqual(getBlockedWorkGraphTasks(snapshot), []);
  const outcome = deriveParentTaskOutcome(snapshot, "root");
  assert.equal(outcome.outcome, "completed");
  assert.deepEqual(outcome.completedTaskIds, []);
  assert.deepEqual(outcome.supersededTaskIds, ["child"]);
  assert.deepEqual(outcome.activeTaskIds, []);

  assert.throws(
    () =>
      createWorkGraphSnapshot(
        draft([
          tasks[0],
          {
            ...tasks[1],
            revision: 2,
            status: "completed",
            acceptanceContracts: [contract()],
          },
          tasks[2],
        ]),
      ),
    (error) =>
      hasCode("WORK_GRAPH_INVALID")(error) &&
      /已验收交付物/.test(error.message),
  );

  assert.doesNotThrow(() =>
    createWorkGraphSnapshot(
      draft([
        tasks[0],
        {
          ...tasks[1],
          revision: 2,
          status: "completed",
          acceptanceContracts: [contract()],
          deliveries: [delivery()],
        },
        tasks[2],
      ]),
    )
  );
});

test("derives parent pending, partial, completed, failed, cancelled, and superseded outcomes", () => {
  const parent = task("root", {
    status: "in_progress",
    acceptanceContracts: [
      contract({ acceptanceCriteria: [], expectedDeliverables: [] }),
    ],
  });
  const graph = (children) =>
    createWorkGraphSnapshot(
      draft([parent, ...children.map((entry) => ({ ...entry, parentTaskId: "root" }))]),
    );
  const boundOutcome = deriveParentTaskOutcome(graph([task("one")]), "root");
  assert.equal(boundOutcome.graphRevision, 7);
  assert.match(boundOutcome.graphContentDigest, /^[a-f0-9]{64}$/);

  const pendingParent = { ...parent, status: "pending" };
  assert.equal(
    deriveParentTaskOutcome(
      createWorkGraphSnapshot(
        draft([pendingParent, { ...task("one"), parentTaskId: "root" }]),
      ),
      "root",
    ).outcome,
    "pending",
  );
  assert.equal(
    deriveParentTaskOutcome(graph([task("one")]), "root").outcome,
    "partial",
  );
  assert.equal(
    deriveParentTaskOutcome(
      graph([
        task("one", { revision: 2, status: "completed", deliveries: [delivery()] }),
        task("two"),
      ]),
      "root",
    ).outcome,
    "partial",
  );
  assert.equal(
    deriveParentTaskOutcome(
      graph([
        task("one", { revision: 2, status: "completed", deliveries: [delivery()] }),
        task("two", { revision: 2, status: "completed", deliveries: [delivery()] }),
      ]),
      "root",
    ).outcome,
    "completed",
  );
  assert.equal(
    deriveParentTaskOutcome(
      graph([
        task("one", {
          revision: 2,
          status: "completed",
          deliveries: [delivery()],
        }),
        task("replaced", { status: "cancelled" }),
      ]),
      "root",
    ).outcome,
    "completed",
  );
  const dependencyBlockedParent = createWorkGraphSnapshot(
    draft([
      task("gate"),
      { ...parent, dependsOn: ["gate"] },
      {
        ...task("one", {
          revision: 2,
          status: "completed",
          deliveries: [delivery()],
        }),
        parentTaskId: "root",
      },
    ]),
  );
  assert.equal(
    deriveParentTaskOutcome(dependencyBlockedParent, "root").outcome,
    "partial",
  );
  assert.equal(
    deriveParentTaskOutcome(graph([task("one", { status: "failed" })]), "root")
      .outcome,
    "failed",
  );
  assert.equal(
    deriveParentTaskOutcome(
      graph([
        task("one", { status: "cancelled" }),
        task("two", { status: "cancelled" }),
      ]),
      "root",
    ).outcome,
    "cancelled",
  );
  const supersededParent = { ...parent, status: "superseded" };
  assert.equal(
    deriveParentTaskOutcome(
      createWorkGraphSnapshot(
        draft([
          supersededParent,
          {
            ...task("one", { status: "superseded" }),
            parentTaskId: "root",
          },
        ]),
      ),
      "root",
    ).outcome,
    "superseded",
  );
});

test("parent outcome lookup rejects hostile task ids without coercion", () => {
  const snapshot = createWorkGraphSnapshot(
    draft([
      task("root", {
        acceptanceContracts: [
          contract({ acceptanceCriteria: [], expectedDeliverables: [] }),
        ],
      }),
      task("child", { parentTaskId: "root" }),
    ]),
  );
  let coercions = 0;
  const hostileTaskId = {
    toString() {
      coercions += 1;
      return "root";
    },
  };

  assert.throws(
    () => deriveParentTaskOutcome(snapshot, hostileTaskId),
    hasCode("WORK_GRAPH_INVALID"),
  );
  assert.equal(coercions, 0);
});
