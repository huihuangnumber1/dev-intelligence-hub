import assert from "node:assert/strict";
import test from "node:test";
import {
  WORKFLOW_EVENT_TYPES,
  WorkflowEventError,
  normalizeStoredWorkflowEvent,
  normalizeWorkflowEvent,
} from "../src/domain/workflow-events.js";

function event(overrides = {}) {
  return {
    schemaVersion: 1,
    eventType: "pull_request.observed",
    occurredAt: "2026-08-02T03:04:05.006Z",
    source: { provider: "github", scopeId: "local-owner" },
    subject: {
      id: "github:pr:acme/command-center#42",
      repository: "acme/command-center",
      number: 42,
    },
    payload: {
      labels: ["review", "priority-high"],
      relation: "review_requested",
      state: "open",
    },
    ...overrides,
  };
}

function assertInvalid(operation) {
  assert.throws(
    operation,
    (error) =>
      error instanceof WorkflowEventError &&
      error.code === "INVALID_WORKFLOW_EVENT" &&
      error.statusCode === 400,
  );
}

test("supports every PR and Issue workflow event plus trusted owner intake", () => {
  const eventNames = [
    "observed",
    "created",
    "updated",
    "completed",
    "left_scope",
    "classified",
    "status",
  ];
  const expectedTypes = ["pull_request", "issue"].flatMap((kind) =>
    eventNames.map((name) => `${kind}.${name}`),
  );

  assert.deepEqual(WORKFLOW_EVENT_TYPES, [
    ...expectedTypes,
    "owner_request.created",
    "pull_request.owner_requested",
    "pull_request.internal_review_requested",
    "pull_request.role_handoff",
    "issue.owner_requested",
  ]);
  for (const eventType of expectedTypes) {
    const normalized = normalizeWorkflowEvent(event({ eventType }));
    assert.equal(normalized.eventType, eventType);
    assert.match(normalized.contentDigest, /^[a-f0-9]{64}$/);
    assert.equal(
      normalized.eventId,
      `workflow-event-${normalized.contentDigest}`,
    );
  }
});

test("PR and Issue events retain business fields that are also used by owner requests", () => {
  const payload = {
    title: "Shared title",
    description: "Shared description",
    priority: "high",
    workType: "requirements",
    acceptanceCriteria: ["Verified behavior"],
  };
  for (const eventType of ["pull_request.created", "issue.created"]) {
    const normalized = normalizeWorkflowEvent(event({ eventType, payload }));
    assert.deepEqual(normalized.payload, payload);
  }
});

test("internal repair review sources bind their server provenance and exact published Head", () => {
  const headRefOid = "a".repeat(40);
  const input = event({
    eventType: "pull_request.internal_review_requested",
    source: { provider: "internal-review-repair", scopeId: "internal-review:11111111-1111-4111-8111-111111111111" },
    payload: {
      state: "open", workType: "pull_request", headRefOid, gitTargetAvailable: true,
      gitTarget: { schemaVersion: 1, provider: "github", sourceAccountId: "local-owner", baseRepository: "acme/command-center",
        baseRefName: "main", baseRefOid: "b".repeat(40), headRepository: "acme/command-center", headRefName: "fix/repair", headRefOid },
      internalReview: { kind: "own_pr_repair", headRefOid, feedbackDigest: "c".repeat(64),
        publicationConfirmationId: "publication:1", controlledCommitEvidenceId: "controlled-commit:1" },
    },
  });
  assert.equal(normalizeWorkflowEvent(input).payload.internalReview.headRefOid, headRefOid);
  for (const forged of [
    { ...input, source: { provider: "github", scopeId: "local-owner" } },
    { ...input, eventType: "pull_request.updated" },
    { ...input, payload: { ...input.payload, internalReview: { ...input.payload.internalReview, headRefOid: "d".repeat(40) } } },
  ]) assertInvalid(() => normalizeWorkflowEvent(forged));
});

test("issue evidence digests must be canonical SHA-256 values", () => {
  const normalized = normalizeWorkflowEvent(event({
    eventType: "issue.updated",
    payload: { evidenceDigest: "a".repeat(64) },
  }));
  assert.equal(normalized.payload.evidenceDigest, "a".repeat(64));
  assertInvalid(() => normalizeWorkflowEvent(event({
    eventType: "issue.updated",
    payload: { evidenceDigest: "not-a-digest" },
  })));
});

