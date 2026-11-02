const test = require('node:test');
const assert = require('node:assert/strict');
const { createUnifiedEvaluationService } = require('../src/runs/unified-evaluation.service');

const tick = () => new Promise(resolve => setImmediate(resolve));
function fixture() {
  const rows = new Map(); const keys = new Map(); const pending = new Map();
  const repository = {
    findIdempotent: async (scope, key) => keys.get(`${scope}:${key}`),
    async createIdempotent(job, scope, key, hash) {
      const id = `${scope}:${key}`; const old = keys.get(id);
      if (old) return { created: false, runId: old.runId, matches: old.hash === hash };
      keys.set(id, { runId: job.runId, hash }); rows.set(job.runId, structuredClone(job));
      return { created: true, runId: job.runId };
    },
    async save(job) { rows.set(job.runId, structuredClone(job)); },
    async get(id) { return structuredClone(rows.get(id)); },
  };
  const evaluator = { scoreMode: 'none', async startQuestionRun(body, { onText }) {
    onText(body.question);
    let done; const completion = new Promise(resolve => { done = resolve; });
    pending.set(body.question, done);
    return { run: { id: body.question }, completion };
  } };
  const evaluators = { literature: evaluator, alloy: evaluator };
  return { rows, pending, repository, evaluators, service: createUnifiedEvaluationService({ repository, evaluators, maxActive: 6, maxPerService: 5 }) };
}

test('统一运行可将航空服务限制为单并发，同时允许其他服务运行', async () => {
  const { repository, evaluators, pending } = fixture();
  evaluators['literature-aircraft'] = evaluators.literature;
  const service = createUnifiedEvaluationService({ repository, evaluators, maxActive: 6, maxPerService: 5, serviceLimits: { 'literature-aircraft': 1 } });
  const create = (serviceKey, n) => service.createRun({ serviceKey, question: `服务独立并发测试 ${serviceKey}-${n}` }, { scope: 'user', key: `limit-${serviceKey}-${n}` });
  const first = await create('literature-aircraft', 1);
  const second = await create('literature-aircraft', 2);
  await create('alloy', 1);
  assert.equal((await service.get(second.runId)).status, 'queued');
  assert.equal(pending.size, 2);
  pending.get((await service.get(first.runId)).question)({ status: 'error', error: '模拟失败' });
  await tick();
  assert.equal((await service.get(second.runId)).status, 'running');
  for (const resolve of pending.values()) resolve({ status: 'done' });
  await tick();
});

test('自动批次同一个幂等键只创建一次，并保留失败原因', async () => {
  const { service, pending } = fixture();
  const input = { serviceKey: 'alloy', question: '自动批次失败原因记录测试', batchId: 'batch-1' };
  const first = await service.createBatchRun(input, { key: 'batch-1:alloy:1' });
  const second = await service.createBatchRun(input, { key: 'batch-1:alloy:1' });
  assert.equal(first.runId, second.runId);
  assert.equal(second.reused, true);
  pending.get(input.question)({ status: 'error', error: '模拟服务连接断开' });
  await tick();
  assert.equal((await service.get(first.runId)).error, '模拟服务连接断开');
});

test('每服务五个运行，第六个排队；其他服务可运行，结果不串扰', async () => {
  const { service, pending } = fixture(); const created = [];
  const create = (serviceKey, n) => service.createRun({ serviceKey, question: `独立并发测试题目编号 ${serviceKey}-${n}` }, { scope: 'user', key: `${serviceKey}-${n}` });
  for (let i = 0; i < 6; i++) created.push(await create('literature', i));
  const other = await create('alloy', 0);
  assert.equal(pending.size, 6);
  const queued = await service.get(created[5].runId);
  assert.equal(queued.status, 'queued'); assert.equal(queued.executionStatus, 'queued');
  const events = []; const observation = await service.observe(created[5].runId, (name) => events.push(name));
  assert.equal(observation.live, true);
  const original = await service.get(created[0].runId);
  pending.get(original.question)({ status: 'done' }); await tick();
  assert.ok(events.includes('execution'));
  const started = await service.get(created[5].runId);
  assert.equal(started.status, 'running'); assert.equal(started.answer, started.question);
  assert.equal((await service.get(other.runId)).answer, (await service.get(other.runId)).question);
  for (const resolve of pending.values()) resolve({ status: 'done' });
  await tick(); observation.unsubscribe();
});

