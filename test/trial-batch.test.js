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
  const serviceAddresses = Object.fromEntries(['mission-material', 'literature', 'literature-aircraft', 'alloy', 'synthesis', 'new-material', 'alpha-rsi'].map(key => [key, `ws://${key}.example/start`]));
  let firstFailure = true;
  const evaluations = { async comparisonStorageReady() { return true; }, async createBatchRun(input, { key }) {
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
  assert.equal(f.created.size, 320);
  for (let i = 0; i < 50; i++) {
    const synthesis = f.created.get(`${f.plan.id}:synthesis:${i}`);
    const alpha = f.created.get(`${f.plan.id}:alpha-rsi:${i}`);
    assert.equal(synthesis.question, alpha.question);
    assert.match(synthesis.comparisonGroupId, /^[a-f0-9]{64}$/);
    assert.equal(synthesis.comparisonGroupId, alpha.comparisonGroupId);
  }
  await f.service.dispatch('2026-11-02');
  assert.equal(f.plan.state, 'submitted');
  assert.equal(f.created.size, 320);
  assert.equal(f.calls.length, 640);
  assert.equal(f.generated, 100);
});

test('随机出题失败记录计划失败，不派发任何题', async () => {
  let state; let dispatched = 0;
  const repository = { async create() { state = 'generating'; return true; }, async fail() { state = 'failed'; }, async get() { return { state }; } };
  const serviceAddresses = Object.fromEntries(['mission-material', 'literature', 'literature-aircraft', 'alloy', 'synthesis', 'new-material', 'alpha-rsi'].map(key => [key, `ws://${key}.example/start`]));
  const service = createTrialBatchService({ repository, serviceAddresses, generator: { async generate() { throw new Error('模型不可用'); } }, evaluations: { async comparisonStorageReady() { return true; }, async createBatchRun() { dispatched++; } } });
  await assert.rejects(service.prepare('2026-11-02'));
  assert.equal(state, 'failed');
  assert.equal(dispatched, 0);
});

test('旧版270次快照按原键恢复，不依赖1110或对比存储', async () => {
  const keys = ['mission-material', 'literature', 'literature-aircraft', 'alloy', 'synthesis', 'new-material'];
  const addresses = Object.fromEntries(keys.map(key => [key, `ws://${key}.example/start`]));
  const items = Object.fromEntries(keys.map(key => [key, Array.from({ length: key === 'mission-material' ? 20 : 50 }, (_, i) => `材料测试问题 ${key} ${i}`)]));
  const plan = { id: 'old-plan', state: 'dispatching', items, serviceAddresses: addresses }; const calls = [];
  const service = createTrialBatchService({ repository: { async get() { return plan; }, async submitted() { plan.state = 'submitted'; } }, serviceAddresses: addresses, generator: {}, evaluations: { async createBatchRun(input, meta) { calls.push({ input, meta }); } } });
  await service.dispatch('2026-11-02');
  assert.equal(calls.length, 270);
  assert.ok(calls.every(call => !call.input.comparisonGroupId));
  assert.equal(plan.state, 'submitted');
});

test('对比存储未就绪时记录失败，不出题或派发', async () => {
  const addresses = Object.fromEntries(['mission-material', 'literature', 'literature-aircraft', 'alloy', 'synthesis', 'new-material', 'alpha-rsi'].map(key => [key, `ws://${key}.example/start`]));
  let state; let reason;
  const repository = { async create() { return true; }, async fail(id, error) { state = 'failed'; reason = error; } };
  const service = createTrialBatchService({ repository, serviceAddresses: addresses, generator: {}, evaluations: { async comparisonStorageReady() { return false; } } });
  await assert.rejects(service.prepare('2026-11-02'), /对比存储尚未迁移/);
  assert.equal(state, 'failed'); assert.match(reason, /对比存储/);
});

test('同题快照被改动时在派发前拒绝整轮', async () => {
  const f = fixture();
  await f.service.prepare('2026-11-02');
  f.plan.items['alpha-rsi'][0] = '一条不同的合成材料测试问题';
  await assert.rejects(f.service.dispatch('2026-11-02'), /对比题目快照不一致/);
  assert.equal(f.created.size, 0);
});
