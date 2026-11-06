const test = require('node:test');
const assert = require('node:assert/strict');
const { DEFAULT_SCHEME, SERVICE_KEYS, validateScheme } = require('../src/runs/batch-scheme');
const { generateTrialQuestions } = require('../src/question-bank/trial-questions');
const { createTrialBatchService } = require('../src/runs/trial-batch.service');
const { createManualBatchService } = require('../src/runs/manual-batch.service');

function small() {
  const config = structuredClone(DEFAULT_SCHEME);
  config.pools = { aviation: 0, synthesis: 3 };
  for (const key of SERVICE_KEYS) config.services[key] = { aviation: 0, synthesis: ['alloy', 'alpha-rsi'].includes(key) ? 3 : 0 };
  return config;
}
function generator() { let i = 0; return { async generate(input) { return { items: Array.from({ length: input.count }, () => ({ question: `这是合成材料测评问题，第 ${++i} 题。` })) }; } }; }

test('方案校验题池、服务、对比数量和单批上限', () => {
  const config = small();
  assert.deepEqual(validateScheme(config), config);
  const bad = structuredClone(config); bad.services['alpha-rsi'].synthesis = 2;
  assert.throws(() => validateScheme(bad), /相同数量/);
  bad.services['alpha-rsi'].synthesis = 3; bad.services.synthesis.synthesis = 4;
  assert.throws(() => validateScheme(bad), /不能超过/);
  const tooMany = structuredClone(DEFAULT_SCHEME); tooMany.services.literature.synthesis = 50;
  assert.throws(() => validateScheme(tooMany), /320/);
  const invalid = structuredClone(config); invalid.services.synthesis.aviation = 1;
  assert.throws(() => validateScheme(invalid));
});

test('小批次只生成三道题并完全相同地分发给两服务', async () => {
  const result = await generateTrialQuestions({ generator: generator(), scheme: small() });
  assert.deepEqual(Object.keys(result), ['alloy', 'alpha-rsi']);
  assert.equal(result.alloy.length, 3); assert.deepEqual(result.alloy, result['alpha-rsi']);
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
  const addresses = { alloy: 'ws://alloy.test', 'alpha-rsi': 'ws://alpha.test' };
  const evaluations = { async comparisonStorageReady() { return true; }, async createBatchRun(input, options) { calls.push({ input, options }); } };
  const trialService = createTrialBatchService({ repository: {}, evaluations, generator: generator(), serviceAddresses: addresses });
  const service = createManualBatchService({ repository, evaluations, generator: generator(), serviceAddresses: addresses, trialService, schemes: {} });
  const first = await service.create({ config: small(), userId: 'user-a', key: 'request-1' });
  for (let i = 0; i < 20 && plan.state !== 'submitted'; i++) await new Promise(resolve => setImmediate(resolve));
  assert.equal(plan.state, 'submitted'); assert.equal(calls.length, 6);
  assert.ok(calls.every(call => call.input.ownerUserId === 'user-a'));
  for (let i = 0; i < 3; i++) {
    const left = calls.find(call => call.options.key.endsWith(`:alloy:${i}`)).input;
    const right = calls.find(call => call.options.key.endsWith(`:alpha-rsi:${i}`)).input;
    assert.equal(left.question, right.question); assert.equal(left.comparisonGroupId, right.comparisonGroupId);
  }
  const again = await service.create({ config: small(), userId: 'user-a', key: 'request-1' });
  assert.equal(again.batchId, first.batchId); assert.equal(again.reused, true); assert.equal(calls.length, 6);
  const changed = small(); changed.compareAlloyAlpha = false;
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
  const serviceAddresses = { alloy: 'ws://alloy.test', 'alpha-rsi': 'ws://alpha.test' };
  const service = createTrialBatchService({ repository, evaluations, generator: generator(), serviceAddresses, schemes });
  await service.prepare('2026-11-04'); config.services.synthesis.synthesis = 1;
  await service.dispatch('2026-11-04');
  assert.equal(calls.length, 6); assert.equal(plan.configSnapshot.scheme.version, 2); assert.equal(plan.state, 'submitted');
});
