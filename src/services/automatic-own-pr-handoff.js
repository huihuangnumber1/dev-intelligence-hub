import { isDeepStrictEqual } from 'node:util';
import { automaticTestingOwner } from '../domain/automatic-review-policy.js';
import { currentWorkItemEvent, currentWorkItemExecutionBinding } from './work-ledger-pr-source.js';

const sameLogin = (a, b) => typeof a === 'string' && typeof b === 'string' && a.toLowerCase() === b.toLowerCase();

export class AutomaticOwnPrHandoff {
  #running = null;
  #afterId = null;
  #cursor = null;

  constructor({ store, configurationReader, ledger, github, assignee, roleStateReader,
    codeJobReader, bindingReader = { read: currentWorkItemExecutionBinding } }) {
    for (const [port, methods] of [[store, ['read']], [configurationReader, ['readActive']],
      [ledger, ['listItems', 'readItemForReconciliation', 'readPullRequestExecutionContext']],
      [github, ['readOwnPullRequestHandoff']], [assignee, ['assignAssignee']], [roleStateReader, ['read']],
      [codeJobReader, ['get']], [bindingReader, ['read']]]) {
      if (methods.some(method => typeof port?.[method] !== 'function')) throw new TypeError('Invalid own PR handoff port');
    }
    Object.assign(this, { store, configurationReader, ledger, github, assignee, roleStateReader, codeJobReader, bindingReader });
  }

  runCycle({ signal = null, limit = 2 } = {}) {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 20) throw new TypeError('Invalid handoff cycle limit');
    if (this.#running) return this.#running;
    const running = this.#run(signal, limit).finally(() => { if (this.#running === running) this.#running = null; });
    this.#running = running;
    return running;
  }

