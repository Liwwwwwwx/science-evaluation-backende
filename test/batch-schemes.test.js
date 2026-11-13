const test = require('node:test');
const assert = require('node:assert/strict');
const { DEFAULT_SCHEME, SERVICE_KEYS, validateScheme, upgradeComparisonScheme } = require('../src/runs/batch-scheme');
const { generateTrialQuestions } = require('../src/question-bank/trial-questions');
const { createTrialBatchService } = require('../src/runs/trial-batch.service');
const { createManualBatchService } = require('../src/runs/manual-batch.service');

function small() {
  const config = structuredClone(DEFAULT_SCHEME);
  for (const key of SERVICE_KEYS) config.services[key] = ['alpha-rsi', 'alpha-combined-rsi'].includes(key) ? 3 : 0;
  return config;
}
function generator() { let i = 0; return { async generate(input) { return { items: Array.from({ length: input.count }, () => ({ question: `这是合成材料测评问题，第 ${++i} 题。` })) }; } }; }

test('方案校验服务题量、对比数量和单批上限', () => {
  const config = small();
  assert.deepEqual(validateScheme(config), config);
  const bad = structuredClone(config); bad.compareAlloyAlpha = true; bad.services.alloy = 3; bad.services['alpha-rsi'] = 2;
  assert.throws(() => validateScheme(bad), /相同数量/);
  const tooMany = structuredClone(DEFAULT_SCHEME); tooMany.services.literature = 100; tooMany.services['mission-material'] = 100;
  assert.throws(() => validateScheme(tooMany), /320/);
  const invalid = structuredClone(config); invalid.services.synthesis = 101;
  assert.throws(() => validateScheme(invalid), /0至100/);
  const missing = structuredClone(config); delete missing.services.literature;
  assert.equal(validateScheme(missing).services.literature, 0);
});

test('旧方案把航空与合成题量合并为服务题数', () => {
  const legacy = {
    pools: { aviation: 3, synthesis: 3 },
    services: {
      alloy: { aviation: 2, synthesis: 1 }, 'alpha-rsi': { aviation: 2, synthesis: 1 },
      synthesis: { aviation: 0, synthesis: 3 }, literature: { aviation: 0, synthesis: 0 },
      'literature-aircraft': { aviation: 0, synthesis: 0 }, 'mission-material': { aviation: 0, synthesis: 0 },
      'new-material': { aviation: 0, synthesis: 0 },
    },
    compareAlloyAlpha: true,
  };
  const normalized = validateScheme(legacy);
  assert.equal(normalized.services.alloy, 3);
  assert.equal(normalized.services['alpha-rsi'], 3);
  assert.equal(normalized.services.synthesis, 3);
  assert.equal(normalized.pools, undefined);
});

test('方案并发按服务校验并补全默认值，旧方案不携带并发', () => {
  const config = small();
  config.concurrency = { alloy: 2, 'alpha-rsi': 2 };
  const normalized = validateScheme(config);
  assert.equal(normalized.concurrency.alloy, 2);
  assert.equal(normalized.concurrency['mission-material'], 5);
  assert.equal(validateScheme(small()).concurrency, undefined);
  assert.throws(() => validateScheme({ ...config, concurrency: { alloy: 0 } }), /1至5/);
  assert.throws(() => validateScheme({ ...config, concurrency: { alloy: 6 } }), /1至5/);
  assert.throws(() => validateScheme({ ...config, concurrency: { unknown: 2 } }), /并发配置无效/);
});

test('两个 RSI 服务独立生成题目', async () => {
  const result = await generateTrialQuestions({ generator: generator(), scheme: small() });
  assert.deepEqual(Object.keys(result), ['alpha-rsi', 'alpha-combined-rsi']);
  assert.equal(result['alpha-rsi'].length, 3); assert.equal(result['alpha-combined-rsi'].length, 3);
  assert.notDeepEqual(result['alpha-rsi'], result['alpha-combined-rsi']);
});

test('手动批次以个人身份派发，幂等重试复用原批次和题目', async () => {
  let plan; const calls = [];
  const repository = {
    async find(user, key) { return plan && user === plan.ownerUserId && key === 'request-1' ? structuredClone(plan) : null; },
    async ownershipReady() { return true; },
    async create(input) { plan = { id: input.id, state: 'generating', ownerUserId: input.userId, configSnapshot: input.configSnapshot, serviceAddresses: input.serviceAddresses, ruleSnapshot: input.ruleSnapshot }; return { plan: structuredClone(plan), reused: false }; },
    async get() { return structuredClone(plan); },
    async ready(id, items) { plan.items = items; plan.state = 'dispatching'; return true; },
    async submitted() { plan.state = 'submitted'; },
    async fail(id, error) { plan.state = 'failed'; plan.error = error; },
  };
  const addresses = { 'alpha-combined-rsi': 'ws://combined.test', 'alpha-rsi': 'ws://alpha.test' };
  const evaluations = { async comparisonStorageReady() { return true; }, async createBatchRun(input, options) { calls.push({ input, options }); } };
  const trialService = createTrialBatchService({ repository: {}, evaluations, generator: generator(), serviceAddresses: addresses });
  const service = createManualBatchService({ repository, evaluations, generator: generator(), serviceAddresses: addresses, trialService, schemes: {} });
  const first = await service.create({ config: small(), userId: 'user-a', key: 'request-1' });
  for (let i = 0; i < 20 && plan.state !== 'submitted'; i++) await new Promise(resolve => setImmediate(resolve));
  assert.equal(plan.state, 'submitted'); assert.equal(calls.length, 6);
  assert.ok(calls.every(call => call.input.ownerUserId === 'user-a'));
  for (let i = 0; i < 3; i++) {
    const left = calls.find(call => call.options.key.endsWith(`:alpha-combined-rsi:${i}`)).input;
    const right = calls.find(call => call.options.key.endsWith(`:alpha-rsi:${i}`)).input;
    assert.notEqual(left.question, right.question); assert.equal(left.comparisonGroupId, undefined); assert.equal(right.comparisonGroupId, undefined);
  }
  const again = await service.create({ config: small(), userId: 'user-a', key: 'request-1' });
  assert.equal(again.batchId, first.batchId); assert.equal(again.reused, true); assert.equal(calls.length, 6);
  const changed = small(); changed.services['alpha-rsi'] = 2;
  await assert.rejects(service.create({ config: changed, userId: 'user-a', key: 'request-1' }), { code: 'BATCH_IDEMPOTENCY_CONFLICT' });
});

