import { types } from 'node:util';
import { canonicalJsonDigest, canonicalJsonStringify } from '../lib/canonical-json-digest.js';

export const MAX_CI_REPAIR_EVIDENCE_BYTES = 16 * 1024;
export const FAILED_CI_CONCLUSIONS = new Set(['FAILURE', 'ERROR', 'TIMED_OUT', 'ACTION_REQUIRED', 'STARTUP_FAILURE']);
const FIELDS = ['schemaVersion', 'repository', 'number', 'headRefOid', 'headRefName', 'checks', 'diagnostics'];
const REPORT_FIELDS = new Set(['check', 'schemaVersion', 'buildUrl', 'buildNumber', 'repository', 'headRefOid',
  'state', 'result', 'consoleHasReplacementCharacters', 'untrustedEvidence', 'checkout', 'failures',
  'failuresTruncated', 'failureSummary', 'code', 'observedAt', 'contentDigest', 'materialDigest']);
const oid = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u;
const invalid = () => Object.assign(new Error('CI 修复证据无效'), { code: 'CI_REPAIR_EVIDENCE_INVALID' });

function fields(value) {
  if (!value || typeof value !== 'object' || types.isProxy(value) || Object.getPrototypeOf(value) !== Object.prototype) throw invalid();
  const entries = [];
  for (const key of Reflect.ownKeys(value)) {
    const property = Object.getOwnPropertyDescriptor(value, key);
    if (typeof key !== 'string' || ['__proto__', 'prototype', 'constructor'].includes(key) ||
        !property?.enumerable || !Object.hasOwn(property, 'value')) throw invalid();
    entries.push([key, property.value]);
  }
  return entries;
}
function exact(value, expected) {
  const entries = fields(value);
  if (entries.length !== expected.length || expected.some(key => !entries.some(([name]) => key === name))) throw invalid();
  return Object.fromEntries(entries);
}
function text(value, maximum, { multiline = false } = {}) {
  if (typeof value !== 'string' || !value || Buffer.byteLength(value) > maximum ||
      (multiline ? /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u : /[\u0000-\u001f\u007f]/u).test(value)) throw invalid();
  return value;
}
function array(value, maximum) {
  if (!Array.isArray(value) || types.isProxy(value) || Object.getPrototypeOf(value) !== Array.prototype || value.length > maximum ||
      Reflect.ownKeys(value).length !== value.length + 1) throw invalid();
  return Array.from({ length: value.length }, (_, index) => {
    const property = Object.getOwnPropertyDescriptor(value, String(index));
    if (!property?.enumerable || !Object.hasOwn(property, 'value')) throw invalid();
    return property.value;
  });
}
function json(value, depth = 0) {
  if (depth > 12) throw invalid();
  if (value === null || typeof value === 'boolean' || (typeof value === 'number' && Number.isFinite(value))) return value;
  if (typeof value === 'string') return value === '' ? '' : text(value, MAX_CI_REPAIR_EVIDENCE_BYTES, { multiline: true });
  if (Array.isArray(value)) return array(value, 128).map(entry => json(entry, depth + 1));
  const entries = fields(value); if (entries.length > 64) throw invalid();
  return Object.fromEntries(entries.map(([key, entry]) => [key, json(entry, depth + 1)]));
}
function check(value) {
  const item = exact(value, ['kind', 'name', 'url', 'conclusion']);
  if (!['check_run', 'status_context'].includes(item.kind) || !FAILED_CI_CONCLUSIONS.has(item.conclusion)) throw invalid();
  text(item.name, 512);
  if (item.url !== null) {
    text(item.url, 2048); const url = new URL(item.url);
    if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password) throw invalid();
  }
  return { kind: item.kind, name: item.name, url: item.url, conclusion: item.conclusion };
}
function stableReport(value, material) {
  const entries = fields(value);
  if (entries.some(([key]) => !REPORT_FIELDS.has(key))) throw invalid();
  const report = json(Object.fromEntries(entries.filter(([key]) => !['observedAt', 'contentDigest'].includes(key))));
  if (Object.hasOwn(report, 'materialDigest') &&
      (typeof report.materialDigest !== 'string' || !/^[a-f0-9]{64}$/u.test(report.materialDigest))) throw invalid();
  const matching = material.checks.filter(check => check.name === report.check);
  if (matching.length === 0 || !['available', 'building', 'version_mismatch', 'unavailable'].includes(report.state)) throw invalid();
  if (report.buildUrl && !matching.some(check => check.url === report.buildUrl)) throw invalid();
  if (report.state === 'available' && (report.repository !== material.repository || report.headRefOid !== material.headRefOid ||
      report.checkout?.matched !== true || report.checkout.sha !== material.headRefOid || report.checkout.branch !== material.headRefName ||
      !report.buildUrl || report.untrustedEvidence !== true)) throw invalid();
  return report;
}

export function createCiRepairEvidence(value) {
  try {
    const input = exact(value, FIELDS);
    if (input.schemaVersion !== 1 || !/^[A-Za-z0-9-]+\/[A-Za-z0-9_.-]+$/u.test(text(input.repository, 140)) ||
        !Number.isSafeInteger(input.number) || input.number < 1 || !oid.test(text(input.headRefOid, 64))) throw invalid();
    text(input.headRefName, 512);
    const checks = array(input.checks, 32).map(check).sort((a, b) => canonicalJsonStringify(a).localeCompare(canonicalJsonStringify(b), 'en'));
    if (!checks.length || new Set(checks.map(entry => JSON.stringify(entry))).size !== checks.length) throw invalid();
    const material = { schemaVersion: 1, repository: input.repository, number: input.number,
      headRefOid: input.headRefOid, headRefName: input.headRefName, checks };
    const triggerDigest = canonicalJsonDigest(material);
    material.diagnostics = array(input.diagnostics, 3).map(report => stableReport(report, material))
      .sort((a, b) => canonicalJsonStringify(a).localeCompare(canonicalJsonStringify(b), 'en'));
    const result = { ...material, triggerDigest, contentDigest: canonicalJsonDigest({ ...material, triggerDigest }) };
    if (Buffer.byteLength(JSON.stringify(result)) > MAX_CI_REPAIR_EVIDENCE_BYTES) throw invalid();
    return result;
  } catch { throw invalid(); }
}

export function normalizeCiRepairEvidence(value) {
  const input = exact(value, [...FIELDS, 'triggerDigest', 'contentDigest']);
  const { contentDigest, triggerDigest, ...material } = input;
  const normalized = createCiRepairEvidence(material);
  if (contentDigest !== normalized.contentDigest || triggerDigest !== normalized.triggerDigest) throw invalid();
  return normalized;
}
