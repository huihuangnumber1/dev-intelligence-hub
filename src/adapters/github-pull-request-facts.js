import { types as utilTypes } from "node:util";

import { createPullRequestReadFacts } from "../domain/pull-request-read-facts.js";
import { normalizePullRequestGitTarget } from "../domain/git-tool-contract.js";
import { githubCurrentPullRequestGitTarget } from "./github-current-pull-request-target.js";

export const GITHUB_PULL_REQUEST_FACTS_QUERY = String.raw`
query MyDashboardPullRequestFacts(
  $owner: String!
  $name: String!
  $number: Int!
  $commentCount: Int!
  $reviewCount: Int!
  $threadCount: Int!
  $threadCommentCount: Int!
  $checkCount: Int!
) {
  repository(owner: $owner, name: $name) {
    pullRequest(number: $number) {
      number
      url
      reviewDecision
      baseRefName
      baseRefOid
      baseRef { name repository { nameWithOwner } target { ... on Commit { oid } } }
      headRefName
      headRefOid
      headRef { name repository { nameWithOwner } target { ... on Commit { oid } } }
      headRepository { nameWithOwner }
      comments(last: $commentCount) {
        nodes { id author { login } body createdAt updatedAt url }
        pageInfo { hasPreviousPage hasNextPage }
      }
      reviews(last: $reviewCount) {
        nodes { id author { login } state submittedAt commit { oid } body url }
        pageInfo { hasPreviousPage hasNextPage }
      }
      reviewThreads(last: $threadCount) {
        nodes {
          id
          path
          line
          originalLine
          isResolved
          isOutdated
          comments(last: $threadCommentCount) {
            nodes {
              id
              author { login }
              body
              createdAt
              updatedAt
              url
              pullRequestReview { id state submittedAt commit { oid } }
            }
            pageInfo { hasPreviousPage hasNextPage }
          }
        }
        pageInfo { hasPreviousPage hasNextPage }
      }
      commits(last: 1) {
        nodes {
          commit {
            statusCheckRollup {
              contexts(first: $checkCount) {
                nodes {
                  __typename
                  ... on CheckRun {
                    name
                    status
                    conclusion
                    detailsUrl
                    startedAt
                    completedAt
                    isRequired(pullRequestNumber: $number)
                  }
                  ... on StatusContext {
                    context
                    state
                    targetUrl
                    createdAt
                    isRequired(pullRequestNumber: $number)
                  }
                }
                pageInfo { hasPreviousPage hasNextPage }
              }
            }
          }
        }
      }
    }
  }
}`;

const GRAPH_PULL_REQUEST_KEYS = Object.freeze([
  "number",
  "url",
  "reviewDecision",
  "baseRefName",
  "baseRefOid",
  "baseRef",
  "headRefName",
  "headRefOid",
  "headRef",
  "headRepository",
  "comments",
  "reviews",
  "reviewThreads",
  "commits",
]);
const VIEW_TARGET_KEYS = Object.freeze([
  "number",
  "url",
  "baseRefName",
  "baseRefOid",
  "headRefName",
  "headRefOid",
  "headRepository",
  "headRepositoryOwner",
]);
const VIEW_TARGET_STATE_KEYS = Object.freeze([...VIEW_TARGET_KEYS, "state"]);
const PULL_REQUEST_STATES = new Set(["OPEN", "CLOSED", "MERGED"]);
const VIEW_REPOSITORY_KEYS = Object.freeze(["id", "name", "nameWithOwner"]);
const VIEW_OWNER_KEYS = Object.freeze(["id", "name", "login"]);
const CONNECTION_KEYS = Object.freeze(["nodes", "pageInfo"]);
const PAGE_INFO_KEYS = Object.freeze(["hasPreviousPage", "hasNextPage"]);
const COMMENT_KEYS = Object.freeze([
  "id",
  "author",
  "body",
  "createdAt",
  "updatedAt",
  "url",
]);
const REVIEW_KEYS = Object.freeze([
  "id",
  "author",
  "state",
  "submittedAt",
  "commit",
  "body",
  "url",
]);
const THREAD_KEYS = Object.freeze([
  "id",
  "path",
  "line",
  "originalLine",
  "isResolved",
  "isOutdated",
  "comments",
]);
const THREAD_COMMENT_KEYS = Object.freeze([
  ...COMMENT_KEYS,
  "pullRequestReview",
]);
const CHECK_RUN_KEYS = Object.freeze([
  "__typename",
  "name",
  "status",
  "conclusion",
  "detailsUrl",
  "startedAt",
  "completedAt",
  "isRequired",
]);
const STATUS_CONTEXT_KEYS = Object.freeze([
  "__typename",
  "context",
  "state",
  "targetUrl",
  "createdAt",
  "isRequired",
]);

