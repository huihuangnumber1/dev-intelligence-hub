import { types as utilTypes } from "node:util";
import {
  CODE_JOB_ACTIONS_BY_OPERATION,
  CODE_JOB_LEGACY_BRAIN_BINDING_SCHEMA,
  CODE_JOB_TASK_BRAIN_BINDING_SCHEMA,
  createCodeJobGrant,
  normalizeCodeJobGrant,
} from "../domain/code-job-contract.js";
import { digestValue } from "../domain/code-executor-contract.js";
import {
  codeExecutionSourceWritablePaths,
  isHeadRepairExecutionSource,
  normalizeCodeExecutionSource,
  sameCodeExecutionSource,
} from "../domain/code-execution-source.js";
import {
  CodeExecutionPolicy,
  normalizeWorkspacePath,
} from "../domain/code-execution-policy.js";
import {
  sameConflictPreparationBinding,
} from "../domain/conflict-preparation-binding.js";
import {
  assertWorkProposalAuthorityBinding,
  assertWorkProposalExactKeys,
  normalizeBoundWorkProposal,
  normalizeWorkProposalDigest,
  workProposalArrayValues,
  workProposalDataEntries,
  workProposalError,
} from "../domain/work-proposal-contract.js";
import { normalizeBrainConfig } from "./brain-router.js";

const OPERATIONS = Object.freeze(["inspect", "modify", "verify"]);
const OPERATION_SET = new Set(OPERATIONS);
const SAFE_ROLE_ID = /^[a-z0-9](?:[a-z0-9-]{0,126}[a-z0-9])?$/;
const SAFE_WORKSPACE_ID = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/;
const SAFE_REPOSITORY = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const SHA256 = /^[a-f0-9]{64}$/;
const GIT_OID = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/;
const EXECUTOR_CAPABILITIES = new Set([
  "directory_snapshot",
  "git_head_snapshot",
  "conflict_preparation_snapshot",
]);
const PREPARED_CODE_JOB_GRANTS = new WeakSet();
const INPUT_STORAGE_UNAVAILABLE = new Set([
  "EACCES", "EPERM", "EBUSY", "EIO", "ENOSPC", "EMFILE", "ENFILE",
]);

function invalid(message = "代码任务授权配置无效") {
  return workProposalError("INVALID_CODE_JOB_AUTHORITY", message);
}

function verifierErrorCodes(error) {
  try {
    const codes = [], seen = new Set();
    for (let current = error; current !== undefined;) {
      if (!current || utilTypes.isProxy(current) || !(current instanceof Error) || seen.has(current) || codes.length >= 16) return null;
      seen.add(current);
      const code = Object.getOwnPropertyDescriptor(current, "code");
      const cause = Object.getOwnPropertyDescriptor(current, "cause");
      if ((code && !("value" in code)) || (cause && !("value" in cause)) ||
          (!code && "code" in current) || (!cause && "cause" in current)) return null;
      codes.push(code?.value ?? null);
      current = cause?.value;
    }
    return codes;
  } catch {
    return null;
  }
}

function verifierFailure(error, kind, message) {
  const codes = verifierErrorCodes(error);
  if (codes === null || codes.includes("PROCESS_STOP_FAILED")) return invalid(message);
  let unavailable = false;
  if (kind === "input") {
    // These are errors from the configured trusted input port, never evidence
    // that the current Head or assignment was revoked.
    unavailable = codes[0] === "OWNER_REVIEW_ASSIGNMENT_UNAVAILABLE" ||
      (codes.length === 1 && (codes[0] === "WORK_LEDGER_NOT_READY" || INPUT_STORAGE_UNAVAILABLE.has(codes[0])));
  } else {
    // The broad preflight wrapper also contains security failures. Accept only
    // the exact managed-process path whose timeout/abort confirms a safe stop.
    unavailable = (codes[0] === "CONTROLLED_GIT_TIMEOUT" && codes.slice(1).every(code => code === null)) ||
      (codes.length === 3 && codes[0] === "CONTROLLED_GIT_PREFLIGHT_FAILED" && codes[1] === "GIT_MIRROR_PREFLIGHT_FAILED" &&
        ["PROCESS_TIMEOUT", "PROCESS_ABORTED"].includes(codes[2]));
  }
  return unavailable
    ? workProposalError("CODE_JOB_AUTHORITY_VERIFICATION_UNAVAILABLE", "代码任务授权暂时无法核验，请稍后重试", 503, { cause: error })
    : invalid(message);
}

