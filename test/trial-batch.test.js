const test = require('node:test');
const assert = require('node:assert/strict');
const { createTrialBatchService } = require('../src/runs/trial-batch.service');

function fixture() {
  let plan = null; let generated = 0; const created = new Map(); const calls = [];
  const repository = {
    async create(value) { if (plan) return false; plan = { ...value, state: 'generating' }; return true; },
    async get() { return structuredClone(plan); },
    async ready(id, items) { if (plan.id !== id || plan.state !== 'generating') return false; plan.items = items; plan.state = 'dispatching'; return true; },
    async fail(id, error) { if (plan.id === id) { plan.state = 'failed'; plan.error = error; } },
    async submitted(id) { if (plan.id === id) plan.state = 'submitted'; },
  };
  const generator = { async generate(input) { return { items: Array.from({ length: input.count }, () => ({ question: `请分析材料结构及性能研究案例第 ${++generated} 题。` })) }; } };
  const serviceAddresses = Object.fromEntries(['mission-material', 'literature', 'literature-aircraft', 'alloy', 'synthesis', 'new-material'].map(key => [key, `ws://${key}.example/start`]));
  let firstFailure = true;
  const evaluations = { async createBatchRun(input, { key }) {
    calls.push(key); created.set(key, input);
    if (firstFailure) { firstFailure = false; throw new Error('模拟写入结果未知'); }
  } };
  return { service: createTrialBatchService({ repository, evaluations, generator, serviceAddresses }), get plan() { return plan; }, get generated() { return generated; }, created, calls };
}

test('题目快照先固定，派发异常后继续其他题并按原键恢复', async () => {
  const f = fixture();
  await f.service.prepare('2026-11-02');
  assert.equal(f.generated, 100);
  await f.service.prepare('2026-11-02');
  assert.equal(f.generated, 100);
  await assert.rejects(f.service.dispatch('2026-11-02'), /派发状态未知/);
  assert.equal(f.plan.state, 'dispatching');
  assert.equal(f.created.size, 270);
  await f.service.dispatch('2026-11-02');
  assert.equal(f.plan.state, 'submitted');
  assert.equal(f.created.size, 270);
  assert.equal(f.calls.length, 540);
  assert.equal(f.generated, 100);
});

test('随机出题失败记录计划失败，不派发任何题', async () => {
  let state; let dispatched = 0;
  const repository = { async create() { state = 'generating'; return true; }, async fail() { state = 'failed'; }, async get() { return { state }; } };
  const serviceAddresses = Object.fromEntries(['mission-material', 'literature', 'literature-aircraft', 'alloy', 'synthesis', 'new-material'].map(key => [key, `ws://${key}.example/start`]));
  const service = createTrialBatchService({ repository, serviceAddresses, generator: { async generate() { throw new Error('模型不可用'); } }, evaluations: { async createBatchRun() { dispatched++; } } });
  await assert.rejects(service.prepare('2026-11-02'));
  assert.equal(state, 'failed');
  assert.equal(dispatched, 0);
});