const REVIEW_DECISIONS = new Set([
  "APPROVED",
  "CHANGES_REQUESTED",
  "REVIEW_REQUIRED",
]);
const REVIEW_STATES = new Set([
  "APPROVED",
  "CHANGES_REQUESTED",
  "COMMENTED",
  "DISMISSED",
  "PENDING",
]);
const CHECK_STATUSES = new Set([
  "QUEUED",
  "IN_PROGRESS",
  "COMPLETED",
  "PENDING",
  "EXPECTED",
  "REQUESTED",
  "WAITING",
]);
const CHECK_CONCLUSIONS = new Set([
  "SUCCESS",
  "FAILURE",
  "NEUTRAL",
  "CANCELLED",
  "SKIPPED",
  "TIMED_OUT",
  "ACTION_REQUIRED",
  "STARTUP_FAILURE",
  "STALE",
  "ERROR",
]);
const UNSAFE_REMOTE_TEXT = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/;
const UNSAFE_DISPLAY_TEXT = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}\p{Cs}]/u;
const GITHUB_ACTOR_LOGIN =
  /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?(?:\[bot\])?$/;

export class GitHubPullRequestFactsError extends Error {
  constructor(message = "GitHub returned invalid pull request facts") {
    super(message);
    this.name = "GitHubPullRequestFactsError";
    this.code = "GITHUB_PULL_REQUEST_FACTS_INVALID";
    this.statusCode = 502;
  }
}

function invalid(message) {
  return new GitHubPullRequestFactsError(message);
}

function dataMap(value, name) {
  if (
    value === null ||
    typeof value !== "object" ||
    utilTypes.isProxy(value) ||
    Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Object.prototype
  ) {
    throw invalid(`${name} is invalid`);
  }
  const result = new Map();
  for (const key of Reflect.ownKeys(value)) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (
      typeof key !== "string" ||
      !descriptor?.enumerable ||
      !("value" in descriptor)
    ) {
      throw invalid(`${name} is invalid`);
    }
    result.set(key, descriptor.value);
  }
  return result;
}

function exactDataMap(value, keys, name) {
  const fields = dataMap(value, name);
  if (
    fields.size !== keys.length ||
    keys.some((key) => !fields.has(key))
  ) {
    throw invalid(`${name} is invalid`);
  }
  return fields;
}

function dataArray(value, name, maximumEntries) {
  if (
    utilTypes.isProxy(value) ||
    !Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Array.prototype ||
    value.length > maximumEntries
  ) {
    throw invalid(`${name} is invalid`);
  }
  const expectedKeys = Array.from({ length: value.length }, (_, index) =>
    String(index),
  );
  const keys = Reflect.ownKeys(value);
  if (
    keys.length !== expectedKeys.length + 1 ||
    !keys.includes("length") ||
    expectedKeys.some((key) => !keys.includes(key))
  ) {
    throw invalid(`${name} is invalid`);
  }
  return expectedKeys.map((key) => {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor?.enumerable || !("value" in descriptor)) {
      throw invalid(`${name} is invalid`);
    }
    return descriptor.value;
  });
}

function remoteText(value, name, maximumBytes, { empty = false } = {}) {
  if (
    typeof value !== "string" ||
    (!empty && value.length === 0) ||
    UNSAFE_REMOTE_TEXT.test(value) ||
    Buffer.byteLength(value, "utf8") > maximumBytes
  ) {
    throw invalid(`${name} is invalid`);
  }
  return value;
}