function taskBrainNotConfigured(roleId) {
  return workProposalError(
    "CODE_TASK_BRAIN_NOT_CONFIGURED",
    `岗位 ${roleId} 尚未配置任务大脑`,
  );
}

function freezePreparedGrant(value) {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) freezePreparedGrant(child);
    Object.freeze(value);
  }
  return value;
}

export function prepareCodeJobGrantVerification(value) {
  let grant;
  try {
    grant = normalizeCodeJobGrant(value);
  } catch {
    throw invalid("代码任务授权封印无效");
  }
  freezePreparedGrant(grant);
  PREPARED_CODE_JOB_GRANTS.add(grant);
  return grant;
}

function plainRecord(value, name) {
  const entries = workProposalDataEntries(value, invalid(`${name} 无效`));
  return Object.fromEntries(entries);
}

function exactRecord(value, keys, name) {
  assertWorkProposalExactKeys(value, keys, invalid(`${name} 无效`));
  return value;
}

function safeRoleId(value, name) {
  if (typeof value !== "string" || !SAFE_ROLE_ID.test(value)) {
    throw invalid(`${name} 无效`);
  }
  return value;
}

function safeWorkspaceId(value, name) {
  if (typeof value !== "string" || !SAFE_WORKSPACE_ID.test(value)) {
    throw invalid(`${name} 无效`);
  }
  return value;
}

function sha256(value, name) {
  if (typeof value !== "string" || !SHA256.test(value)) {
    throw invalid(`${name} 无效`);
  }
  return value;
}

function positiveInteger(value, name) {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw invalid(`${name} 无效`);
  }
  return value;
}

function normalizeWorkspaceBindings(value) {
  const result = new Map();
  for (const [repository, workspaceIdValue] of workProposalDataEntries(
    value,
    invalid("workspaceByRepository 无效"),
  )) {
    if (!SAFE_REPOSITORY.test(repository) || result.has(repository)) {
      throw invalid("workspaceByRepository.repository 无效");
    }
    result.set(
      repository,
      safeWorkspaceId(workspaceIdValue, "workspaceByRepository.workspaceId"),
    );
  }
  return result;
}

function normalizeStringArray(value, maximum, name, { minimum = 0 } = {}) {
  const entries = workProposalArrayValues(value, maximum, invalid(`${name} 无效`));
  if (
    entries.length < minimum ||
    entries.some((entry) => typeof entry !== "string") ||
    new Set(entries).size !== entries.length
  ) {
    throw invalid(`${name} 无效`);
  }
  return [...entries];
}