test("normalizes key order into a stable content-addressed event", () => {
  const left = event({
    payload: {
      state: "open",
      labels: ["one", "two"],
      files: [{ path: "src/app.js", deletions: 1, additions: 2 }],
    },
  });
  const right = {
    payload: {
      files: [{ additions: 2, path: "src/app.js", deletions: 1 }],
      labels: ["one", "two"],
      state: "open",
    },
    subject: {
      number: 42,
      repository: "acme/command-center",
      id: "github:pr:acme/command-center#42",
    },
    source: { scopeId: "local-owner", provider: "github" },
    occurredAt: "2026-08-02T03:04:05.006Z",
    eventType: "pull_request.observed",
    schemaVersion: 1,
  };

  const normalizedLeft = normalizeWorkflowEvent(left);
  const normalizedRight = normalizeWorkflowEvent(right);
  assert.deepEqual(normalizedLeft, normalizedRight);
  assert.deepEqual(Object.keys(normalizedLeft.payload), [
    "files",
    "labels",
    "state",
  ]);
  assert.notStrictEqual(normalizedLeft.payload, left.payload);
  assert.equal(Object.isFrozen(normalizedLeft), true);
  assert.equal(Object.isFrozen(normalizedLeft.payload.files[0]), true);

  left.payload.files[0].path = "changed after normalization";
  assert.equal(normalizedLeft.payload.files[0].path, "src/app.js");
});

test("event identity binds timestamp, type, subject, source, and payload", () => {
  const original = normalizeWorkflowEvent(event());
  const variants = [
    event({ occurredAt: "2026-08-02T03:04:05.007Z" }),
    event({ eventType: "pull_request.updated" }),
    event({ source: { provider: "github", scopeId: "another-user" } }),
    event({
      subject: {
        id: "github:pr:acme/command-center#43",
        repository: "acme/command-center",
        number: 43,
      },
    }),
    event({ payload: { state: "closed" } }),
  ];

  for (const variant of variants) {
    const normalized = normalizeWorkflowEvent(variant);
    assert.notEqual(normalized.contentDigest, original.contentDigest);
    assert.notEqual(normalized.eventId, original.eventId);
  }
});

test("PR events carry one atomic Git target bound to the subject and legacy Head", () => {
  const gitTarget = {
    schemaVersion: 1,
    provider: "github",
    sourceAccountId: "runtime-user",
    baseRepository: "acme/command-center",
    baseRefName: "main",
    baseRefOid: "a".repeat(40),
    headRepository: "contributor/command-center",
    headRefName: "fix/conflict",
    headRefOid: "b".repeat(40),
  };
  const normalized = normalizeWorkflowEvent(event({
    payload: {
      headRefOid: gitTarget.headRefOid,
      gitTarget,
      gitTargetAvailable: true,
    },
  }));

  assert.deepEqual(normalized.payload.gitTarget, gitTarget);
  assert.ok(Object.isFrozen(normalized.payload.gitTarget));
  assertInvalid(() => normalizeWorkflowEvent(event({
    payload: {
      headRefOid: "c".repeat(40),
      gitTarget,
      gitTargetAvailable: true,
    },
  })));
  assertInvalid(() => normalizeWorkflowEvent(event({
    payload: {
      headRefOid: gitTarget.headRefOid,
      gitTarget,
      gitTargetAvailable: true,
      baseRefOid: gitTarget.baseRefOid,
    },
  })));
  assertInvalid(() => normalizeWorkflowEvent(event({
    eventType: "issue.updated",
    payload: {
      headRefOid: gitTarget.headRefOid,
      gitTarget,
      gitTargetAvailable: true,
    },
  })));
  assertInvalid(() => normalizeWorkflowEvent(event({
    payload: { headRefOid: gitTarget.headRefOid, gitTargetAvailable: true },
  })));
  assertInvalid(() => normalizeWorkflowEvent(event({
    payload: {
      headRefOid: gitTarget.headRefOid,
      gitTarget,
      gitTargetAvailable: false,
    },
  })));
  assertInvalid(() => normalizeWorkflowEvent(event({
    eventType: "issue.updated",
    payload: { gitTargetAvailable: false },
  })));
});