function nullableTimestamp(value, name) {
  if (value === null) return null;
  const timestamp = remoteText(value, name, 30);
  if (
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?Z$/u.test(
      timestamp,
    )
  ) {
    throw invalid(`${name} is invalid`);
  }
  const milliseconds = Date.parse(timestamp);
  const canonical = Number.isFinite(milliseconds)
    ? new Date(milliseconds).toISOString()
    : "";
  if (!canonical || canonical.slice(0, 19) !== timestamp.slice(0, 19)) {
    throw invalid(`${name} is invalid`);
  }
  return canonical;
}

function displayText(value, name, maximumBytes) {
  const normalized = remoteText(value, name, maximumBytes);
  if (UNSAFE_DISPLAY_TEXT.test(normalized) || !normalized.trim()) {
    throw invalid(`${name} is invalid`);
  }
  return normalized;
}

function requiredTimestamp(value, name) {
  const timestamp = nullableTimestamp(value, name);
  if (timestamp === null) throw invalid(`${name} is invalid`);
  return timestamp;
}

function optionalUrl(value, name, { allowHttp = false } = {}) {
  if (value === null || value === "") return "";
  const url = remoteText(value, name, 2_048);
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    throw invalid(`${name} is invalid`);
  }
  if ((parsed.protocol !== "https:" && !(allowHttp && parsed.protocol === 'http:')) || parsed.username || parsed.password) {
    throw invalid(`${name} is invalid`);
  }
  return parsed.href;
}

function safeCheckUrl(value, name) {
  try {
    return optionalUrl(value, name, { allowHttp: true });
  } catch (error) {
    if (error instanceof GitHubPullRequestFactsError) return "";
    throw error;
  }
}

function boolean(value, name) {
  if (typeof value !== "boolean") throw invalid(`${name} is invalid`);
  return value;
}

function nullableBoolean(value, name) {
  return value === null ? null : boolean(value, name);
}

function nullableLine(value, name) {
  if (value === null) return null;
  if (!Number.isSafeInteger(value) || value < 1) {
    throw invalid(`${name} is invalid`);
  }
  return value;
}

function enumOrUnknown(value, allowed, { empty = "UNKNOWN" } = {}) {
  if (value === null || value === "") return empty;
  if (typeof value !== "string") return "UNKNOWN";
  const normalized = value.toUpperCase();
  return allowed.has(normalized) ? normalized : "UNKNOWN";
}

function authorLogin(value, name) {
  if (value === null) return "";
  const fields = exactDataMap(value, ["login"], name);
  const login = displayText(fields.get("login"), `${name}.login`, 44);
  if (!GITHUB_ACTOR_LOGIN.test(login) || login.includes("--")) {
    throw invalid(`${name}.login is invalid`);
  }
  return login;
}

function commitOid(value, name) {
  if (value === null) return "";
  const fields = exactDataMap(value, ["oid"], name);
  const oid = remoteText(fields.get("oid"), `${name}.oid`, 64);
  if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u.test(oid)) {
    throw invalid(`${name}.oid is invalid`);
  }
  return oid;
}

function truncateUtf8(value, maximumBytes) {
  const text = remoteText(value, "body", 256 * 1024, { empty: true });
  if (Buffer.byteLength(text, "utf8") <= maximumBytes) {
    return { body: text, truncated: false };
  }
  let body = "";
  let bytes = 0;
  for (const character of text) {
    const nextBytes = Buffer.byteLength(character, "utf8");
    if (bytes + nextBytes > maximumBytes) break;
    body += character;
    bytes += nextBytes;
  }
  return { body, truncated: true };
}

function connection(value, name, maximumEntries) {
  const fields = exactDataMap(value, CONNECTION_KEYS, name);
  const pageInfo = exactDataMap(
    fields.get("pageInfo"),
    PAGE_INFO_KEYS,
    `${name}.pageInfo`,
  );
  const hasPreviousPage = boolean(
    pageInfo.get("hasPreviousPage"),
    `${name}.pageInfo.hasPreviousPage`,
  );
  const hasNextPage = boolean(
    pageInfo.get("hasNextPage"),
    `${name}.pageInfo.hasNextPage`,
  );
  return {
    nodes: dataArray(fields.get("nodes"), `${name}.nodes`, maximumEntries),
    truncated: hasPreviousPage || hasNextPage,
  };
}

