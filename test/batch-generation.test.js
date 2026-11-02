const test = require('node:test');
const assert = require('node:assert/strict');
const { generateBatchQuestions } = require('../src/question-bank/batch-generation');

test('按方向分批生成，跨批去重并补齐目标数量', async () => {
  const calls = [];
  const generator = { async generate(input) {
    calls.push(input);
    return { items: calls.length === 1
      ? [{ question: '请解释钛合金的高温蠕变机制。' }, { question: '请解释钛合金的高温蠕变机制！' }]
      : [{ question: '请说明航空复合材料的湿热失效机制。' }] };
  } };
  const result = await generateBatchQuestions({ generator, input: { serviceKey: 'literature-aircraft', topic: '航空材料' }, count: 2 });
  assert.equal(result.length, 2);
  assert.deepEqual(calls.map(call => call.count), [2, 1]);
  assert.ok(calls.every(call => call.serviceKey === 'literature-aircraft' && call.topic === '航空材料'));
});

test('多次生成仍不足时明确失败，不返回不完整批次', async () => {
  const generator = { async generate() { return { items: [{ question: '请解释钛合金的高温蠕变机制。' }] }; } };
  await assert.rejects(generateBatchQuestions({ generator, input: { domainKey: 'materials-rd' }, count: 2, maxAttempts: 2 }), { code: 'BATCH_QUESTIONS_INSUFFICIENT' });
});

test('暂时生成失败可在有限次数内补充题目', async () => {
  let calls = 0;
  const generator = { async generate() { if (++calls === 1) throw Error('模型暂时不可用'); return { items: [{ question: '请分析合金结构对高温强度的影响。' }] }; } };
  assert.equal((await generateBatchQuestions({ generator, input: { domainKey: 'materials-rd' }, count: 1, maxAttempts: 2 })).length, 1);
  assert.equal(calls, 2);
});
