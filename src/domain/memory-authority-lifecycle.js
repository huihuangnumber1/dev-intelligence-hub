import { digestValue } from "./code-executor-contract.js";
import { normalizePullRequestExecutionBinding } from "./pull-request-execution-binding.js";

export function authorityLifecycleMemoryRecord(entry) {
  const binding = entry.binding;
  const authority = binding === null
    ? {
        applies: false,
        current: false,
        bindingDigest: null,
        inputBinding: null,
      }
    : { applies: true, current: false, bindingDigest: digestValue(normalizePullRequestExecutionBinding(binding)), inputBinding: binding };
  const content = {
    memoryType: entry.sourceKind,
    lifecycleOnly: true,
    priorRecordId: entry.recordId,
    reason: binding === null
      ? "projection_state_migrated"
      : "input_authority_superseded",
    authority,
  };
  const sourceKey = `${entry.key}:authority-obsolete:${digestValue({
    priorRecordId: entry.recordId,
    authority,
  })}`;
  return {
    schemaVersion: 1,
    source: {
      kind: entry.sourceKind,
      id: `${sourceKey}:${digestValue({
        sourceKind: entry.sourceKind,
        sourceKey,
        content,
      })}`,
    },
    occurredAt: entry.occurredAt,
    roleId: null,
    repository: binding?.repository ?? null,
    eventType: `${entry.sourceKind.replaceAll("-", "_")}.authority_obsolete`,
    title: `${entry.sourceKind} 权威已失效`,
    summary: binding === null
      ? "旧投影状态已安全失效"
      : `${binding.repository}#${binding.pullRequestNumber} · ${binding.headRefOid}`,
    content: JSON.stringify(content),
    evidence: [`supersedes:${entry.recordId}`],
    tags: [entry.sourceKind, "authority_obsolete", "obsolete"],
    sourceUrl: null,
    subjectNumber: binding?.pullRequestNumber ?? null,
  };
}
