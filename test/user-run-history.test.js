const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createApp } = require('../src/app');
const { createUnifiedEvaluationService } = require('../src/runs/unified-evaluation.service');

test('侧栏历史接口限定会话用户、读写权限、同源、写开关及标题格式', async t => {
  const id = '11111111-1111-4111-8111-111111111111';
  const calls = [];
  const authService = { async authenticate(token) { if (!token) throw Object.assign(Error('请登录'), { status: 401 }); return { id: token, permissions: token === 'reader' ? ['team-services:read'] : ['team-services:read', 'team-services:write'] }; } };
  const evaluations = { async listHistory(user) { calls.push(['list',user]); return { items: [], storageReady: true }; }, async updateHistory(...args) { calls.push(args); return { ok: true }; } };
  for (const enabled of [true, false]) {
    const app = createApp({ token: 'x'.repeat(32), authService, evaluations, runWriteEnabled: enabled, publicOrigin: 'http://localhost' });
    await new Promise(resolve => app.listen(0, '127.0.0.1', resolve)); t.after(() => app.close());
    const base = `http://127.0.0.1:${app.address().port}/api/evaluation/unified/history`;
    const post = (cookie, body, origin = 'http://localhost', suffix = id) => fetch(`${base}/${suffix}`, { method: 'POST', headers: { cookie: `evaluation_session=${cookie}`, origin, 'content-type': 'application/json' }, body: JSON.stringify(body) });
    assert.equal((await fetch(base)).status, 401);
    const list = await fetch(base, { headers: { cookie: 'evaluation_session=reader' } });
    assert.equal(list.status, 200); assert.equal((await list.json()).canManage, false);
    assert.equal((await post('reader', { action: 'remove' })).status, 403);
    assert.equal((await post('writer', { action: 'remove' }, 'http://evil.invalid')).status, 403);
    assert.equal((await post('writer', { action: 'remove' }, 'http://localhost', 'bad')).status, 400);
    if (enabled) {
      assert.equal((await post('writer', { action: 'rename', title: '  ' })).status, 400);
      assert.equal((await post('writer', { action: 'rename', title: 'a'.repeat(101) })).status, 400);
      assert.equal((await post('writer', { action: 'remove', title: 'x' })).status, 400);
      assert.equal((await post('writer', { action: 'rename', title: '  我的对话  ' })).status, 200);
      assert.equal((await post('writer', { action: 'remove' })).status, 200);
    } else assert.equal((await post('writer', { action: 'remove' })).status, 503);
  }
  assert.deepEqual(calls.filter(call => call[1] === id), [['writer',id,'rename','我的对话'], ['writer',id,'remove','']]);
});

test('侧栏存储尚未迁移时保留原运行列表，写入明确返回不可用', async () => {
  const missing = Object.assign(Error('missing table'), { code: '42P01' });
  const service = createUnifiedEvaluationService({ repository: { listHistory: async () => { throw missing; }, updateHistory: async () => { throw missing; }, list: async () => ({ items: [{ runId: 'old' }] }) }, evaluators: {} });
  assert.deepEqual(await service.listHistory('user'), { items: [{ runId: 'old' }], storageReady: false });
  await assert.rejects(service.updateHistory('user', 'id', 'remove', ''), { status: 503, code: 'HISTORY_STORAGE_UNAVAILABLE' });
});

test('列表仅将当前进程无法确认的活动记录标为快照，不改写数据库状态', async () => {
  let liveId; let complete;
  const completion = new Promise(resolve => { complete = resolve; });
  const items = () => [{ runId: liveId, status: 'done' }, { runId: 'previous', status: 'running' }, { runId: 'finished', status: 'done' }];
  const repository = { async findIdempotent() { return null; }, async createIdempotent(job) { liveId = job.runId; return { created: true }; }, async save() {}, async get() { return null; }, async listHistory() { return items(); }, async list() { return { items: items(), total: 3 }; } };
  const service = createUnifiedEvaluationService({ repository, evaluators: { literature: { async startQuestionRun() { return { run: { id: 'native' }, completion }; }, async getRunQuality() { return { status: 'absent' }; } } } });
  const started = await service.createRun({ serviceKey: 'literature', question: '请提供一份可以验证的说明。' }, { scope: 'evaluation-user:u1', key: 'history-recovery' });
  for (const result of [await service.listHistory('u1'), await service.list({})]) {
    assert.equal(result.items[0].runId, started.runId); assert.equal(result.items[0].status, 'running'); assert.equal(result.items[0].recoveryState, undefined);
    assert.equal(result.items[1].status, 'running'); assert.equal(result.items[1].recoveryState, 'snapshot_only');
    assert.equal(result.items[2].recoveryState, undefined);
  }
  await service.end(started.runId, { scope: 'evaluation-user:u1' }); complete({ status: 'done' });
});