function projectComment(value, name, maximumBodyBytes, keys = COMMENT_KEYS) {
  const fields = exactDataMap(value, keys, name);
  const body = truncateUtf8(fields.get("body"), maximumBodyBytes);
  return {
    id: displayText(fields.get("id"), `${name}.id`, 256),
    author: authorLogin(fields.get("author"), `${name}.author`),
    body: body.body,
    bodyTruncated: body.truncated,
    createdAt: requiredTimestamp(fields.get("createdAt"), `${name}.createdAt`),
    updatedAt: requiredTimestamp(fields.get("updatedAt"), `${name}.updatedAt`),
    url: optionalUrl(fields.get("url"), `${name}.url`),
  };
}

function projectReview(value, name, maximumBodyBytes) {
  const fields = exactDataMap(value, REVIEW_KEYS, name);
  const body = truncateUtf8(fields.get("body"), maximumBodyBytes);
  return {
    id: displayText(fields.get("id"), `${name}.id`, 256),
    author: authorLogin(fields.get("author"), `${name}.author`),
    state: enumOrUnknown(fields.get("state"), REVIEW_STATES),
    submittedAt: nullableTimestamp(
      fields.get("submittedAt"),
      `${name}.submittedAt`,
    ),
    commitOid: commitOid(fields.get("commit"), `${name}.commit`),
    body: body.body,
    bodyTruncated: body.truncated,
    url: optionalUrl(fields.get("url"), `${name}.url`),
  };
}

function projectThreadComment(value, name, maximumBodyBytes) {
  const fields = exactDataMap(value, THREAD_COMMENT_KEYS, name);
  const comment = projectComment(
    Object.fromEntries(COMMENT_KEYS.map((key) => [key, fields.get(key)])),
    name,
    maximumBodyBytes,
  );
  const reviewValue = fields.get("pullRequestReview");
  if (reviewValue === null) {
    return {
      ...comment,
      reviewId: "",
      reviewState: "UNKNOWN",
      reviewSubmittedAt: null,
      reviewCommitOid: "",
    };
  }
  const review = exactDataMap(
    reviewValue,
    ["id", "state", "submittedAt", "commit"],
    `${name}.pullRequestReview`,
  );
  return {
    ...comment,
    reviewId: displayText(review.get("id"), `${name}.reviewId`, 256),
    reviewState: enumOrUnknown(review.get("state"), REVIEW_STATES),
    reviewSubmittedAt: nullableTimestamp(
      review.get("submittedAt"),
      `${name}.reviewSubmittedAt`,
    ),
    reviewCommitOid: commitOid(review.get("commit"), `${name}.reviewCommit`),
  };
}

function projectThread(value, name, limits) {
  const fields = exactDataMap(value, THREAD_KEYS, name);
  const comments = connection(
    fields.get("comments"),
    `${name}.comments`,
    limits.threadComments,
  );
  return {
    id: displayText(fields.get("id"), `${name}.id`, 256),
    path: displayText(fields.get("path"), `${name}.path`, 4_096),
    line: nullableLine(fields.get("line"), `${name}.line`),
    originalLine: nullableLine(
      fields.get("originalLine"),
      `${name}.originalLine`,
    ),
    resolved: nullableBoolean(fields.get("isResolved"), `${name}.isResolved`),
    outdated: nullableBoolean(fields.get("isOutdated"), `${name}.isOutdated`),
    comments: comments.nodes.map((entry, index) =>
      projectThreadComment(
        entry,
        `${name}.comments.nodes[${index}]`,
        limits.bodyBytes,
      ),
    ),
    commentsTruncated: comments.truncated,
  };
}

function checkRequirement(value, name) {
  return boolean(value, `${name}.isRequired`) ? "required" : "optional";
}

