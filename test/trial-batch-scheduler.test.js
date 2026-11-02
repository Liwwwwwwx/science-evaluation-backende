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
  await assert.rejects(scheduler.tick(), /已有 Mission/); assert.equal(prepared, 0);
  let created = 0;
  const mission = createMissionDailyService({ enabled: true, ready: true, now, skipDate: day => day === '2026-11-02',
    evaluations: {}, repository: { async pending() { return null; }, async create() { created++; } } });
  await mission.tick(); assert.equal(created, 0);
});
