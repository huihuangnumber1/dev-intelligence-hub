import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, readdir, realpath, rmdir, unlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";

import { projectRoot } from "../lib/config.js";
import { KnownCliLocator } from "../lib/known-cli-locator.js";
import { PRODUCTION_PRIVATE_DIRECTORY_MANAGER } from "../lib/private-directory-manager.js";
import { SupervisedProcessRunner, isProductionSupervisedProcessRunner, didSupervisedProcessNotStart, readReapedProcessFailureOutput } from "../lib/supervised-process-runner.js";
import { CodexAppServerRunner, didAppServerNotStart, didAppServerNotStartModel, didAppServerReap, readAppServerFailureOutput, readAppServerFailureDiagnostic } from '../lib/codex-app-server-runner.js';
import { normalizeStructuredBrainRequest, readStructuredBrainGenerateInput } from "../lib/structured-brain-request.js";
import { normalizeAbortSignal } from "../lib/structured-provider-request.js";
import { parseJsonWithUniqueKeys } from "../lib/strict-json.js";
import { parseNativeResultJson } from "../lib/native-result-json.js";
import { GitHubReviewReader } from "./github-review-reader.js";
import { isReviewSourceFailure, normalizeLegacyReviewSourceFailure } from "../domain/review-source-failure.js";
import { createCodeJobArtifactReader } from "./code-job-artifact-reader.js";
import { describeCodeReadContext, revokeCodeReadContext } from "../lib/code-read-context.js";
import { createCodeJobExecutionMcp } from "./code-job-execution-mcp.js";
import { closeCodeExecutionContext, revokeCodeExecutionContext } from "../lib/code-execution-context.js";
import { currentTaskExecution } from "../lib/task-execution-context.js";
import { createCodeExecutionWatchdog, codeExecutionWatchdogSignal, closeCodeExecutionWatchdog } from '../lib/code-execution-watchdog.js';
import { acquireNativeAdmission, createNativeModelAdmission, currentNativeAdmission, retainUnknownNativeInvocations, withNativeAdmission, withNativeEntityExclusion } from '../lib/native-model-admission.js';
import { readUnknownNativeInvocations } from './native-codex-marker-identity.js';
import { reconcileNativeBootRecovery } from './native-codex-boot-recovery.js';
import { readWindowsBootIdentity } from '../lib/windows-boot-identity.js';
import {createNativeExecLifecycle} from '../lib/native-exec-lifecycle.js';
import {readNativeModelCapacity} from '../lib/native-model-capacity.js';
import { parseStructuredCodeActionDecision } from "../domain/structured-code-action-contract.js";
import { CodexNativeSessionStore, isNativeCodexThreadId, nativeCodexDigest, nativeCodexHomeIdentity } from "./codex-native-session-store.js";
import { loadNativeReviewSkill, NATIVE_REVIEW_SKILL_DOCUMENT, NATIVE_REVIEW_SKILL_FILE, NATIVE_REVIEW_SKILL_NAME } from "../lib/native-review-skill.js";
import { appServerArguments, reviewerConfiguration, NATIVE_ADVISORY_INSTRUCTION, NATIVE_CHANNEL_INSTRUCTIONS, CODE_EXECUTION_CHANNEL_INSTRUCTIONS } from '../lib/codex-app-server-policy.js';

const HOMES = new Map();
const FENCE_RECONCILIATIONS = new WeakMap();
const SETTLED_FAILURE_OUTPUT = new WeakMap();
const SETTLED_NOT_STARTED = new WeakSet();
const SETTLED_NO_MODEL = new WeakSet();
const SETTLED_NATIVE_REAPED = new WeakSet();
const SAFE_MODEL = /^[A-Za-z0-9][A-Za-z0-9._:/@+-]{0,255}$/u;
const ENVELOPE_SCHEMA = { type: "object", additionalProperties: false, required: ["result"], properties: { result: { type: "string" } } };
const DEFINITIONS = {
  STRUCTURED_PROVIDER_UNAVAILABLE: [503, "Native Codex provider is unavailable"],
  STRUCTURED_PROVIDER_REQUEST_FAILED: [502, "Native Codex request failed"],
  STRUCTURED_PROVIDER_CREDENTIAL_UNAVAILABLE: [503, "Native Codex login is unavailable"],
  STRUCTURED_PROVIDER_CANCELLED: [499, "Native Codex request was cancelled"],
  STRUCTURED_PROVIDER_TIMEOUT: [504, "Native Codex request timed out"],
  STRUCTURED_PROVIDER_IDLE_TIMEOUT: [504, "Native Codex code execution stopped making progress"],
  STRUCTURED_PROVIDER_QUEUE_TIMEOUT: [503, "Native Codex queue wait timed out before execution"],
  STRUCTURED_PROVIDER_BUSY: [503, "Native Codex capacity is occupied; work remains unclaimed"],
  STRUCTURED_PROVIDER_MODEL_CAPACITY: [503, "Selected model is temporarily at capacity; the system will retry"],
  STRUCTURED_PROVIDER_REQUEST_TOO_LARGE: [413, "Native Codex input exceeds its limit"],
  STRUCTURED_PROVIDER_RESPONSE_TOO_LARGE: [413, "Native Codex response exceeds its limit"],
  STRUCTURED_PROVIDER_RESPONSE_INVALID: [502, "Native Codex response is invalid"],
  STRUCTURED_PROVIDER_PROCESS_FAILED: [502, "Native Codex process failed"],
  STRUCTURED_PROVIDER_OUTPUT_LIMIT: [502, "Native Codex output exceeded its limit"],
  STRUCTURED_PROVIDER_REAP_FAILED: [500, "Native Codex process termination could not be confirmed"],
  STRUCTURED_PROVIDER_CLEANUP_FAILED: [500, "Native Codex invocation cleanup failed"],
  STRUCTURED_PROVIDER_SESSION_RECOVERY_FAILED: [500, "Native Codex session reference could not be saved or read; native history was preserved"],
  CODE_ARTIFACT_READ_INCOMPLETE: [503, "Controlled code source was not fully read before writing or completing"],
  CODE_ARTIFACT_READ_INVALID: [503, "Controlled code source is invalid"],
  CODE_EXECUTION_UNAVAILABLE: [503, "Continuous controlled code execution is unavailable"],
  CODE_EXECUTION_UNSETTLED: [503, "Controlled code actions have not settled"],
};

