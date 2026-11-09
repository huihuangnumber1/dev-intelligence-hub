import { types as utilTypes } from "node:util";
import { normalizePullRequestGitTarget } from "../domain/git-tool-contract.js";

// PullRequest.baseRefOid (and REST base.sha) can describe an older base snapshot.
// The Ref target is the current branch commit used by controlled development.
export const GITHUB_CURRENT_PULL_REQUEST_FIELDS = `
  number url state author { login } changedFiles mergedAt mergeCommit { oid } mergedBy { login }
  baseRefName baseRefOid
  baseRef { name repository { nameWithOwner } target { ... on Commit { oid } } }
  headRefName headRefOid
  headRef { name repository { nameWithOwner } target { ... on Commit { oid } } }
  headRepository { nameWithOwner }
`;
export const GITHUB_CURRENT_PULL_REQUEST_QUERY = `query MyDashboardCurrentPullRequestTarget($owner:String!,$name:String!,$number:Int!) {
  repository(owner:$owner,name:$name) { nameWithOwner pullRequest(number:$number) { ${GITHUB_CURRENT_PULL_REQUEST_FIELDS} } }
}`;

function invalid() {
  return Object.assign(new Error("GitHub current PR target is unavailable or invalid"), {
    code: "GITHUB_CURRENT_PR_TARGET_INVALID", statusCode: 502,
  });
}

function fields(value) {
  if (!value || typeof value !== "object" || utilTypes.isProxy(value) ||
      Object.getPrototypeOf(value) !== Object.prototype) throw invalid();
  const result = Object.create(null);
  for (const key of Reflect.ownKeys(value)) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (typeof key !== "string" || !descriptor?.enumerable || !("value" in descriptor)) throw invalid();
    result[key] = descriptor.value;
  }
  return result;
}

function liveRef(value, name, repository) {
  const ref = fields(value);
  const repo = fields(ref.repository);
  const target = fields(ref.target);
  if (ref.name !== name || typeof repo.nameWithOwner !== "string" ||
      repo.nameWithOwner.toLowerCase() !== repository.toLowerCase() ||
      typeof target.oid !== "string" || !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(target.oid)) throw invalid();
  return target.oid;
}

export function githubCurrentPullRequestGitTarget(value, { baseRepository, sourceAccountId, terminal = false }) {
  const pr = fields(value);
  if (terminal && !["CLOSED", "MERGED"].includes(pr.state)) throw invalid();
  const headRepository = fields(pr.headRepository).nameWithOwner;
  if (typeof headRepository !== "string") throw invalid();
  const baseRefOid = liveRef(pr.baseRef, pr.baseRefName, baseRepository);
  if (!terminal) {
    const liveHeadOid = liveRef(pr.headRef, pr.headRefName, headRepository);
    if (liveHeadOid !== pr.headRefOid) throw invalid();
  }
  try {
    return normalizePullRequestGitTarget({
      schemaVersion: 1, provider: "github", sourceAccountId, baseRepository,
      baseRefName: pr.baseRefName, baseRefOid,
      headRepository, headRefName: pr.headRefName, headRefOid: pr.headRefOid,
    });
  } catch { throw invalid(); }
}

export function projectGitHubCurrentPullRequestTarget(response, identity) {
  return projectCurrentPullRequestTarget(response, identity, false);
}

