const test = require('node:test');
const assert = require('node:assert/strict');
const { createAlphaRsiSupplement } = require('../src/runs/alpha-rsi-supplement');

test('自动补充使用题目和追问，并在首选模型不可用时使用备用模型', async () => {
  let prompt;
  const generate = createAlphaRsiSupplement({ clients: {
    deepSeekScore: { isConfigured: () => true, callJson: async () => { throw new Error('failed'); } },
    qwenScore: { model: '备用模型', isConfigured: () => true, callJson: async value => { prompt = value; return { message: '假设温度为 900°C。' }; } },
  } });
  const result = await generate({ question: '比较材料强度', title: '补充温度', questions: ['温度是多少？'] });
  assert.deepEqual(result, { message: '假设温度为 900°C。', model: '备用模型' });
  for (const phrase of ['比较材料强度', '补充温度', '温度是多少？', '假设', '不得声称是用户提供']) assert.ok(prompt.includes(phrase));
});

test('模型未配置或输出为空时明确失败', async () => {
  const input = { question: '测试题', title: '补充', questions: [] };
  await assert.rejects(createAlphaRsiSupplement({ clients: {} })(input), /模型未配置/);
  const generate = createAlphaRsiSupplement({ clients: { deepSeekScore: { isConfigured: () => true, callJson: async () => ({ message: ' ' }) } } });
  await assert.rejects(generate(input), /生成失败/);
});