function normalizeAuthority(value) {
  exactRecord(value, ["workspaces"], "executorAuthority");
  const workspaces = workProposalArrayValues(
    value.workspaces,
    64,
    invalid("executorAuthority.workspaces 无效"),
  );
  if (workspaces.length === 0) {
    throw invalid("executorAuthority.workspaces 不能为空");
  }
  const result = new Map();
  for (const workspaceValue of workspaces) {
    const hasCapabilities = Object.hasOwn(workspaceValue, "capabilities");
    const hasExcludePaths = Object.hasOwn(workspaceValue, "excludePaths");
    const workspace = exactRecord(
      workspaceValue,
      [
        "id",
        "writablePaths",
        ...(hasExcludePaths ? ["excludePaths"] : []),
        "requiredProfiles",
        "authorityDigest",
        ...(hasCapabilities ? ["capabilities"] : []),
      ],
      "executorAuthority.workspace",
    );
    const id = safeWorkspaceId(workspace.id, "executorAuthority.workspace.id");
    if (result.has(id)) throw invalid("executorAuthority.workspace 重复");
    const writablePaths = normalizeStringArray(
      workspace.writablePaths,
      64,
      "executorAuthority.workspace.writablePaths",
    ).map((entry) => {
      try {
        return normalizeWorkspacePath(entry);
      } catch {
        throw invalid("executorAuthority.workspace.writablePaths 无效");
      }
    });
    if (new Set(writablePaths).size !== writablePaths.length) {
      throw invalid("executorAuthority.workspace.writablePaths 重复");
    }
    const excludePaths = hasExcludePaths
      ? normalizeStringArray(
          workspace.excludePaths,
          64,
          "executorAuthority.workspace.excludePaths",
        ).map((entry) => {
          try {
            return normalizeWorkspacePath(entry);
          } catch {
            throw invalid("executorAuthority.workspace.excludePaths 无效");
          }
        })
      : [];
    if (new Set(excludePaths).size !== excludePaths.length) {
      throw invalid("executorAuthority.workspace.excludePaths 重复");
    }
    const requiredProfiles = workProposalArrayValues(
      workspace.requiredProfiles,
      32,
      invalid("executorAuthority.workspace.requiredProfiles 无效"),
    ).map((profile) => {
      exactRecord(
        profile,
        ["id", "configDigest"],
        "executorAuthority.workspace.requiredProfile",
      );
      return {
        id: safeWorkspaceId(
          profile.id,
          "executorAuthority.workspace.requiredProfile.id",
        ),
        configDigest: sha256(
          profile.configDigest,
          "executorAuthority.workspace.requiredProfile.configDigest",
        ),
      };
    });
    if (requiredProfiles.length === 0) {
      throw invalid("executorAuthority.workspace.requiredProfiles 不能为空");
    }
    if (new Set(requiredProfiles.map(({ id: profileId }) => profileId)).size !== requiredProfiles.length) {
      throw invalid("executorAuthority.workspace.requiredProfiles 重复");
    }
    const capabilities = hasCapabilities
      ? normalizeStringArray(
          workspace.capabilities,
          EXECUTOR_CAPABILITIES.size,
          "executorAuthority.workspace.capabilities",
        ).sort()
      : [];
    if (capabilities.some((capability) => !EXECUTOR_CAPABILITIES.has(capability))) {
      throw invalid("executorAuthority.workspace.capabilities 无效");
    }
    result.set(id, {
      id,
      writablePaths,
      excludePaths,
      requiredProfiles,
      capabilities,
      authorityDigest: sha256(
        workspace.authorityDigest,
        "executorAuthority.workspace.authorityDigest",
      ),
    });
  }
  return result;
}

function normalizeOperationsByRole(value) {
  const result = new Map();
  for (const [roleIdValue, rawOperations] of workProposalDataEntries(
    value,
    invalid("codeOperationsByRole 无效"),
  )) {
    const roleId = safeRoleId(roleIdValue, "codeOperationsByRole.roleId");
    const operations = normalizeStringArray(
      rawOperations,
      OPERATIONS.length,
      "codeOperationsByRole.operations",
      { minimum: 1 },
    );
    if (operations.some((operation) => !OPERATION_SET.has(operation))) {
      throw invalid("codeOperationsByRole.operations 无效");
    }
    result.set(roleId, operations.sort());
  }
  if (result.size === 0) throw invalid("codeOperationsByRole 不能为空");
  return result;
}

function normalizeCodeActionRoles(value) {
  return new Set(
    normalizeStringArray(value, 100, "codeActionRoles", { minimum: 1 }).map(
      (roleId) => safeRoleId(roleId, "codeActionRoles.roleId"),
    ),
  );
}

function authorizedOperations(value, authorizedRoles) {
  const result = new Map(
    [...value.entries()].filter(([roleId]) => authorizedRoles.has(roleId)),
  );
  if (result.size === 0) {
    throw invalid("codeActionRoles 与 codeOperationsByRole 没有交集");
  }
  return result;
}

export function codeJobBrainDigest({
  roleId: roleIdValue,
  taskBrain: rawBrain,
  brainProviders,
} = {}) {
  return codeJobBrainBindingDigests({
    roleId: roleIdValue,
    brain: rawBrain,
    brainProviders,
    brainBindingSchema: CODE_JOB_TASK_BRAIN_BINDING_SCHEMA,
  })[0];
}

export function legacyCodeJobBrainDigest({
  roleId: roleIdValue,
  brain: rawBrain,
  brainProviders,
} = {}) {
  return codeJobBrainBindingDigests({
    roleId: roleIdValue,
    brain: rawBrain,
    brainProviders,
    brainBindingSchema: CODE_JOB_LEGACY_BRAIN_BINDING_SCHEMA,
  })[0];
}