function failure(code = "STRUCTURED_PROVIDER_UNAVAILABLE") {
  // The process runner explicitly classifies an early exit as unavailable.
  // Unknown caught errors have no such transport evidence and consume budget.
  if (code === "STRUCTURED_PROVIDER_PROCESS_EXITED") code = "STRUCTURED_PROVIDER_UNAVAILABLE";
  if (typeof code === "string" && code.startsWith("CODE_READ_")) code = "CODE_ARTIFACT_READ_INVALID";
  if (typeof code !== "string" || !Object.hasOwn(DEFINITIONS, code)) code = "STRUCTURED_PROVIDER_REQUEST_FAILED";
  const [statusCode, message] = DEFINITIONS[code];
  return Object.assign(new Error(message), { code, statusCode });
}

function bounded(value, fallback, maximum, name) {
  const result = value ?? fallback;
  if (!Number.isSafeInteger(result) || result < 1 || result > maximum) throw new TypeError(`${name} is invalid`);
  return result;
}

function absolute(value) {
  if (typeof value !== "string" || !path.isAbsolute(value) || /[\u0000\r\n]/u.test(value)) throw new TypeError("Native Codex path is invalid");
  return path.resolve(value);
}

function overlaps(left, right) {
  const a = nativeCodexHomeIdentity(left);
  const b = nativeCodexHomeIdentity(right);
  const contained = (root, child) => { const rel = path.relative(root, child); return rel === "" || (!rel.startsWith(`..${path.sep}`) && rel !== ".." && !path.isAbsolute(rel)); };
  return contained(a, b) || contained(b, a);
}

function status(state) {
  return Object.freeze({ schemaVersion: 1, state, cliAvailable: state !== "cli_unavailable", fileLoginAvailable: state === "available", credentialMode: "codex-native-login" });
}

function operationSignal(caller) {
  const controller = new AbortController();
  const abort = () => controller.abort(failure("STRUCTURED_PROVIDER_CANCELLED"));
  caller?.addEventListener("abort", abort, { once: true });
  if (caller?.aborted) abort();
  let timer;
  return { signal: controller.signal, abort,
    follow(signal) { clearTimeout(timer); const forward = () => controller.abort(signal.reason); signal.addEventListener('abort', forward, { once: true }); if (signal.aborted) forward(); return () => signal.removeEventListener('abort', forward); },
    deadline(timeoutMs, code) { clearTimeout(timer); timer = setTimeout(() => controller.abort(failure(code)),timeoutMs); },
    clearDeadline() { clearTimeout(timer); },
    close() { clearTimeout(timer); caller?.removeEventListener("abort", abort); } };
}

function sanitizedEnvironment(environment, nativeHome) {
  // Preserve only operating-system essentials and explicit network transport.
  // GitHub, git, SSH, API keys, node injection and user MCP secrets are absent.
  const permitted = new Set(["path", "systemroot", "windir", "comspec", "pathext", "home", "userprofile", "appdata", "localappdata", "temp", "tmp", "tmpdir", "https_proxy", "http_proxy", "no_proxy"]);
  const env = {};
  for (const [name, value] of Object.entries(environment)) {
    if (permitted.has(name.toLowerCase()) && typeof value === "string" && !value.includes("\u0000")) env[name] = value;
  }
  return { ...env, CODEX_HOME: nativeHome, CI: "1", NO_COLOR: "1", TERM: "dumb", LANG: "C.UTF-8", LC_ALL: "C.UTF-8" };
}

function argumentsFor(request, directory, threadId, reader, nativeSkill = false) {
  return [
    "exec", "--ignore-user-config", "--ignore-rules", "--strict-config", "--skip-git-repo-check",
    "--sandbox", "read-only", "--color", "never", "--json",
    ...(request.sessionKey ? [] : ["--ephemeral"]),
    "--output-schema", path.join(directory, "output-schema.json"),
    "--output-last-message", path.join(directory, "last-message.json"),
    "--model", request.model, "-C", directory,
    "-c", 'approval_policy="never"', "-c", 'web_search="disabled"',
    "-c", "project_doc_max_bytes=0",
    "-c", 'model_provider="openai"',
    ...(request.reasoningEffort ? ["-c", `model_reasoning_effort="${request.reasoningEffort}"`] : []),
    "-c", 'service_tier="default"',
    ...["shell_tool", "apps", "browser_use", "computer_use", "image_generation", ...(!nativeSkill ? ["multi_agent"] : []), "hooks", "plugins", "remote_plugin", "plugin_sharing", "skill_search", "goals"].flatMap((name) => ["--disable", name]),
    "-c", "features.skip_host_skill_discovery=true",
    "-c", "skills.include_instructions=false", "-c", "skills.bundled.enabled=false",
    ...(nativeSkill ? ["--enable", "multi_agent"] : []),
    ...(reader ? ["-c", `mcp_servers.pr_review.url=${JSON.stringify(reader.url)}`, "-c", "mcp_servers.pr_review.required=true",
      "-c", 'mcp_servers.pr_review.enabled_tools=["read_document","read_source","list_directory"]',
      ...["read_document", "read_source", "list_directory"].flatMap((tool) => ["-c", `mcp_servers.pr_review.tools.${tool}.approval_mode="approve"`, "-c", `mcp_servers.pr_review.tools.${tool}.output_token_limit=65536`])] : []),
    ...(threadId ? ["resume", threadId] : []), "-",
  ];
}

function threadFrom(result, previous = null) {
  let found = null;
  const bytes = result?.stdoutBytes ?? result?.stdout ?? "";
  const text = (Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes)).toString("utf8");
  for (const line of text.split(/\r?\n/u)) {
    if (!line.trim()) continue;
    let event;
    try { event = parseJsonWithUniqueKeys(line); } catch { continue; }
    if (event?.type !== "thread.started") continue;
    if (!isNativeCodexThreadId(event.thread_id) ||
        (found !== null && found !== event.thread_id) || (previous !== null && previous !== event.thread_id)) throw failure("STRUCTURED_PROVIDER_SESSION_RECOVERY_FAILED");
    found = event.thread_id;
  }
  return found ?? previous;
}

