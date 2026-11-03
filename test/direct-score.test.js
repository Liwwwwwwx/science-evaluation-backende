const test = require('node:test');
const assert = require('node:assert/strict');
const { createDirectScoreService, segmentsOf } = require('../src/scoring/direct-score');
const { createApp } = require('../src/app');

const question = '比较两种材料并说明选择依据';
const answer = '材料甲导热更好，材料乙重量更轻。';
const standard = '比较导热和重量，并说明选择依据';
const response = { score: 80, summary: '综合参考分，标准未指定权重', criteria: [{ criterion: '比较导热和重量', status: 'met', reason: '两者均有比较', evidence: '材料甲导热更好' }], suggestions: ['补充选择依据'] };
const client = (handler, configured = true) => ({ model: 'test-model', isConfigured: () => configured, callJson: handler });

test('直接评分使用给定题目、标准及输出，独立展示各评委结果', async () => {
  const prompts = [];
  const service = createDirectScoreService({ clients: { deepSeekScore: client(async prompt => { prompts.push(prompt); return response; }), qwenScore: client(async () => { throw Error('unavailable'); }) } });
  const result = await service.score({ question, standard, answer });
  assert.equal(result.scores.deepSeekScore.score, 80);
  assert.equal(result.scores.deepSeekScore.criteria[0].evidence, '材料甲导热更好');
  assert.equal(result.scores.qwenScore.status, 'failed');
  for (const value of [question, standard, answer]) assert.ok(prompts[0].includes(value));
});

test('无法核对证据或标准时保留参考分，但不展示未经验证的引用', async () => {
  const invalidEvidence = { ...response, criteria: [{ ...response.criteria[0], evidence: '不存在的引用' }] };
  const service = createDirectScoreService({ clients: { deepSeekScore: client(async () => invalidEvidence), qwenScore: client(async () => ({ ...response, criteria: [{ ...response.criteria[0], criterion: '无关要求' }] })) } });
  const result = await service.score({ question, standard, answer });
  assert.equal(result.scores.deepSeekScore.score, 80);
  assert.equal(result.scores.deepSeekScore.provisional, true);
  assert.equal(result.scores.deepSeekScore.criteria[0].status, 'unclear');
  assert.equal(result.scores.deepSeekScore.criteria[0].evidence, null);
  assert.equal(result.scores.deepSeekScore.criteria[0].evidenceUnverified, true);
  assert.ok(result.scores.deepSeekScore.evidenceWarning);
  assert.equal(result.scores.qwenScore.score, 80);
  assert.equal(result.scores.qwenScore.criteria[0].standardUnverified, true);
  assert.equal(result.scores.qwenScore.provisional, true);
});

test('题库关联标准的评价项不完整时保留参考分并列出缺项', async () => {
  const saved = JSON.stringify({ evaluationCriteria: [{ name: '比较导热和重量' }, { name: '说明选择依据' }] });
  const service = createDirectScoreService({ clients: { deepSeekScore: client(async () => response) } });
  const result = await service.score({ question, standard: saved, answer });
  assert.equal(result.scores.deepSeekScore.score, 80);
  assert.equal(result.scores.deepSeekScore.provisional, true);
  assert.match(result.scores.deepSeekScore.evidenceWarning, /未获得评价/);
  assert.equal(result.scores.deepSeekScore.criteria[1].criterion, '说明选择依据');
  assert.equal(result.scores.deepSeekScore.criteria[1].status, 'unclear');
});

test('逐项引用标准描述原文时不会误判为漏评', async () => {
  const saved = JSON.stringify({ evaluationCriteria: [{ name: '导热比较', description: '比较导热和重量' }] });
  const service = createDirectScoreService({ clients: { deepSeekScore: client(async () => response) } });
  const result = await service.score({ question, standard: saved, answer });
  assert.equal(result.scores.deepSeekScore.score, 80);
  assert.equal(result.scores.deepSeekScore.evidenceWarning, null);
});

test('原文片段编号还原真实内容，关联标准编号允许使用不同的显示文字', async () => {
  const saved = JSON.stringify({ evaluationCriteria: [{ name: '导热比较', description: '比较导热和重量' }] });
  const judge = { ...response, criteria: [{ id: 'C1', criterion: '模型改写的名称', status: 'met', reason: '已比较', evidence: ['A1'] }] };
  const service = createDirectScoreService({ clients: { deepSeekScore: client(async () => judge) } });
  const result = await service.score({ question, standard: saved, answer });
  assert.equal(result.scores.deepSeekScore.criteria[0].criterion, '导热比较');
  assert.equal(result.scores.deepSeekScore.criteria[0].evidence, answer);
  assert.equal(result.scores.deepSeekScore.provisional, false);
});