test('相同幂等键的排队任务只创建一次，重启只读快照不重复派发', async () => {
  const { service, pending, repository, evaluators } = fixture();
  const jobs = [];
  for (let i = 0; i < 6; i++) jobs.push(await service.createRun({ serviceKey: 'literature', question: `并发幂等测试问题编号 ${i}` }, { scope: 'user', key: `key-${i}` }));
  const repeated = await service.createRun({ serviceKey: 'literature', question: '并发幂等测试问题编号 5' }, { scope: 'user', key: 'key-5' });
  assert.equal(repeated.runId, jobs[5].runId); assert.equal(repeated.reused, true); assert.equal(pending.size, 5);
  const restarted = createUnifiedEvaluationService({ repository, evaluators });
  const snapshot = await restarted.get(jobs[5].runId);
  assert.equal(snapshot.status, 'queued'); assert.equal(snapshot.recoveryState, 'snapshot_only');
  assert.equal(pending.size, 5);
  for (const resolve of pending.values()) resolve({ status: 'done' });
  await tick();
  for (const resolve of pending.values()) resolve({ status: 'done' });
  await tick();
});

test('评分容量满时继续等待，执行槽位已释放且不会因繁忙标记失败', async () => {
  const { repository, evaluators, pending } = fixture();
  const scoreFinishes = []; let scoreCalls = 0;
  const scoring = {
    pending: () => ({ deepSeekScore: { status: 'pending' } }),
    async score(_job, publish) {
      scoreCalls++;
      await new Promise(resolve => scoreFinishes.push(resolve));
      await publish({ scoring: { finishedAt: new Date().toISOString() }, scores: { deepSeekScore: { status: 'ready' } }, markdownSyntax: {} });
    },
  };
  const service = createUnifiedEvaluationService({ repository, evaluators, scoring, maxActive: 5, maxPerService: 5 });
  const jobs = [];
  for (let i = 0; i < 5; i++) jobs.push(await service.createRun({ serviceKey: 'literature', question: `评分并发测试问题编号 ${i}` }, { scope: 'u', key: `score-${i}` }));
  for (const resolve of pending.values()) resolve({ status: 'done' });
  await tick(); await tick();
  assert.equal(scoreCalls, 4);
  assert.equal((await service.get(jobs[4].runId)).status, 'scoring');
  assert.equal((await service.get(jobs[4].runId)).scoreError, null);
  scoreFinishes[0](); await tick(); await tick();
  assert.equal(scoreCalls, 5);
  for (const finish of scoreFinishes) finish();
  await tick();
});

test('完成评分在保存结束后才对读取方显示完成', async () => {
  const { repository, evaluators, pending } = fixture();
  const save = repository.save; let finishSave;
  repository.save = async value => {
    if (value.run?.scoring?.finishedAt) await new Promise(resolve => { finishSave = resolve; });
    await save(value);
  };
  const scoring = { pending: () => ({ deepSeekScore: { status: 'pending' } }), async score(_job, publish) {
    await publish({ scoring: { finishedAt: new Date().toISOString() }, scores: { deepSeekScore: { status: 'ready' } }, markdownSyntax: {} });
  } };
  const service = createUnifiedEvaluationService({ repository, evaluators, scoring });
  const started = await service.createRun({ serviceKey: 'literature', question: '评分完成与保存时序测试题目' }, { scope: 'u', key: 'persist' });
  pending.get('评分完成与保存时序测试题目')({ status: 'done' });
  while (!finishSave) await tick();
  let returned = false;
  const reading = service.get(started.runId).then(value => { returned = true; return value; });
  await tick(); assert.equal(returned, false);
  finishSave();
  assert.ok((await reading).run.scoring.finishedAt);
  assert.ok((await repository.get(started.runId)).run.scoring.finishedAt);
});
