const { test } = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const path = require('node:path');
const { Pool } = require('pg');
const { createApp } = require('../src/app');
const { createServiceSettings, validateAddress } = require('../src/runs/service-settings');
const { createUnifiedEvaluationService } = require('../src/runs/unified-evaluation.service');

test('测评地址拒绝不完整 IP、非公网地址、凭据以及不兼容的新材料路径', () => {
  for (const address of ['ws://8.8.8:1105/start', 'ws://127.0.0.1/start', 'ws://169.254.169.254/start',
    'ws://172.16.1.1/start', 'ws://100.66.5.1/start', 'ws://0x08080808/start', 'ws://[::1]/start',
    'ws://user:pass@8.8.8.8/start', 'ws://8.8.8.8/start?token=x', 'ws://8.8.8.8/../start', 'ws://8.8.8.8/new-material/query']) {
    assert.throws(() => validateAddress(address, 'new-material'), { code: 'SERVICE_SETTINGS_INVALID' });
  }
  assert.equal(validateAddress(' ws://8.8.8.8:1105/new-material/start ', 'new-material'), 'ws://8.8.8.8:1105/new-material/start');
  assert.equal(validateAddress(null, 'new-material'), null);
});

test('只有 admin 能读取或修改地址，且保存要求同源会话', async t => {
  let writes = 0;
  const serviceSettings = { list: async () => ({ version: 0, items: [{ address: 'ws://8.8.8.8/start' }] }), async save(_input, id) { assert.equal(id, 'admin'); writes++; return { version: 1, items: [] }; } };
  const authService = { async authenticate(id) {
    if (!id) throw Object.assign(new Error('请登录'), { status: 401 });
    return { id, username: id, permissions: ['team-services:read', 'team-services:write'] };
  } };
  const server = createApp({ token: 'test'.repeat(8), authService, serviceSettings, publicOrigin: 'http://localhost' });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  const url = `http://127.0.0.1:${server.address().port}/api/evaluation/unified/service-settings`;
  const get = session => fetch(url, { headers: { cookie: `evaluation_session=${session}` } });
  const post = (session, origin = 'http://localhost') => fetch(url, { method: 'POST', headers: { cookie: `evaluation_session=${session}`, origin, 'content-type': 'application/json' }, body: '{}' });
  assert.equal((await fetch(url)).status, 401);
  assert.equal((await get('writer')).status, 403);
  assert.equal((await post('writer')).status, 403);
  assert.equal((await post('admin', 'http://elsewhere.invalid')).status, 403);
  assert.equal((await (await get('admin')).json()).items[0].address, 'ws://8.8.8.8/start');
  assert.equal((await post('admin')).status, 200);
  assert.equal(writes, 1);
});

const socketDir = process.env.EVALUATION_SETTINGS_TEST_PG_SOCKET;
test('隔离 PostgreSQL：地址与开关即时生效，排队时拒绝修改并保护并发保存', { skip: !socketDir }, async t => {
  assert.match(socketDir, /^\/tmp\/science-settings-pg\.[A-Za-z0-9]+$/);
  const pool = new Pool({ host: socketDir, port: 55418, database: 'science_evaluation', user: 'postgres' });
  t.after(() => pool.end());
  const defaults = { 'alpha-rsi': { serviceAddress: 'ws://configured.invalid/start' } };
  const calls = [];
  const factories = { 'new-material': address => ({
    serviceAddress: address, scoreMode: 'none',
    async startQuestionRun() { calls.push(address); return { run: { id: 'fake-native-run' }, completion: Promise.resolve({ status: 'done' }) }; },
  }) };
  const settings = createServiceSettings({ pool, defaults, factories });
  const secondProcess = createServiceSettings({ pool, defaults, factories });
  const evaluations = createUnifiedEvaluationService({ getEvaluators: async () => (await secondProcess.runtime()).evaluators });
  assert.equal((await settings.list()).storageReady, false);
  assert.deepEqual(await evaluations.availableServices(), ['alpha-rsi']);
  await pool.query(readFileSync(path.resolve(__dirname, '../migrations/016_evaluation_service_settings.sql'), 'utf8'));
  const address = 'ws://8.8.8.8:1105/new-material/start';
  const newSetting = { version: 0, items: [{ key: 'new-material', enabled: true, address }] };
  const concurrent = await Promise.allSettled([settings.save(newSetting, 'admin'), secondProcess.save(newSetting, 'admin')]);
  assert.equal(concurrent.filter(result => result.status === 'fulfilled').length, 1);
  assert.equal(concurrent.find(result => result.status === 'rejected').reason.code, 'SERVICE_SETTINGS_CONFLICT');
  assert.deepEqual(await evaluations.availableServices(), ['alpha-rsi', 'new-material']);
  const started = await evaluations.start({ serviceKey: 'new-material', question: '请为耐高温应用推荐新材料。' });
  started.subscribe(() => {});
  await started.nativeCompletion;
  assert.deepEqual(calls, [address]);
  assert.equal((await evaluations.get(started.runId)).run.serviceAddress, address);
  await pool.query("CREATE TABLE public.unified_evaluation_runs (status text); INSERT INTO public.unified_evaluation_runs VALUES ('queued')");
  const pause = { version: 1, items: [{ key: 'new-material', enabled: false, address }] };
  await assert.rejects(settings.save(pause, 'admin'), { code: 'SERVICE_SETTINGS_BUSY' });
  await pool.query("UPDATE public.unified_evaluation_runs SET status = 'running'");
  assert.equal((await settings.save(pause, 'admin')).version, 2);
  assert.deepEqual(await evaluations.availableServices(), ['alpha-rsi']);
  assert.deepEqual((await secondProcess.runtime()).paused, ['new-material']);
  assert.equal((await evaluations.get(started.runId)).run.serviceAddress, address);
});