test('输出分片保留完整原文和 Unicode 字符，并控制片段数量', () => {
  const input = `${'a\n'.repeat(149)}😀${'b'.repeat(400)}`;
  const chunks = segmentsOf(input);
  assert.equal(chunks.map(item => item.text).join(''), input);
  assert.ok(chunks.length <= 3);
  assert.ok(chunks.every(item => !/[\uD800-\uDBFF]$/.test(item.text)));
});

test('模型未给分时重试一次；重复失败不伪造分数或复制另一家结果', async () => {
  let calls = 0;
  const service = createDirectScoreService({ clients: {
    deepSeekScore: client(async () => { calls++; return calls === 1 ? { ...response, score: null } : { ...response, score: '85/100' }; }),
    qwenScore: client(async () => ({ ...response, score: null })),
  } });
  const result = await service.score({ question, standard, answer });
  assert.equal(result.scores.deepSeekScore.score, 85);
  assert.equal(result.scores.deepSeekScore.attempts, 2);
  assert.equal(result.scores.qwenScore.status, 'failed');
  assert.match(result.scores.qwenScore.error, /未返回有效分数/);
  assert.equal(Object.hasOwn(result.scores.qwenScore, 'score'), false);
});

test('模型只返回分数时保留参考分，标明评价不完整', async () => {
  const service = createDirectScoreService({ clients: { deepSeekScore: client(async () => ({ score: 72 })) } });
  const result = await service.score({ question, standard, answer });
  assert.equal(result.scores.deepSeekScore.score, 72);
  assert.equal(result.scores.deepSeekScore.provisional, true);
  assert.match(result.scores.deepSeekScore.evidenceWarning, /逐项评价/);
});

test('凭据脱敏、无模型、并发上限及超时均明确处理', async () => {
  let prompt = '';
  const service = createDirectScoreService({ clients: { deepSeekScore: client(async p => { prompt = p; return response; }) } });
  const result = await service.score({ question, standard, answer: `${answer}\nPASSWORD=temporary-example-password` });
  assert.equal(result.redacted, true);
  assert.ok(!prompt.includes('temporary-example-password'));
  await assert.rejects(createDirectScoreService({ clients: {} }).score({ question, standard, answer }), { status: 503 });
  const busy = createDirectScoreService({ clients: { deepSeekScore: client(() => new Promise(() => {})) }, maxActive: 1, timeoutMs: 20 });
  const first = busy.score({ question, standard, answer });
  await assert.rejects(busy.score({ question, standard, answer }), { status: 429 });
  assert.equal((await first).scores.deepSeekScore.status, 'failed');
});

test('接口要求登录、写权限和同源；关联标准必须属于当前题目版本', async t => {
  const authService = { async authenticate(value) { if (!value) throw Object.assign(Error('请登录'), { status: 401 }); return { id: 'u', permissions: value === 'reader' ? ['team-services:read'] : value === 'write-only' ? ['team-services:write'] : ['team-services:read', 'team-services:write'] }; } };
  const standardId = '11111111-1111-4111-8111-111111111111';
  let called = 0;
  const directScore = { async score(input) { called++; return { input }; } };
  const questionBank = { async get(id, version) { assert.equal(id, 'q'); assert.equal(version, 'v1'); return { question, status: 'active' }; } };
  const standardsRepository = { async list() { return { items: [{ id: standardId, question, content: { evaluationCriteria: [{ name: '比较导热和重量' }] } }] }; } };
  const server = createApp({ token: 'x'.repeat(32), authService, directScore, questionBank, standardsRepository, publicOrigin: 'http://localhost' });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); t.after(() => server.close());
  const url = `http://127.0.0.1:${server.address().port}/api/evaluation/direct-score`;
  const payload = { question, answer, standard: { type: 'saved', questionId: 'q', datasetVersion: 'v1', id: standardId } };
  const send = (headers, body = payload) => fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });
  assert.equal((await send({ origin: 'http://localhost' })).status, 401);
  assert.equal((await send({ origin: 'http://localhost', cookie: 'evaluation_session=reader' })).status, 403);
  assert.equal((await send({ origin: 'http://localhost', cookie: 'evaluation_session=write-only' })).status, 403);
  assert.equal((await send({ origin: 'http://evil', cookie: 'evaluation_session=writer' })).status, 403);
  const headers = { origin: 'http://localhost', cookie: 'evaluation_session=writer' };
  assert.equal((await send(headers, { ...payload, standard: { ...payload.standard, id: '22222222-2222-4222-8222-222222222222' } })).status, 404);
  assert.equal((await send(headers, { ...payload, question: '另一道题目内容不同' })).status, 409);
  const result = await (await send(headers)).json();
  assert.equal(called, 1);
  assert.match(result.input.standard, /比较导热和重量/);
  assert.equal(result.input.answer, answer);
});
