import { encodeVerificationRecoveryEvidence, decodeVerificationRecoveryEvidence } from './verification-recovery-evidence.js';

export const INSPECTION_ENVIRONMENT_RECOVERY_REASON = 'automatic_inspection_environment_restored';
export const INSPECTION_ENVIRONMENT_PROOF_REASON = 'docker_prestart_environment_restored';

export function encodeInspectionEnvironmentEvidence(value) {
  if (!/^sha256:[a-f0-9]{64}$/u.test(value?.imageId ?? '')) throw new TypeError('Invalid inspection environment image');
  return [...encodeVerificationRecoveryEvidence(value), `docker-image:${value.imageId}`];
}

export function decodeInspectionEnvironmentEvidence(refs) {
  if (!Array.isArray(refs) || refs.length !== 7) return null;
  const image = refs.filter(ref => typeof ref === 'string' && ref.startsWith('docker-image:'));
  const identity = decodeVerificationRecoveryEvidence(refs.filter(ref => !image.includes(ref)));
  if (!identity || image.length !== 1 || !/^docker-image:sha256:[a-f0-9]{64}$/u.test(image[0])) return null;
  return { ...identity, imageId: image[0].slice('docker-image:'.length) };
}