  async #completedWork() {
    try {
      return await this.ledger.listItems({ roleId: 'developer', status: 'completed', limit: 100,
        ...(this.#cursor ? { cursor: this.#cursor } : {}) });
    } catch (error) {
      if (!this.#cursor || error?.code !== 'WORK_LEDGER_CURSOR_INVALID') throw error;
      this.#cursor = null; this.#afterId = null;
      return this.ledger.listItems({ roleId: 'developer', status: 'completed', limit: 100 });
    }
  }

  async #verified(root, binding) {
    const decision = root.decisionContext;
    if (decision?.source !== 'proposal' || decision.outcome !== 'succeeded' ||
        decision.value?.kind !== 'code_action_proposal') return false;
    const evidence = decision.value.evidence;
    if (!Array.isArray(evidence)) return false;
    const jobs = evidence.filter(value => typeof value === 'string' && /^code-job:code-job-[a-f0-9]{55}$/.test(value));
    if (jobs.length !== 1 || !evidence.includes('code-job-status:completed')) return false;
    const job = await this.codeJobReader.get(jobs[0].slice(9));
    // The worker admits completed verify only after every grant profile passes.
    // Match the memory receipt consumed by the successful proposal settlement.
    return job?.operation === 'verify' && job.status === 'completed' && job.terminalResult?.kind === 'completed' &&
      job.requestedBy?.workItemId === root.itemId && job.requestedBy.roleId === 'developer' &&
      job.proposalId === decision.referenceId && isDeepStrictEqual(job.inputBinding, binding) &&
      typeof job.memoryProjection?.recordId === 'string' && evidence.includes(`memory:${job.memoryProjection.recordId}`);
  }

  async #run(signal, limit) {
    const result = { assigned: 0, already: 0, pending: 0 };
    signal?.throwIfAborted();
    const config = structuredClone((await this.configurationReader.readActive())?.configuration);
    if (config?.githubActions?.enabled !== true || config.githubActions.automaticOwnPrRepair !== true ||
        config.githubActions.assignAfterAutomaticReview === false) return result;
    const role = await this.roleStateReader?.read('pr-engineer');
    if (role?.enabled !== true || role.paused !== false) return result;
    const snapshot = await this.store.read('snapshot', null);
    if (snapshot?.sourceStatus?.githubPullRequests?.ok !== true) return result;
    const actor = config.githubActions.actorAccountId;
    const policy = config.workCoordination?.policy;
    const page = await this.#completedWork();
    const roots = page.items;
    const unique = new Map();
    for (const root of roots) {
      const event = currentWorkItemEvent(root);
      const item = snapshot.items.find(item => item.kind === 'pull_request' &&
        item.repo === event?.subject?.repository && item.number === event?.subject?.number);
      if (root.kind !== 'source_root' || root.source?.scope?.active !== true ||
          !item || item.state !== 'open' || item.relation !== 'authored' || !sameLogin(item.author, actor) ||
          !config.trackedRepositories.includes(item.repo) || item.headRefOid !== event.payload.headRefOid) continue;
      unique.set(`${item.repo}#${item.number}`, { root, item });
    }
    const candidates = [...unique.values()];
    const start = candidates.findIndex(c => c.root.itemId === this.#afterId) + 1;
    if (start + limit >= candidates.length) { this.#cursor = page.nextCursor; this.#afterId = null; }
    for (const { root, item } of [...candidates.slice(start), ...candidates.slice(0, start)].slice(0, limit)) {
      this.#afterId = root.itemId;
      try {
        signal?.throwIfAborted();
        const binding = this.bindingReader.read(root);
        if (!binding || !await this.#verified(root, binding)) continue;
        const context = await this.ledger.readPullRequestExecutionContext(binding);
        if (!isDeepStrictEqual(context.inputBinding, binding) || !sameLogin(context.author, actor)) continue;
        const facts = await this.github.readOwnPullRequestHandoff({ repository: item.repo, number: item.number, account: actor }, { signal });
        if (facts.state !== 'open' || facts.isDraft !== false || !sameLogin(facts.author, actor) ||
            facts.headRefOid !== item.headRefOid || !Array.isArray(facts.assignees) || !Array.isArray(facts.reviewDecisions)) continue;
        const reviewer = automaticTestingOwner(item, policy?.reviewOwnersByProduct);
        if (!reviewer) continue;
        const originalReviewer = facts.reviewDecisions.filter(r => r.state === 'CHANGES_REQUESTED' &&
          policy.reviewOwnersByProduct[reviewer.product]?.some(login => sameLogin(login, r.author)))
          .sort((a, b) => Date.parse(b.submittedAt) - Date.parse(a.submittedAt))[0]?.author;
        const humanApproved = facts.reviewDecision === 'APPROVED' && facts.reviewDecisions.some(r =>
          r.state === 'APPROVED' && r.reviewedHeadRefOid === item.headRefOid &&
          !sameLogin(r.author, actor) && policy.reviewOwnersByProduct[reviewer.product]?.some(login => sameLogin(login, r.author)));
        const destination = humanApproved ? automaticTestingOwner(item, policy.testingOwnersByProduct)?.login : originalReviewer || reviewer.login;
        if (!destination || sameLogin(destination, actor)) continue;
        const knownOwners = [actor, destination, ...(humanApproved ? policy.reviewOwnersByProduct[reviewer.product] : [])];
        if (facts.assignees.some(login => !knownOwners.some(owner => sameLogin(owner, login)))) continue;
        const expectedOwner = facts.assignees.find(login => sameLogin(login, actor)) ||
          facts.assignees.find(login => policy.reviewOwnersByProduct[reviewer.product]?.some(owner => sameLogin(owner, login)));
        const already = facts.assignees.length === 1 && sameLogin(facts.assignees[0], destination);
        if (!already && !expectedOwner) continue;
        const current = await this.ledger.readItemForReconciliation({ itemId: root.itemId });
        const latestConfig = (await this.configurationReader.readActive())?.configuration;
        if (current?.status !== 'completed' || current.source?.scope?.active !== true ||
            !isDeepStrictEqual(this.bindingReader.read(current), binding) ||
            !isDeepStrictEqual(current.decisionContext, root.decisionContext) || !isDeepStrictEqual(latestConfig, config)) continue;
        if (humanApproved) {
          const latestFacts = await this.github.readOwnPullRequestHandoff({ repository: item.repo, number: item.number, account: actor }, { signal });
          if (!isDeepStrictEqual(latestFacts, facts)) continue;
        }
        const activeRole = await this.roleStateReader.read('pr-engineer');
        if (activeRole?.enabled !== true || activeRole.paused !== false ||
            !isDeepStrictEqual((await this.configurationReader.readActive())?.configuration, config)) continue;
        signal?.throwIfAborted();
        if (!already) await this.assignee.assignAssignee({ actorAccountId: actor, repository: item.repo,
          pullRequestNumber: item.number, expectedHeadOid: item.headRefOid,
          expectedAssigneeLogin: expectedOwner, assigneeLogin: destination }, { signal });
        result[already ? 'already' : 'assigned'] += 1;
      } catch (error) {
        signal?.throwIfAborted();
        result.pending += 1;
        result.lastError = error?.code || 'OWN_PR_HANDOFF_UNAVAILABLE';
      }
    }
    return result;
  }
}
