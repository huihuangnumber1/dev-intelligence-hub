const PULL_REQUEST_EVENTS = Object.freeze([
  "pull_request.role_handoff",
  "pull_request.observed",
  "pull_request.created",
  "pull_request.updated",
  "pull_request.classified",
  "pull_request.status",
]);

const SELF_FIX_ACTIONS = Object.freeze([
  "address_review",
  "fix_ci",
  "resolve_conflict",
  "continue_draft",
]);

export const AUTHORED_PR_SELF_FIX_RULE_ID =
  "system-authored-pr-self-fix-to-developer";
export const AUTHORED_PR_APPROVED_RULE_ID =
  "system-authored-pr-approved-to-tester";
export const REVIEWED_PR_APPROVED_RULE_ID =
  "system-reviewed-pr-approved-to-tester";

export function withPrLifecycleRoutes(definition) {
  if (
    definition === null ||
    typeof definition !== "object" ||
    Array.isArray(definition) ||
    !Array.isArray(definition.rules)
  ) {
    throw new TypeError("workflow routing definition is invalid");
  }
  const rules = definition.rules.filter(
    ({ id }) => ![
      AUTHORED_PR_SELF_FIX_RULE_ID,
      AUTHORED_PR_APPROVED_RULE_ID,
      REVIEWED_PR_APPROVED_RULE_ID,
    ].includes(id),
  );
  return {
    ...definition,
    rules: [
      {
        id: AUTHORED_PR_APPROVED_RULE_ID,
        source: "root",
        enabled: true,
        priority: 10_000,
        fallback: false,
        condition: {
          op: "all",
          conditions: [
            {
              op: "oneOf",
              path: "eventType",
              values: [...PULL_REQUEST_EVENTS],
            },
            {
              op: "equals",
              path: "payload.relation",
              value: "authored",
            },
            {
              op: "equals",
              path: "payload.actionState",
              value: "waiting_other",
            },
            {
              op: "equals",
              path: "payload.nextAction",
              value: "wait_merge",
            },
            {
              op: "equals",
              path: "payload.reviewDecision",
              value: "APPROVED",
            },
          ],
        },
        targets: [{ type: "role", id: "tester" }],
        onMatch: "stop",
      },
      {
        id: AUTHORED_PR_SELF_FIX_RULE_ID,
        source: "root",
        enabled: true,
        priority: 10_000,
        fallback: false,
        condition: {
          op: "all",
          conditions: [
            {
              op: "oneOf",
              path: "eventType",
              values: [...PULL_REQUEST_EVENTS],
            },
            {
              op: "equals",
              path: "payload.relation",
              value: "authored",
            },
            {
              op: "equals",
              path: "payload.actionState",
              value: "action_now",
            },
            {
              op: "oneOf",
              path: "payload.nextAction",
              values: [...SELF_FIX_ACTIONS],
            },
          ],
        },
        targets: [{ type: "role", id: "developer" }],
        onMatch: "stop",
      },
      ...rules,
    ],
  };
}