test('夜间新计划保存方案快照，按原配比派发而不是硬编码320次', async () => {
  let plan; const calls = [];
  const repository = {
    async create(value) { plan = { ...value, state: 'generating' }; return true; },
    async get() { return structuredClone(plan); }, async ready(id, items) { plan.items = items; plan.state = 'dispatching'; return true; },
    async submitted() { plan.state = 'submitted'; }, async fail(id, error) { plan.state = 'failed'; plan.error = error; },
  };
  const config = small();
  const schemes = { async nightly() { return { id: 'scheme', name: '小批次', version: 2, config }; } };
  const evaluations = { async comparisonStorageReady() { return true; }, async createBatchRun(input) { calls.push(input); } };
  const serviceAddresses = { 'alpha-combined-rsi': 'ws://combined.test', 'alpha-rsi': 'ws://alpha.test' };
  const service = createTrialBatchService({ repository, evaluations, generator: generator(), serviceAddresses, schemes });
  await service.prepare('2026-11-04');
  await service.dispatch('2026-11-04');
  assert.equal(calls.length, 6); assert.equal(plan.configSnapshot.scheme.version, 2); assert.equal(plan.state, 'submitted');
});

test('夜间与手动派发携带方案配置的每服务并发', async () => {
  let plan; const calls = [];
  const repository = {
    async create(value) { plan = { ...value, state: 'generating' }; return true; },
    async get() { return structuredClone(plan); }, async ready(id, items) { plan.items = items; plan.state = 'dispatching'; return true; },
    async submitted() { plan.state = 'submitted'; }, async fail(id, error) { plan.state = 'failed'; plan.error = error; },
  };
  const config = small();
  config.concurrency = { 'alpha-combined-rsi': 2, 'alpha-rsi': 2 };
  const schemes = { async nightly() { return { id: 'scheme', name: '小批次', version: 2, config }; } };
  const evaluations = { async comparisonStorageReady() { return true; }, async createBatchRun(input) { calls.push(input); } };
  const serviceAddresses = { 'alpha-combined-rsi': 'ws://combined.test', 'alpha-rsi': 'ws://alpha.test' };
  const service = createTrialBatchService({ repository, evaluations, generator: generator(), serviceAddresses, schemes });
  await service.prepare('2026-11-04');
  await service.dispatch('2026-11-04');
  assert.equal(calls.length, 6);
  assert.ok(calls.every(call => call.concurrencyLimits && call.concurrencyLimits['alpha-combined-rsi'] === 2 && call.concurrencyLimits['alpha-rsi'] === 2));
});

test('旧方案投影到新批次时停用旧服务及同题对比', () => {
  const legacy = {
    pools: { aviation: 3, synthesis: 3 },
    services: {
      alloy: { aviation: 2, synthesis: 1 }, 'alpha-rsi': { aviation: 0, synthesis: 3 },
      synthesis: { aviation: 0, synthesis: 3 }, literature: { aviation: 0, synthesis: 0 },
      'literature-aircraft': { aviation: 0, synthesis: 0 }, 'mission-material': { aviation: 0, synthesis: 0 },
      'new-material': { aviation: 0, synthesis: 0 },
    },
    compareSynthesisAlpha: true,
  };
  const upgraded = upgradeComparisonScheme(legacy);
  assert.equal(upgraded.compareAlloyAlpha, false);
  assert.equal(upgraded.compareSynthesisAlpha, false);
  assert.equal(upgraded.services.alloy, 0); assert.equal(upgraded.services.synthesis, 0);
  assert.equal(upgraded.services['alpha-rsi'], 3); assert.equal(legacy.services.alloy.aviation, 2);
});

test('旧配置投影后创建的新批次，原请求重试仍复用原批次', async () => {
  const config = structuredClone(DEFAULT_SCHEME);
  for (const key of SERVICE_KEYS) config.services[key] = ['alloy', 'alpha-rsi'].includes(key) ? 3 : 0;
  config.compareAlloyAlpha = true;
  let plan;
  const repository = {
    async find() { return plan || null; }, async ownershipReady() { return true; },
    async create(input) { plan = { id: input.id, state: 'submitted', configSnapshot: input.configSnapshot }; return { plan, reused: false }; },
    async get() { return plan; },
  };
  const service = createManualBatchService({ repository, evaluations: {}, generator: {}, serviceAddresses: { 'alpha-rsi': 'ws://alpha.test' }, trialService: {}, schemes: {} });
  const first = await service.create({ config, userId: 'alice', key: 'legacy-request' });
  const second = await service.create({ config, userId: 'alice', key: 'legacy-request' });
  assert.equal(second.batchId, first.batchId); assert.equal(second.reused, true);
  assert.equal(plan.configSnapshot.config.services.alloy, 0);
  assert.equal(plan.configSnapshot.config.compareAlloyAlpha, false);
});
