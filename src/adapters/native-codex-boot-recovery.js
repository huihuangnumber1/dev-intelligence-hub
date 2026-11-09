import { lstat, mkdir, realpath, rename } from 'node:fs/promises';
import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { StateStore } from '../lib/state-store.js';
import { normalizeWindowsBootIdentity } from '../lib/windows-boot-identity.js';
import { nativeCodexHomeIdentity } from './codex-native-session-store.js';
import { readNativeJsonArtifact } from './native-codex-marker-identity.js';

const UUID = '[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}';
const ENTITY = new RegExp(`^(?:[a-f0-9]{64}|${UUID})$`);
const REASON = 'windows_boot_changed_after_quarantine';
const invalid = () => Object.assign(new Error('Native boot recovery evidence is invalid'), { code: 'NATIVE_BOOT_RECOVERY_INVALID' });
const exact = (value, keys) => value && Object.keys(value).sort().join(',') === [...keys].sort().join(',');
const timestamp = value => typeof value === 'string' && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;
const sameBoot = (left, right) => left.machineDigest === right.machineDigest && left.startedAt === right.startedAt && left.recordId === right.recordId;

async function regularDirectory(directory) {
  const info = await lstat(directory);
  if (!info.isDirectory() || info.isSymbolicLink() || nativeCodexHomeIdentity(await realpath(directory)) !== nativeCodexHomeIdentity(directory)) throw invalid();
}

async function optionalArtifact(file) {
  try { await lstat(file); }
  catch (error) { if (error.code === 'ENOENT') return undefined; throw error; }
  const artifact = await readNativeJsonArtifact(file, 64 * 1024);
  if (!artifact) throw invalid();
  return artifact.value;
}

function validMarker(record, prefix, now) {
  return exact(record, ['name', 'digest', 'entity', 'invocation', 'createdAt']) &&
    new RegExp(`^${prefix}(?:-${UUID})?\\.json$`).test(record.name) && /^[a-f0-9]{64}$/.test(record.digest) &&
    ENTITY.test(record.entity) && new RegExp(`^(?:invocation|probe)-${UUID}$`).test(record.invocation) &&
    Number.isSafeInteger(record.createdAt) && record.createdAt >= 0 && record.createdAt <= now;
}

function validSnapshot(value, prefix, now) {
  return exact(value, ['schemaVersion', 'prefix', 'boot', 'capturedAt', 'markers']) && value.schemaVersion === 1 &&
    value.prefix === prefix && normalizeWindowsBootIdentity(value.boot, now) && timestamp(value.capturedAt) &&
    Date.parse(value.capturedAt) <= now && Date.parse(value.boot.startedAt) <= Date.parse(value.capturedAt) &&
    Array.isArray(value.markers) && value.markers.length <= 32 &&
    value.markers.every(record => validMarker(record, prefix, Date.parse(value.capturedAt))) &&
    new Set(value.markers.map(record => record.name)).size === value.markers.length &&
    new Set(value.markers.map(record => record.invocation)).size === value.markers.length;
}

function newBootAfterSnapshot(snapshot, boot) {
  return snapshot.boot.machineDigest === boot.machineDigest && snapshot.boot.recordId !== boot.recordId &&
    Date.parse(boot.startedAt) > Date.parse(snapshot.capturedAt) &&
    boot.uptimeMs + 1000 < snapshot.boot.uptimeMs;
}

function validReceipt(value, snapshot, marker, now, currentBoot) {
  return exact(value, ['schemaVersion', 'prefix', 'marker', 'previousBoot', 'currentBoot', 'quarantinedAt', 'recoveredAt', 'reason']) &&
    value.schemaVersion === 1 && value.prefix === snapshot.prefix && value.reason === REASON &&
    isDeepStrictEqual(value.marker, marker) && isDeepStrictEqual(value.previousBoot, snapshot.boot) &&
    value.quarantinedAt === snapshot.capturedAt && normalizeWindowsBootIdentity(value.currentBoot, now) &&
    newBootAfterSnapshot(snapshot, value.currentBoot) && timestamp(value.recoveredAt) &&
    Date.parse(value.recoveredAt) >= Date.parse(value.currentBoot.startedAt) && Date.parse(value.recoveredAt) <= now &&
    currentBoot.machineDigest === value.currentBoot.machineDigest &&
    Date.parse(currentBoot.startedAt) >= Date.parse(value.currentBoot.startedAt);
}

function recoveryPaths(root, prefix, marker) {
  const receiptKey = `boot-recovery-${prefix.slice(7)}-${marker.digest}`;
  return { file: path.join(root, marker.name), archive: path.join(root, 'recovered-invocations', marker.name),
    receipt: path.join(root, `${receiptKey}.json`), receiptKey };
}

