const ID = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/u;
const SHA256 = /^[a-f0-9]{64}$/u;
const FIELDS = [
  ['headRefOid', 'head:', /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u],
  ['actionId', 'action:', ID],
  ['executionId', 'execution:', ID],
  ['profileId', 'profile:', ID],
  ['profileConfigDigest', 'profile-config:', SHA256],
  ['workspaceRevision', 'workspace:', SHA256],
];

export function encodeVerificationRecoveryEvidence(value) {
  return FIELDS.map(([field, prefix, pattern]) => {
    if (typeof value?.[field] !== 'string' || !pattern.test(value[field])) throw new TypeError('Invalid verification recovery evidence');
    return `${prefix}${value[field]}`;
  });
}

export function decodeVerificationRecoveryEvidence(references) {
  if (!Array.isArray(references) || references.length !== FIELDS.length || references.some(ref => typeof ref !== 'string')) return null;
  const result = {};
  for (const [field, prefix, pattern] of FIELDS) {
    const matches = references.filter(ref => ref.startsWith(prefix));
    if (matches.length !== 1 || !pattern.test(matches[0].slice(prefix.length))) return null;
    result[field] = matches[0].slice(prefix.length);
  }
  return Object.freeze(result);
}