async function readResult(file, maximum) {
  let handle;
  try {
    const before = await lstat(file, { bigint: true });
    if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1n) throw failure("STRUCTURED_PROVIDER_RESPONSE_INVALID");
    if (before.size > BigInt(maximum)) throw failure("STRUCTURED_PROVIDER_RESPONSE_TOO_LARGE");
    handle = await open(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    const opened = await handle.stat({ bigint: true });
    if (before.dev !== opened.dev || before.ino !== opened.ino || before.size !== opened.size) throw failure("STRUCTURED_PROVIDER_RESPONSE_INVALID");
    const bytes = await handle.readFile();
    if (bytes.length > maximum) throw failure("STRUCTURED_PROVIDER_RESPONSE_TOO_LARGE");
    const envelope = parseJsonWithUniqueKeys(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
    if (!envelope || Object.keys(envelope).length !== 1 || typeof envelope.result !== "string") throw failure("STRUCTURED_PROVIDER_RESPONSE_INVALID");
    const value = parseNativeResultJson(envelope.result);
    if (!value || typeof value !== "object" || Array.isArray(value)) throw failure("STRUCTURED_PROVIDER_RESPONSE_INVALID");
    const rejectDangerousKeys = (item) => {
      if (!item || typeof item !== "object") return;
      for (const [key, child] of Object.entries(item)) {
        if (["__proto__", "constructor", "prototype"].includes(key)) throw failure("STRUCTURED_PROVIDER_RESPONSE_INVALID");
        rejectDangerousKeys(child);
      }
    };
    rejectDangerousKeys(value);
    return JSON.stringify(value);
  } catch (error) { throw failure(error?.code ?? "STRUCTURED_PROVIDER_RESPONSE_INVALID"); }
  finally { await handle?.close(); }
}

export class NativeCodexBrainProvider {
  #dependencies;
  #options;
  #nativeHome;
  #root;
  #state;
  #sessions;
  #controllers = new Set();
  #operations = new Set();
  #closed = false;
  #bootRecovery = null;

  constructor(options, dependencies = {}) {
    if (!options || options.cliKind !== "codex-cli" || options.credentialMode !== "codex-native-login" ||
        typeof options.id !== "string" || !/^[a-z0-9][a-z0-9._-]{0,127}$/u.test(options.id)) throw new TypeError("Native Codex options are invalid");
    this.id = options.id;
    this.kind = "codex-cli";
    this.remote = true;
    this.singleAttempt = true;
    this.supportsEntitySessions = true;
    this.sessionIsolationKey = "codex-cli:codex-native-login";
    this.supportsReviewReading = true;
    this.supportsCodeReading = true;
    this.#options = {
      timeoutMs: bounded(options.timeoutMs, 120_000, 3_600_000, "timeoutMs"),
      queueTimeoutMs: bounded(options.queueTimeoutMs, 3_600_000, 86_400_000, "queueTimeoutMs"),
      maxRequestBytes: bounded(options.maxRequestBytes, 256 * 1024, 1024 * 1024, "maxRequestBytes"),
      maxResponseBytes: bounded(options.maxResponseBytes, 256 * 1024, 1024 * 1024, "maxResponseBytes"),
    };
    // Snapshot at construction: browser configuration can never choose a home.
    const environment = { ...(dependencies.environment ?? process.env) };
    const transport = environment.DIH_CODEX_NATIVE_TRANSPORT ?? (process.platform==='win32' ? 'app-server' : 'exec');
    if (!['exec','app-server'].includes(transport)) throw new TypeError('Native Codex transport is invalid');
    this.transport = transport;
    this.supportsCodeExecution = transport === 'app-server';
    this.supportsNativeReviewSkills = true;
    this.#nativeHome = absolute(environment.CODEX_HOME || path.join(homedir(), ".codex"));
    const temporaryRoot = absolute(dependencies.temporaryRoot ?? path.join(homedir(), ".mydashboard-supervised-cli-v1"));
    this.#root = `${temporaryRoot}-native`;
    const protectedRoots = [projectRoot, ...(dependencies.protectedRoots ?? []), this.#nativeHome, temporaryRoot].map(absolute);
    if (protectedRoots.some((root) => overlaps(root, this.#root))) throw new TypeError("Native runtime directory overlaps a protected location");
    this.#dependencies = {
      processRunner: dependencies.processRunner ?? new SupervisedProcessRunner(),
      appServerRunner: dependencies.appServerRunner ?? new CodexAppServerRunner(),
      commandLocator: dependencies.commandLocator ?? new KnownCliLocator(),
      rootDirectoryManager: dependencies.rootDirectoryManager ?? PRODUCTION_PRIVATE_DIRECTORY_MANAGER,
      reviewReaderFactory: dependencies.reviewReaderFactory ?? ((target, opts) => new GitHubReviewReader().open(target, opts)),
      codeReaderFactory: dependencies.codeReaderFactory ?? createCodeJobArtifactReader,
      codeExecutionFactory: dependencies.codeExecutionFactory ?? createCodeJobExecutionMcp,
      reviewSkillLoader: dependencies.reviewSkillLoader ?? loadNativeReviewSkill,
      environment: sanitizedEnvironment(environment, this.#nativeHome),
      protectedRoots,
      clock: dependencies.clock ?? Date.now,
    };
    const key = nativeCodexHomeIdentity(this.#nativeHome);
    const deploymentCapacity=dependencies.maxConcurrentTurns!==undefined?dependencies:
      options.maxConcurrentTurns!==undefined?{maxConcurrentTurns:options.maxConcurrentTurns,allowConcurrentNativeHome:true}:readNativeModelCapacity(environment);
    const capacity = bounded(deploymentCapacity.maxConcurrentTurns, 1, 4, 'maxConcurrentTurns');
    if (capacity > 1 && deploymentCapacity.allowConcurrentNativeHome !== true) throw new TypeError('Concurrent native home access requires explicit validation opt-in');
    this.#state = HOMES.get(key);
    if (!this.#state) HOMES.set(key, this.#state = createNativeModelAdmission(capacity));
    if (this.#state.capacity !== capacity) throw new TypeError('Native home admission capacity differs between providers');
    this.#state.launchJournalCertified = this.#state.launchJournalCertified !== false &&
      isProductionSupervisedProcessRunner(this.#dependencies.processRunner) && dependencies.appServerRunner === undefined;
    this.#bootRecovery = dependencies.nativeBootRecovery ?? (this.#state.launchJournalCertified
      ? async input => reconcileNativeBootRecovery({ ...input, bootIdentity: await readWindowsBootIdentity() })
      : null);
    this.#sessions = dependencies.nativeSessionStore ?? new CodexNativeSessionStore({ root: path.join(this.#root, "sessions"), nativeHome: this.#nativeHome });
  }

  #marker() { return path.join(this.#root, `active-${nativeCodexDigest(nativeCodexHomeIdentity(this.#nativeHome))}-${randomUUID()}.json`); }

  #needsBootRecoveryInspection(files, prefix) {
    return this.#bootRecovery !== null && !this.#state.bootRecoveryInspected &&
      files.includes(`boot-quarantine-${prefix.slice(7)}.json`);
  }

  async #ensureBootRecoveryBoundary(signal) {
    if (!this.#bootRecovery || this.#state.bootRecoveryInspected) return;
    await this.#state.preparation.enqueue(async () => {
      signal?.throwIfAborted();
      if (this.#state.bootRecoveryInspected) return;
      let files;
      try { files = await readdir(this.#root); }
      catch (error) { if (error.code !== 'ENOENT') this.#state.blocked = true; return; }
      const prefix = `active-${nativeCodexDigest(nativeCodexHomeIdentity(this.#nativeHome))}`;
      if (this.#needsBootRecoveryInspection(files, prefix)) this.#state.blocked = true;
      else this.#state.bootRecoveryInspected = true;
    });
    signal?.throwIfAborted();
  }

  async #isolateUnknownInvocations(signal = null) {
    if (!this.#state.blocked) return;
    let pending = FENCE_RECONCILIATIONS.get(this.#state);
    if (!pending) {
      pending = this.#state.preparation.enqueue(async () => {
        if (!this.#state.blocked || [...this.#state.active].some(token => token.exclusive)) return;
        let entries = await readUnknownNativeInvocations({ root: this.#root,
          prefix: `active-${nativeCodexDigest(nativeCodexHomeIdentity(this.#nativeHome))}`, clock: this.#dependencies.clock });
        if (entries !== null && this.#bootRecovery && [...this.#state.active].every(token => token.unknown)) {
          let result;
          try {
            result = await this.#bootRecovery({ root: this.#root,
              prefix: `active-${nativeCodexDigest(nativeCodexHomeIdentity(this.#nativeHome))}`,
              entries, clock: this.#dependencies.clock });
          } catch { this.#state.bootRecoveryInspected = false; return; }
          this.#state.bootRecoveryInspected = result.sealed === true;
          entries = result.entries;
          for (const { file } of result.recovered) {
            const token = this.#state.unknownInvocations.get(file);
            if (token) this.#state.active.delete(token);
            this.#state.unknownInvocations.delete(file);
            this.#state.markers.delete(file);
          }
          if (result.sealed && entries.length === 0 && this.#state.active.size === 0 && this.#state.markers.size === 0) {
            this.#state.blocked = false;
            this.#state.lastStatus = null;
            return;
          }
        }
        if (entries !== null && retainUnknownNativeInvocations(this.#state, entries) &&
            [...this.#state.markers].every(marker => this.#state.unknownInvocations.has(marker))) {
          this.#state.blocked = false;
          this.#state.lastStatus = null;
        }
      });
      FENCE_RECONCILIATIONS.set(this.#state, pending);
    }
    try { await pending; }
    finally { if (FENCE_RECONCILIATIONS.get(this.#state) === pending) FENCE_RECONCILIATIONS.delete(this.#state); }
    signal?.throwIfAborted();
  }

  async #prepare(signal) {
    return this.#state.preparation.enqueue(()=>this.#prepareRuntime(signal));
  }

  async #prepareRuntime(signal) {
    signal.throwIfAborted();
    if(this.#state.blocked)throw failure('STRUCTURED_PROVIDER_REAP_FAILED');
    try {
      const details = await lstat(this.#nativeHome);
      if (!details.isDirectory() || details.isSymbolicLink() || nativeCodexHomeIdentity(await realpath(this.#nativeHome)) !== nativeCodexHomeIdentity(this.#nativeHome)) throw failure();
    } catch { signal.throwIfAborted(); throw failure("STRUCTURED_PROVIDER_CREDENTIAL_UNAVAILABLE"); }
    const prepare = (directory) => this.#dependencies.rootDirectoryManager.prepare({ directory, signal, validateLocation: async () => {
      if (this.#dependencies.protectedRoots.some((root) => overlaps(root, directory))) throw failure();
    } });
    await prepare(this.#root);
    await prepare(path.join(this.#root, "sessions"));
    const prefix = `active-${nativeCodexDigest(nativeCodexHomeIdentity(this.#nativeHome))}`;
    const files = await readdir(this.#root);
    if (this.#needsBootRecoveryInspection(files, prefix) ||
        files.some(name => name.startsWith(prefix) && name.endsWith('.json') && !this.#state.markers.has(path.join(this.#root,name)))) {
      this.#state.blocked = true;
      throw failure("STRUCTURED_PROVIDER_REAP_FAILED");
    }
    if (this.#bootRecovery) this.#state.bootRecoveryInspected = true;
    signal.throwIfAborted();
    return prepare;
  }

  async #runProcess(options, signal, marker, onProcessAttempt = () => {}, runner = this.#dependencies.processRunner) {
    const { nativeAdmissionEntity: entity, ...processOptions } = options;
    signal.throwIfAborted();
    if(this.#state.blocked)throw failure('STRUCTURED_PROVIDER_REAP_FAILED');
    this.#state.markers.add(marker);
    try {
      if (typeof entity !== "string") throw new TypeError("Native process has no admission identity");
      await writeFile(marker, JSON.stringify({ schemaVersion: 2, invocation: path.basename(options.cwd), createdAt: this.#dependencies.clock(), entity }), { flag: "wx", mode: 0o600 });
    } catch (error) {
      this.#state.markers.delete(marker);
      if (error?.code === "EEXIST") { this.#state.blocked = true; throw failure("STRUCTURED_PROVIDER_REAP_FAILED"); }
      throw error;
    }
    // Supervision owns bounded teardown even after the caller cancels. Keeping
    // this same promise attached preserves its reap proof and close tracking.
    const outcome = await Promise.resolve().then(() => {
      signal.throwIfAborted();
      onProcessAttempt();
      return runner.run({ ...processOptions, signal });
    }).then((value) => ({ value }), (error) => ({ error }));
    if (outcome.error?.code === "STRUCTURED_PROVIDER_REAP_FAILED") {
      this.#state.blocked = true;
      throw failure("STRUCTURED_PROVIDER_REAP_FAILED");
    }
    await unlink(marker);
    this.#state.markers.delete(marker);
    if (signal.aborted) {
      if (didAppServerReap(outcome.error) || (runner === this.#dependencies.appServerRunner &&
          outcome.value?.exitCode === 0 && outcome.value?.signal === null)) SETTLED_NATIVE_REAPED.add(signal.reason);
      if (didSupervisedProcessNotStart(outcome.error) || didAppServerNotStart(outcome.error)) SETTLED_NOT_STARTED.add(signal.reason);
      if (didAppServerNotStartModel(outcome.error)) SETTLED_NO_MODEL.add(signal.reason);
      const output = outcome.value ?? readReapedProcessFailureOutput(outcome.error) ?? readAppServerFailureOutput(outcome.error);
      if (output) SETTLED_FAILURE_OUTPUT.set(signal.reason, output);
      throw signal.reason;
    }
    if (outcome.error) throw outcome.error;
    if (outcome.value?.exitCode !== 0 || outcome.value?.signal !== null) throw failure("STRUCTURED_PROVIDER_PROCESS_FAILED");
    return outcome.value;
  }

  async #cleanup(directory, files, directories = []) {
    // Forced Windows wrapper termination can skip its stdin-file finally block.
    // Only settled supervision reaches cleanup; retain every unknown entry.
    const entries = await readdir(directory).catch(() => { throw failure("STRUCTURED_PROVIDER_CLEANUP_FAILED"); });
    const runnerInputs = entries.filter((name) => /^\.supervised-stdin-[a-f0-9]{32}\.bin$/u.test(name));
    for (const name of [...files, ...runnerInputs]) {
      const file = path.join(directory, name);
      try {
        const details = await lstat(file);
        if (!details.isFile() || details.isSymbolicLink() || details.nlink !== 1) throw failure("STRUCTURED_PROVIDER_CLEANUP_FAILED");
        await unlink(file);
      } catch (error) { if (error?.code !== "ENOENT") throw failure("STRUCTURED_PROVIDER_CLEANUP_FAILED"); }
    }
    for (const relative of directories) {
      const target = path.join(directory, relative);
      try {
        const info = await lstat(target);
        if (!info.isDirectory() || info.isSymbolicLink()) throw failure("STRUCTURED_PROVIDER_CLEANUP_FAILED");
        await rmdir(target);
      } catch (error) { if (error?.code !== "ENOENT") throw failure("STRUCTURED_PROVIDER_CLEANUP_FAILED"); }
    }
    try { await rmdir(directory); } catch { throw failure("STRUCTURED_PROVIDER_CLEANUP_FAILED"); }
  }

  #invalidateAvailability(error) {
    if (['STRUCTURED_PROVIDER_UNAVAILABLE', 'STRUCTURED_PROVIDER_CREDENTIAL_UNAVAILABLE',
      'STRUCTURED_PROVIDER_PROCESS_FAILED', 'STRUCTURED_PROVIDER_PROCESS_EXITED'].includes(error?.code)) this.#state.lastStatus = null;
  }

  #operation(signal, callback, timeoutMs = this.#options.timeoutMs, {entityKey = randomUUID(), exclusive = false, model = false,enforceEntity=false,codeExecution=false} = {}) {
    if (this.#closed) return Promise.reject(failure());
    const operation = operationSignal(signal);
    operation.deadline(this.#options.queueTimeoutMs, 'STRUCTURED_PROVIDER_QUEUE_TIMEOUT');
    this.#controllers.add(operation);
    const attempt = (async () => {
      let token, borrowed = false, acquiredUse = false, detach, watchdog, detachWatchdog;
      const context = model ? currentTaskExecution() : null;
      try {
        context?.reportModelState?.('waiting_model');
        detach = context?.registerLiveControl?.({steer:async () => { throw failure('STRUCTURED_PROVIDER_BUSY'); },interrupt:async () => operation.abort()});
        token = !exclusive ? currentNativeAdmission(this.#state) : null;
        borrowed = Boolean(token);
        if(token && enforceEntity && token.entity!==entityKey)throw new TypeError('Native admission entity differs from the reserved entity');
        if (token?.inUse) throw failure('STRUCTURED_PROVIDER_BUSY');
        token ??= await acquireNativeAdmission(this.#state, entityKey, operation.signal, {exclusive});
        token.inUse = true;
        acquiredUse = true;
        detach?.(); detach = null;
        operation.signal.throwIfAborted();
        if (codeExecution) {
          watchdog = createCodeExecutionWatchdog({ startupMs: timeoutMs, idleMs: Math.max(15 * 60_000, timeoutMs) });
          detachWatchdog = operation.follow(codeExecutionWatchdogSignal(watchdog));
        } else operation.deadline(timeoutMs, 'STRUCTURED_PROVIDER_TIMEOUT');
        context?.reportModelState?.('starting_model');
        return await callback(operation.signal, watchdog, token.entity);
      } catch (error) {
        if (!token && operation.signal.aborted) context?.confirmStopped?.();
        if (model) this.#invalidateAvailability(error);
        if (isReviewSourceFailure(error)) throw error;
        const sourceFailure = normalizeLegacyReviewSourceFailure(error);
        if (sourceFailure) throw sourceFailure;
        const mapped = failure(error?.code ?? "STRUCTURED_PROVIDER_REQUEST_FAILED");
        const diagnostic = readAppServerFailureDiagnostic(error);
        if (diagnostic) Object.defineProperty(mapped, 'nativeFailure', { value: diagnostic });
        throw mapped;
      } finally {
        detach?.();
        detachWatchdog?.(); if (watchdog) closeCodeExecutionWatchdog(watchdog);
        if (token && acquiredUse) { token.inUse = false; if (!borrowed || token.releaseRequested) token.release(); }
        operation.close(); this.#controllers.delete(operation);
      }
    })();
    this.#operations.add(attempt);
    void attempt.then(() => this.#operations.delete(attempt), () => this.#operations.delete(attempt));
    return attempt;
  }

  async withAdmission({entityKey, signal = null, waitForCapacity = false} = {}, operation) {
    if (this.#closed) throw failure();
    if (typeof entityKey !== 'string' || !entityKey || Buffer.byteLength(entityKey) > 1024 || /[\u0000-\u001f]/u.test(entityKey) || typeof operation !== 'function') throw new TypeError('Native admission request is invalid');
    if (typeof waitForCapacity !== 'boolean') throw new TypeError('Native admission wait option is invalid');
    const caller = normalizeAbortSignal(signal);
    if (this.#bootRecovery && !this.#state.bootRecoveryInspected) await this.#ensureBootRecoveryBoundary(caller);
    if (this.#closed) throw failure('STRUCTURED_PROVIDER_CANCELLED');
    if (this.#state.blocked) {
      await this.#isolateUnknownInvocations(caller);
      if (this.#closed) throw failure('STRUCTURED_PROVIDER_CANCELLED');
    }
    if (!waitForCapacity) return withNativeAdmission(this.#state, nativeCodexDigest(entityKey), caller, operation);
    const waiting = operationSignal(caller);
    waiting.deadline(this.#options.queueTimeoutMs, 'STRUCTURED_PROVIDER_QUEUE_TIMEOUT');
    this.#controllers.add(waiting);
    const queued = withNativeAdmission(this.#state, nativeCodexDigest(entityKey), waiting.signal, () => {
      waiting.clearDeadline();
      waiting.signal.throwIfAborted();
      if (this.#closed) throw failure('STRUCTURED_PROVIDER_CANCELLED');
      return operation();
    }, {waitForCapacity: true});
    this.#operations.add(queued);
    try { return await queued; }
    finally { waiting.close(); this.#controllers.delete(waiting); this.#operations.delete(queued); }
  }

  async withEntityQuiescence({ entityKey, signal = null } = {}, operation) {
    if (this.#closed) throw failure();
    if (typeof operation !== "function") throw new TypeError("Native quiescence operation is invalid");
    if (typeof entityKey !== 'string' || !entityKey || Buffer.byteLength(entityKey) > 1024 || /[\u0000-\u001f]/u.test(entityKey)) throw new TypeError('Native quiescence entity is invalid');
    signal = normalizeAbortSignal(signal);
    signal?.throwIfAborted();
    if (!this.#state.launchJournalCertified) return { executed: false };
    if (this.#bootRecovery && !this.#state.bootRecoveryInspected) await this.#ensureBootRecoveryBoundary(signal);
    if (this.#state.blocked) await this.#isolateUnknownInvocations(signal);
    const attempt = withNativeEntityExclusion(this.#state, nativeCodexDigest(entityKey), signal, async () => {
      const settled = await this.#state.preparation.enqueue(async () => {
        const prefix = `active-${nativeCodexDigest(nativeCodexHomeIdentity(this.#nativeHome))}`;
        let files;
        try { files = await readdir(this.#root); } catch { return false; }
        if (this.#needsBootRecoveryInspection(files, prefix)) return false;
        const entries = await readUnknownNativeInvocations({ root: this.#root,
          prefix: `active-${nativeCodexDigest(nativeCodexHomeIdentity(this.#nativeHome))}`,
          clock: this.#dependencies.clock, signal });
        return entries !== null && !entries.some(entry => entry.entity === nativeCodexDigest(entityKey));
      });
      if (!settled || this.#closed || !this.#state.launchJournalCertified) return { executed: false };
      signal?.throwIfAborted();
      // Every built-in launch journals before spawning and retains its marker
      // until tree supervision settles. Entity exclusion stays held while host
      // actions drain; this does not rewrite any historical execution receipt.
      return { executed: true, result: await operation() };
    });
    this.#operations.add(attempt);
    try { return await attempt; }
    finally { this.#operations.delete(attempt); }
  }

  async generate(rawRequest) {
    const input = readStructuredBrainGenerateInput(rawRequest);
    const signal = normalizeAbortSignal(input.signal);
    if (this.#bootRecovery && !this.#state.bootRecoveryInspected) await this.#ensureBootRecoveryBoundary(signal);
    if (this.#state.blocked) await this.#isolateUnknownInvocations(signal);
    const request = normalizeStructuredBrainRequest({ model: input.model, messages: input.messages, schema: input.schema,
      ...(input.reasoningEffort ? { reasoningEffort: input.reasoningEffort } : {}),
      ...(input.sessionKey ? { sessionKey: input.sessionKey } : {}), ...(input.reviewTarget ? { reviewTarget: input.reviewTarget } : {}),
      ...(input.admissionEntityKey?{admissionEntityKey:input.admissionEntityKey}:{}),
      ...(input.codeReadContext ? { codeReadContext: input.codeReadContext } : {}),
      ...(input.codeExecutionContext ? { codeExecutionContext: input.codeExecutionContext } : {}) }, { maxRequestBytes: this.#options.maxRequestBytes });
    if (!SAFE_MODEL.test(request.model)) throw new TypeError("CLI model is invalid");
    if (request.codeExecutionContext && !this.supportsCodeExecution) throw failure("CODE_EXECUTION_UNAVAILABLE");
    const nativeSkill = request.reviewTarget && this.supportsNativeReviewSkills;
    const wireInput = JSON.stringify({ instruction: request.codeExecutionContext ? CODE_EXECUTION_CHANNEL_INSTRUCTIONS + " Return exactly one envelope with a result string containing the final complete JSON object matching the business schema."
      : (nativeSkill ? `Use $${NATIVE_REVIEW_SKILL_NAME}. Read its resources through pr_review MCP; do not search for other skills or execute host file commands. ` : "") + NATIVE_ADVISORY_INSTRUCTION +
      (request.reviewTarget ? "Use pr_review MCP to read both complete review-manifest.json and review.diff, following nextOffset until null; read pinned related source as needed. Staged files are convenient previews; MCP reads establish completeness." : "") +
      (request.codeReadContext ? "Use the supplied read-only MCP tools to read code-read-manifest.json and the complete audited sources with read_source, following nextOffset until null. Inline code is only a preview. Before writing an existing listed file, read every page of that file; before completing, read every listed source. These immutable sources belong only to this controlled job and current workspace version." : ""), messages: request.messages, schema: request.schema });
    if (Buffer.byteLength(wireInput) > this.#options.maxRequestBytes) throw failure("STRUCTURED_PROVIDER_REQUEST_TOO_LARGE");
    const timeoutMs = this.#options.timeoutMs;
    const operation = this.#operation(signal, async (operationSignal, watchdog, nativeAdmissionEntity) => {
      const prepare = await this.#prepare(operationSignal);
      const descriptor = await this.#dependencies.commandLocator.resolve("codex-cli", { signal: operationSignal });
      let reader;
      let execution;
      let processResult;
      let processFailure;
      let directory;
      let result;
      let error;
      const files = ["output-schema.json", "last-message.json", "task.json", "review.diff", "review-manifest.json", "code-read-manifest.json"];
      const directories = nativeSkill ? [`.agents/skills/${NATIVE_REVIEW_SKILL_NAME}`, ".agents/skills", ".agents"] : [];
      try {
        const skill = nativeSkill ? await this.#dependencies.reviewSkillLoader() : null;
        if (request.reviewTarget) reader = await this.#dependencies.reviewReaderFactory(request.reviewTarget, {
          signal: operationSignal, ...(skill ? { skillDocuments: skill.documents } : {}),
        });
        if (request.codeReadContext) reader = await this.#dependencies.codeReaderFactory(request.codeReadContext, { signal: operationSignal });
        if (request.codeExecutionContext) execution = await this.#dependencies.codeExecutionFactory(request.codeExecutionContext, { signal: operationSignal, watchdog });
        directory = path.join(this.#root, `invocation-${randomUUID()}`);
        await prepare(directory);
        if (skill) {
          files.push(NATIVE_REVIEW_SKILL_FILE);
          for (const relative of [...directories].reverse()) await prepare(path.join(directory, relative));
          await writeFile(path.join(directory, NATIVE_REVIEW_SKILL_FILE), skill.documents[NATIVE_REVIEW_SKILL_DOCUMENT], { flag: "wx", mode: 0o600 });
        }
        await writeFile(path.join(directory, "output-schema.json"), JSON.stringify(ENVELOPE_SCHEMA), { flag: "wx", mode: 0o600 });
        await writeFile(path.join(directory, "task.json"), wireInput, { flag: "wx", mode: 0o600 });
        // Standalone text needs no live controls, native history or code tools.
        // Exec can ignore home configuration; app-server still discovers built-in
        // app inventories even with its model-facing app features disabled.
        const standaloneText = !currentTaskExecution() && !request.sessionKey && !request.admissionEntityKey &&
          !request.reviewTarget && !request.codeReadContext && !request.codeExecutionContext;
        const live = this.transport === 'app-server' && !standaloneText;
        const instructionsFile = path.join(directory,'model-instructions.txt');
        const agentConfigPath = path.join(directory,'reviewer.toml');
        if(live) {
          files.push('model-instructions.txt','reviewer.toml');
          await writeFile(instructionsFile,request.codeExecutionContext?CODE_EXECUTION_CHANNEL_INSTRUCTIONS:NATIVE_CHANNEL_INSTRUCTIONS,{flag:'wx',mode:0o600});
          await writeFile(agentConfigPath,reviewerConfiguration(request,instructionsFile),{flag:'wx',mode:0o600});
        }
        if (request.reviewTarget && reader) {
          await writeFile(path.join(directory, "review.diff"), reader.diffText, { flag: "wx", mode: 0o600 });
          await writeFile(path.join(directory, "review-manifest.json"), reader.manifestText, { flag: "wx", mode: 0o600 });
        }
        if (request.codeReadContext && reader) {
          await writeFile(path.join(directory, "code-read-manifest.json"), reader.manifestText, { flag: "wx", mode: 0o600 });
        }
        const previous = request.sessionKey ? await this.#sessions.read({ sessionKey: request.sessionKey, signal: operationSignal }) : null;
        if (request.sessionKey) await this.#sessions.begin?.({ sessionKey: request.sessionKey, threadId: previous, signal: operationSignal });
        let checkpointedThread = previous;
        const onThreadIdentified = live && request.sessionKey ? async threadId => {
          operationSignal.throwIfAborted();
          if (!isNativeCodexThreadId(threadId) || (checkpointedThread && checkpointedThread !== threadId)) throw failure("STRUCTURED_PROVIDER_SESSION_RECOVERY_FAILED");
          // This closure alone owns the admitted request's session key. Do not
          // accept a binding from native output or expose it in the wire input.
          await this.#sessions.begin({ sessionKey: request.sessionKey, threadId, signal: operationSignal });
          checkpointedThread = threadId;
        } : null;
        let processAttempted = false;
        const lifecycle=live?null:createNativeExecLifecycle(currentTaskExecution(),Buffer.from(wireInput));
        try {
          const args = argumentsFor(request, directory, previous, reader, Boolean(skill));
          processResult = await this.#runProcess({ nativeAdmissionEntity, executable: descriptor, args: live ? appServerArguments(request,instructionsFile,Boolean(skill)) : args, cwd: directory, env: this.#dependencies.environment,
            ...(onThreadIdentified ? { onThreadIdentified } : {}),
            ...(live ? {appServer:{input:wireInput,model:request.model,effort:request.reasoningEffort,schema:ENVELOPE_SCHEMA,previous,
              isolation:{reader:reader?{url:reader.url}:null,agentConfigPath,ephemeral:!request.sessionKey,
                ...(execution?{channel:'code-job',execution:{url:execution.url,revoke:execution.revoke}}:{}),
                ...(skill?{skill:{name:NATIVE_REVIEW_SKILL_NAME,path:path.join(directory,NATIVE_REVIEW_SKILL_FILE)}}:{})}}} : {}),
            input: live?Buffer.from(wireInput):Buffer.alloc(0),...(lifecycle?{duplex:lifecycle.duplex}:{}), ...(watchdog ? { codeExecutionWatchdog: watchdog } : {}), timeoutMs, maxStdoutBytes: reader || execution ? 64 * 1024 * 1024 : 1024 * 1024, maxStderrBytes: this.#options.maxResponseBytes }, operationSignal, this.#marker(), () => { processAttempted = true; }, live ? this.#dependencies.appServerRunner : this.#dependencies.processRunner);
          this.#state.lastStatus = status("available");
        } catch (failure) { processFailure = failure; this.#invalidateAvailability(failure); }
        finally {lifecycle?.close();}
        if (request.sessionKey && !this.#state.blocked) {
          const threadId = threadFrom(processResult ?? SETTLED_FAILURE_OUTPUT.get(processFailure) ?? readReapedProcessFailureOutput(processFailure) ?? readAppServerFailureOutput(processFailure), checkpointedThread);
          if (threadId) await this.#sessions.save({ sessionKey: request.sessionKey, threadId });
          else if (!processAttempted || didSupervisedProcessNotStart(processFailure) || didAppServerNotStart(processFailure) || didAppServerNotStartModel(processFailure) || SETTLED_NOT_STARTED.has(processFailure) || SETTLED_NO_MODEL.has(processFailure)) await this.#sessions.cancel?.({ sessionKey: request.sessionKey });
          else throw failure("STRUCTURED_PROVIDER_SESSION_RECOVERY_FAILED");
        }
        if (processFailure) throw processFailure;
        if (processResult?.interrupted) throw failure('STRUCTURED_PROVIDER_CANCELLED');
        operationSignal.throwIfAborted();
        result = await readResult(path.join(directory, "last-message.json"), this.#options.maxResponseBytes);
        if (request.codeExecutionContext) {
          let decision;
          try { decision = parseStructuredCodeActionDecision(result); }
          catch { throw failure("STRUCTURED_PROVIDER_RESPONSE_INVALID"); }
          if (decision.action.type !== "complete") throw failure("STRUCTURED_PROVIDER_RESPONSE_INVALID");
        }
        if (request.codeReadContext) {
          let decision;
          try { decision = parseStructuredCodeActionDecision(result); }
          catch { throw failure("STRUCTURED_PROVIDER_RESPONSE_INVALID"); }
          if (decision.action.type === "complete") await reader.assertComplete();
          if (decision.action.type === "write_text" &&
              describeCodeReadContext(request.codeReadContext).documents.some(({ path }) => path === decision.action.path)) {
            await reader.assertComplete([decision.action.path]);
          }
          reader.commit();
          operationSignal.throwIfAborted();
        }
        if (request.reviewTarget && reader && ['propose_github_review','complete','handoff'].includes(JSON.parse(result).intent?.type)) await reader.assertComplete(JSON.parse(result).intent);
      } catch (caught) { error = caught; }
      finally {
        if (request.codeExecutionContext) {
          // Native completion/interrupt revokes admission immediately. Drain
          // already admitted host actions before certifying that pause stopped.
          try {
            revokeCodeExecutionContext(request.codeExecutionContext);
            const receipt = execution ? await execution.close() : await closeCodeExecutionContext(request.codeExecutionContext);
            if (receipt?.settled !== true) error ??= failure("CODE_EXECUTION_UNSETTLED");
            // A pause may be saved after the native terminal event. A verified
            // completed process is equally stopped once host actions drain;
            // the worker checks persisted control before any final host action.
            else if ((processResult || didAppServerReap(processFailure) || SETTLED_NATIVE_REAPED.has(processFailure)) &&
                !this.#state.blocked) currentTaskExecution()?.confirmStopped();
          } catch { error ??= failure("STRUCTURED_PROVIDER_CLEANUP_FAILED"); }
        }
        try { await reader?.close(); } catch { error ??= failure("STRUCTURED_PROVIDER_CLEANUP_FAILED"); }
        // A still-running process owns this workspace. Retain it and its marker.
        if (directory && !this.#state.blocked) {
          try { await this.#cleanup(directory, files, directories); } catch (caught) { error = caught; }
        }
        if (operationSignal.aborted) error ??= operationSignal.reason;
        if (error && request.codeReadContext) revokeCodeReadContext(request.codeReadContext);
      }
      if (error) throw error;
      return result;
    }, timeoutMs, {entityKey: request.admissionEntityKey ? nativeCodexDigest(request.admissionEntityKey) : request.sessionKey ? nativeCodexDigest(request.sessionKey) : randomUUID(),model:true,enforceEntity:request.admissionEntityKey!==undefined,codeExecution:Boolean(request.codeExecutionContext)});
    if (!request.codeExecutionContext) return operation;
    // Queue/preparation failures happen before endpoint construction. They must
    // still revoke the opaque capability and release its host owner exactly once.
    try { return await operation; }
    catch (error) {
      revokeCodeExecutionContext(request.codeExecutionContext, { abortActive: true });
      try { await closeCodeExecutionContext(request.codeExecutionContext); } catch { /* Preserve the first lifecycle failure. */ }
      throw error;
    }
  }

  async readStatus({ signal = null } = {}) {
    signal = normalizeAbortSignal(signal);
    if (signal?.aborted) throw failure("STRUCTURED_PROVIDER_CANCELLED");
    if (this.#closed) throw failure();
    if (this.#bootRecovery && !this.#state.bootRecoveryInspected) await this.#ensureBootRecoveryBoundary(signal);
    if (this.#state.blocked) await this.#isolateUnknownInvocations(signal);
    if (this.transport === 'app-server' && this.#dependencies.appServerRunner.supportsContainedExecution === false) return status('cli_unavailable');
    if (this.#state.blocked) return status("broker_blocked");
    if (this.#state.active.size > 0 && this.#state.lastStatus) return this.#state.lastStatus;
    try {
      return await this.#operation(signal, async (operationSignal, _watchdog, nativeAdmissionEntity) => {
        const prepare = await this.#prepare(operationSignal);
        let descriptor;
        try { descriptor = await this.#dependencies.commandLocator.resolve("codex-cli", { signal: operationSignal }); }
        catch (error) {
          operationSignal.throwIfAborted();
          if (error?.code !== "STRUCTURED_PROVIDER_UNAVAILABLE") throw error;
          return this.#state.lastStatus = status("cli_unavailable");
        }
        const directory = path.join(this.#root, `probe-${randomUUID()}`);
        await prepare(directory);
        try {
          const result = await this.#runProcess({ nativeAdmissionEntity, executable: descriptor, args: ["login", "status"], cwd: directory, env: this.#dependencies.environment,
            input: Buffer.alloc(0), timeoutMs: Math.min(30_000, this.#options.timeoutMs), maxStdoutBytes: 4096, maxStderrBytes: 4096 }, operationSignal, this.#marker());
          const stdout = String(result.stdout ?? Buffer.from(result.stdoutBytes ?? "").toString("utf8")).trim();
          const stderr = String(result.stderr ?? Buffer.from(result.stderrBytes ?? "").toString("utf8")).trim();
          const available = (stdout === "Logged in using ChatGPT" && !stderr) || (stderr === "Logged in using ChatGPT" && !stdout);
          return this.#state.lastStatus = status(available ? "available" : "file_login_unavailable");
        } catch (error) {
          if (["STRUCTURED_PROVIDER_PROCESS_EXITED", "STRUCTURED_PROVIDER_PROCESS_FAILED"].includes(error?.code)) throw failure("STRUCTURED_PROVIDER_CREDENTIAL_UNAVAILABLE");
          throw error;
        } finally { if (!this.#state.blocked) await this.#cleanup(directory, []); }
      }, Math.min(30_000,this.#options.timeoutMs), {exclusive:this.#state.unknownInvocations.size === 0});
    } catch (error) {
      if (["STRUCTURED_PROVIDER_CANCELLED", "STRUCTURED_PROVIDER_REQUEST_FAILED"].includes(error?.code)) throw error;
      return this.#state.lastStatus = status(this.#state.blocked || error?.code === "STRUCTURED_PROVIDER_REAP_FAILED" ? "broker_blocked" :
        error?.code === "STRUCTURED_PROVIDER_CREDENTIAL_UNAVAILABLE" ? "file_login_unavailable" : "cli_unavailable");
    }
  }

  async checkAvailability(request = {}) {
    const signal = normalizeAbortSignal(request.signal ?? null);
    if (signal?.aborted) throw failure("STRUCTURED_PROVIDER_CANCELLED");
    if (this.#closed) throw failure();
    if (this.#bootRecovery && !this.#state.bootRecoveryInspected) await this.#ensureBootRecoveryBoundary(signal);
    if (this.#closed) throw failure();
    if (this.#state.blocked) await this.#isolateUnknownInvocations(signal);
    if (this.#state.blocked) throw failure("STRUCTURED_PROVIDER_REAP_FAILED");
    if (this.transport === 'app-server' && this.#dependencies.appServerRunner.supportsContainedExecution === false) throw failure();
    // Availability is admission, not a second serialized model operation.
    // Each queued generation still validates the home, session and CLI itself.
    // A successful login check is shared across idle workforce cycles. Repeating
    // its exclusive probe before every claim can keep real work permanently out.
    // Explicit status reads still refresh login; execution failures invalidate it.
    if ([...this.#state.active].some(token => !token.unknown) || this.#state.lastStatus?.state === 'available') return;
    const result = await this.readStatus({ signal });
    if (result.state !== "available") throw failure(result.state === "broker_blocked" ? "STRUCTURED_PROVIDER_REAP_FAILED" :
      result.state === "file_login_unavailable" ? "STRUCTURED_PROVIDER_CREDENTIAL_UNAVAILABLE" : "STRUCTURED_PROVIDER_UNAVAILABLE");
  }

  async close() {
    this.#closed = true;
    for (const operation of this.#controllers) operation.abort();
    await Promise.allSettled([...this.#operations]);
    if (this.#state.blocked) throw failure("STRUCTURED_PROVIDER_REAP_FAILED");
  }
}

export function createNativeCodexBrainProvider(options, dependencies) {
  return new NativeCodexBrainProvider(options, dependencies);
}
