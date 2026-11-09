import { canonicalJsonDigest } from "../lib/canonical-json-digest.js";
import { createReviewSourceFailure } from "../domain/review-source-failure.js";

const failure = cause => createReviewSourceFailure("PR_REVIEW_READ_REFERENCED_MATERIAL_UNAVAILABLE", cause);
const api = (endpoint, extra = []) => ["api", "--hostname", "github.com", endpoint, ...extra];
const text = value => { if (typeof value !== "string") throw new Error("Invalid referenced text"); return value; };
const instant = value => { if (typeof value !== "string" || !Number.isFinite(Date.parse(value))) throw new Error("Invalid source time"); return new Date(value).toISOString(); };
const identifier = value => { if (!Number.isSafeInteger(value) || value < 1) throw new Error("Invalid GitHub identity"); return String(value); };

function referencesIn(bodies, repository, number) {
  const groups = new Map();
  for (const body of bodies) {
    for (const match of text(body).replace(/```[\s\S]*?```/gu, "").matchAll(/https?:\/\/[^\s<>"`]+/gu)) {
      let url;
      try { url = new URL(match[0].replace(/[),.;，。；\]}]+$/gu, "")); } catch { continue; }
      if (url.protocol !== "https:" || url.hostname !== "github.com" || url.username || url.password || url.port) continue;
      const parts = /^\/([A-Za-z0-9-]{1,39})\/([A-Za-z0-9_.-]{1,100})\/(issues|pull)\/([1-9][0-9]*)\/?$/u.exec(url.pathname);
      if (!parts || !Number.isSafeInteger(Number(parts[4]))) continue;
      const repo = `${parts[1]}/${parts[2]}`, issue = Number(parts[4]);
      if (repo.toLowerCase() === repository.toLowerCase() && issue === number) continue;
      const key = `${repo.toLowerCase()}#${issue}`;
      if (!groups.has(key)) groups.set(key, { repository: repo, number: issue, urls: new Set() });
      url.search = ""; groups.get(key).urls.add(url.toString());
      if (groups.size > 20) throw new Error("Referenced material capacity exceeded");
    }
  }
  return [...groups.values()].sort((a, b) => `${a.repository}#${a.number}`.localeCompare(`${b.repository}#${b.number}`, "en"));
}

function resourceUrl(value, reference, hash = null) {
  const url = new URL(text(value));
  if (url.protocol !== "https:" || url.hostname !== "github.com" || url.port || url.search || url.username || url.password ||
      !["issues", "pull"].some(kind => url.pathname.toLowerCase() === `/${reference.repository}/${kind}/${reference.number}`.toLowerCase()) ||
      (hash !== null && url.hash !== hash)) throw new Error("Referenced material identity changed");
  return url.toString();
}

function comment(value, reference) {
  const id = identifier(value.id);
  const parent = new URL(text(value.issue_url));
  if (parent.protocol !== "https:" || parent.hostname !== "api.github.com" || parent.port || parent.username || parent.password ||
      parent.pathname.toLowerCase() !== `/repos/${reference.repository}/issues/${reference.number}`.toLowerCase() || parent.search || parent.hash) {
    throw new Error("Referenced comment parent changed");
  }
  return { id, nodeId: value.node_id ?? null, author: value.user?.login ?? null, body: text(value.body),
    createdAt: instant(value.created_at), updatedAt: instant(value.updated_at), url: resourceUrl(value.html_url, reference, `#issuecomment-${id}`) };
}

async function pagedComments(run, endpoint, options, consume, expectedCount = null) {
  const values = [];
  for (let page = 1; page <= 101; page++) {
    options.signal?.throwIfAborted();
    const entries = await run("gh", api(`${endpoint}?per_page=20&page=${page}`), options);
    if (!Array.isArray(entries) || entries.length > 20) throw new Error("Incomplete referenced comments");
    for (const value of entries) { consume(value); values.push(value); }
    if (values.length > 2000 || (expectedCount !== null && values.length > expectedCount)) throw new Error("Referenced comments changed during read");
    if (entries.length < 20) {
      if (expectedCount !== null && values.length !== expectedCount) throw new Error("Incomplete referenced comments");
      if (new Set(values.map(value => identifier(value.id))).size !== values.length) throw new Error("Duplicate referenced comments");
      return values;
    }
  }
  throw new Error("Referenced comment capacity exceeded");
}

function inlineComment(value, reference) {
  const id = identifier(value.id);
  const parent = new URL(text(value.pull_request_url));
  if (parent.protocol !== "https:" || parent.hostname !== "api.github.com" || parent.port || parent.username || parent.password || parent.search || parent.hash ||
      parent.pathname.toLowerCase() !== `/repos/${reference.repository}/pulls/${reference.number}`.toLowerCase()) throw new Error("Referenced inline comment parent changed");
  return { id, nodeId: value.node_id ?? null, reviewId: identifier(value.pull_request_review_id),
    replyToId: value.in_reply_to_id == null ? null : identifier(value.in_reply_to_id), author: value.user?.login ?? null,
    body: text(value.body), createdAt: instant(value.created_at), updatedAt: instant(value.updated_at),
    commitOid: value.commit_id ?? null, path: value.path ?? null, url: resourceUrl(value.html_url, reference, `#discussion_r${id}`) };
}

