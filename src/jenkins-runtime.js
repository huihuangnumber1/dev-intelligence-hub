import path from 'node:path';
import { projectIdentityDigest } from './lib/project-identity.js';
import { JenkinsConnectionStore } from './services/jenkins-connection-store.js';
import { JenkinsCiDiagnostics, probeJenkinsConnection } from './services/jenkins-ci-diagnostics.js';

export function createJenkinsRuntime({ projectRoot, privateRuntimeDirectory, fetchImpl = fetch, connectionStore }) {
  if (typeof privateRuntimeDirectory !== 'string' || !path.isAbsolute(privateRuntimeDirectory)) return null;
  const projectDigest = projectIdentityDigest({ projectRoot });
  if (path.basename(privateRuntimeDirectory).toLowerCase() !== projectDigest) return null;
  const credentials = connectionStore ?? new JenkinsConnectionStore({
    directory: path.join(privateRuntimeDirectory, 'jenkins-credentials-v1'), projectDigest,
  });
  const diagnostics = new JenkinsCiDiagnostics({ credentialSource: credentials, fetchImpl });
  return Object.freeze({
    connection: Object.freeze({
      status: options => credentials.status(options),
      async connect(value, options) {
        if (typeof value?.repository !== 'string' || !/^[\w.-]+\/[\w.-]+$/u.test(value.repository)) throw Object.assign(new Error('Jenkins 仓库无效'), { statusCode: 400 });
        try {
          await probeJenkinsConnection(value, { fetchImpl, ...options });
          return { ...await credentials.set(value, options), state: 'available' };
        } catch (error) {
          options?.signal?.throwIfAborted();
          throw Object.assign(new Error(error?.code === 'JENKINS_AUTH_REQUIRED' ? 'Jenkins 认证失败，请检查账号或 API Token' : '暂时无法连接 Jenkins 构建'),
            { code: error?.code === 'JENKINS_AUTH_REQUIRED' ? error.code : 'JENKINS_CONNECTION_UNAVAILABLE', statusCode: 400 });
        }
      },
    }),
    diagnostics: Object.freeze({ read: (value, options) => diagnostics.read(value, options) }),
  });
}
