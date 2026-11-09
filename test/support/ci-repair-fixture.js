import { createCiRepairEvidence } from '../../src/domain/ci-repair-evidence.js';
import { createCiRepairCodeExecutionSource } from '../../src/domain/code-execution-source.js';

export function ciRepairSource(inputBinding, writablePaths, diagnostics = []) {
  return createCiRepairCodeExecutionSource({ inputBinding, writablePaths,
    ciEvidence: createCiRepairEvidence({ schemaVersion: 1, repository: inputBinding.repository,
      number: inputBinding.pullRequestNumber, headRefOid: inputBinding.headRefOid,
      headRefName: inputBinding.gitTarget.headRefName,
      checks: [{ kind: 'status_context', name: 'QuickTest', url: 'https://ci.example/job/QuickTest/12/', conclusion: 'FAILURE' }],
      diagnostics }) });
}
