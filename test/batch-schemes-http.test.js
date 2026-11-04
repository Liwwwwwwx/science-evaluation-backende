const test = require('node:test');
const assert = require('node:assert/strict');
const { createApp } = require('../src/app');
const { DEFAULT_SCHEME } = require('../src/runs/batch-scheme');

test('方案读取、管理员保存及手动发起分别校验权限、来源和写开关', async t => {
  const calls = [];
  const authService = { async authenticate(token) {
    if (!token) throw Object.assign(new Error('请登录'), { status: 401 });
    return { id: token, username: token === 'admin' ? 'admin' : 'user', permissions: token === 'read' ? ['team-services:read'] : ['team-services:read', 'team-services:write'] };
  } };
  const batchSchemes = { async list() { return { storageReady: true, items: [] }; }, async save(input) { calls.push(input); return input; } };
  const manualBatches = { async create(input) { calls.push(input); return { batchId: 'batch-id', reused: false }; } };
  const server = createApp({ token: 'x'.repeat(32), authService, batchSchemes, manualBatches, runWriteEnabled: true, publicOrigin: 'http://localhost' });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); t.after(() => server.close());
  const base = `http://127.0.0.1:${server.address().port}/api/evaluation/unified/batch-schemes`;
  const headers = (user, origin = 'http://localhost') => ({ cookie: `evaluation_session=${user}`, origin, 'content-type': 'application/json', 'idempotency-key': 'test-key' });
  assert.equal((await fetch(base)).status, 401);
  assert.equal((await fetch(base, { headers: headers('read') })).status, 200);
  const data = JSON.stringify({ name: '夜间方案', config: DEFAULT_SCHEME, isNightly: true, version: 0 });
  assert.equal((await fetch(base, { method: 'POST', headers: headers('user'), body: data })).status, 403);
  assert.equal((await fetch(base, { method: 'POST', headers: headers('user'), body: JSON.stringify({ ...JSON.parse(data), isNightly: false, name: '我的方案' }) })).status, 200);
  assert.equal((await fetch(base, { method: 'POST', headers: headers('admin', 'http://evil.test'), body: data })).status, 403);
  assert.equal((await fetch(base, { method: 'POST', headers: headers('admin'), body: data })).status, 200);
  assert.equal((await fetch(`${base}/run`, { method: 'POST', headers: headers('read'), body: data })).status, 403);
  assert.equal((await fetch(`${base}/run`, { method: 'POST', headers: headers('user'), body: JSON.stringify({ config: DEFAULT_SCHEME }) })).status, 202);
  assert.equal(calls.at(-1).userId, 'user'); assert.equal(calls.at(-1).key, 'test-key');
});

test('仅管理员可切换夜间方案，个人删除保留当前用户身份并校验同源', async t => {
  const calls = []; const id = '11111111-1111-4111-8111-111111111111';
  const authService = { async authenticate(token) { if (!token) throw Object.assign(new Error('请登录'), { status: 401 }); return { id: token, username: token === 'admin' ? 'admin' : 'user', permissions: ['team-services:read', 'team-services:write'] }; } };
  const batchSchemes = { async list(input) { calls.push(['list', input]); return { storageReady: true, items: [] }; }, async nightly() { return null; }, async setNightly(input) { calls.push(['nightly', input]); return input; }, async remove(input) { calls.push(['remove', input]); return { ok: true }; } };
  const server = createApp({ token: 'x'.repeat(32), authService, batchSchemes, runWriteEnabled: true, nightlyEnabled: false, publicOrigin: 'http://localhost' });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); t.after(() => server.close());
  const base = `http://127.0.0.1:${server.address().port}/api/evaluation/unified/batch-schemes`;
  const headers = (user, origin = 'http://localhost') => ({ cookie: `evaluation_session=${user}`, origin, 'content-type': 'application/json', 'idempotency-key': 'test-key' });
  const catalog = await (await fetch(base, { headers: headers('alice') })).json();
  assert.equal(catalog.nightlyEnabled, false); assert.deepEqual(calls[0], ['list', { userId: 'alice', admin: false }]);
  const body = JSON.stringify({ action: 'setNightly', id, version: 1 });
  assert.equal((await fetch(base, { method: 'POST', headers: headers('alice'), body })).status, 403);
  assert.equal((await fetch(base, { method: 'POST', headers: headers('admin', 'http://evil.test'), body })).status, 403);
  assert.equal((await fetch(base, { method: 'POST', headers: headers('admin'), body })).status, 200);
  assert.equal(calls.at(-1)[1].userId, 'admin');
  assert.equal((await fetch(base, { method: 'POST', headers: headers('alice'), body: JSON.stringify({ action: 'remove', id, version: 1 }) })).status, 200);
  assert.equal(calls.at(-1)[1].userId, 'alice');
});
