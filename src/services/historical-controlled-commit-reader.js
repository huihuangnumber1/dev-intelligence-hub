import { isDeepStrictEqual } from "node:util";
import { normalizePullRequestExecutionBinding, samePullRequestExecutionBinding } from "../domain/pull-request-execution-binding.js";
import { normalizeControlledCommitEvidence } from "../domain/controlled-commit-evidence.js";
import { createChangePackageControlledCommitReceipt, sameChangePackageControlledCommitReceipt } from "../domain/change-package-controlled-commit.js";
import { CHANGE_PACKAGE_CONTROLLED_COMMIT_STATE_KEY, normalizeControlledCommitDeliveryPersistedState } from "./change-package-controlled-commit-service.js";

const JOB_ID = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/u;
const OID = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u;
const failure = (code, message) => Object.assign(new Error(message), { code });

// This port observes already committed local deliveries. It never creates,
// repairs, publishes or advances a delivery record.
export class HistoricalControlledCommitReader {
  constructor({ store, controlledCommitReader }) {
    if (typeof store?.read !== "function" || typeof controlledCommitReader?.verify !== "function") {
      throw new TypeError("Historical controlled commit reader requires read and verify ports");
    }
    this.store = store;
    this.controlledCommitReader = controlledCommitReader;
  }

  async findCommitted({ inputBinding: value, jobId, commitOid }) {
    const inputBinding = normalizePullRequestExecutionBinding(value);
    if (!JOB_ID.test(jobId) || !OID.test(commitOid)) throw new TypeError("Historical controlled commit lookup is invalid");
    const state = normalizeControlledCommitDeliveryPersistedState(await this.store.read(
      CHANGE_PACKAGE_CONTROLLED_COMMIT_STATE_KEY, { schemaVersion: 1, revision: 0, deliveries: [] },
    ));
    const candidates = state.deliveries.filter((row) => row.status === "committed" &&
      row.receipt.commitOid === commitOid && row.request.executionSource.kind === "review_repair" &&
      samePullRequestExecutionBinding(row.request.executionSource.inputBinding, inputBinding));
    if (candidates.length === 0) return null;
    if (candidates.length !== 1) throw failure("OWN_PR_REPAIR_COMMIT_AMBIGUOUS", "历史受控修复提交来源存在歧义");
    const record = candidates[0];
    const evidence = normalizeControlledCommitEvidence(await this.controlledCommitReader.verify({ evidenceId: record.evidenceId }));
    const expected = createChangePackageControlledCommitReceipt(record.request, evidence);
    if (evidence.package.job.id !== jobId || evidence.commit.oid !== commitOid ||
        !isDeepStrictEqual(evidence.executionSource, record.request.executionSource) ||
        !sameChangePackageControlledCommitReceipt(expected, record.receipt)) {
      throw failure("OWN_PR_REPAIR_COMMIT_INVALID", "历史受控修复提交与 delivery 回执不匹配");
    }
    return structuredClone({ request: record.request, receipt: record.receipt, evidence });
  }
}
