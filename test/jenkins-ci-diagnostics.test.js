import test from 'node:test';
import assert from 'node:assert/strict';
import { JenkinsCiDiagnostics, parseJenkinsGoogleTestConsole } from '../src/services/jenkins-ci-diagnostics.js';
import { jenkinsBuildIdentity } from '../src/services/jenkins-connection-store.js';

const HEAD = 'a'.repeat(40), BRANCH = 'feature/fix';
const BUILD = 'http://jenkins.example:8080/job/QuickTest/123/';
const log = `HEAD is now at ${HEAD.slice(0, 11)} merge base
[INFO] Branch: ${BRANCH}  SHA: ${HEAD}
[ RUN      ] CodeTest.Formatting
source/one.cpp:12: Failure
Expected no hard-coded date format
[  FAILED  ] CodeTest.Formatting (12 ms)
[ RUN      ] CodeTest.Includes
test/synthetic.cpp:1: Missing include for Widget.h
[  FAILED  ] CodeTest.Includes (18 ms)
[ RUN      ] CodeTest.Duplicates
same block at lines 20 and 40
[  FAILED  ] CodeTest.Duplicates (5 ms)
[  FAILED  ] 3 tests, listed below:
[  FAILED  ] CodeTest.Formatting
[  FAILED  ] CodeTest.Includes
[  FAILED  ] CodeTest.Duplicates
Finished: FAILURE
`;
const request = { repository: 'acme/repo', headRefOid: HEAD, headRefName: BRANCH, buildUrl: BUILD };

function fixture({ consoleText = log, metadata = { number: 123, building: false, result: 'FAILURE' } } = {}) {
  const calls = [];
  const credentialSource = { async acquire(value) {
    assert.equal(value.repository, 'acme/repo');
    const identity = jenkinsBuildIdentity(value.buildUrl);
    if (identity.origin !== 'http://jenkins.example:8080' || identity.jobPath !== '/job/QuickTest/') throw Object.assign(new Error('not allowed'), { code: 'JENKINS_CONNECTION_UNAVAILABLE' });
    return { username: 'fixture-user', password: 'fixture-secret', version: 'v1' };
  } };
  const fetchImpl = async (url, options) => {
    calls.push({ url, options });
    assert.equal(options.method, 'GET'); assert.equal(options.redirect, 'manual');
    assert.equal(options.headers.Authorization, `Basic ${Buffer.from('fixture-user:fixture-secret').toString('base64')}`);
    return new Response(url.endsWith('api/json') ? JSON.stringify(metadata) : consoleText);
  };
  return { calls, credentialSource, fetchImpl, create: overrides => new JenkinsCiDiagnostics({ credentialSource, fetchImpl, ...overrides }) };
}

test('real Jenkins Google Test layout yields exact final checkout and three distinct failures', () => {
  const parsed = parseJenkinsGoogleTestConsole(log, request);
  assert.equal(parsed.checkout.matched, true);
  assert.deepEqual(parsed.failures.map(item => item.name), ['CodeTest.Formatting', 'CodeTest.Includes', 'CodeTest.Duplicates']);
  assert.match(parsed.failures[1].text, /Missing include for Widget/);
});

for (const [name, text] of [
  ['wrong head', log.replaceAll(HEAD, 'b'.repeat(40)).replaceAll(HEAD.slice(0, 11), 'b'.repeat(11))],
  ['wrong branch', log.replace(BRANCH, 'other')],
  ['later reset', log.replace('[ RUN      ]', `git reset --hard ${'b'.repeat(40)}\n[ RUN      ]`)],
  ['reset during tests', `${log}\nHEAD is now at ${HEAD.slice(0, 11)} later reset`],
  ['missing reset proof', log.replace(/^HEAD[^\n]+\n/u, '')],
]) test(`diagnostics never attribute ${name} to the current Head`, () => {
  assert.equal(parseJenkinsGoogleTestConsole(text, request).checkout.matched, false);
});

test('reader uses only the two bounded authenticated GET endpoints and caches matched completed reports', async () => {
  const f = fixture(), reader = f.create();
  const report = await reader.readBuild(request);
  assert.equal(report.state, 'available'); assert.equal(report.result, 'FAILURE');
  assert.equal(report.failures.length, 3); assert.equal(report.untrustedEvidence, true);
  assert.deepEqual(f.calls.map(call => call.url).sort(), [`${BUILD}api/json`, `${BUILD}consoleText`]);
  assert.deepEqual(await reader.readBuild(request), report);
  assert.equal(f.calls.length, 2);
});

test('old checkout diagnostics retain mismatch evidence and expose no old failure instructions', async () => {
  const f = fixture(); const report = await f.create().readBuild({ ...request, headRefOid: 'b'.repeat(40) });
  assert.equal(report.state, 'version_mismatch'); assert.deepEqual(report.failures, []);
  assert.equal(report.checkout.sha, HEAD);
});

for (const buildUrl of ['http://other.example/job/QuickTest/123/', 'http://jenkins.example:8080/job/Secret/123/',
  `${BUILD}?anything=1`, `${BUILD}#fragment`, 'http://user:secret@jenkins.example:8080/job/QuickTest/123/',
  'http://jenkins.example:8080/job/QuickTest/%2e%2e/123/']) {
  test('foreign or malformed targets receive no authenticated request', async () => {
    const f = fixture(); await assert.rejects(f.create().readBuild({ ...request, buildUrl })); assert.equal(f.calls.length, 0);
  });
}

