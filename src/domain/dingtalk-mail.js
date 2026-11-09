import { createHash } from "node:crypto";

export function githubMailSource(body) {
  const text = String(body || "");
  const identity = text.match(/Message ID:\s*\\*<([\w.-]+\/[\w.-]+)\/(pull|issues)\/(\d+)\//iu);
  const links = [...text.matchAll(/https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/(?:pull|issues)\/\d+(?:[?#][^\s)<>]*)?/gu)]
    .map(([value]) => new URL(value));
  const threads = [...new Set(links.map((url) => url.pathname))];
  const path = identity ? `/${identity[1]}/${identity[2]}/${identity[3]}` : threads.length === 1 ? threads[0] : null;
  if (!path) return null;
  const [, owner, repo, , number] = path.split("/");
  const linked = links.find((url) => url.pathname === path && /^#(?:issuecomment|discussion_r|pullrequestreview)-\d+$/u.test(url.hash));
  const threadUrl = `https://github.com${path}`;
  return { repo: `${owner}/${repo}`, number: Number(number), url: threadUrl + (linked?.hash || ""), threadUrl };
}

export function cleanMailBody(body, github = false) {
  let text = String(body || "");
  if (github) text = text.split(/\n(?:---\s*\n)?Reply to this email directly,/u)[0];
  return text
    .replace(/!\[[^\]]*\]\([^\n)]*\)/gu, "")
    .replace(/\[([^\]]+)\]\(https?:\/\/[^\s)]+\)/gu, "$1")
    .replace(/https?:\/\/[^\s<>]+/gu, (value) => {
      try { const url = new URL(value); return `${url.origin}${url.pathname}`; }
      catch { return ""; }
    })
    .replace(/<[^>]*>/gu, " ")
    .replace(/&nbsp;/gu, " ")
    .replace(/&amp;/gu, "&")
    .trim();
}

export function mailItem(message, { mailbox, ownerLogin }) {
  const raw = message.markdownBody || "";
  const github = /(?:^|@)github\.com$/iu.test(message.from?.email || "");
  const source = github ? githubMailSource(raw) : null;
  const content = cleanMailBody(raw, github);
  const escaped = String(ownerLogin || "").replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  const currentText = content.split(/\n(?:On .+wrote:|在.+写道[：:])/u)[0];
  const mentioned = (escaped && new RegExp(`@${escaped}(?![\\w-])`, "iu").test(currentText)) ||
    (github && /You are receiving this because you were mentioned\./u.test(raw));
  const assigned = github && /You are receiving this because you (?:were|are) assigned\./u.test(raw);
  const authored = github && /You are receiving this because you authored the thread\./u.test(raw);
  const reviewRequested = github && /You are receiving this because your review was requested\./u.test(raw);
  const participated = github && /You are receiving this because you (?:commented|are participating)\./u.test(raw);
  const direct = (message.toRecipients || []).some((recipient) => recipient.email?.toLowerCase() === mailbox.toLowerCase());
  const relation = mentioned ? "mentioned" : assigned ? "assigned" : authored ? "authored" :
    reviewRequested ? "review_requested" : participated ? "participated" : github ? "followed" : direct ? "direct" : "copied";
  const thread = source?.threadUrl || message.conversationId || message.id;
  const key = createHash("sha256").update(`${mailbox}\0${thread}`).digest("hex").slice(0, 20);
  return {
    id: `dingtalk:mail:${key}:${message.id}`,
    kind: "mail", relation, currentUser: ownerLogin, mailProvider: github ? "github" : "mail",
    title: message.subject || "无主题邮件",
    content,
    author: message.from?.name || message.from?.email || "",
    context: `邮件 · ${message.subject || "无主题邮件"}`,
    conversationId: `mail:${key}`,
    updatedAt: message.receivedDateTime,
    url: source?.url || "",
    state: "open",
    bodyIncomplete: message.bodyHasMore === true || message.bodyHasMore === "true",
    ...(source ? { githubSource: { repo: source.repo, number: source.number },
      notificationOnly: /^(?:(?:Assigned|Unassigned) #\d+ (?:to|from) @[\w-]+\.?|(?:Closed|Merged|Reopened) (?:#\d+|this pull request)\.?|Approved this pull request\.?)$/iu.test(content) } : {}),
  };
}

export function mergeMailNotifications(items, githubItems) {
  const known = new Map(githubItems.map((item) => [`${item.repo?.toLowerCase()}#${item.number}`, item]));
  return items.flatMap((item) => {
    if (item.kind !== "mail") return [item];
    const match = item.githubSource && known.get(`${item.githubSource.repo.toLowerCase()}#${item.githubSource.number}`);
    if (item.notificationOnly && match) return [];
    if (item.mailProvider === "github" && item.relation === "followed") {
      const relation = ["authored", "assigned", "review_requested"].includes(match?.relation) ? match.relation :
        match && item.currentUser && match.author?.toLowerCase() === item.currentUser.toLowerCase() ? "authored" : null;
      return relation ? [{ ...item, relation }] : [];
    }
    return [item];
  });
}
