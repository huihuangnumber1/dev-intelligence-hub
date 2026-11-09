import { normalizePullRequestExecutionBinding } from "./pull-request-execution-binding.js";
import { normalizeChangePackageControlledCommitReceipt } from "./change-package-controlled-commit.js";

const OWNER_PUBLICATION_ID = /^owner-publication-[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/u;
const KEYS = ["schemaVersion", "kind", "publicationId", "observedAt", "actorAccountId", "jobId", "inputBinding", "controlledCommitReceipt"];
const LOGIN = /^[a-z0-9](?:[a-z0-9-]{0,37}[a-z0-9])?$/iu;
const JOB_ID = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/u;
const invalid = () => Object.assign(new Error("观察到的历史 owner 发布来源无效"), { code: "OWN_PR_REPAIR_PUBLICATION_PROVENANCE_INVALID" });

export const isOwnerPublicationId = (value) => typeof value === "string" && OWNER_PUBLICATION_ID.test(value);

export function normalizeObservedOwnerPublication(value, published) {
  if (!value || Object.getPrototypeOf(value) !== Object.prototype ||
      Reflect.ownKeys(value).length !== KEYS.length ||
      !KEYS.every((key) => Object.getOwnPropertyDescriptor(value, key)?.enumerable &&
        Object.hasOwn(Object.getOwnPropertyDescriptor(value, key), "value"))) throw invalid();
  const inputBinding = normalizePullRequestExecutionBinding(value.inputBinding);
  const receipt = normalizeChangePackageControlledCommitReceipt(value.controlledCommitReceipt);
  if (value.schemaVersion !== 1 || value.kind !== "observed_owner_publication" ||
      !isOwnerPublicationId(value.publicationId) || value.publicationId !== published.confirmationId ||
      typeof value.observedAt !== "string" || !Number.isFinite(Date.parse(value.observedAt)) ||
      new Date(value.observedAt).toISOString() !== value.observedAt ||
      typeof value.actorAccountId !== "string" || !LOGIN.test(value.actorAccountId) ||
      value.actorAccountId.toLowerCase() !== inputBinding.gitTarget.sourceAccountId.toLowerCase() ||
      typeof value.jobId !== "string" || !JOB_ID.test(value.jobId) ||
      inputBinding.repository !== published.repository || inputBinding.pullRequestNumber !== published.number ||
      receipt.commitOid !== published.commitOid) throw invalid();
  return structuredClone({ ...value, inputBinding, controlledCommitReceipt: receipt });
}
