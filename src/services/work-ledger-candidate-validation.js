import { appendWorkGraphMemoryEvents } from "./work-ledger-graph-memory.js";
import { validateWorkLedgerGraphTransition } from "./work-ledger-graph.js";
import { validatePullRequestSourceTransition } from "./work-ledger-pr-source.js";
import {
  assertWorkLedgerCapacity,
  normalizeWorkLedgerPersistedState,
  retainWorkLedgerTimelineForCapacity,
} from "./work-ledger-state.js";
import { workLedgerError } from "./work-ledger-values.js";

function ownDataValue(value, key) {
  if (
    value === null ||
    (typeof value !== "object" && typeof value !== "function")
  ) {
    return undefined;
  }
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  return descriptor && "value" in descriptor ? descriptor.value : undefined;
}

export function serializeWorkLedgerCandidateError(error, depth = 0) {
  const message = ownDataValue(error, "message");
  const name = ownDataValue(error, "name");
  const code = ownDataValue(error, "code");
  const statusCode = ownDataValue(error, "statusCode");
  const cause = ownDataValue(error, "cause");
  return {
    name: typeof name === "string"
      ? name
      : error instanceof TypeError
        ? "TypeError"
        : "Error",
    message: typeof message === "string"
      ? message
      : "员工工作台账候选状态处理失败",
    ...(typeof code === "string" ? { code } : {}),
    ...(Number.isSafeInteger(statusCode) ? { statusCode } : {}),
    ...(depth < 4 && cause !== undefined
      ? { cause: serializeWorkLedgerCandidateError(cause, depth + 1) }
      : {}),
  };
}

export function prepareWorkLedgerCandidate({
  previousState,
  candidate,
  limits,
  appendGraphMemory = true,
}) {
  if (appendGraphMemory) {
    candidate = appendWorkGraphMemoryEvents(
      previousState,
      candidate,
      limits,
    );
  }
  try {
    assertWorkLedgerCapacity(candidate, limits);
  } catch (error) {
    if (error?.code !== 'WORK_LEDGER_CAPACITY_EXCEEDED') throw error;
    candidate = retainWorkLedgerTimelineForCapacity(previousState, candidate, limits);
    assertWorkLedgerCapacity(candidate, limits);
  }
  let normalized;
  try {
    normalized = normalizeWorkLedgerPersistedState(candidate, limits);
  } catch (error) {
    if (error?.code === "WORK_LEDGER_CAPACITY_EXCEEDED") throw error;
    throw workLedgerError(
      "WORK_LEDGER_STATE_CORRUPTED",
      "拒绝写入不一致的员工工作台账",
      503,
      { cause: error },
    );
  }
  try {
    validateWorkLedgerGraphTransition(previousState, normalized);
  } catch (error) {
    throw workLedgerError(
      "WORK_LEDGER_GRAPH_TRANSITION_INVALID",
      "员工工作图转换与台账修订不一致",
      409,
      { cause: error },
    );
  }
  try {
    validatePullRequestSourceTransition(previousState.items, normalized.items,
      previousState.timeline, normalized.timeline);
  } catch (error) {
    throw workLedgerError(
      "WORK_LEDGER_PR_SOURCE_TRANSITION_INVALID",
      "PR 来源历史与台账修订不一致",
      409,
      { cause: error },
    );
  }
  return normalized;
}
