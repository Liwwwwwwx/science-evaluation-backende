const test = require('node:test');
const assert = require('node:assert/strict');
const { generateTrialQuestions } = require('../src/question-bank/trial-questions');

test('新生成100道题，按服务领域复用为320次运行，1110与合金材料同题', async () => {
  const calls = []; let i = 0;
  const generator = { async generate(input) { calls.push(input); return { items: Array.from({ length: input.count }, () => ({ question: `请针对第${++i}个航空高温合金场景，在700℃、抗拉强度≥800 MPa 约束下给出 2–3 组 wt.% 配比候选并排序。` })) }; } };
  const result = await generateTrialQuestions({ generator });
  assert.deepEqual(Object.fromEntries(Object.entries(result).map(([key, value]) => [key, value.length])), { 'mission-material': 20, literature: 50, 'literature-aircraft': 50, alloy: 50, synthesis: 50, 'alpha-rsi': 50, 'new-material': 50 });
  assert.deepEqual(result['alpha-rsi'], result.alloy);
  assert.equal(new Set(Object.values(result).flat()).size, 100);
  assert.ok(calls.slice(0, 5).every(input => input.serviceKey === 'literature-aircraft' && input.focus === 'optimization'));
  assert.ok(calls.slice(5).every(input => input.serviceKey === 'synthesis' && input.focus === 'optimization'));
});
