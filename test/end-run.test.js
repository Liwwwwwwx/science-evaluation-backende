const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createUnifiedEvaluationService } = require('../src/runs/unified-evaluation.service');

test('结束运行只允许发起人，并立即标记为已结束且不再等待远端结果', async () => {
  const saved = [];
  const repository = {
    async create(job) { saved.push(job); },
    async save(job) { saved.push(job); },
    async findIdempotent() { return null; },
    async createIdempotent() { return { created: true }; },
    async get() { return null; },
  };
  let complete;
  const completion = new Promise(resolve => { complete = resolve; });
  const service = createUnifiedEvaluationService({
    repository,
    evaluators: {
      literature: {
        serviceAddress: 'http://literature.invalid',
        async startQuestionRun() { return { run: { id: 'native-1' }, completion }; },
        async getRunQuality() { return { status: 'ok' }; },
      },
    },
  });
  const started = await service.createRun({ serviceKey: 'literature', question: '请列出三条可验证的实验判据。' }, { scope: 'evaluation-user:u1', key: 'end-case' });
  const before = await service.get(started.runId, { scope: 'evaluation-user:u1' });
  assert.equal(before.canEnd, true);
  await assert.rejects(service.end(started.runId, { scope: 'evaluation-user:u2' }), { status: 403 });
  const ended = await service.end(started.runId, { scope: 'evaluation-user:u1' });
  assert.equal(ended.status, 'cancelled');
  const after = await service.get(started.runId, { scope: 'evaluation-user:u1' });
  assert.equal(after.status, 'cancelled');
  assert.equal(after.canEnd, false);
  assert.equal(after.error, '用户结束了本次测评');
  complete({ status: 'done', details: { displayEvents: [] } });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(saved.at(-1).status, 'cancelled');
});

test('结束后忽略迟到正文与状态，保留结束时的快照', async () => {
  let callbacks; let complete; const saved = [];
  const completion = new Promise(resolve => { complete = resolve; });
  const repository = { async createIdempotent() { return { created: true }; }, async findIdempotent() { return null; }, async save(value) { saved.push(value); }, async get() { return null; } };
  const service = createUnifiedEvaluationService({ repository, evaluators: { literature: {
    async startQuestionRun(_input, options) { callbacks = options; return { run: { id: 'native' }, completion }; },
    async getRunQuality() { return { status: 'absent' }; },
  } } });
  const run = await service.createRun({ serviceKey: 'literature', question: '请提供一份可以验证的说明。' }, { scope: 'evaluation-user:u1', key: 'end-late-data' });
  callbacks.onText('结束前'); callbacks.onState({ progress: ['结束前'] });
  await service.end(run.runId, { scope: 'evaluation-user:u1' });
  callbacks.onText('不应出现'); callbacks.onState({ progress: ['不应出现'] });
  const after = await service.get(run.runId, { scope: 'evaluation-user:u1' });
  assert.equal(after.answer, '结束前'); assert.deepEqual(after.run.details.progress, ['结束前']);
  complete({ status: 'done' }); await new Promise(resolve => setImmediate(resolve));
  assert.equal(saved.at(-1).answer, '结束前'); assert.equal(saved.at(-1).status, 'cancelled');
});
