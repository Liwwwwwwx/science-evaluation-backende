const test = require('node:test');
const assert = require('node:assert/strict');
const { createApp } = require('../src/app');
const { createQuestionBankGenerationService } = require('../src/question-bank/generation');
const { createUnifiedEvaluationService } = require('../src/runs/unified-evaluation.service');

const token = 'test-service-token-0123456789012345';
const path = '/api/admin/team-services/evaluations/question-bank/generate';

test('内部接口校验令牌和输入，生成只返回预览', async (t) => {
  let calls = 0;
  const generator = createQuestionBankGenerationService({ llm: { model: 'mock', isConfigured: () => true, async callJson() { calls++; return { questions: ['请比较两种材料的强度', '请比较两种材料的强度。'] }; } } });
  const server = createApp({ token, generator });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}`;
  assert.equal((await fetch(`${base}/health`)).status, 200);
  const body = JSON.stringify({ serviceKey: 'alloy', topic: '合金性能', count: 2 });
  assert.equal((await fetch(base + path, { method: 'POST', headers: { 'content-type': 'application/json' }, body })).status, 401);
  const headers = { authorization: `Bearer ${token}`, 'content-type': 'application/json' };
  assert.equal((await fetch(base + path, { method: 'POST', headers, body: JSON.stringify({ serviceKey: 'bad', topic: '合金', count: 2 }) })).status, 400);
  const response = await fetch(base + path, { method: 'POST', headers, body });
  assert.equal(response.status, 200);
  assert.deepEqual((await response.json()).items, [{ serviceKey: 'alloy', question: '请比较两种材料的强度' }]);
  assert.equal(calls, 1);
  assert.equal((await fetch(base + path, { method: 'POST', headers, body: 'x'.repeat(9000) })).status, 413);
});

test('缺少安全令牌不能启动，未配置模型时返回 503', async (t) => {
  assert.throws(() => createApp({ token: 'short' }));
  const generator = createQuestionBankGenerationService({ llm: { isConfigured: () => false } });
  const server = createApp({ token, generator });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const result = await fetch(`http://127.0.0.1:${server.address().port}${path}`, { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify({ serviceKey: 'alloy', topic: '材料', count: 1 }) });
  assert.equal(result.status, 503);
});

test('独立运行核心区分执行与评分状态', async () => {
  let finishScore;
  const score = new Promise((resolve) => { finishScore = resolve; });
  const evaluator = { async askQuestionStream(_, { onText }) { onText('回答'); return { run: { id: 'native-1' }, completion: Promise.resolve({ status: 'done' }) }; }, async getAskResult() { return score; } };
  const service = createUnifiedEvaluationService({ evaluators: { 'alpha-rsi': evaluator } });
  const run = await service.start({ serviceKey: 'alpha-rsi', question: '测试题目' });
  await new Promise((resolve) => setImmediate(resolve));
  const pending = await service.get(run.runId);
  assert.equal(pending.answer, '回答');
  assert.equal(pending.executionStatus, 'succeeded');
  assert.equal(pending.scoringStatus, 'pending');
  finishScore({ deepSeekScore: { status: 'failed' }, qwenScore: { status: 'unavailable' } });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal((await service.get(run.runId)).scoringStatus, 'failed');
});