test("stored events are re-normalized and their identity is verified", () => {
  const stored = normalizeWorkflowEvent(event());
  assert.deepEqual(normalizeStoredWorkflowEvent(stored), stored);

  assertInvalid(() =>
    normalizeStoredWorkflowEvent({ ...stored, contentDigest: "0".repeat(64) }),
  );
  assertInvalid(() =>
    normalizeStoredWorkflowEvent({ ...stored, eventId: "workflow-event-forged" }),
  );
  assertInvalid(() =>
    normalizeStoredWorkflowEvent({
      ...stored,
      payload: { ...stored.payload, state: "closed" },
    }),
  );
});

test("requires exact plain data-only DTOs without invoking accessors", () => {
  assertInvalid(() => normalizeWorkflowEvent({ ...event(), extra: true }));
  assertInvalid(() => {
    const value = event();
    delete value.payload;
    normalizeWorkflowEvent(value);
  });
  assertInvalid(() => normalizeWorkflowEvent(Object.create(event())));
  assertInvalid(() =>
    normalizeWorkflowEvent(Object.assign(Object.create(null), event())),
  );
  assertInvalid(() =>
    normalizeWorkflowEvent({
      ...event(),
      source: Object.assign(Object.create({ inherited: true }), {
        provider: "github",
        scopeId: "me",
      }),
    }),
  );
  assertInvalid(() => normalizeWorkflowEvent(event({ payload: [] })));
  assertInvalid(() =>
    normalizeWorkflowEvent(
      event({
        payload: {
          nested: Object.assign(Object.create(null), { state: "open" }),
        },
      }),
    ),
  );

  let getterCalls = 0;
  const payload = {};
  Object.defineProperty(payload, "state", {
    enumerable: true,
    get() {
      getterCalls += 1;
      return "open";
    },
  });
  assertInvalid(() => normalizeWorkflowEvent(event({ payload })));
  assert.equal(getterCalls, 0);

  const symbolPayload = { state: "open" };
  symbolPayload[Symbol("hidden")] = "value";
  assertInvalid(() => normalizeWorkflowEvent(event({ payload: symbolPayload })));

  const sparse = [];
  sparse.length = 2;
  sparse[1] = "value";
  assertInvalid(() => normalizeWorkflowEvent(event({ payload: { sparse } })));
  assertInvalid(() =>
    normalizeWorkflowEvent(event({ payload: { callback: () => "run" } })),
  );
});

test("accepts only whitelisted facts and rejects credentials or capabilities", () => {
  const forbiddenKeys = [
    "token",
    "tokens",
    "access_token",
    "API-Key",
    "clientSecret",
    "authorization",
    "password",
    "private_key",
    "secrets",
    "credentials",
    "command",
    "argv",
    "shell",
    "script",
    "cwd",
    "env",
    "capability",
    "spawn",
  ];

  for (const key of forbiddenKeys) {
    assertInvalid(() =>
      normalizeWorkflowEvent(event({ payload: { facts: { [key]: "hidden" } } })),
    );
  }

  const forbiddenAliases = [
    "githubToken",
    "GitHubToken",
    "GITHUB_TOKEN",
    "bearerToken",
    "Bearer-Token",
    "oauth_token_value",
    "OAuth.Token.Value",
    "passwordValue",
    "PASSWORDVALUE",
    "PASSWORD-VALUE",
    "commandLine",
    "Command_Line",
    "ghToken",
    "GH-TOKEN",
    "githubPAT",
    "GitHub.PAT.Value",
    "idToken",
    "ID_TOKEN_VALUE",
    "sessionToken",
    "Session-Token",
    "jwt",
    "JWT.Claims",
    "sshKey",
    "SSH-KEY-VALUE",
    "deployKey",
    "Deploy.Key",
    "bearer",
    "BEARER_VALUE",
    "oauth",
    "O-AUTH",
    "OAuth.Scope",
    "apiToken",
    "API_TOKEN",
    "api-token-value",
    "userToken",
    "csrfToken",
    "slackBotToken",
    "serviceAccountKey",
    "signingKey",
    "encryptionKey",
    "apiTokens",
    "userTokens",
    "csrfTokens",
    "slackBotTokens",
    "serviceAccountKeys",
    "signingKeys",
    "encryptionKeys",
    "apitoken",
    "usertoken",
    "csrftoken",
    "slackbottoken",
    "serviceaccountkey",
    "signingkey",
    "encryptionkey",
    "secretkey",
    "accesskey",
    "awsaccesskey",
    "openaiapikey",
    "slackbotkey",
    "csrfkey",
    "userkey",
  ];
  for (const key of forbiddenAliases) {
    assertInvalid(() =>
      normalizeWorkflowEvent(
        event({ payload: { outer: { nestedFacts: { [key]: "hidden" } } } }),
      ),
    );
  }

  const safe = normalizeWorkflowEvent(
    event({
      payload: {
        actionState: "ready",
        changedFields: ["labels", "state"],
        nextAction: "review",
        tokenCount: 42,
      },
    }),
  );
  assert.equal(safe.payload.actionState, "ready");
  assert.deepEqual(safe.payload.changedFields, ["labels", "state"]);
  assert.equal(safe.payload.nextAction, "review");
  for (const key of ["monkey", "keynote", "tokenizer"]) {
    assertInvalid(() => normalizeWorkflowEvent(event({ payload: { [key]: "safe" } })));
  }
});