function projectCheckRun(fields, name) {
  const checkName = displayText(fields.get("name"), `${name}.name`, 512);
  return {
    kind: "check_run",
    name: checkName,
    status: enumOrUnknown(fields.get("status"), CHECK_STATUSES),
    conclusion: enumOrUnknown(fields.get("conclusion"), CHECK_CONCLUSIONS, {
      empty: "NONE",
    }),
    url: safeCheckUrl(fields.get("detailsUrl"), `${name}.detailsUrl`),
    startedAt: nullableTimestamp(fields.get("startedAt"), `${name}.startedAt`),
    completedAt: nullableTimestamp(
      fields.get("completedAt"),
      `${name}.completedAt`,
    ),
    requirement: checkRequirement(fields.get("isRequired"), name),
  };
}

function statusContextLifecycle(state) {
  if (["PENDING", "EXPECTED"].includes(state)) return state;
  if (["SUCCESS", "FAILURE", "ERROR"].includes(state)) return "COMPLETED";
  return "UNKNOWN";
}

function statusContextConclusion(state) {
  if (["SUCCESS", "FAILURE", "ERROR"].includes(state)) return state;
  if (["PENDING", "EXPECTED"].includes(state)) return "NONE";
  return "UNKNOWN";
}

function projectStatusContext(fields, name) {
  const checkName = displayText(fields.get("context"), `${name}.context`, 512);
  const state = enumOrUnknown(
    fields.get("state"),
    new Set(["SUCCESS", "FAILURE", "ERROR", "PENDING", "EXPECTED"]),
  );
  return {
    kind: "status_context",
    name: checkName,
    status: statusContextLifecycle(state),
    conclusion: statusContextConclusion(state),
    url: safeCheckUrl(fields.get("targetUrl"), `${name}.targetUrl`),
    startedAt: nullableTimestamp(fields.get("createdAt"), `${name}.createdAt`),
    completedAt: null,
    requirement: checkRequirement(fields.get("isRequired"), name),
  };
}

function projectCheck(value, name) {
  const discriminator = dataMap(value, name).get("__typename");
  if (discriminator === "CheckRun") {
    return projectCheckRun(
      exactDataMap(value, CHECK_RUN_KEYS, name),
      name,
    );
  }
  if (discriminator === "StatusContext") {
    return projectStatusContext(
      exactDataMap(value, STATUS_CONTEXT_KEYS, name),
      name,
    );
  }
  throw invalid(`${name} has an unsupported type`);
}

function checkConnection(pullRequest, limits) {
  const commits = exactDataMap(
    pullRequest.get("commits"),
    ["nodes"],
    "pullRequest.commits",
  );
  const commitNodes = dataArray(
    commits.get("nodes"),
    "pullRequest.commits.nodes",
    1,
  );
  if (commitNodes.length === 0) {
    return { nodes: [], truncated: false };
  }
  const commitNode = exactDataMap(
    commitNodes[0],
    ["commit"],
    "pullRequest.commits.nodes[0]",
  );
  const commit = exactDataMap(
    commitNode.get("commit"),
    ["statusCheckRollup"],
    "pullRequest.commits.nodes[0].commit",
  );
  const rollupValue = commit.get("statusCheckRollup");
  if (rollupValue === null) return { nodes: [], truncated: false };
  const rollup = exactDataMap(
    rollupValue,
    ["contexts"],
    "pullRequest.statusCheckRollup",
  );
  return connection(
    rollup.get("contexts"),
    "pullRequest.statusCheckRollup.contexts",
    limits.checks,
  );
}

function pullRequestNode(response) {
  const responseFields = exactDataMap(response, ["data"], "GraphQL response");
  const data = exactDataMap(responseFields.get("data"), ["repository"], "data");
  const repository = exactDataMap(
    data.get("repository"),
    ["pullRequest"],
    "data.repository",
  );
  const pullRequest = repository.get("pullRequest");
  if (pullRequest === null) throw invalid("pull request was not found");
  return exactDataMap(pullRequest, GRAPH_PULL_REQUEST_KEYS, "pullRequest");
}

