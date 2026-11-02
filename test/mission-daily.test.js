const test = require('node:test');
const assert = require('node:assert/strict');
const { createMissionDailyService, localTime, dailyKey } = require('../src/runs/mission-daily.service');
const { createApp } = require('../src/app');

function fixture() {
  const plans = new Map(); const jobs = new Map(); let active = false; let count = 10; let failOnce = false;
  const repository = {
    async selectQuestions() { return Array.from({ length: count }, (_, i) => ({ questionId: `q${i}`, datasetVersion: 'v1', question: `每日材料评测问题 ${i}`, sourceType: 'fixed' })); },
    async get(day) { return plans.get(day) || null; },
    async create(plan) { if (!plans.has(plan.date)) plans.set(plan.date, structuredClone(plan)); return plans.get(plan.date); },
    async pending() { return [...plans.values()].find(plan => plan.state === 'dispatching') || null; },
    async markSubmitted(id) { [...plans.values()].find(plan => plan.id === id).state = 'submitted'; },
    async hasUnfinishedRuns() { return active; },
    async latest() { return [...plans.values()].sort((a, b) => b.date.localeCompare(a.date))[0] || null; },
    async runs(id) { return [...jobs.values()].filter(job => job.batchId === id); },
  };
  const evaluations = { async createMissionDailyRun(input, { key, ruleSnapshot }) {
    if (failOnce && jobs.size === 3) { failOnce = false; throw Error('模拟进程中断'); }
    if (!jobs.has(key)) jobs.set(key, { ...input, runId: key, status: 'queued', scores: {}, ruleSnapshot });
    return { runId: key };
  } };
  let now = new Date('2026-11-02T14:00:00Z');
  const scoring = { snapshotRule: async () => ({ id: 'rule-v1' }) };
  const make = (serviceAddress = 'ws://mission.example/start') => createMissionDailyService({ repository, evaluations, scoring, serviceAddress, enabled: true, ready: true, now: () => now });
  return { plans, jobs, make, setNow: value => { now = new Date(value); }, setActive: value => { active = value; }, setCount: value => { count = value; }, failNext: () => { failOnce = true; } };
}

test('北京时间 22:00 创建十题，同一天多次和多进程触发不重复', async () => {
  const f = fixture(); const first = f.make(); const second = f.make();
  assert.deepEqual(localTime(new Date('2026-11-02T14:00:00Z')), { date: '2026-11-02', minute: 1320 });
  await Promise.all([first.tick(), second.tick()]); await first.tick();
  assert.equal(f.plans.size, 1); assert.equal(f.jobs.size, 10);
  const plan = f.plans.get('2026-11-02'); assert.equal(plan.items.length, 10); assert.equal(plan.state, 'submitted');
  assert.ok([...f.jobs.values()].every(job => job.ruleSnapshot.id === 'rule-v1'));
  assert.equal((await first.status()).last.items.length, 10);
});

test('中断后恢复已固定的清单与规则，不重复创建已接收题目', async () => {
  const f = fixture(); const service = f.make(); f.failNext();
  await assert.rejects(service.tick(), /中断/);
  assert.equal(f.jobs.size, 3); assert.equal(f.plans.get('2026-11-02').state, 'dispatching');
  f.setCount(2); f.setNow('2026-11-03T03:00:00Z');
  await f.make().tick();
  assert.equal(f.jobs.size, 10); assert.equal(f.plans.get('2026-11-02').state, 'submitted');
  assert.ok([...f.jobs.values()].every(job => job.ruleSnapshot.id === 'rule-v1'));
  assert.equal(dailyKey('2026-11-02', { questionId: 'a', datasetVersion: 'v1' }), dailyKey('2026-11-02', { questionId: 'a', datasetVersion: 'v1' }));
});

test('上一轮未结束、缺题或错过时间时明确记录，不堆积补跑', async () => {
  const f = fixture(); f.setActive(true); await f.make().tick();
  assert.equal(f.plans.get('2026-11-02').state, 'skipped'); assert.equal(f.jobs.size, 0);
  f.setActive(false); f.setNow('2026-11-03T14:00:00Z'); f.setCount(3); await f.make().tick();
  assert.equal(f.plans.get('2026-11-03').items.length, 3); assert.match(f.plans.get('2026-11-03').reason, /3/);
  f.setNow('2026-11-04T14:11:00Z'); await f.make().tick();
  assert.equal(f.plans.get('2026-11-04').state, 'skipped'); assert.equal(f.jobs.size, 3);
});

test('开关未启用或依赖未就绪时不创建运行', async () => {
  const f = fixture();
  const unavailable = createMissionDailyService({ repository: {}, evaluations: {}, enabled: true, ready: false });
  const disabled = createMissionDailyService({ repository: {}, evaluations: {}, enabled: false, ready: true });
  await unavailable.tick(); await disabled.tick();
  assert.equal(f.plans.size, 0); assert.equal((await disabled.status()).enabled, false);
});

test('计划创建后服务地址改变，剩余任务暂停而不发往新地址', async () => {
  const f = fixture(); f.failNext(); await assert.rejects(f.make().tick(), /中断/);
  const changed = f.make('ws://new.example/start'); await changed.tick();
  assert.equal(f.jobs.size, 3); assert.equal(f.plans.get('2026-11-02').state, 'dispatching');
  assert.match((await changed.status()).last.reason, /地址已变化/);
});

test('每日状态接口要求已有会话和运行读取权限', async t => {
  const evaluations = { missionDailyStatus: async () => ({ enabled: true, ready: true, time: '22:00', targetCount: 10 }) };
  const authService = { authenticate: async token => {
    if (!token) throw Object.assign(Error('请登录'), { status: 401 });
    return { id: token, permissions: token === 'reader' ? ['team-services:read'] : [] };
  } };
  const server = createApp({ token: 'x'.repeat(32), authService, evaluations, publicOrigin: 'http://localhost' });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); t.after(() => server.close());
  const url = `http://127.0.0.1:${server.address().port}/api/evaluation/unified/mission-daily`;
  assert.equal((await fetch(url)).status, 401);
  assert.equal((await fetch(url, { headers: { cookie: 'evaluation_session=no-permission' } })).status, 403);
  const response = await fetch(url, { headers: { cookie: 'evaluation_session=reader' } });
  assert.equal(response.status, 200); assert.equal((await response.json()).time, '22:00');
});