export function codeJobBrainBindingDigests({
  roleId: roleIdValue,
  brain: rawBrain,
  brainProviders,
  brainBindingSchema,
}) {
  if (![CODE_JOB_LEGACY_BRAIN_BINDING_SCHEMA, CODE_JOB_TASK_BRAIN_BINDING_SCHEMA].includes(brainBindingSchema)) {
    throw invalid("代码任务大脑绑定版本无效");
  }
  const schemaVersion = brainBindingSchema;
  const binding = schemaVersion === CODE_JOB_TASK_BRAIN_BINDING_SCHEMA ? "taskBrain" : "brain";
  const roleId = safeRoleId(roleIdValue, "roleId");
  const providers = plainRecord(brainProviders, "brainProviders");
  let brain;
  try {
    brain = normalizeBrainConfig(rawBrain);
  } catch (cause) {
    throw invalid(`岗位 ${roleId} 的大脑配置无效`, { cause });
  }
  if (!Object.hasOwn(providers, brain.provider)) {
    throw invalid(`岗位 ${roleId} 的大脑提供方未配置`);
  }
  const provider = plainRecord(
    providers[brain.provider],
    `brainProviders.${brain.provider}`,
  );
  const digests = [digestValue({ schemaVersion, roleId, [binding]: brain, provider })];
  // Adding a default-denied data class must not revoke grants serialized before
  // that class existed. Keep the current digest for new grants and accept only
  // the equivalent missing-false encoding; explicit permission changes stay bound.
  if (brain.remoteData.dingtalk === false) {
    const { dingtalk, ...remoteData } = brain.remoteData;
    digests.push(digestValue({ schemaVersion, roleId, [binding]: { ...brain, remoteData }, provider }));
  }
  return Object.freeze(digests);
}

function normalizeBrainDigests({
  brainByRoleValue,
  providersValue,
  roleIds,
  legacy,
}) {
  const fieldName = legacy ? "legacyBrainByRole" : "taskBrainByRole";
  const brainByRole = plainRecord(brainByRoleValue, fieldName);
  const providers = plainRecord(providersValue, "brainProviders");
  const result = new Map();
  for (const roleId of roleIds) {
    if (
      !Object.hasOwn(brainByRole, roleId) ||
      brainByRole[roleId] === null ||
      brainByRole[roleId] === undefined
    ) {
      if (legacy) throw invalid(`岗位 ${roleId} 缺少历史大脑配置`);
      continue;
    }
    result.set(
      roleId,
      codeJobBrainBindingDigests({ roleId, brain: brainByRole[roleId], brainProviders: providers,
        brainBindingSchema: legacy ? CODE_JOB_LEGACY_BRAIN_BINDING_SCHEMA : CODE_JOB_TASK_BRAIN_BINDING_SCHEMA }),
    );
  }
  return result;
}

function normalizeStoredProposal(value) {
  exactRecord(
    value,
    [
      "proposalId",
      "contentDigest",
      "policyVersion",
      "kind",
      "requestedBy",
      "source",
      "binding",
      "payload",
    ],
    "proposal",
  );
  const proposal = normalizeBoundWorkProposal({
    proposalId: value.proposalId,
    policyVersion: value.policyVersion,
    kind: value.kind,
    requestedBy: value.requestedBy,
    source: value.source,
    binding: value.binding,
    payload: value.payload,
  });
  if (
    proposal.kind !== "code_action_proposal" ||
    normalizeWorkProposalDigest(value.contentDigest, invalid()) !==
      proposal.contentDigest
  ) {
    throw invalid("代码工作提案绑定无效");
  }
  const binding = exactRecord(
    proposal.binding,
    [
      "eventId",
      "subject",
      "repository",
      "workspaceId",
      "inputBinding",
      ...(Object.hasOwn(proposal.binding, "executionSource")
        ? ["executionSource"]
        : []),
      ...(Object.hasOwn(proposal.binding, "evidenceTarget")
        ? ["evidenceTarget"]
        : []),
      ...(Object.hasOwn(proposal.binding, "dispatchIntentId")
        ? ["dispatchIntentId"]
        : []),
    ],
    "proposal.binding",
  );
  assertWorkProposalAuthorityBinding(
    proposal,
    binding,
    invalid("proposal.binding 权威信息无效"),
  );
  exactRecord(
    proposal.payload,
    [
      "operation",
      "objective",
      "acceptanceCriteria",
      "evidence",
      "summary",
      "reason",
    ],
    "proposal.payload",
  );
  assertExecutionInputKind(proposal.binding);
  if (!Object.hasOwn(proposal.binding, "executionSource")) return proposal;
  if (proposal.payload.operation !== "modify") {
    throw invalid("Conflict preparation 只能授权 modify 代码任务");
  }
  let executionSource;
  try {
    executionSource = normalizeCodeExecutionSource(
      proposal.binding.executionSource,
    );
  } catch {
    throw invalid("proposal.binding.executionSource 无效");
  }
  if (proposal.binding.inputBinding === null) {
    throw invalid("Conflict preparation 缺少 PR 输入绑定");
  }
  return {
    ...proposal,
    binding: { ...proposal.binding, executionSource },
  };
}

