const test = require('node:test');
const assert = require('node:assert/strict');
const { generateTrialQuestions } = require('../src/question-bank/trial-questions');

test('默认批次按当前服务独立出题，两个 RSI 不共享题目', async () => {
  const calls = []; let i = 0;
  const generator = { async generate(input) { calls.push(input); return { items: Array.from({ length: input.count }, () => ({ question: `材料测评问题：请分析第 ${++i} 个合金配比和目标性能。` })) }; } };
  const result = await generateTrialQuestions({ generator });
  assert.deepEqual(Object.fromEntries(Object.entries(result).map(([key, value]) => [key, value.length])), { 'mission-material': 20, literature: 50, 'literature-aircraft': 50, 'alpha-rsi': 50, 'alpha-combined-rsi': 50 });
  assert.equal(new Set(Object.values(result).flat()).size, 220);
  assert.ok(calls.filter(input => input.serviceKey === 'alpha-rsi').every(input => input.focus === 'composition'));
  assert.ok(calls.filter(input => input.serviceKey === 'alpha-combined-rsi').every(input => input.generationMode === 'service'));
  assert.ok(calls.every(input => !['alloy', 'synthesis', 'new-material'].includes(input.serviceKey)));
});