test('redirects, authentication failures and login HTML remain unavailable without following a redirect', async () => {
  for (const response of [new Response(null, { status: 302, headers: { Location: 'http://other.example/' } }),
    new Response('forbidden', { status: 403 }), new Response('<html>Sign in to Jenkins</html>')]) {
    const f = fixture(); let calls = 0;
    const reader = f.create({ fetchImpl: async (_url, options) => { calls++; assert.equal(options.redirect, 'manual'); return response.clone(); } });
    const result = await reader.read({ ...request, checks: [{ name: 'QuickTest', url: BUILD, conclusion: 'FAILURE' }] });
    assert.equal(result.reports[0].state, 'unavailable'); assert.equal(calls, 2);
  }
});

test('decoded response stream limits and mismatched build numbers fail closed', async () => {
  const f = fixture();
  const reader = f.create({ fetchImpl: async url => new Response(url.endsWith('api/json') ? JSON.stringify({ number: 123, building: false }) : 'x'.repeat(2 * 1024 * 1024 + 1)) });
  await assert.rejects(reader.readBuild(request), { code: 'JENKINS_RESPONSE_TOO_LARGE' });
  await assert.rejects(fixture({ metadata: { number: 124, building: false } }).create().readBuild(request), { code: 'JENKINS_RESPONSE_INVALID' });
});

test('secrets are redacted before excerpts or model diagnostics and JSON-encoded output obeys its budget', async () => {
  const secret = 'fixture-secret', basic = Buffer.from('fixture-user:fixture-secret').toString('base64');
  const oversized = log.replace('Expected no hard-coded date format', `password=${secret}\n${basic}\n${Buffer.from(secret).toString('base64')}\n${'\\"重复'.repeat(5000)}`);
  const f = fixture({ consoleText: oversized });
  const report = await f.create().read({ ...request, checks: [{ name: 'QuickTest', url: BUILD, conclusion: 'FAILURE' }], maximumBytes: 6000 });
  const encoded = JSON.stringify(report);
  assert.ok(Buffer.byteLength(encoded) <= 6000); assert.ok(report.reports[0].failures.some(item => item.truncated));
  assert.ok(!encoded.includes(secret)); assert.ok(!encoded.includes(basic)); assert.ok(!encoded.includes(Buffer.from(secret).toString('base64')));
});

test('unrelated checks are skipped and optional read errors never expose their cause', async () => {
  const f = fixture(); f.credentialSource.acquire = async () => { throw new Error('private fixture-secret diagnostic'); };
  const result = await f.create().read({ ...request, checks: [{ name: 'GitHub', url: 'https://github.com/acme/repo/actions/runs/1', conclusion: 'FAILURE' }, { name: 'QuickTest', url: BUILD, conclusion: 'FAILURE' }] });
  assert.equal(result.reports.length, 1); assert.equal(result.reports[0].state, 'unavailable');
  assert.ok(!JSON.stringify(result).includes('fixture-secret'));
});

test('three unrelated failing checks cannot starve QuickTest diagnostics', async () => {
  const f = fixture();
  const result = await f.create().read({ ...request, checks: [
    ...['Build', 'Lint', 'Coverage'].map(name => ({ name, url: `https://github.com/acme/repo/actions/runs/${name}`, conclusion: 'FAILURE' })),
    { name: 'QuickTest', url: BUILD, conclusion: 'FAILURE' },
  ] });
  assert.equal(result.reports.length, 1);
  assert.equal(result.reports[0].check, 'QuickTest');
  assert.equal(result.reports[0].failures.length, 3);
});

test('escaped credentials and quoted JSON secret fields are redacted before excerpts', () => {
  const secret = 'quote"slash\\secret';
  const evidence = `${JSON.stringify({ password: secret })}\n${JSON.stringify(secret)}\n${JSON.stringify({ api_token: 'unrelated-private-value' })}`;
  const parsed = parseJenkinsGoogleTestConsole(log.replace('Expected no hard-coded date format', evidence), { ...request, secrets: [secret] });
  const text = parsed.failures[0].text;
  assert.ok(!text.includes(secret));
  assert.ok(!text.includes(JSON.stringify(secret).slice(1, -1)));
  assert.ok(!text.includes('unrelated-private-value'));
  assert.match(text, /REDACTED/);
});

test('legacy non-UTF8 console bytes retain ASCII checkout proof and mark decoded text limitations', async () => {
  const f = fixture();
  const reader = f.create({ fetchImpl: async url => new Response(url.endsWith('api/json')
    ? JSON.stringify({ number: 123, building: false, result: 'FAILURE' })
    : Buffer.concat([Buffer.from(log.replace('Expected no hard-coded date format', 'non-UTF8 error follows: ')), Buffer.from([0xff])])) });
  const result = await reader.readBuild(request);
  assert.equal(result.state, 'available');
  assert.equal(result.consoleHasReplacementCharacters, true);
  assert.equal(result.failures.length, 3);
});
