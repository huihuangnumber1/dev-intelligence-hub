import {
  DEFAULT_ISSUE_ACTIVE_WINDOW_DAYS,
  prioritize,
} from "./prioritizer.js";
import { isPersonalPullRequest } from './pr-responsibility.js';

const DAY_MS = 86_400_000;

function group(items, predicate) {
  return items.filter(predicate);
}

function newestVersionsFirst(versions) {
  const timestamp = (version) => {
    const value =
      version.publishedAt ||
      version.updatedAt ||
      version.createdAt ||
      version.dueAt;
    const parsed = Date.parse(value || 0);
    return Number.isFinite(parsed) ? parsed : 0;
  };
  return [...versions].sort(
    (left, right) => timestamp(right) - timestamp(left),
  );
}

function newestUpdatedFirst(items) {
  return [...items].sort(
    (left, right) =>
      Date.parse(right.updatedAt || right.createdAt || 0) -
      Date.parse(left.updatedAt || left.createdAt || 0),
  );
}

function issueActiveWindowCutoff(refreshedAt, options) {
  const days = Number.isSafeInteger(options?.issueActiveWindowDays) &&
      options.issueActiveWindowDays > 0
    ? options.issueActiveWindowDays
    : DEFAULT_ISSUE_ACTIVE_WINDOW_DAYS;
  return Date.parse(refreshedAt) - days * DAY_MS;
}

function automaticWorkEligible(item, issueCutoff) {
  if (item.kind === "pull_request") return item.actionState !== "historical";
  if (item.kind !== "issue") return true;
  const updatedAt = Date.parse(item.updatedAt || item.createdAt || "");
  if (!Number.isFinite(updatedAt)) return true;
  return updatedAt > issueCutoff;
}

export function buildDashboard(snapshot, previousSnapshot = null, options = {}) {
  const issueCutoff = issueActiveWindowCutoff(snapshot.refreshedAt, options);
  const personalItems = snapshot.items.filter(item => item.kind !== 'pull_request' || isPersonalPullRequest(item));
  const prioritized = prioritize(personalItems, snapshot.refreshedAt, options)
    .map((item) => {
      const eligible = automaticWorkEligible(item, issueCutoff);
      return {
        ...item,
        automaticWorkEligible: eligible,
        manualAddRecommended:
          ["pull_request", "issue"].includes(item.kind) && !eligible,
      };
    });
  const completedIds = new Set(snapshot.items.map((item) => item.id));
  const recentlyCompleted = (previousSnapshot?.items || [])
    .filter(item => item.kind !== 'pull_request' || isPersonalPullRequest(item))
    .filter(item => item.kind !== 'pull_request' || ['closed', 'merged'].includes(item.state?.toLowerCase()))
    .filter((item) => !completedIds.has(item.id))
    .slice(0, 8);

  return {
    meta: {
      refreshedAt: snapshot.refreshedAt,
      durationMs: snapshot.durationMs,
      sources: snapshot.sources,
      errors: snapshot.errors,
      brain: snapshot.brain || {
        enabled: false,
        provider: "",
        model: "",
        assessed: 0,
        errors: [],
      },
    },
    focus: prioritized.filter((item) => item.score >= 80).slice(0, 7),
    groups: {
      actionNow: group(
        prioritized,
        (item) =>
          item.kind === "pull_request" && item.actionState === "action_now",
      ),
      waitingOther: group(
        prioritized,
        (item) =>
          item.kind === "pull_request" &&
          item.actionState === "waiting_other",
      ),
      uncertainPullRequests: group(
        prioritized,
        (item) =>
          item.kind === "pull_request" && item.actionState === "uncertain",
      ),
      historicalPullRequests: group(
        prioritized,
        (item) =>
          item.kind === "pull_request" && item.actionState === "historical",
      ),
      reviewRequested: group(
        prioritized,
        (item) =>
          item.kind === "pull_request" &&
          item.relation === "review_requested",
      ),
      myIssues: newestUpdatedFirst(
        group(
          prioritized,
          (item) => item.kind === "issue" && item.relation === "assigned",
        ),
      ),
      myPullRequests: group(
        prioritized,
        (item) =>
          item.kind === "pull_request" && item.relation === "authored",
      ),
      dingtalk: group(prioritized, (item) =>
        [
          "announcement",
          "message",
          "mention",
          "todo",
          "conversation",
          "mail",
        ].includes(item.kind),
      ),
      versions: newestVersionsFirst(snapshot.versions || []),
      recentlyCompleted,
    },
    counts: {
      total: prioritized.length,
      urgent: prioritized.filter((item) => item.score >= 90).length,
      actionNow: prioritized.filter(
        (item) =>
          item.kind === "pull_request" && item.actionState === "action_now",
      ).length,
      waitingOther: prioritized.filter(
        (item) =>
          item.kind === "pull_request" &&
          item.actionState === "waiting_other",
      ).length,
      uncertainPullRequests: prioritized.filter(
        (item) =>
          item.kind === "pull_request" && item.actionState === "uncertain",
      ).length,
      historicalPullRequests: prioritized.filter(
        (item) =>
          item.kind === "pull_request" && item.actionState === "historical",
      ).length,
      reviewRequested: prioritized.filter(
        (item) => item.relation === "review_requested",
      ).length,
      issues: prioritized.filter((item) => item.kind === "issue").length,
    },
  };
}
