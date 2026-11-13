const test = require('node:test');
const assert = require('node:assert/strict');
const { createTrialBatchService } = require('../src/runs/trial-batch.service');

function fixture(comparisonReady = true) {
  let plan = null; let generated = 0; const created = new Map(); const calls = [];
  const repository = {
    async create(value) { if (plan) return false; plan = { ...value, state: 'generating' }; return true; },
    async get() { return structuredClone(plan); },
    async ready(id, items) { if (plan.id !== id || plan.state !== 'generating') return false; plan.items = items; plan.state = 'dispatching'; return true; },
    async fail(id, error) { if (plan.id === id) { plan.state = 'failed'; plan.error = error; } },
    async submitted(id) { if (plan.id === id) plan.state = 'submitted'; },
  };
  const generator = { async generate(input) { return { items: Array.from({ length: input.count }, () => ({ question: `请分析材料结构及性能研究案例第 ${++generated} 题。` })) }; } };
  const serviceAddresses = Object.fromEntries(['mission-material', 'literature', 'literature-aircraft', 'alloy', 'synthesis', 'new-material', 'alpha-rsi', 'alpha-combined-rsi'].map(key => [key, `ws://${key}.example/start`]));
  let firstFailure = true;
  const evaluations = { async comparisonStorageReady() { return comparisonReady; }, async createBatchRun(input, { key }) {
    calls.push(key); created.set(key, input);
    if (firstFailure) { firstFailure = false; throw new Error('模拟写入结果未知'); }
  } };
  return { service: createTrialBatchService({ repository, evaluations, generator, serviceAddresses }), get plan() { return plan; }, get generated() { return generated; }, created, calls };
}

test('新批次冻结独立题目，派发异常后按原键恢复', async () => {
  const f = fixture(); await f.service.prepare('2026-11-02');
  assert.equal(f.generated, 220);
  await f.service.prepare('2026-11-02'); assert.equal(f.generated, 220);
  await assert.rejects(f.service.dispatch('2026-11-02'), /派发状态未知/);
  assert.equal(f.plan.state, 'dispatching'); assert.equal(f.created.size, 220);
  assert.ok([...f.created.values()].every(item => !item.comparisonGroupId && !['alloy', 'synthesis', 'new-material'].includes(item.serviceKey)));
  assert.notEqual(f.created.get(`${f.plan.id}:alpha-rsi:0`).question, f.created.get(`${f.plan.id}:alpha-combined-rsi:0`).question);
  await f.service.dispatch('2026-11-02');
  assert.equal(f.plan.state, 'submitted'); assert.equal(f.created.size, 220); assert.equal(f.calls.length, 440);
});

test('随机出题失败记录计划失败，不派发任何题', async () => {
  let state; let dispatched = 0;
  const repository = { async create() { state = 'generating'; return true; }, async fail() { state = 'failed'; }, async get() { return { state }; } };
  const serviceAddresses = Object.fromEntries(['mission-material', 'literature', 'literature-aircraft', 'alloy', 'synthesis', 'new-material', 'alpha-rsi', 'alpha-combined-rsi'].map(key => [key, `ws://${key}.example/start`]));
  const service = createTrialBatchService({ repository, serviceAddresses, generator: { async generate() { throw new Error('模型不可用'); } }, evaluations: { async comparisonStorageReady() { return true; }, async createBatchRun() { dispatched++; } } });
  await assert.rejects(service.prepare('2026-11-02'));
  assert.equal(state, 'failed');
  assert.equal(dispatched, 0);
});

test('旧批次包含停用服务时不派发并保留原快照', async () => {
  const keys = ['mission-material', 'literature', 'literature-aircraft', 'alloy', 'synthesis', 'new-material'];
  const addresses = Object.fromEntries(keys.map(key => [key, `ws://${key}.example/start`]));
  const items = Object.fromEntries(keys.map(key => [key, Array.from({ length: key === 'mission-material' ? 20 : 50 }, (_, i) => `材料测试问题 ${key} ${i}`)]));
  const plan = { id: 'old-plan', state: 'dispatching', items, serviceAddresses: addresses }; const calls = [];
  const service = createTrialBatchService({ repository: { async get() { return plan; }, async submitted() { plan.state = 'submitted'; } }, serviceAddresses: addresses, generator: {}, evaluations: { async createBatchRun(input) { calls.push(input); } } });
  await assert.rejects(service.dispatch('2026-11-02'), /已停用/);
  assert.equal(calls.length, 0); assert.equal(plan.state, 'dispatching'); assert.equal(plan.items.alloy.length, 50);
});

test('新批次不依赖历史对比存储', async () => {
  const f = fixture(false); await f.service.prepare('2026-11-02');
  assert.equal(f.plan.state, 'dispatching'); assert.equal(f.generated, 220);
});

test('题目快照被删改时在派发前拒绝整轮', async () => {
  const f = fixture(); await f.service.prepare('2026-11-02');
  f.plan.items['alpha-rsi'].pop();
  await assert.rejects(f.service.dispatch('2026-11-02'), /题目快照无效/);
  assert.equal(f.created.size, 0);
});