function targetFromFields(
  fields,
  { baseRepository, sourceAccountId },
  name,
  headRepositoryName,
) {
  if (!Number.isSafeInteger(fields.get("number")) || fields.get("number") < 1) {
    throw invalid(`${name}.number is invalid`);
  }
  try {
    return {
      number: fields.get("number"),
      url: optionalUrl(fields.get("url"), `${name}.url`),
      gitTarget: normalizePullRequestGitTarget({
        schemaVersion: 1,
        provider: "github",
        sourceAccountId,
        baseRepository,
        baseRefName: fields.get("baseRefName"),
        baseRefOid: fields.get("baseRefOid"),
        headRepository: headRepositoryName,
        headRefName: fields.get("headRefName"),
        headRefOid: fields.get("headRefOid"),
      }),
    };
  } catch {
    throw invalid(`${name} Git target is invalid`);
  }
}

export function githubGraphPullRequestTarget(response, identity) {
  const binding = identity.executionBinding;
  const fields = pullRequestNode(response);
  const headRepository = exactDataMap(
    fields.get("headRepository"),
    ["nameWithOwner"],
    "pullRequest.headRepository",
  );
  let currentTarget;
  try {
    currentTarget = githubCurrentPullRequestGitTarget(Object.fromEntries(fields), {
      baseRepository: binding.repository, sourceAccountId: binding.gitTarget.sourceAccountId,
    });
  } catch { throw invalid("pullRequest current Git target is invalid"); }
  fields.set("baseRefOid", currentTarget.baseRefOid);
  return targetFromFields(
    fields,
    {
      baseRepository: binding.repository,
      sourceAccountId: binding.gitTarget.sourceAccountId,
    },
    "pullRequest",
    headRepository.get("nameWithOwner"),
  );
}

function viewHeadRepositoryName(repositoryValue, ownerValue) {
  const headRepository = dataMap(
    repositoryValue,
    "PR target response.headRepository",
  );
  const headRepositoryOwner = dataMap(
    ownerValue,
    "PR target response.headRepositoryOwner",
  );
  if (
    !headRepository.has("id") ||
    !headRepository.has("name") ||
    [...headRepository.keys()].some(
      (key) => !VIEW_REPOSITORY_KEYS.includes(key),
    ) ||
    !headRepositoryOwner.has("login") ||
    [...headRepositoryOwner.keys()].some((key) => !VIEW_OWNER_KEYS.includes(key))
  ) {
    throw invalid("PR target response repository identity is invalid");
  }
  const repositoryName = headRepository.get("name");
  const ownerLogin = headRepositoryOwner.get("login");
  if (typeof repositoryName !== "string" || typeof ownerLogin !== "string") {
    throw invalid("PR target response repository identity is invalid");
  }
  const nameWithOwner = `${ownerLogin}/${repositoryName}`;
  const claimedNameWithOwner = headRepository.get("nameWithOwner");
  if (
    headRepository.has("nameWithOwner") &&
    (typeof claimedNameWithOwner !== "string" ||
      (claimedNameWithOwner.length > 0 &&
        claimedNameWithOwner.toLowerCase() !== nameWithOwner.toLowerCase()))
  ) {
    throw invalid("PR target response repository identity is contradictory");
  }
  return nameWithOwner;
}

export function githubViewPullRequestTarget(response, identity) {
  const fields = exactDataMap(response, VIEW_TARGET_KEYS, "PR target response");
  const binding = identity.executionBinding;
  const headRepositoryName = viewHeadRepositoryName(
    fields.get("headRepository"),
    fields.get("headRepositoryOwner"),
  );
  return targetFromFields(
    fields,
    {
      baseRepository: binding.repository,
      sourceAccountId: binding.gitTarget.sourceAccountId,
    },
    "PR target response",
    headRepositoryName,
  );
}

