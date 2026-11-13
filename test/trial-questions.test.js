const test = require('node:test');
const assert = require('node:assert/strict');
const { generateTrialQuestions } = require('../src/question-bank/trial-questions');
const { DEFAULT_SCHEME, SERVICE_KEYS } = require('../src/runs/batch-scheme');

test('默认批次的两个 RSI 使用相同配比题并独立运行', async () => {
  const calls = []; let i = 0;
  const generator = { async generate(input) { calls.push(input); return { items: Array.from({ length: input.count }, () => ({ question: `材料测评问题：请分析第 ${++i} 个合金配比和目标性能。` })) }; } };
  const result = await generateTrialQuestions({ generator });
  assert.deepEqual(Object.fromEntries(Object.entries(result).map(([key, value]) => [key, value.length])), { 'mission-material': 20, literature: 50, 'literature-aircraft': 50, 'alpha-rsi': 50, 'alpha-combined-rsi': 50 });
  assert.equal(new Set(Object.values(result).flat()).size, 170);
  assert.deepEqual(result['alpha-rsi'], result['alpha-combined-rsi']);
  assert.ok(calls.filter(input => input.serviceKey === 'alpha-rsi').every(input => input.questionKind === 'composition'));
  assert.equal(calls.filter(input => input.serviceKey === 'alpha-combined-rsi').length, 0);
  assert.ok(calls.every(input => !['alloy', 'synthesis', 'new-material'].includes(input.serviceKey)));
});

test('题量不同时共享前缀，1109 制备专项独立生成且只计入 1109', async () => {
  const config = structuredClone(DEFAULT_SCHEME);
  for (const key of SERVICE_KEYS) config.services[key] = 0;
  config.services['alpha-rsi'] = 2; config.services['alpha-combined-rsi'] = 3; config.rsiManufacturingCount = 2;
  const calls = []; let index = 0;
  const generator = { async generate(input) { calls.push(input); return { items: Array.from({ length: input.count }, () => ({ question: `${input.questionKind} 材料配比测试题 ${++index}` })) }; } };
  const result = await generateTrialQuestions({ generator, scheme: config });
  assert.equal(result['alpha-rsi'].length, 2);
  assert.equal(result['alpha-combined-rsi'].length, 5);
  assert.deepEqual(result['alpha-rsi'], result['alpha-combined-rsi'].slice(0, 2));
  assert.ok(result['alpha-combined-rsi'].slice(3).every(question => question.startsWith('manufacturing')));
  assert.equal(calls.filter(input => input.questionKind === 'manufacturing').length, 1);
});

test('只启用 1109 制备专项时仍能独立生成题目', async () => {
  const config = structuredClone(DEFAULT_SCHEME);
  for (const key of SERVICE_KEYS) config.services[key] = 0;
  config.rsiManufacturingCount = 2;
  const generator = { async generate(input) { return { items: Array.from({ length: input.count }, (_, index) => ({ question: `制备专项材料参考问题 ${index + 1}` })) }; } };
  const result = await generateTrialQuestions({ generator, scheme: config });
  assert.deepEqual(Object.keys(result), ['alpha-combined-rsi']);
  assert.equal(result['alpha-combined-rsi'].length, 2);
});
