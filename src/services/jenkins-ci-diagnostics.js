import { canonicalJsonDigest } from '../lib/canonical-json-digest.js';
import { jenkinsBuildIdentity } from './jenkins-connection-store.js';

const failure = code => Object.assign(new Error('Jenkins build diagnostics are unavailable'), { code });
const digest = canonicalJsonDigest;
const sha = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u;

function redact(value, secrets) {
  let text = String(value).replace(/\u001b\[[0-?]*[ -/]*[@-~]/gu, '').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/gu, '');
  const variants = new Set(secrets.filter(Boolean).flatMap(secret =>
    [secret, JSON.stringify(secret).slice(1, -1), encodeURIComponent(secret), Buffer.from(secret).toString('base64')]));
  for (const secret of [...variants].sort((left, right) => right.length - left.length)) text = text.split(secret).join('[REDACTED]');
  return text.replace(/(https?:\/\/)[^\s/@]+:[^\s/@]+@/gu, '$1[REDACTED]@')
    .replace(/\b(authorization|password|api[_-]?token|jenkins-crumb)(["']?\s*[:=]\s*)[^\r\n]+/giu, '$1$2[REDACTED]');
}

function excerpt(text, maximum = 4000) {
  if (maximum === 0) return { text: '', truncated: text.length > 0 };
  if (Buffer.byteLength(text) <= maximum) return { text, truncated: false };
  const head = Buffer.from(text).subarray(0, Math.floor(maximum / 4)).toString('utf8');
  const tail = Buffer.from(text).subarray(-Math.floor(maximum * 3 / 4)).toString('utf8');
  return { text: `${head}\n[...省略...]\n${tail}`, truncated: true };
}

export function parseJenkinsGoogleTestConsole(text, { headRefOid, headRefName, secrets = [] }) {
  return parseRedactedJenkinsConsole(redact(text, secrets), { headRefOid, headRefName });
}

function parseRedactedJenkinsConsole(log, { headRefOid, headRefName }) {
  const lines = log.split(/\r?\n/u);
  const firstTest = lines.findIndex(line => /^\[\s*RUN\s*\]/u.test(line));
  const prefix = lines.slice(0, firstTest < 0 ? lines.length : firstTest);
  const header = prefix.flatMap((line, index) => {
    const match = /^\[INFO\]\s+Branch:\s+(.+?)\s+SHA:\s+([a-f0-9]{40}|[a-f0-9]{64})\s*$/u.exec(line);
    return match ? [{ branch: match[1], sha: match[2], index }] : [];
  }).at(-1);
  const resets = prefix.flatMap(line => {
    const match = /\bHEAD is now at ([a-f0-9]{7,64})\b/u.exec(line);
    return match ? [match[1]] : [];
  });
  const reset = resets.at(-1);
  const changedAfterStart = firstTest >= 0 && lines.slice(firstTest).some(line =>
    /\bHEAD is now at [a-f0-9]{7,64}\b|\bgit (?:checkout|reset)\b/u.test(line));
  const changedAfterHeader = header && prefix.slice(header.index + 1).some(line => /\bgit (?:checkout|reset)\b|\bHEAD is now at /u.test(line));
  const matches = Boolean(header && reset && header.sha === headRefOid && header.branch === headRefName &&
    header.sha.startsWith(reset) && !changedAfterStart && !changedAfterHeader);
  const tests = new Map(); let active = null;
  for (const line of lines) {
    const start = /^\[\s*RUN\s*\]\s+(\S+)/u.exec(line);
    if (start) { active = { name: start[1], lines: [] }; continue; }
    const finish = /^\[\s*(FAILED|OK)\s*\]\s+(\S+)/u.exec(line);
    if (finish && active?.name === finish[2]) {
      if (finish[1] === 'FAILED') tests.set(active.name, { name: active.name, ...excerpt(active.lines.join('\n')) });
      active = null;
    } else if (active) active.lines.push(line);
  }
  return { checkout: { source: 'console_header_and_git_reset', sha: header?.sha ?? null, branch: header?.branch ?? null,
    resetPrefix: reset ?? null, matched: matches, changedAfterTestStart: changedAfterStart },
    failures: [...tests.values()].slice(0, 12), failuresTruncated: tests.size > 12 };
}

async function responseText(response, maximum, { fatal = true } = {}) {
  if (!response.ok) throw failure([401, 403].includes(response.status) ? 'JENKINS_AUTH_REQUIRED' : 'JENKINS_READ_FAILED');
  if (Number(response.headers.get('content-length')) > maximum) throw failure('JENKINS_RESPONSE_TOO_LARGE');
  const reader = response.body?.getReader();
  if (!reader) throw failure('JENKINS_RESPONSE_INVALID');
  const chunks = []; let bytes = 0;
  try {
    for (;;) {
      const next = await reader.read(); if (next.done) break;
      bytes += next.value.byteLength;
      if (bytes > maximum) { void reader.cancel().catch(() => {}); throw failure('JENKINS_RESPONSE_TOO_LARGE'); }
      chunks.push(Buffer.from(next.value));
    }
    return new TextDecoder('utf-8', { fatal }).decode(Buffer.concat(chunks));
  } finally { reader.releaseLock(); }
}

export async function probeJenkinsConnection(value, { fetchImpl = fetch, signal } = {}) {
  try {
    const identity = jenkinsBuildIdentity(value.buildUrl);
    if (typeof value.username !== 'string' || !/^[^:\r\n\u0000]{1,128}$/u.test(value.username) ||
        typeof value.password !== 'string' || value.password.length === 0 || Buffer.byteLength(value.password) > 4096) throw failure('JENKINS_CONNECTION_UNAVAILABLE');
    const boundedSignal = signal ? AbortSignal.any([signal, AbortSignal.timeout(8000)]) : AbortSignal.timeout(8000);
    const response = await fetchImpl(`${identity.buildUrl}api/json`, { method: 'GET', redirect: 'manual', signal: boundedSignal,
      headers: { Authorization: `Basic ${Buffer.from(`${value.username}:${value.password}`).toString('base64')}`, Accept: 'application/json' } });
    const metadata = JSON.parse(await responseText(response, 524288));
    if (metadata.number !== identity.buildNumber || typeof metadata.building !== 'boolean') throw failure('JENKINS_RESPONSE_INVALID');
    return { state: 'available', buildNumber: metadata.number };
  } catch (error) {
    signal?.throwIfAborted();
    throw failure(error?.code === 'JENKINS_AUTH_REQUIRED' ? error.code : 'JENKINS_CONNECTION_UNAVAILABLE');
  }
}

export class JenkinsCiDiagnostics {
  #cache = new Map();
  constructor({ credentialSource, fetchImpl = fetch, clock = () => new Date() }) {
    if (typeof credentialSource?.acquire !== 'function' || typeof fetchImpl !== 'function') throw new TypeError('Jenkins diagnostics dependencies are invalid');
    Object.assign(this, { credentialSource, fetchImpl, clock });
  }

  async readBuild(request, { signal } = {}) {
    try { return await this.#readBuild(request, { signal }); }
    catch (error) {
      signal?.throwIfAborted();
      throw failure(/^JENKINS_[A-Z_]+$/u.test(error?.code ?? '') ? error.code : 'JENKINS_DIAGNOSTICS_UNAVAILABLE');
    }
  }

  async #readBuild(request, { signal } = {}) {
    signal?.throwIfAborted();
    const identity = jenkinsBuildIdentity(request.buildUrl);
    if (!sha.test(request.headRefOid) || typeof request.headRefName !== 'string') throw failure('JENKINS_BINDING_INVALID');
    const credential = await this.credentialSource.acquire(request, { signal });
    if (typeof credential?.username !== 'string' || typeof credential.password !== 'string' || credential.password.length === 0) throw failure('JENKINS_CONNECTION_UNAVAILABLE');
    const key = digest({ repository: request.repository, ...identity, headRefOid: request.headRefOid,
      headRefName: request.headRefName, credentialVersion: credential.version });
    const now = new Date(this.clock()).getTime();
    const cached = this.#cache.get(key);
    if (cached && now >= cached.at && now - cached.at < 120000) return structuredClone(cached.value);
    const authorization = `Basic ${Buffer.from(`${credential.username}:${credential.password}`).toString('base64')}`;
    const controller = new AbortController();
    const boundedSignal = AbortSignal.any([...(signal ? [signal] : []), AbortSignal.timeout(12000), controller.signal]);
    const read = async (suffix, maximum) => {
      const response = await this.fetchImpl(`${identity.buildUrl}${suffix}`, {
        method: 'GET', redirect: 'manual', signal: boundedSignal, headers: { Authorization: authorization, Accept: suffix === 'api/json' ? 'application/json' : 'text/plain' },
      });
      const text = await responseText(response, maximum, { fatal: suffix === 'api/json' });
      if (/^\s*(?:<!doctype|<html|<form)/iu.test(text)) throw failure('JENKINS_AUTH_REQUIRED');
      return text;
    };
    let metadataText, consoleText;
    try { [metadataText, consoleText] = await Promise.all([read('api/json', 524288), read('consoleText', 2 * 1024 * 1024)]); }
    catch (error) { controller.abort(); throw error; }
    const metadata = JSON.parse(metadataText);
    if (metadata.number !== identity.buildNumber || typeof metadata.building !== 'boolean') throw failure('JENKINS_RESPONSE_INVALID');
    const secrets = [credential.password, Buffer.from(credential.password).toString('base64'), encodeURIComponent(credential.password), authorization, authorization.slice(6)];
    const redactedConsole = redact(consoleText, secrets);
    const parsed = parseRedactedJenkinsConsole(redactedConsole, request);
    const value = { schemaVersion: 1, buildUrl: identity.buildUrl, buildNumber: identity.buildNumber,
      repository: request.repository, headRefOid: request.headRefOid, observedAt: new Date(this.clock()).toISOString(),
      state: !parsed.checkout.matched ? 'version_mismatch' : metadata.building ? 'building' : 'available',
      result: ['SUCCESS', 'FAILURE', 'UNSTABLE', 'ABORTED', 'NOT_BUILT'].includes(metadata.result) ? metadata.result : null,
      // Keep full console identity before excerpts are bounded for model context.
      materialDigest: digest({ domain: 'mydashboard-jenkins-build-material/v1',
        repository: request.repository, headRefOid: request.headRefOid,
        buildUrl: identity.buildUrl, buildNumber: metadata.number, checkout: parsed.checkout,
        building: metadata.building, result: metadata.result, console: redactedConsole }),
      consoleHasReplacementCharacters: consoleText.includes('\uFFFD'),
      untrustedEvidence: true, ...parsed };
    if (!parsed.checkout.matched) value.failures = [];
    if (parsed.checkout.matched && metadata.result === 'FAILURE' && value.failures.length === 0) {
      value.failureSummary = excerpt(redactedConsole, 3000);
    }
    value.contentDigest = digest(value);
    if (!metadata.building) {
      if (this.#cache.size >= 32) this.#cache.delete(this.#cache.keys().next().value);
      this.#cache.set(key, { at: now, value });
    }
    return structuredClone(value);
  }

  async read({ repository, headRefOid, headRefName, checks, maximumBytes = 12000 }, { signal } = {}) {
    if (!Number.isSafeInteger(maximumBytes) || maximumBytes < 256 || maximumBytes > 16384) return null;
    const reports = [];
    const candidates = checks.filter(check => {
      if (!['FAILURE', 'ERROR', 'TIMED_OUT', 'ACTION_REQUIRED'].includes(check.conclusion) || !check.url) return false;
      try { jenkinsBuildIdentity(check.url); return true; } catch { return false; }
    }).slice(0, 3);
    for (const check of candidates) {
      signal?.throwIfAborted();
      try { reports.push({ check: check.name, ...await this.readBuild({ repository, headRefOid, headRefName, buildUrl: check.url }, { signal }) }); }
      catch (error) {
        signal?.throwIfAborted();
        reports.push({ check: check.name, state: 'unavailable', code: ['JENKINS_AUTH_REQUIRED', 'JENKINS_CONNECTION_UNAVAILABLE', 'JENKINS_RESPONSE_TOO_LARGE'].includes(error?.code) ? error.code : 'JENKINS_DIAGNOSTICS_UNAVAILABLE' });
      }
    }
    if (reports.length === 0) return null;
    const result = { schemaVersion: 1, repository, headRefOid, reports };
    for (const maximum of [2000, 512, 0]) {
      for (const report of reports) if (report.failures) {
        report.failures = report.failures.map(item => ({ ...item, ...excerpt(item.text, maximum) }));
        delete report.contentDigest;
        report.contentDigest = digest(report);
      }
      for (const report of reports) if (report.failureSummary) {
        report.failureSummary = excerpt(report.failureSummary.text, maximum);
        delete report.contentDigest; report.contentDigest = digest(report);
      }
      result.contentDigest = digest({ schemaVersion: result.schemaVersion, repository, headRefOid, reports });
      if (Buffer.byteLength(JSON.stringify(result)) <= maximumBytes) return result;
    }
    return null;
  }
}
