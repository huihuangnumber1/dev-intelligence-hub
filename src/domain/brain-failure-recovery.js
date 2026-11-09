// Recovery authority is independent of owner-attention copy. These contexts
// intentionally differ: process exits are infrastructure for work items but
// pause controlled code jobs; session faults need role maintenance but can retry
// between code-job actions. Callers still own admission and reconciliation.
const RECOVERY_BY_CODE = new Map([
  ...["BRAIN_CREDENTIAL_UNAVAILABLE", "BRAIN_PROVIDER_NOT_CONFIGURED", "REMOTE_DATA_NOT_AUTHORIZED"].map(code => [
    code, { workItemInfrastructure: true, codeJobRetry: true, operatorPause: true },
  ]),
  ["ROLE_TASK_BRAIN_NOT_CONFIGURED", { workItemInfrastructure: true, codeJobRetry: true }],
  ...["STRUCTURED_PROVIDER_PROCESS_FAILED", "STRUCTURED_PROVIDER_PROCESS_EXITED"].map(code => [
    code, { workItemInfrastructure: true, requestInfrastructure: true },
  ]),
  ["STRUCTURED_PROVIDER_MODEL_CAPACITY", {
    workItemInfrastructure: true, codeJobRetry: true, requestInfrastructure: true, capacity: true,
  }],
  ...["STRUCTURED_PROVIDER_SESSION_RECOVERY_FAILED", "STRUCTURED_PROVIDER_CLEANUP_FAILED", "STRUCTURED_PROVIDER_REAP_FAILED"].map(code => [
    code, { workItemInfrastructure: true, codeJobRetry: true, maintenance: true },
  ]),
  ...["STRUCTURED_PROVIDER_UNAVAILABLE", "STRUCTURED_PROVIDER_CREDENTIAL_UNAVAILABLE"].map(code => [
    code, { workItemInfrastructure: true, codeJobRetry: true, requestInfrastructure: true },
  ]),
  ["STRUCTURED_PROVIDER_RESPONSE_INVALID", { codeJobRetry: true, modelFailure: true }],
  ...["STRUCTURED_PROVIDER_RESPONSE_TOO_LARGE", "STRUCTURED_PROVIDER_OUTPUT_LIMIT"].map(code => [
    code, { modelFailure: true },
  ]),
  ["STRUCTURED_PROVIDER_TIMEOUT", { requestInfrastructure: true }],
  ...["STRUCTURED_PROVIDER_BUSY", "STRUCTURED_PROVIDER_QUEUE_TIMEOUT"].map(code => [
    code, { requestInfrastructure: true, capacity: true },
  ]),
]);

export function isWorkItemBrainInfrastructureFailure(code) {
  return RECOVERY_BY_CODE.get(code)?.workItemInfrastructure === true;
}

export function isCodeJobBrainRetryableFailure(code) {
  return RECOVERY_BY_CODE.get(code)?.codeJobRetry === true;
}

export function requiresBrainMaintenance(code) {
  return RECOVERY_BY_CODE.get(code)?.maintenance === true;
}

export function requiresBrainOperatorPause(code) {
  return RECOVERY_BY_CODE.get(code)?.operatorPause === true ||
    (typeof code === "string" && code.startsWith("STRUCTURED_PROVIDER_"));
}

// Request failure knowledge does not grant fallback permission or work-item
// budget exemption. Those policies have different, explicit contracts above.
export function isBrainRequestInfrastructureFailure(code) {
  return RECOVERY_BY_CODE.get(code)?.requestInfrastructure === true;
}

export function isBrainCapacityFailure(code) {
  return RECOVERY_BY_CODE.get(code)?.capacity === true;
}

export function isBrainModelFailure(code) {
  return RECOVERY_BY_CODE.get(code)?.modelFailure === true;
}
