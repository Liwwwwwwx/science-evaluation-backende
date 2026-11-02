const test = require('node:test');
const assert = require('node:assert/strict');
const { createApp } = require('../src/app');

const ID = '11111111-1111-4111-8111-111111111111';

function fixture() {
  const authService = {
    async authenticate(token) {
      if (!token) throw Object.assign(new Error('请登录'), { status: 401 });
      return { id: 'reader', permissions: ['team-services:read'] };
    },
  };
  const batches = {
    async list(input) { return { items: [{ batchId: ID, date: '2026-11-02', source: input.source === 'all' ? 'trial' : input.source }], total: 1, page: 1, pageSize: 20, storageReady: true }; },
    async get(id) { return { batch: { batchId: id, date: '2026-11-02' }, services: [], totals: {}, coverage: {} }; },
    async runs(id) { return { batchId: id, items: [], total: 0, page: 1, pageSize: 20 }; },
    async comparison(id) { return { base: { batchId: id }, previous: null, comparable: false, mode: 'none', services: [], questions: [] }; },
  };
  return createApp({ token: 'x'.repeat(32), authService, batches, publicOrigin: 'http://localhost', secureCookies: false });
}

test('批次只读接口校验权限、参数、方法和批次 ID', async (t) => {
  const server = fixture();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  const base = `http://127.0.0.1:${server.address().port}/api/evaluation/unified/batches`;
  const headers = { cookie: 'evaluation_session=reader' };
  assert.equal((await fetch(base)).status, 401);
  assert.equal((await fetch(base, { headers })).status, 200);
  assert.equal((await fetch(`${base}?source=bad`, { headers })).status, 400);
  assert.equal((await fetch(`${base}/not-a-uuid`, { headers })).status, 400);
  assert.equal((await fetch(`${base}/${ID}`, { method: 'POST', headers })).status, 405);
  assert.equal((await fetch(`${base}/${ID}/comparison?against=bad`, { headers })).status, 400);
  const list = await (await fetch(`${base}?source=trial`, { headers })).json();
  assert.equal(list.items[0].source, 'trial');
  const detail = await (await fetch(`${base}/${ID}`, { headers })).json();
  assert.equal(detail.batch.batchId, ID);
  assert.equal((await fetch(`${base}/${ID}/runs?sort=bad`, { headers })).status, 400);
  assert.equal((await fetch(`${base}/${ID}/comparison`, { headers })).status, 200);
});