function selectedThreads(comments, { reviewId = null, commentId = null }) {
  const byId = new Map(comments.map(value => [value.id, value]));
  if (commentId !== null && !byId.has(commentId)) throw new Error("Referenced inline comment is missing");
  const rootFor = value => {
    const seen = new Set();
    while (value.replyToId !== null) {
      if (seen.has(value.id) || !byId.has(value.replyToId)) throw new Error("Incomplete referenced thread");
      seen.add(value.id); value = byId.get(value.replyToId);
    }
    return value.id;
  };
  const roots = new Map(comments.map(value => [value.id, rootFor(value)]));
  const selected = new Set(comments.filter(value => commentId === null ? value.reviewId === reviewId : value.id === commentId).map(value => roots.get(value.id)));
  return comments.filter(value => selected.has(roots.get(value.id)));
}

async function readResource(run, reference, options, consume) {
  const endpoint = `repos/${reference.repository}/issues/${reference.number}`;
  const issue = await run("gh", api(endpoint), options);
  if (issue.number !== reference.number || !Number.isSafeInteger(issue.comments) || issue.comments < 0 || issue.comments > 2000) throw new Error("Incomplete referenced resource");
  consume(issue);
  const comments = (await pagedComments(run, `${endpoint}/comments`, options, consume, issue.comments)).map(value => comment(value, reference));
  const anchors = [];
  let inlineComments = null;
  for (const address of reference.urls) {
    const hash = new URL(address).hash;
    const issueComment = /^#issuecomment-([1-9][0-9]*)$/u.exec(hash);
    if (issueComment) {
      if (!comments.some(value => value.id === issueComment[1])) throw new Error("Referenced comment is missing");
      continue;
    }
    const review = /^#pullrequestreview-([1-9][0-9]*)$/u.exec(hash);
    const inline = /^#discussion_r([1-9][0-9]*)$/u.exec(hash);
    if (!review && !inline) continue;
    const id = (review ?? inline)[1];
    inlineComments ??= (await pagedComments(run, `repos/${reference.repository}/pulls/${reference.number}/comments`, options, consume)).map(value => inlineComment(value, reference));
    if (inline) {
      anchors.push({ id, kind: "inline_thread", comments: selectedThreads(inlineComments, { commentId: id }) });
      continue;
    }
    const item = await run("gh", api(`repos/${reference.repository}/pulls/${reference.number}/reviews/${id}`), options);
    consume(item);
    if (identifier(item.id) !== id) throw new Error("Referenced review identity changed");
    anchors.push({ id, nodeId: item.node_id ?? null, kind: "review", author: item.user?.login ?? null,
      body: text(item.body), state: item.state ?? null, commitOid: item.commit_id ?? null,
      createdAt: instant(item.submitted_at ?? item.created_at), updatedAt: item.updated_at ? instant(item.updated_at) : null,
      url: resourceUrl(item.html_url, reference, hash), comments: selectedThreads(inlineComments, { reviewId: id }) });
  }
  return { schemaVersion: 1, sourceUrls: [...reference.urls].sort(),
    scope: "Referenced issue body and issue comments, plus complete threads for explicit Review/inline anchors. Code diffs, other Reviews and attachment URLs are references unless separately read.",
    issue: { repository: reference.repository, number: reference.number, title: text(issue.title), body: issue.body === null ? "" : text(issue.body),
      author: issue.user?.login ?? null, state: text(issue.state), createdAt: instant(issue.created_at), updatedAt: instant(issue.updated_at),
      url: resourceUrl(issue.html_url, reference) }, comments, anchors };
}

// One level of explicitly linked GitHub discussions only. Linked bodies are
// untrusted evidence and never expand the tool's command or write authority.
export async function readGitHubReferencedMaterials({ run, repository, pullRequestNumber, bodies, options = {} } = {}) {
  try {
    if (typeof run !== "function" || typeof repository !== "string" || !Array.isArray(bodies)) throw new Error("Invalid reference reader");
    const references = [], documents = {};
    let totalBytes = 0, downloadedBytes = 0;
    const consume = value => {
      downloadedBytes += Buffer.byteLength(JSON.stringify(value));
      if (downloadedBytes > 4 * 1024 * 1024) throw new Error("Referenced material capacity exceeded");
    };
    for (const reference of referencesIn(bodies, repository, pullRequestNumber)) {
      options.signal?.throwIfAborted();
      const snapshot = await readResource(run, reference, options, consume);
      options.signal?.throwIfAborted();
      const document = `linked-material-${String(references.length + 1).padStart(3, "0")}.json`;
      const contents = JSON.stringify(snapshot, null, 2);
      totalBytes += Buffer.byteLength(contents);
      if (totalBytes > 4 * 1024 * 1024) throw new Error("Referenced material capacity exceeded");
      documents[document] = contents;
      references.push({ repository: reference.repository, number: reference.number, sourceUrls: [...reference.urls].sort(),
        document, contentDigest: canonicalJsonDigest(snapshot) });
    }
    return { documents, references, digest: canonicalJsonDigest(references) };
  } catch (cause) {
    options.signal?.throwIfAborted();
    throw failure(cause);
  }
}