function assertExecutionInputKind(binding) {
  const subject = binding.subject;
  const expectedKind = binding.inputBinding === null ? "issue" : "pr";
  const expectedId = `github:${expectedKind}:${binding.repository}#${subject.number}`;
  if (subject.id !== expectedId) {
    throw invalid(
      binding.inputBinding === null
        ? "只有可信 Issue 输入可以创建无 Head 绑定的代码任务"
        : "PR 代码任务的输入身份与 Head 绑定不一致",
    );
  }
}

function publicRoleOperations(operationsByRole) {
  return Object.freeze(
    Object.fromEntries(
      [...operationsByRole.entries()]
        .sort(([left], [right]) => left.localeCompare(right, "en"))
        .map(([roleId, operations]) => [roleId, Object.freeze([...operations])]),
    ),
  );
}

function writablePathsForGrant(operation, executionSource, workspace) {
  if (executionSource === null) {
    return operation === "modify"
      ? [...workspace.writablePaths].sort((left, right) => left.localeCompare(right, "en"))
      : [];
  }
  if (operation !== "modify") {
    throw invalid("Conflict preparation 只能授权 modify 代码任务");
  }
  if (isHeadRepairExecutionSource(executionSource) &&
      digestValue(codeExecutionSourceWritablePaths(executionSource)) !==
      digestValue([...workspace.writablePaths].sort((left, right) => left.localeCompare(right, "en")))) {
    throw invalid("Review repair 写范围必须与当前工作区配置一致");
  }
  const configuredPolicy = new CodeExecutionPolicy({
    writablePaths: workspace.writablePaths,
    excludePaths: workspace.excludePaths,
  });
  const conflictPaths = codeExecutionSourceWritablePaths(executionSource);
  try {
    for (const conflictPath of conflictPaths) {
      configuredPolicy.assertWritable(conflictPath);
    }
  } catch {
    throw invalid("Conflict preparation 超出工作区写权限");
  }
  return conflictPaths;
}

export class CodeJobGrantFactory {
  #workspaces;
  #policyVersion;
  #workspaceByRepository;
  #operationsByRole;
  #brainDigests;
  #publicOperations;
  #scopeAuthorityDigest;
  #verifyInputAuthority;
  #verifyConflictPreparation;
  #creationEnabled;
  #brainBindingSchema;

