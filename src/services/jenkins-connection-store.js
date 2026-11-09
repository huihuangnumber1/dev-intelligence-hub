import { createHash } from 'node:crypto';
import { lstat, realpath } from 'node:fs/promises';
import path from 'node:path';
import { StateStore } from '../lib/state-store.js';
import { OperationQueue } from '../lib/operation-queue.js';
import { PRODUCTION_PRIVATE_DIRECTORY_MANAGER } from '../lib/private-directory-manager.js';
import { WindowsDpapi } from '../lib/windows-dpapi.js';

const unavailable = () => Object.assign(new Error('Jenkins connection is unavailable'), { code: 'JENKINS_CONNECTION_UNAVAILABLE' });
const digest = value => createHash('sha256').update(value).digest('hex');

export function jenkinsBuildIdentity(value) {
  if (typeof value !== 'string' || value.length > 2048 || /[\u0000-\u0020\\]/u.test(value)) throw unavailable();
  const url = new URL(value);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash || /%2f|%5c|%00|%2e/iu.test(url.pathname)) throw unavailable();
  const match = /^(.*\/(?:job\/[^/]+\/)+)([1-9][0-9]*)\/$/u.exec(url.pathname);
  if (!match || !Number.isSafeInteger(Number(match[2]))) throw unavailable();
  return { buildUrl: url.href, origin: url.origin, jobPath: match[1], buildNumber: Number(match[2]) };
}

function credentials(value) {
  if (typeof value?.username !== 'string' || !/^[^:\r\n\u0000]{1,128}$/u.test(value.username) ||
      typeof value?.password !== 'string' || value.password.length < 1 || Buffer.byteLength(value.password) > 4096 || /[\r\n\u0000]/u.test(value.password)) throw unavailable();
  return { username: value.username, password: value.password };
}

export class JenkinsConnectionStore {
  #queue = new OperationQueue();
  #identity;
  #cached;

  constructor({ directory, projectDigest, protector = new WindowsDpapi(), privateDirectoryManager = PRODUCTION_PRIVATE_DIRECTORY_MANAGER, clock = () => new Date() }) {
    if (!path.isAbsolute(directory) || !/^[a-f0-9]{64}$/u.test(projectDigest)) throw unavailable();
    Object.assign(this, { directory: path.resolve(directory), projectDigest, protector, privateDirectoryManager, clock });
    this.store = new StateStore(this.directory);
  }

  async #prepare(signal) {
    signal?.throwIfAborted();
    if (this.#identity) {
      const info = await lstat(this.directory, { bigint: true });
      const canonical = await realpath(this.directory);
      const samePath = process.platform === 'win32' ? canonical.toLowerCase() === this.directory.toLowerCase() : canonical === this.directory;
      if (!info.isDirectory() || info.isSymbolicLink() || !samePath || info.dev.toString() !== this.#identity.device || info.ino.toString() !== this.#identity.inode) throw unavailable();
      return;
    }
    const identity = await this.privateDirectoryManager.prepare({ directory: this.directory, signal: signal ?? null,
      validateLocation: () => { if (path.basename(this.directory) !== 'jenkins-credentials-v1') throw unavailable(); } });
    if (!identity || identity.path !== this.directory || await realpath(this.directory) !== this.directory) throw unavailable();
    if (this.#identity && (this.#identity.device !== identity.device || this.#identity.inode !== identity.inode)) throw unavailable();
    this.#identity = identity;
  }

  async #record(signal) {
    await this.#prepare(signal);
    try {
      const file = await lstat(path.join(this.directory, 'connection.json'));
      if (!file.isFile() || file.isSymbolicLink() || file.nlink !== 1 || file.size > 32768) throw unavailable();
    } catch (error) { if (error?.code === 'ENOENT') return null; throw unavailable(); }
    const row = await this.store.read('connection', null, { signal });
    await this.#prepare(signal);
    if (row?.schemaVersion !== 1 || row.projectDigest !== this.projectDigest || typeof row.ciphertext !== 'string' || row.ciphertext.length > 24000 ||
        typeof row.repository !== 'string' || !/^[\w.-]+\/[\w.-]+$/u.test(row.repository)) throw unavailable();
    const identity = jenkinsBuildIdentity(row.buildUrl);
    if (identity.origin !== row.origin || identity.jobPath !== row.jobPath) throw unavailable();
    return row;
  }

  #entropy(row) { return Buffer.from(digest(`${this.projectDigest}\n${row.repository}\n${row.origin}\n${row.jobPath}`), 'hex'); }

  #run(operation, signal) {
    return this.#queue.enqueue(async () => {
      try { return await operation(); }
      catch { signal?.throwIfAborted(); throw unavailable(); }
    });
  }

  status(options = {}) {
    return this.#run(async () => {
      const row = await this.#record(options.signal);
      return row ? { configured: true, repository: row.repository, buildUrl: row.buildUrl, username: row.username, updatedAt: row.updatedAt } : { configured: false };
    }, options.signal);
  }

  set(value, options = {}) {
    return this.#run(async () => {
      const identity = jenkinsBuildIdentity(value.buildUrl);
      const secret = credentials(value);
      if (typeof value.repository !== 'string' || !/^[\w.-]+\/[\w.-]+$/u.test(value.repository)) throw unavailable();
      await this.#prepare(options.signal);
      const row = { schemaVersion: 1, projectDigest: this.projectDigest, ...identity, repository: value.repository,
        username: secret.username, updatedAt: new Date(this.clock()).toISOString() };
      const plain = Buffer.from(JSON.stringify({ ...secret, repository: row.repository, origin: row.origin, jobPath: row.jobPath }));
      try { row.ciphertext = (await this.protector.protect(plain, this.#entropy(row), options)).toString('base64'); }
      finally { plain.fill(0); }
      await this.#prepare(options.signal);
      await this.store.write('connection', row);
      await this.#prepare(options.signal);
      this.#cached = null;
      return { configured: true, repository: row.repository, buildUrl: row.buildUrl, username: row.username, updatedAt: row.updatedAt };
    }, options.signal);
  }

  acquire(request, options = {}) {
    return this.#run(async () => {
      const identity = jenkinsBuildIdentity(request.buildUrl);
      const row = await this.#record(options.signal);
      if (!row || request.repository !== row.repository || identity.origin !== row.origin || identity.jobPath !== row.jobPath) throw unavailable();
      const version = digest(row.ciphertext);
      if (this.#cached?.version !== version) {
        const bytes = await this.protector.unprotect(Buffer.from(row.ciphertext, 'base64'), this.#entropy(row), options);
        let decoded;
        try { decoded = JSON.parse(bytes.toString('utf8')); } finally { bytes.fill(0); }
        const secret = credentials(decoded);
        if (decoded.repository !== row.repository || decoded.origin !== row.origin || decoded.jobPath !== row.jobPath) throw unavailable();
        this.#cached = { version, ...secret };
      }
      return { username: this.#cached.username, password: this.#cached.password, version };
    }, options.signal);
  }
}