test("enforces payload depth, entry, container, string, and total-byte limits", () => {
  let nested = { value: true };
  for (let index = 0; index < 17; index += 1) nested = { nested };
  assertInvalid(() => normalizeWorkflowEvent(event({ payload: nested })));

  assertInvalid(() =>
    normalizeWorkflowEvent(
      event({ payload: { entries: Array.from({ length: 201 }, () => true) } }),
    ),
  );
  assertInvalid(() =>
    normalizeWorkflowEvent(
      event({ payload: { text: "x".repeat(16 * 1024 + 1) } }),
    ),
  );
  assertInvalid(() =>
    normalizeWorkflowEvent(
      event({
        payload: Object.fromEntries(
          Array.from({ length: 200 }, (_, index) => [
            `field${index}`,
            Array.from({ length: 5 }, () => true),
          ]),
        ),
      }),
    ),
  );
  assertInvalid(() =>
    normalizeWorkflowEvent(
      event({
        payload: Object.fromEntries(
          Array.from({ length: 64 }, (_, index) => [
            `field${index}`,
            "x".repeat(1_100),
          ]),
        ),
      }),
    ),
  );
});

test("rejects malformed event semantics and non-canonical scalar values", () => {
  const invalidEvents = [
    event({ schemaVersion: 2 }),
    event({ eventType: "pull_request.deleted" }),
    event({ eventType: "repository.observed" }),
    event({ occurredAt: "2026-08-02T03:04:05Z" }),
    event({ occurredAt: "2026-08-02T03:04:05.006+00:00" }),
    event({ source: { provider: "Git Hub", scopeId: "me" } }),
    event({ source: { provider: "GitHub", scopeId: "me" } }),
    event({ source: { provider: "github", scopeId: "bad\u0000scope" } }),
    event({ source: { provider: "github", scopeId: "bad\nscope" } }),
    event({
      subject: {
        id: "github:pr:bad\nid",
        repository: "acme/command-center",
        number: 42,
      },
    }),
    event({
      subject: {
        id: "github:pr:repo#0",
        repository: "acme/command-center",
        number: 0,
      },
    }),
    event({
      subject: {
        id: "github:pr:hidden#1",
        repository: "acme/.hidden",
        number: 1,
      },
    }),
    event({ payload: { riskScore: Number.NaN } }),
    event({ payload: { riskScore: Number.POSITIVE_INFINITY } }),
    event({ payload: { missing: undefined } }),
  ];

  for (const value of invalidEvents) {
    assertInvalid(() => normalizeWorkflowEvent(value));
  }

  assert.equal(
    normalizeWorkflowEvent(event({ payload: { riskScore: -0 } })).payload.riskScore,
    0,
  );
});

test("rejects cyclic payloads", () => {
  const payload = { state: "open" };
  payload.self = payload;
  assertInvalid(() => normalizeWorkflowEvent(event({ payload })));
});