  constructor({
    executorAuthority,
    policyVersion,
    workspaceByRepository,
    codeActionRoles,
    codeOperationsByRole,
    taskBrainByRole,
    legacyBrainByRole,
    brainProviders,
    scopeAuthorityDigest,
    inputAuthorityVerifier,
    conflictPreparationVerifier,
  } = {}) {
    if (
      scopeAuthorityDigest !== undefined &&
      typeof scopeAuthorityDigest !== "function"
    ) {
      throw new TypeError("scopeAuthorityDigest must be a function");
    }
    this.#workspaces = normalizeAuthority(executorAuthority);
    this.#policyVersion = positiveInteger(policyVersion, "policyVersion");
    this.#workspaceByRepository = normalizeWorkspaceBindings(
      workspaceByRepository,
    );
    this.#operationsByRole = authorizedOperations(
      normalizeOperationsByRole(codeOperationsByRole),
      normalizeCodeActionRoles(codeActionRoles),
    );
    const usesLegacyBrains = legacyBrainByRole !== undefined;
    if (usesLegacyBrains && taskBrainByRole !== undefined) {
      throw invalid(
        "taskBrainByRole 与 legacyBrainByRole 不能同时配置",
      );
    }
    this.#brainDigests = normalizeBrainDigests({
      brainByRoleValue: usesLegacyBrains
        ? legacyBrainByRole
        : taskBrainByRole ?? {},
      providersValue: brainProviders,
      roleIds: this.#operationsByRole.keys(),
      legacy: usesLegacyBrains,
    });
    this.#creationEnabled = !usesLegacyBrains;
    this.#brainBindingSchema = usesLegacyBrains
      ? CODE_JOB_LEGACY_BRAIN_BINDING_SCHEMA
      : CODE_JOB_TASK_BRAIN_BINDING_SCHEMA;
    this.#publicOperations = publicRoleOperations(this.#operationsByRole);
    this.#scopeAuthorityDigest = scopeAuthorityDigest ?? null;
    if (
      inputAuthorityVerifier !== undefined &&
      (!inputAuthorityVerifier ||
        typeof inputAuthorityVerifier.verify !== "function")
    ) {
      throw new TypeError("inputAuthorityVerifier must provide verify(binding)");
    }
    this.#verifyInputAuthority = inputAuthorityVerifier?.verify.bind(
      inputAuthorityVerifier,
    ) ?? null;
    if (
      conflictPreparationVerifier !== undefined &&
      (!conflictPreparationVerifier ||
        typeof conflictPreparationVerifier.verify !== "function")
    ) {
      throw new TypeError(
        "conflictPreparationVerifier must provide verify(binding)",
      );
    }
    this.#verifyConflictPreparation =
      conflictPreparationVerifier?.verify.bind(conflictPreparationVerifier) ??
      null;
    Object.freeze(this);
  }

  create(value) {
    if (!this.#creationEnabled) {
      throw invalid("历史岗位大脑授权只能恢复校验，不能创建新的代码任务");
    }
    const proposal = normalizeStoredProposal(value);
    const operation = proposal.payload.operation;
    const roleId = proposal.requestedBy.roleId;
    const executionSource = Object.hasOwn(
      proposal.binding,
      "executionSource",
    )
      ? proposal.binding.executionSource
      : null;
    const workspace = this.#currentAuthority({
      policyVersion: proposal.policyVersion,
      repository: proposal.binding.repository,
      workspaceId: proposal.binding.workspaceId,
      roleId,
      operation,
      executionSource,
    });
    const brainDigest = this.#brainDigests.get(roleId)?.[0];
    if (brainDigest === undefined) throw taskBrainNotConfigured(roleId);
    const locallyAdmittedSource = this.#verifyExecutionSource(
      executionSource,
      proposal.binding.inputBinding,
      workspace,
      { verifyEvidence: false },
    );
    const writablePaths = writablePathsForGrant(
      operation,
      locallyAdmittedSource,
      workspace,
    );
    const createResult = (verifiedSource) => {
      const grant = createCodeJobGrant({
        schemaVersion: verifiedSource === null ? 2 : 3,
        brainBindingSchema: CODE_JOB_TASK_BRAIN_BINDING_SCHEMA,
        proposalId: proposal.proposalId,
        contentDigest: proposal.contentDigest,
        policyVersion: proposal.policyVersion,
        requestedBy: proposal.requestedBy,
        source: proposal.source,
        subject: proposal.binding.subject,
        repository: proposal.binding.repository,
        workspaceId: proposal.binding.workspaceId,
        inputBinding: proposal.binding.inputBinding,
        ...(verifiedSource === null
          ? {}
          : { executionSource: verifiedSource }),
        workspaceAuthorityDigest: workspace.authorityDigest,
        operation,
        objective: proposal.payload.objective,
        acceptanceCriteria: proposal.payload.acceptanceCriteria,
        evidence: proposal.payload.evidence,
        summary: proposal.payload.summary,
        reason: proposal.payload.reason,
        allowedActions: CODE_JOB_ACTIONS_BY_OPERATION[operation],
        writablePaths,
        requiredProfiles: workspace.requiredProfiles,
        brainDigest,
      });
      return Object.freeze({
        grant,
        allowedOperationsByRole: this.#publicOperations,
      });
    };
    const authorizeSource = (verifiedInput) => {
      const source = this.#verifyExecutionSource(
        locallyAdmittedSource,
        verifiedInput,
        workspace,
      );
      return source instanceof Promise
        ? source.then(createResult)
        : createResult(source);
    };
    const inputAuthorization = this.#verifyInputBinding(
      proposal.binding.inputBinding,
      workspace,
      { requireGitHeadSnapshot: executionSource?.kind !== "conflict_preparation" },
    );
    return inputAuthorization instanceof Promise
      ? inputAuthorization.then(authorizeSource)
      : authorizeSource(inputAuthorization);
  }

  verify(value) {
    const grant = PREPARED_CODE_JOB_GRANTS.has(value)
      ? value
      : prepareCodeJobGrantVerification(value);
    if (
      ![2, 3].includes(grant.schemaVersion) ||
      !Object.hasOwn(grant, "inputBinding")
    ) {
      throw invalid("旧版代码任务授权只能恢复查看，不能接纳新的执行动作");
    }
    const brainBindingSchema = Object.hasOwn(grant, "brainBindingSchema")
      ? grant.brainBindingSchema
      : CODE_JOB_LEGACY_BRAIN_BINDING_SCHEMA;
    if (brainBindingSchema !== this.#brainBindingSchema) {
      throw invalid("代码任务授权的大脑绑定版本与校验上下文不一致");
    }
    assertExecutionInputKind(grant);
    const roleId = grant.requestedBy.roleId;
    const brainDigests = this.#brainDigests.get(roleId);
    if (brainDigests === undefined) {
      throw invalid("代码任务授权对应的任务大脑已移除");
    }
    if (!brainDigests.includes(grant.brainDigest)) throw invalid("代码任务授权已不符合当前执行配置");
    const brainDigest = grant.brainDigest;
    const workspace = this.#currentAuthority({
      policyVersion: grant.policyVersion,
      repository: grant.repository,
      workspaceId: grant.workspaceId,
      roleId,
      operation: grant.operation,
      executionSource: grant.schemaVersion === 3 ? grant.executionSource : null,
    });
    const executionSource = grant.schemaVersion === 3
      ? grant.executionSource
      : null;
    const locallyAdmittedSource = this.#verifyExecutionSource(
      executionSource,
      grant.inputBinding,
      workspace,
      { verifyEvidence: false },
    );
    const expected = {
      workspaceAuthorityDigest: workspace.authorityDigest,
      allowedActions: CODE_JOB_ACTIONS_BY_OPERATION[grant.operation],
      writablePaths: writablePathsForGrant(
        grant.operation,
        locallyAdmittedSource,
        workspace,
      ),
      requiredProfiles: workspace.requiredProfiles,
      brainDigest,
    };
    const actual = Object.fromEntries(
      Object.keys(expected).map((key) => [key, grant[key]]),
    );
    if (digestValue(actual) !== digestValue(expected)) {
      throw invalid("代码任务授权已不符合当前执行配置");
    }
    const verifySource = (verifiedInput) => {
      const source = this.#verifyExecutionSource(
        locallyAdmittedSource,
        verifiedInput,
        workspace,
      );
      return source instanceof Promise
        ? source.then(() => grant)
        : grant;
    };
    const inputAuthorization = this.#verifyInputBinding(
      grant.inputBinding,
      workspace,
      { requireGitHeadSnapshot: executionSource?.kind !== "conflict_preparation" },
    );
    return inputAuthorization instanceof Promise
      ? inputAuthorization.then(verifySource)
      : verifySource(inputAuthorization);
  }

  #verifyInputBinding(
    inputBinding,
    workspace,
    { requireGitHeadSnapshot = true } = {},
  ) {
    if (inputBinding === null) return null;
    if (inputBinding.schemaVersion !== 2) {
      throw invalid("旧版 PR 输入绑定只能恢复查看，不能创建或授权新的代码执行");
    }
    if (!GIT_OID.test(inputBinding.headRefOid)) {
      throw invalid("PR 代码任务没有绑定有效的 Git Head OID");
    }
    if (
      requireGitHeadSnapshot &&
      !workspace.capabilities.includes("git_head_snapshot")
    ) {
      throw invalid("代码工作区不具备固定 Git Head 快照能力");
    }
    if (this.#verifyInputAuthority === null) {
      throw invalid("PR 代码任务缺少当前 Head 授权校验器");
    }
    const assertVerified = (verified) => {
      if (digestValue(verified) !== digestValue(inputBinding)) {
        throw invalid("PR 当前 Head 授权校验器返回了不一致结果");
      }
      return verified;
    };
    let verified;
    try {
      verified = this.#verifyInputAuthority(structuredClone(inputBinding));
    } catch (error) {
      throw verifierFailure(error, "input", "PR 代码任务绑定的 Head 已失效");
    }
    return verified instanceof Promise
      ? verified.then(assertVerified, (error) => {
          throw verifierFailure(error, "input", "PR 代码任务绑定的 Head 已失效");
        })
      : assertVerified(verified);
  }

  #verifyExecutionSource(
    executionSource,
    inputBinding,
    workspace,
    { verifyEvidence = true } = {},
  ) {
    if (executionSource === null) return null;
    let normalized;
    try {
      normalized = normalizeCodeExecutionSource(executionSource);
    } catch {
      throw invalid("Conflict preparation 执行来源无效");
    }
    if (
      inputBinding === null ||
      !sameCodeExecutionSource(normalized, {
        ...normalized,
        inputBinding,
      })
    ) {
      throw invalid("Conflict preparation 与当前 PR Head 不匹配");
    }
    if (isHeadRepairExecutionSource(normalized)) {
      if (!workspace.capabilities.includes("git_head_snapshot")) {
        throw invalid("Review repair 工作区缺少固定 Head 快照能力");
      }
      return normalized;
    }
    if (!workspace.capabilities.includes("conflict_preparation_snapshot")) {
      throw invalid("代码工作区不具备 sealed conflict 快照能力");
    }
    if (this.#verifyConflictPreparation === null) {
      throw invalid("Conflict preparation 缺少 sealed evidence 校验器");
    }
    if (!verifyEvidence) return normalized;
    let verification;
    try {
      verification = this.#verifyConflictPreparation(
        structuredClone(normalized.preparationBinding),
      );
    } catch (error) {
      throw verifierFailure(error, "source", "Conflict preparation 已失效");
    }
    const assertVerified = (verified) => {
      if (
        !sameConflictPreparationBinding(
          verified,
          normalized.preparationBinding,
        )
      ) {
        throw invalid("Conflict preparation 校验结果不一致");
      }
      return normalized;
    };
    return verification instanceof Promise
      ? verification.then(assertVerified, (error) => {
          throw verifierFailure(error, "source", "Conflict preparation 已失效");
        })
      : assertVerified(verification);
  }

  #currentAuthority({
    policyVersion,
    repository,
    workspaceId,
    roleId,
    operation,
    executionSource = null,
  }) {
    const allowedOperations = this.#operationsByRole.get(roleId);
    const boundWorkspace = this.#workspaceByRepository.get(repository);
    const workspace = this.#workspaces.get(workspaceId);
    if (policyVersion !== this.#policyVersion) {
      throw invalid("工作提案引用了已失效的策略版本");
    }
    if (boundWorkspace === undefined || boundWorkspace !== workspaceId) {
      throw invalid("工作提案引用了已撤销的仓库工作区绑定");
    }
    if (!allowedOperations?.includes(operation)) {
      throw invalid("岗位无权创建该类型的代码任务");
    }
    if (!workspace) throw invalid("工作提案引用了未知代码工作区");
    if (this.#scopeAuthorityDigest === null) return workspace;
    return {
      ...workspace,
      authorityDigest: sha256(
        this.#scopeAuthorityDigest({
          executorAuthorityDigest: workspace.authorityDigest,
          policyVersion,
          repository,
          workspaceId,
          roleId,
          operation,
          executionSource,
        }),
        "scopeAuthorityDigest result",
      ),
    };
  }
}
