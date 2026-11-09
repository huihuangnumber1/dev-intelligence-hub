import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { runInNewContext } from 'node:vm';

test('slow initial status cannot submit credentials into a URL or overwrite a completed connection', async () => {
  const html = await readFile(new URL('../public/jenkins.html', import.meta.url), 'utf8');
  assert.match(html, /<form[^>]+method="post"[^>]+action="\/api\/ci\/jenkins\/connection"/u);
  assert.match(html, /<button type="submit" disabled>/u);
  const listeners = new Map(), button = { disabled: true }, status = { textContent: '' };
  const fields = { repository: 'acme/repo', buildUrl: 'http://ci.example/job/QuickTest/1/', username: 'fixture', password: 'fixture-secret' };
  const form = { elements: Object.fromEntries(Object.entries(fields).map(([key, value]) => [key, { value }])),
    querySelector: () => button, addEventListener: (name, callback) => listeners.set(name, callback) };
  let releaseInitial; const pending = new Promise(resolve => { releaseInitial = resolve; });
  const calls = [];
  const fetch = async (url, options) => {
    calls.push({ url, options });
    if (!options.method) return pending;
    return { ok: true, json: async () => ({ configured: true, repository: fields.repository, username: fields.username }) };
  };
  const script = await readFile(new URL('../public/jenkins.js', import.meta.url), 'utf8');
  const task = runInNewContext(`(async () => {${script}\n})()`, {
    document: { querySelector: selector => selector === '#connection-form' ? form : status }, fetch,
    FormData: class { constructor() { return Object.entries(fields); } },
  });
  assert.equal(button.disabled, false);
  assert.equal(typeof listeners.get('submit'), 'function');
  let prevented = false;
  await listeners.get('submit')({ preventDefault() { prevented = true; } });
  assert.equal(prevented, true);
  assert.equal(calls[1].options.method, 'POST');
  assert.equal(calls[1].url.includes(fields.password), false);
  assert.equal(form.elements.password.value, '');
  const connected = status.textContent;
  releaseInitial({ ok: true, json: async () => ({ configured: false }) });
  await task;
  assert.equal(status.textContent, connected);
  assert.match(connected, /已连接/u);
});
