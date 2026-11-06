const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createApp } = require('../src/app');

const authService = {
  async authenticate(token) {
    if (!token) throw Object.assign(new Error('请登录'), { status: 401 });
    return { id: token, permissions: token === 'reader' ? ['team-services:read'] : ['team-services:read', 'team-services:write'] };
  },
};

test('对比测评接口校验权限、同源、写开关、幂等键和账号范围', async (t) => {
  const calls = [];
  const groupId = 'a'.repeat(64);
  const evaluations = {
    async createComparison(input, { scope, key }) { calls.push({ input, scope, key }); return { groupId, runs: [{ runId: '1', serviceKey: 'alloy' }, { runId: '2', serviceKey: 'alpha-rsi' }] }; },
    async getComparison(id, userId) {
      if (id !== groupId) throw Object.assign(new Error('对比组不存在'), { status: 404, code: 'COMPARISON_NOT_FOUND' });
      return { groupId: id, runs: [{ runId: '1', userId }, { runId: '2', userId }] };
    },
  };
  const enabled = createApp({ token: 'x'.repeat(32), authService, evaluations, runWriteEnabled: true, publicOrigin: 'http://localhost' });
  await new Promise((resolve) => enabled.listen(0, '127.0.0.1', resolve));
  t.after(() => enabled.close());
  const base = `http://127.0.0.1:${enabled.address().port}/api/evaluation/unified/comparisons`;
  const body = JSON.stringify({ serviceKeys: ['alloy', 'alpha-rsi'], question: '请比较两种材料在 900°C 下的强度并说明依据。' });
  const post = (token = 'writer', origin = 'http://localhost', key = 'compare-key') => fetch(base, { method: 'POST', headers: { cookie: `evaluation_session=${token}`, origin, 'content-type': 'application/json', 'Idempotency-Key': key }, body });
  assert.equal((await fetch(base, { method: 'POST' })).status, 401);
  assert.equal((await post('reader')).status, 403);
  assert.equal((await post('writer', 'http://evil.invalid')).status, 403);
  const created = await post();
  assert.equal(created.status, 201);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].scope, 'evaluation-user:writer');
  assert.equal(calls[0].key, 'compare-key');
  assert.deepEqual(calls[0].input.serviceKeys, ['alloy', 'alpha-rsi']);
  assert.equal((await created.json()).groupId, groupId);

  const read = await fetch(`${base}/${groupId}`, { headers: { cookie: 'evaluation_session=reader' } });
  assert.equal(read.status, 200);
  const value = await read.json();
  assert.equal(value.runs[0].userId, 'reader');
  assert.equal((await fetch(`${base}/missing`, { headers: { cookie: 'evaluation_session=reader' } })).status, 404);
  assert.equal((await fetch(base, { method: 'GET', headers: { cookie: 'evaluation_session=reader' } })).status, 405);

  const disabled = createApp({ token: 'x'.repeat(32), authService, evaluations, publicOrigin: 'http://localhost' });
  await new Promise((resolve) => disabled.listen(0, '127.0.0.1', resolve));
  t.after(() => disabled.close());
  const disabledUrl = `http://127.0.0.1:${disabled.address().port}/api/evaluation/unified/comparisons`;
  assert.equal((await fetch(disabledUrl, { method: 'POST', headers: { cookie: 'evaluation_session=writer', origin: 'http://localhost', 'content-type': 'application/json', 'Idempotency-Key': 'compare-key' }, body })).status, 503);
});