function projectCurrentPullRequestTarget(response, identity, discovery) {
  const root = fields(response);
  if (root.errors !== undefined) throw invalid();
  const repository = fields(fields(root.data).repository);
  if (typeof repository.nameWithOwner !== "string" ||
      repository.nameWithOwner.toLowerCase() !== identity.repository.toLowerCase()) throw invalid();
  const pr = fields(repository.pullRequest);
  const url = `https://github.com/${identity.repository}/pull/${identity.number}`;
  if (pr.number !== identity.number || typeof pr.url !== "string" ||
      pr.url.toLowerCase() !== url.toLowerCase() || !["OPEN", "CLOSED", "MERGED"].includes(pr.state)) throw invalid();
  if (typeof pr.headRefOid !== "string" || !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(pr.headRefOid)) throw invalid();
  const summary = { number: pr.number, url: pr.url, state: pr.state, headRefOid: pr.headRefOid,
    authorAccountId: pr.author === null ? "" : fields(pr.author).login, changedFiles: pr.changedFiles };
  // Terminal facts retire stale work even when GitHub has deleted its refs.
  // They deliberately carry no executable target or historical-base fallback.
  if (pr.state !== "OPEN") return Object.freeze({ ...summary, gitTarget: null });
  // A deleted branch can disable one discovered PR without hiding healthy PRs.
  // Executable single-target reads remain strict; malformed/missing fields fail.
  if (discovery && ["baseRef", "headRef", "headRepository"].every((key) => Object.hasOwn(pr, key)) &&
      (pr.baseRef === null || pr.headRef === null || pr.headRepository === null)) {
    if (pr.baseRef !== null && liveRef(pr.baseRef, pr.baseRefName, identity.repository).length !== pr.headRefOid.length) throw invalid();
    const headRepository = pr.headRepository === null ? null : fields(pr.headRepository).nameWithOwner;
    if (headRepository !== null) currentPullRequestTargetArgs({ repository: headRepository, number: pr.number });
    if (pr.headRef !== null) {
      const repository = headRepository ?? fields(fields(pr.headRef).repository).nameWithOwner;
      currentPullRequestTargetArgs({ repository, number: pr.number });
      if (liveRef(pr.headRef, pr.headRefName, repository) !== pr.headRefOid) throw invalid();
    }
    return Object.freeze({ ...summary, gitTarget: null });
  }
  if (discovery) {
    const headRepository = fields(pr.headRepository).nameWithOwner;
    if (typeof headRepository !== "string") throw invalid();
    const liveHeadOid = liveRef(pr.headRef, pr.headRefName, headRepository);
    if (liveHeadOid.length !== pr.headRefOid.length) throw invalid();
    if (liveHeadOid !== pr.headRefOid) {
      // A branch can advance before the PR's head snapshot catches up. Validate
      // every target field, but grant neither commit executable authority until
      // GitHub observes a coherent pair. Keep this search member in the batch.
      githubCurrentPullRequestGitTarget({ ...pr, headRefOid: liveHeadOid }, {
        baseRepository: identity.repository, sourceAccountId: identity.sourceAccountId,
      });
      return Object.freeze({ ...summary, gitTarget: null, gitTargetUnavailableReason: "HEAD_REF_CHANGED" });
    }
  }
  const gitTarget = githubCurrentPullRequestGitTarget(repository.pullRequest, {
    baseRepository: identity.repository, sourceAccountId: identity.sourceAccountId,
  });
  return Object.freeze({ ...summary, gitTarget });
}

export function currentPullRequestTargetArgs({ repository, number }) {
  if (typeof repository !== "string" || !/^[A-Za-z0-9-]{1,39}\/[A-Za-z0-9_.-]{1,100}$/.test(repository) ||
      !Number.isSafeInteger(number) || number < 1) throw invalid();
  const [owner, name] = repository.split("/");
  return ["api", "--hostname", "github.com", "graphql", "-f", `query=${GITHUB_CURRENT_PULL_REQUEST_QUERY}`,
    "-f", `owner=${owner}`, "-f", `name=${name}`, "-F", `number=${number}`];
}

export async function readGitHubCurrentPullRequestTarget(run, identity, options = {}) {
  return projectGitHubCurrentPullRequestTarget(await run("gh", currentPullRequestTargetArgs(identity), options), identity);
}

export function applyGitHubCurrentPullRequestTarget(detail, observation) {
  const target = observation.gitTarget;
  const head = detail.headRepository?.nameWithOwner ||
    (detail.headRepository?.name && detail.headRepositoryOwner?.login
      ? `${detail.headRepositoryOwner.login}/${detail.headRepository.name}` : "");
  if (detail.number !== observation.number || detail.url?.toLowerCase() !== observation.url.toLowerCase() ||
      detail.baseRefName !== target.baseRefName || detail.headRefName !== target.headRefName ||
      detail.headRefOid !== target.headRefOid || head.toLowerCase() !== target.headRepository.toLowerCase()) throw invalid();
  return { ...detail, baseRefOid: target.baseRefOid };
}

export function currentPullRequestTargetView(observation) {
  const git = observation.gitTarget;
  const [login, name] = git.headRepository.split("/");
  return { number: observation.number, url: observation.url, state: observation.state,
    baseRefName: git.baseRefName, baseRefOid: git.baseRefOid,
    headRefName: git.headRefName, headRefOid: git.headRefOid,
    headRepository: { id: "", name, nameWithOwner: git.headRepository }, headRepositoryOwner: { login } };
}

// One bounded batch per 25 PRs, with no process-wide cache of mutable refs.
export async function readGitHubCurrentPullRequestTargetBatch(run, identities, options = {}) {
  if (identities.length < 1 || identities.length > 25) throw invalid();
  const selections = identities.map((identity, index) => {
    currentPullRequestTargetArgs(identity);
    const [owner, name] = identity.repository.split("/");
    return `r${index}:repository(owner:${JSON.stringify(owner)},name:${JSON.stringify(name)}) { nameWithOwner pullRequest(number:${identity.number}) { ${GITHUB_CURRENT_PULL_REQUEST_FIELDS} } }`;
  });
  const response = fields(await run("gh", ["api", "--hostname", "github.com", "graphql", "-f",
    `query=query MyDashboardCurrentPullRequestTargets { ${selections.join("\n")} }`], options));
  if (response.errors !== undefined) throw invalid();
  const data = fields(response.data);
  if (Object.keys(data).length !== identities.length) throw invalid();
  return identities.map((identity, index) => projectCurrentPullRequestTarget({ data: { repository: data[`r${index}`] } }, identity, true));
}
