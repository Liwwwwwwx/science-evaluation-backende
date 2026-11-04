const test = require('node:test');
const assert = require('node:assert/strict');
const { createTrialBatchScheduler } = require('../src/runs/trial-batch.scheduler');
const { createMissionDailyService } = require('../src/runs/mission-daily.service');

test('指定日22点开始一次；恢复派发不受触发时间窗口限制', async () => {
  let now = new Date('2026-11-02T13:59:00Z'); let plan = null; let prepared = 0; let dispatched = 0;
  const repository = { async get() { return plan; } };
  const service = { async prepare() { prepared++; plan = { state: 'dispatching' }; }, async dispatch() { dispatched++; plan.state = 'submitted'; } };
  const missionRepository = { async get() { return null; }, async pending() { return null; }, async hasUnfinishedRuns() { return false; } };
  const scheduler = createTrialBatchScheduler({ date: '2026-11-02', repository, service, missionRepository, now: () => now });
  await scheduler.tick(); assert.equal(prepared, 0);
  now = new Date('2026-11-02T14:00:00Z'); await scheduler.tick(); await scheduler.tick();
  assert.equal(prepared, 1); assert.equal(dispatched, 1);
  plan.state = 'dispatching'; now = new Date('2026-11-03T03:00:00Z'); await scheduler.tick();
  assert.equal(prepared, 1); assert.equal(dispatched, 2);
});

test('已有 Mission 夜检时不启动试运行；指定日新平台原夜检跳过', async () => {
  let prepared = 0; const now = () => new Date('2026-11-02T14:00:00Z');
  const scheduler = createTrialBatchScheduler({ date: '2026-11-02', now, repository: { async get() { return null; } },
    service: { async prepare() { prepared++; } }, missionRepository: { async get() { return { id: 'existing' }; } } });
  await assert.rejects(scheduler.tick(), /已有自动测评计划/); assert.equal(prepared, 0);
  let created = 0;
  const mission = createMissionDailyService({ enabled: true, ready: true, now, skipDate: day => day === '2026-11-02',
    evaluations: {}, repository: { async pending() { return null; }, async create() { created++; } } });
  await mission.tick(); assert.equal(created, 0);
});

test('每日模式在连续两天各生成和派发一次，非窗口内不补发', async () => {
  let now = new Date('2026-11-03T17:59:00Z');
  const plans = new Map(); const generated = []; const dispatched = []; const skipped = [];
  const repository = {
    async pending() { return [...plans.values()].find(p => ['generating', 'dispatching'].includes(p.state)) || null; },
    async get(day) { return plans.get(day) || null; }, async hasUnfinishedRuns() { return false; },
    async recordSkipped(value) { skipped.push(value); plans.set(value.date, { ...value, state: 'failed' }); },
  };
  const service = {
    async prepare(day) { generated.push(day); plans.set(day, { date: day, state: 'dispatching' }); },
    async dispatch(day) { dispatched.push(day); plans.get(day).state = 'submitted'; },
  };
  const missionRepository = { async get() { return null; }, async pending() { return null; }, async hasUnfinishedRuns() { return false; } };
  const scheduler = createTrialBatchScheduler({ daily: true, repository, service, missionRepository, now: () => now });
  await scheduler.tick(); assert.deepEqual(generated, []);
  now = new Date('2026-11-03T18:00:00Z'); await scheduler.tick(); await scheduler.tick();
  now = new Date('2026-11-04T17:59:00Z'); await scheduler.tick();
  now = new Date('2026-11-04T18:00:00Z'); await scheduler.tick(); await scheduler.tick();
  now = new Date('2026-11-05T18:11:00Z'); await scheduler.tick();
  assert.deepEqual(generated, ['2026-11-03', '2026-11-04']);
  assert.deepEqual(dispatched, generated);
  assert.equal(skipped.length, 0); // 窗口后首次启动无法判断当时开关是否开启，不补造失败记录。
});

test('每日模式跨天恢复旧计划快照，不重新生成旧题', async () => {
  const plan = { date: '2026-11-03', id: 'old', state: 'dispatching' }; const dispatched = [];
  const repository = { async pending() { return plan; }, async get() { throw new Error('不应查询当天计划'); } };
  const service = { async prepare() { throw new Error('不应重新生成题目'); }, async dispatch(day) { dispatched.push(day); } };
  const scheduler = createTrialBatchScheduler({ daily: true, repository, service, missionRepository: {}, now: () => new Date('2026-11-04T01:00:00Z') });
  await scheduler.tick(); assert.deepEqual(dispatched, ['2026-11-03']);
  plan.state = 'generating'; let expired;
  repository.failExpiredGeneration = async id => { expired = id; };
  await scheduler.tick(); assert.equal(expired, 'old');
});

test('跨年凌晨两点批次归属前一晚', async () => {
  const generated = [];
  const repository = { async pending() { return null; }, async get() { return null; }, async hasUnfinishedRuns() { return false; } };
  const missionRepository = { async get() { return null; }, async pending() { return null; }, async hasUnfinishedRuns() { return false; } };
  const service = { async prepare(day) { generated.push(day); }, async dispatch() {} };
  const scheduler = createTrialBatchScheduler({ daily: true, repository, missionRepository, service, now: () => new Date('2026-12-31T18:00:00Z') });
  await scheduler.tick(); assert.deepEqual(generated, ['2026-12-31']);
});

test('上一轮六服务仍在运行时不叠加新一轮，错过窗口后记录失败', async () => {
  let prepared = false; let now = new Date('2026-11-04T18:00:00Z'); const skipped = [];
  const repository = { async pending() { return null; }, async get() { return null; }, async hasUnfinishedRuns() { return true; }, async recordSkipped(value) { skipped.push(value); } };
  const missionRepository = { async get() { return null; }, async pending() { return null; }, async hasUnfinishedRuns() { return false; } };
  const scheduler = createTrialBatchScheduler({ daily: true, repository, missionRepository, service: { async prepare() { prepared = true; } }, now: () => now });
  await assert.rejects(scheduler.tick(), /未完成任务/); assert.equal(prepared, false);
  now = new Date('2026-11-04T18:10:00Z'); await scheduler.tick();
  assert.equal(skipped[0].date, '2026-11-04'); assert.match(skipped[0].reason, /尚未结束/);
});

test('旧计划跨天仍在派发且错过新一轮窗口时，记录失败并继续恢复旧计划', async () => {
  const old = { date: '2026-11-03', state: 'dispatching' }; const skipped = []; const dispatched = []; let now = new Date('2026-11-04T18:09:00Z');
  const repository = { async pending() { return old; }, async recordSkipped(value) { skipped.push(value); } };
  const scheduler = createTrialBatchScheduler({ daily: true, repository, missionRepository: {},
    service: { async dispatch(day) { dispatched.push(day); } }, now: () => now });
  await scheduler.tick(); now = new Date('2026-11-04T18:11:00Z'); await scheduler.tick();
  assert.equal(skipped[0].date, '2026-11-04'); assert.match(skipped[0].reason, /上一轮/);
  assert.deepEqual(dispatched, ['2026-11-03', '2026-11-03']);
});

test('每日六服务计划启用时不新建 Mission 单服务计划', async () => {
  let created = 0;
  const mission = createMissionDailyService({ enabled: true, ready: true, now: () => new Date('2026-11-04T14:00:00Z'), skipDate: () => true,
    evaluations: {}, repository: { async pending() { return null; }, async create() { created++; } } });
  await mission.tick(); assert.equal(created, 0);
});