export function githubViewPullRequestTargetState(response, identity) {
  const fields = exactDataMap(
    response,
    VIEW_TARGET_STATE_KEYS,
    "PR target response",
  );
  const state = fields.get("state");
  if (typeof state !== "string" || !PULL_REQUEST_STATES.has(state)) {
    throw invalid("PR target response.state is invalid");
  }
  const binding = identity.executionBinding;
  const headRepositoryName = viewHeadRepositoryName(
    fields.get("headRepository"),
    fields.get("headRepositoryOwner"),
  );
  return {
    target: targetFromFields(
      fields,
      {
        baseRepository: binding.repository,
        sourceAccountId: binding.gitTarget.sourceAccountId,
      },
      "PR target response",
      headRepositoryName,
    ),
    state,
  };
}

function factInputBytes(value) {
  return Buffer.byteLength(JSON.stringify(value), "utf8") + 128;
}

function removeOldestThreadComment(input, predicate = () => true) {
  for (const thread of input.reviewThreads) {
    if (predicate(thread) && thread.comments.length > 0) {
      thread.comments.shift();
      thread.commentsTruncated = true;
      return true;
    }
  }
  return false;
}

function fitByteBudget(input, maximumBytes) {
  while (factInputBytes(input) > maximumBytes) {
    input.truncation.byteBudget = true;
    if (input.comments.length > 0) {
      input.comments.shift();
      input.truncation.comments = true;
      continue;
    }
    if (input.reviews.length > 0) {
      input.reviews.shift();
      input.truncation.reviews = true;
      continue;
    }
    if (
      removeOldestThreadComment(
        input,
        ({ resolved, outdated }) => resolved === true || outdated === true,
      )
    ) {
      continue;
    }
    const disposableThread = input.reviewThreads.findIndex(
      ({ resolved, outdated }) => resolved === true || outdated === true,
    );
    if (disposableThread >= 0) {
      input.reviewThreads.splice(disposableThread, 1);
      input.truncation.reviewThreads = true;
      continue;
    }
    if (removeOldestThreadComment(input)) continue;
    if (input.reviewThreads.length > 0) {
      input.reviewThreads.shift();
      input.truncation.reviewThreads = true;
      continue;
    }
    if (input.checks.length > 0) {
      input.checks.shift();
      input.truncation.checks = true;
      continue;
    }
    throw invalid("the pull request identity exceeds the read-fact byte budget");
  }
  return input;
}

export function projectGitHubPullRequestFacts({
  response,
  identity,
  observedAt,
  limits,
}) {
  const pullRequest = pullRequestNode(response);
  const comments = connection(
    pullRequest.get("comments"),
    "pullRequest.comments",
    limits.comments,
  );
  const reviews = connection(
    pullRequest.get("reviews"),
    "pullRequest.reviews",
    limits.reviews,
  );
  const threads = connection(
    pullRequest.get("reviewThreads"),
    "pullRequest.reviewThreads",
    limits.threads,
  );
  const checks = checkConnection(pullRequest, limits);
  const input = {
    identity,
    observedAt,
    reviewDecision: enumOrUnknown(
      pullRequest.get("reviewDecision"),
      REVIEW_DECISIONS,
      { empty: "NONE" },
    ),
    comments: comments.nodes.map((entry, index) =>
      projectComment(
        entry,
        `pullRequest.comments.nodes[${index}]`,
        limits.bodyBytes,
      ),
    ),
    reviews: reviews.nodes.map((entry, index) =>
      projectReview(
        entry,
        `pullRequest.reviews.nodes[${index}]`,
        limits.bodyBytes,
      ),
    ),
    reviewThreads: threads.nodes.map((entry, index) =>
      projectThread(
        entry,
        `pullRequest.reviewThreads.nodes[${index}]`,
        limits,
      ),
    ),
    checks: checks.nodes.map((entry, index) =>
      projectCheck(
        entry,
        `pullRequest.statusCheckRollup.contexts.nodes[${index}]`,
      ),
    ),
    truncation: {
      comments: comments.truncated,
      reviews: reviews.truncated,
      reviewThreads: threads.truncated,
      checks: checks.truncated,
      byteBudget: false,
    },
  };
  try {
    return createPullRequestReadFacts(fitByteBudget(input, limits.factBytes));
  } catch (error) {
    if (error instanceof GitHubPullRequestFactsError) throw error;
    throw invalid("projected pull request facts are invalid");
  }
}