// Current-boot observations only seal evidence. Releasing an old invocation
// requires a later same-machine kernel boot and an independently reset uptime.
export async function reconcileNativeBootRecovery({ root, prefix, entries, bootIdentity, clock = Date.now,
  store = new StateStore(root), renameMarker = rename }) {
  const now = clock();
  if (!/^active-[a-f0-9]{64}$/.test(prefix) || !Array.isArray(entries) || entries.length > 32 || !Number.isSafeInteger(now)) throw invalid();
  const boot = normalizeWindowsBootIdentity(bootIdentity, now);
  await regularDirectory(root);
  const key = `boot-quarantine-${prefix.slice(7)}`;
  const snapshotFile = path.join(root, `${key}.json`);
  const snapshot = await optionalArtifact(snapshotFile);
  if (snapshot !== undefined && (!validSnapshot(snapshot, prefix, now) || !boot ||
      snapshot.boot.machineDigest !== boot.machineDigest)) throw invalid();
  if (!boot) return { entries, recovered: [], sealed: false };
  const markerRecords = [];
  for (const entry of entries) {
    if (nativeCodexHomeIdentity(path.dirname(entry.file)) !== nativeCodexHomeIdentity(root)) throw invalid();
    const artifact = await readNativeJsonArtifact(entry.file, 4096);
    const marker = artifact?.value;
    const record = { name: path.basename(entry.file), digest: artifact?.digest, entity: entry.entity,
      invocation: marker?.invocation, createdAt: marker?.createdAt };
    const keys = marker?.schemaVersion === 2 ? ['schemaVersion', 'invocation', 'createdAt', 'entity'] : ['schemaVersion', 'invocation', 'createdAt'];
    if (![1, 2].includes(marker?.schemaVersion) || !exact(marker, keys) ||
        (marker.schemaVersion === 2 && marker.entity !== entry.entity) || !validMarker(record, prefix, now)) throw invalid();
    markerRecords.push(record);
  }
  if (new Set(markerRecords.map(record => record.name)).size !== markerRecords.length ||
      new Set(markerRecords.map(record => record.invocation)).size !== markerRecords.length) throw invalid();
  markerRecords.sort((left, right) => left.name < right.name ? -1 : left.name > right.name ? 1 : 0);
  if (snapshot === undefined) {
    if (!markerRecords.length) return { entries, recovered: [], sealed: false };
    await store.write(key, { schemaVersion: 1, prefix, boot, capturedAt: new Date(now).toISOString(), markers: markerRecords });
    return { entries, recovered: [], sealed: true };
  }
  for (const marker of markerRecords) {
    const sealed = snapshot.markers.find(record => record.name === marker.name);
    if (sealed && !isDeepStrictEqual(sealed, marker)) throw invalid();
  }
  const recovered = [];
  for (const marker of snapshot.markers.filter(record => !markerRecords.some(current => current.name === record.name))) {
    const paths = recoveryPaths(root, prefix, marker);
    const saved = await optionalArtifact(paths.receipt);
    if (saved === undefined) throw invalid();
    if (!validReceipt(saved, snapshot, marker, now, boot)) throw invalid();
    await regularDirectory(path.dirname(paths.archive));
    if ((await readNativeJsonArtifact(paths.archive, 4096))?.digest !== marker.digest) throw invalid();
    recovered.push({ file: paths.file, archive: paths.archive, receipt: paths.receipt });
  }
  if (sameBoot(snapshot.boot, boot)) {
    if (!isDeepStrictEqual(snapshot.markers, markerRecords)) {
      await store.write(key, { ...snapshot, boot, capturedAt: new Date(now).toISOString(), markers: markerRecords });
    }
    return { entries, recovered, sealed: true };
  }
  for (const marker of markerRecords) {
    if (!snapshot.markers.some(record => isDeepStrictEqual(record, marker))) continue;
    const { receiptKey, receipt, file: original, archive } = recoveryPaths(root, prefix, marker);
    const saved = await optionalArtifact(receipt);
    if (saved !== undefined && !validReceipt(saved, snapshot, marker, now, boot)) throw invalid();
    if (saved === undefined && !newBootAfterSnapshot(snapshot, boot)) continue;
    if (saved === undefined) await store.write(receiptKey, { schemaVersion: 1, prefix, marker, previousBoot: snapshot.boot,
      currentBoot: boot, quarantinedAt: snapshot.capturedAt, recoveredAt: new Date(now).toISOString(), reason: REASON });
    const archiveDirectory = path.join(root, 'recovered-invocations');
    await mkdir(archiveDirectory, { recursive: true, mode: 0o700 });
    await regularDirectory(archiveDirectory);
    const current = await readNativeJsonArtifact(original, 4096);
    if (current?.digest !== marker.digest) throw invalid();
    try { await lstat(archive); throw invalid(); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    await renameMarker(original, archive);
    recovered.push({ file: original, archive, receipt });
  }
  if (recovered.length) {
    const remaining = markerRecords.filter(record => !recovered.some(entry => path.basename(entry.file) === record.name));
    // Keep completed transaction witnesses until another invocation needs a new
    // seal. A lost rename ACK must remain recoverable without an active file.
    if (remaining.length) await store.write(key, { schemaVersion: 1, prefix, boot, capturedAt: new Date(now).toISOString(), markers: remaining });
  }
  return { entries: entries.filter(entry => !recovered.some(record => record.file === entry.file)), recovered, sealed: true };
}
