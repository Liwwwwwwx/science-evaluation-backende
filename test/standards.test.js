const test = require('node:test');
const assert = require('node:assert/strict');
const { createStandardsService } = require('../src/standards/service');
const { createApp } = require('../src/app');
const { createStandardsRepository } = require('../src/standards/repository');

test('无效标准标识在访问数据库前返回 400', async () => {
  const repo = createStandardsRepository({ pool: { query() { throw new Error('不应查询数据库'); } }, questions: {} });
  await assert.rejects(repo.confirm('-'.repeat(36), 'user'), { status: 400, code: 'INVALID_STANDARD' });
});

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
test('模型引用不符合原文时重试一次，并继续校验重试结果', async () => {
  const prompts = [];
  const service = createStandardsService({ llm: { model: 'test', isConfigured: () => true, async callJson(prompt, options) {
    prompts.push(prompt); assert.equal(options.maxTokens, 6000);
    return prompts.length === 1 ? { ...sample, explicitRequirements: [{ ...sample.explicitRequirements[0], source: '比较不同材料' }] } : sample;
  } } });
  const result = await service.generate({ question });
  assert.equal(prompts.length, 2);
  assert.match(prompts[1], /上次结果格式或题目引用未通过校验/);
  assert.equal(result.explicitRequirements[0].source, '比较两种材料');

  let attempts = 0;
  const bad = createStandardsService({ llm: { isConfigured: () => true, async callJson() { attempts++; return { ...sample, evaluationCriteria: [{ ...sample.evaluationCriteria[0], source: '伪造的题目要求' }] }; } } });
  await assert.rejects(bad.generate({ question }), { status: 502, code: 'STANDARDS_GENERATION_FAILED' });
  assert.equal(attempts, 2);
});
test('JSON 格式错误可重试一次，重复错误、超时及模型请求失败分别提示', async () => {
  let calls = 0;
  const retry = createStandardsService({ llm: { isConfigured: () => true, async callJson() { if (++calls === 1) throw new SyntaxError('invalid json'); return sample; } } });
  assert.equal((await retry.generate({ question })).domain, '材料选型');
  assert.equal(calls, 2);
  calls = 0;
  const invalid = createStandardsService({ llm: { isConfigured: () => true, async callJson() { calls++; throw new SyntaxError('invalid json'); } } });
  await assert.rejects(invalid.generate({ question }), { status: 502, code: 'STANDARDS_GENERATION_FAILED', message: '模型返回的标准格式不完整，请稍后重试' });
  assert.equal(calls, 2);
  for (const [error, status, code] of [[Object.assign(new Error('timeout'), { name: 'TimeoutError' }), 504, 'STANDARDS_MODEL_TIMEOUT'], [new Error('upstream private details'), 502, 'STANDARDS_MODEL_FAILED']]) {
    calls = 0;
    const service = createStandardsService({ llm: { isConfigured: () => true, async callJson() { calls++; throw error; } } });
    await assert.rejects(service.generate({ question }), value => value.status === status && value.code === code && !value.message.includes('private details'));
    assert.equal(calls, 1);
  }
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
test('标准生成接口重试无效引用并向客户端返回可区分的失败原因', async t => {
  let calls = 0, mode = 'retry';
  const standards = createStandardsService({ llm: { isConfigured: () => true, async callJson() {
    calls++;
    if (mode === 'timeout') throw Object.assign(new Error('private'), { name: 'TimeoutError' });
    if (calls === 1) return { ...sample, explicitRequirements: [{ ...sample.explicitRequirements[0], source: '无效引用' }] };
    return sample;
  } } });
  const token = 'a'.repeat(32);
  const app = createApp({ token, standards });
  await new Promise(resolve => app.listen(0, '127.0.0.1', resolve)); t.after(() => app.close());
  const post = () => fetch(`http://127.0.0.1:${app.address().port}/api/evaluation/standards`, { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify({ question }) });
  const success = await post();
  assert.equal(success.status, 200);
  assert.equal((await success.json()).explicitRequirements[0].source, '比较两种材料');
  assert.equal(calls, 2);
  mode = 'timeout'; calls = 0;
  const timeout = await post();
  assert.equal(timeout.status, 504);
  const body = await timeout.json();
  assert.equal(body.error.code, 'STANDARDS_MODEL_TIMEOUT');
  assert.equal(body.error.message, '标准生成超时，请稍后重试');
  assert.equal(calls, 1);
});
test('关联标准接口按读写权限和开关保护', async t => {
  const authService={async authenticate(value){if(!value)throw Object.assign(Error('请登录'),{status:401});return{id:'u',permissions:value==='writer'?['team-services:read','team-services:write']:['team-services:read']};}};
  let saved=0;const standardsRepository={async list(){return{items:[]};},async save(){saved++;return{id:'draft',state:'draft'};}};
  const app=createApp({token:'a'.repeat(32),publicOrigin:'http://localhost',authService,standardsRepository,questionBankWriteEnabled:true});
  await new Promise(resolve=>app.listen(0,'127.0.0.1',resolve));t.after(()=>app.close());const base=`http://127.0.0.1:${app.address().port}/api/evaluation/question-standards`;
  assert.equal((await fetch(base+'?questionId=q&datasetVersion=v',{headers:{cookie:'evaluation_session=reader'}})).status,200);
  const post=(cookie,origin)=>fetch(base,{method:'POST',headers:{cookie:`evaluation_session=${cookie}`,origin,'content-type':'application/json'},body:'{}'});
  assert.equal((await post('reader','http://localhost')).status,403);assert.equal((await post('writer','http://evil.test')).status,403);assert.equal((await post('writer','http://localhost')).status,200);assert.equal(saved,1);
});
