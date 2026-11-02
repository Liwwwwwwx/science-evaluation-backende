const test = require('node:test');
const assert = require('node:assert/strict');
const { createStandardsService } = require('../src/standards/service');
const { createApp } = require('../src/app');

const question = '请比较两种材料，并说明选择依据。';
const sample = { domain: '材料选型', taskType: '比较', explicitRequirements: [{ requirement: '比较两种材料', critical: true, source: '比较两种材料' }], evaluationCriteria: [{ name: '材料比较', category: 'required', description: '比较两种材料', howToJudge: '检查是否比较两种材料', source: '比较两种材料' }, { name: '适用边界', category: 'recommended', description: '说明条件', howToJudge: '检查是否说明使用条件', source: null }], missingInformation: ['未提供载荷'] };
test('生成标准要求原题可核对引用，专业建议标记未核验', async () => {
  const service = createStandardsService({ llm: { model: 'test', isConfigured: () => true, async callJson(prompt) { assert.match(prompt, /不回答问题/); return sample; } } });
  const result = await service.generate({ question });
  assert.equal(result.explicitRequirements[0].source, '比较两种材料');
  assert.equal(result.evaluationCriteria[1].verification, 'not_verified');
  assert.equal(result.verification.status, 'not_verified');
  await assert.rejects(service.generate({ question: '太短' }), { code: 'STANDARDS_INVALID' });
  const bad = createStandardsService({ llm: { isConfigured: () => true, async callJson() { return { ...sample, explicitRequirements: [{ ...sample.explicitRequirements[0], source: '伪造的题目要求' }] }; } } });
  await assert.rejects(bad.generate({ question }), { code: 'STANDARDS_GENERATION_FAILED' });
});
test('API 允许授权会话或服务令牌，限制权限和跨站请求', async t => {
  const token = 'a'.repeat(32); let calls = 0;
  const app = createApp({ token, publicOrigin: 'http://localhost', authService: { async authenticate(value) { if (!value) throw Object.assign(new Error('请登录'), { status: 401 }); return { permissions: value === 'writer' ? ['team-services:write'] : [] }; } }, standards: { async generate(input) { calls++; return { question: input.question }; } } });
  await new Promise(resolve => app.listen(0, '127.0.0.1', resolve)); t.after(() => app.close());
  const url = `http://127.0.0.1:${app.address().port}/api/evaluation/standards`;
  const post = headers => fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify({ question }) });
  assert.equal((await post({})).status, 401);
  assert.equal((await post({ cookie: 'evaluation_session=reader', origin: 'http://localhost' })).status, 403);
  assert.equal((await post({ cookie: 'evaluation_session=writer', origin: 'http://evil.test' })).status, 403);
  assert.equal((await post({ cookie: 'evaluation_session=writer', origin: 'http://localhost' })).status, 200);
  assert.equal((await post({ authorization: `Bearer ${token}` })).status, 200);
  assert.equal(calls, 2);
});
