const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createApp } = require('../src/app');
const { createQuestionBankService } = require('../src/question-bank/service');
const { createEvalQuestionBankRepository } = require('../src/question-bank/repository');
const { createQuestionBankGenerationService } = require('../src/question-bank/generation');
const { createRunQuestionResolver } = require('../src/runs/question-resolver');
const { DOMAINS } = require('../src/question-bank/domains');

test('领域出题主题可省略，支持预设方向与自定义，旧服务请求仍要求主题', async () => {
  let prompt = ''; let calls = 0;
  const service = createQuestionBankGenerationService({ llm: { isConfigured: () => true, callJson: async value => { calls++; prompt = value; return { questions: ['请设计芯片封装热管理性能验证实验。'] }; } } });
  const base = { domainKey: 'chip-packaging', count: 1 };
  await service.generate(base);
  assert.ok(prompt.includes('综合出题')); assert.ok(prompt.includes('芯片封装')); assert.ok(prompt.includes('自行选择'));
  for (const [focus, label] of Object.entries({ principles: '基础原理', design: '方案设计', comparison: '性能对比', validation: '实验验证', diagnosis: '问题诊断' })) {
    await service.generate({ ...base, focus, topic: '' }); assert.ok(prompt.includes(label));
    assert.ok(!prompt.includes('本批题型安排'));
  }
  await service.generate({ ...base, focus: 'custom', topic: '可靠性试验' }); assert.ok(prompt.includes('可靠性试验'));
  const previousCalls = calls;
  for (const input of [{ ...base, focus: 'unknown' }, { ...base, focus: 'custom', topic: ' ' }, { ...base, topic: null }, { serviceKey: 'alloy', count: 1 }]) {
    await assert.rejects(() => service.generate(input), e => e.code === 'QUESTION_GENERATION_INVALID');
  }
  assert.equal(calls, previousCalls);
});

test('综合出题按数量分配题型，领域方向进入提示且保持候选接口格式', async () => {
  const prompts = [];
  const service = createQuestionBankGenerationService({ llm: { isConfigured: () => true, callJson: async prompt => { prompts.push(prompt); return { questions: ['请解释当前材料的结构与性能之间的关系。'] }; } } });
  for (const count of [1, 4, 10]) {
    const result = await service.generate({ domainKey: 'chip-packaging', count });
    assert.deepEqual(result.items[0], { domainKey: 'chip-packaging', question: '请解释当前材料的结构与性能之间的关系。' });
    const prompt = prompts.at(-1);
    assert.equal((prompt.match(/第\d+题：/g) || []).length, count);
    assert.ok(prompt.includes('互连与信号完整性'));
    assert.ok(prompt.includes('明确标为假设'));
  }
});

test('按领域生成候选，不绑定服务且拒绝未知领域', async () => {
  let prompt = '';
  const service = createQuestionBankGenerationService({ llm: { isConfigured: () => true, callJson: async value => { prompt = value; return { questions: ['请分析芯片封装中热管理的主要挑战。'] }; } } });
  for (const domainKey of Object.keys(DOMAINS)) {
    const result = await service.generate({ domainKey, topic: '热管理', count: 1 });
    assert.equal(result.items[0].domainKey, domainKey);
    assert.equal(result.items[0].serviceKey, undefined);
    assert.ok(prompt.includes(DOMAINS[domainKey]));
  }
  await assert.rejects(() => service.generate({ domainKey: 'unknown', topic: '测试', count: 1 }), e => e.code === 'QUESTION_GENERATION_INVALID');
  await assert.rejects(() => service.generate({ domainKey: 'chip-packaging', serviceKey: 'alloy', topic: '测试', count: 1 }), e => e.code === 'QUESTION_GENERATION_INVALID');
});

test('按被测服务出题使用对应提示、支持选填主题并绑定目标服务', async () => {
  let prompt = ''; let calls = 0;
  const generator = createQuestionBankGenerationService({ llm: { isConfigured: () => true, callJson: async value => { calls++; prompt = value; return { questions: ['请检索并归纳航空发动机高温合金相关研究文献。'] }; } } });
  const labels = { 'mission-material': 'Mission 主服务', 'alpha-rsi': '材料 RSI', literature: '文献检索服务', 'literature-aircraft': '航空文献服务', alloy: '合金材料服务', synthesis: '合成制备服务', 'new-material': '新材料服务' };
  for (const [serviceKey, label] of Object.entries(labels)) {
    const result = await generator.generate({ generationMode: 'service', serviceKey, count: 1 });
    assert.equal(result.items[0].serviceKey, serviceKey);
    assert.equal(result.items[0].domainKey, undefined);
    assert.ok(prompt.includes(label));
    assert.ok(!prompt.includes('本批题型安排'));
  }
  await generator.generate({ generationMode: 'service', serviceKey: 'literature-aircraft', topic: '发动机合金', count: 1 });
  assert.ok(prompt.includes('发动机合金'));
  const previousCalls = calls;
  for (const input of [
    { generationMode: 'service', serviceKey: 'literature', domainKey: 'materials-rd', count: 1 },
    { generationMode: 'service', serviceKey: 'literature', focus: 'design', count: 1 },
    { generationMode: 'other', serviceKey: 'literature', topic: '测试', count: 1 },
    { generationMode: 'service', serviceKey: 'literature', topic: null, count: 1 },
  ]) await assert.rejects(() => generator.generate(input), e => e.code === 'QUESTION_GENERATION_INVALID');
  assert.equal(calls, previousCalls);
});

test('双服务随机题同时考虑服务侧重点，不绑定题库且按字数上限校验', async () => {
  let prompt = ''; let options = null; let candidate = '请为航空铝合金支架提出 2–3 组 wt.% 配比候选，在屈服强度≥350 MPa、延伸率≥8% 的约束下比较工艺窗口并排序。';
  const generator = createQuestionBankGenerationService({ llm: { model: 'test-model', isConfigured: () => true, callJson: async (value, callOptions) => { prompt = value; options = callOptions; return { questions: [candidate] }; } } });
  for (const keys of [['alloy', 'alpha-rsi'], ['alpha-rsi', 'alloy']]) {
    const result = await generator.generate({ generationMode: 'comparison', serviceKeys: keys, count: 1 });
    assert.deepEqual(result, { generationMode: 'comparison', serviceKeys: keys, items: [{ question: candidate }], model: 'test-model' });
    assert.match(prompt, /成分与性能预测/); assert.match(prompt, /成分、性能与工艺选择/); assert.match(prompt, /最多 500 字符/);
    assert.match(prompt, /航空铝合金/); assert.match(prompt, /不要求预测耐蚀性/); assert.match(prompt, /不要使用氧化物陶瓷/); assert.match(prompt, /不要声称两个服务具有相同工具或保证/);
    assert.match(prompt, /禁止以解释机理、原理或机制作为题目主体/); assert.match(prompt, /至少一个明确的数值约束/);
    assert.match(prompt, /正例/); assert.match(prompt, /反例/);
    assert.equal(options.temperature, 0.6);
  }
  for (const bad of [
    { serviceKeys: ['alloy', 'alloy'], count: 1 }, { serviceKeys: ['alloy', 'bad'], count: 1 },
    { serviceKeys: ['alloy'], count: 1 }, { serviceKeys: ['alloy', 'alpha-rsi'], count: 2 },
    { serviceKeys: ['alloy', 'alpha-rsi'], count: 1, domainKey: 'materials-rd' }, { serviceKeys: ['literature', 'mission-material'], count: 1 },
  ]) await assert.rejects(generator.generate({ generationMode: 'comparison', ...bad }), { code: 'QUESTION_GENERATION_INVALID' });
  candidate = '过'.repeat(501);
  await assert.rejects(generator.generate({ generationMode: 'comparison', serviceKeys: ['alloy', 'alpha-rsi'], count: 1 }), { code: 'QUESTION_GENERATION_EMPTY' });
});

test('对比随机题拒绝机理解释题并自动重试为配比优化题', async () => {
  const prompts = []; let calls = 0;
  const generator = createQuestionBankGenerationService({ llm: { isConfigured: () => true, callJson: async prompt => {
    prompts.push(prompt); calls++;
    return { questions: [calls === 1 ? '请解释镍基高温合金中γ′相沉淀强化的机制。' : '某高温合金要求700℃抗拉强度≥800 MPa，请提出 2–3 组 wt.% 配比候选并排序。'] };
  } } });
  const result = await generator.generate({ generationMode: 'comparison', serviceKeys: ['alloy', 'alpha-rsi'], count: 1 });
  assert.equal(calls, 2);
  assert.match(prompts[1], /不符合要求/);
  assert.match(prompts[1], /不能以解释机理、原理或机制为主题/);
  assert.match(result.items[0].question, /配比/);
});

test('对比随机题连续生成机理题时明确失败，不返回跑偏题目', async () => {
  let calls = 0;
  const generator = createQuestionBankGenerationService({ llm: { isConfigured: () => true, callJson: async () => { calls++; return { questions: ['请解释镍基高温合金中γ′相沉淀强化的机制。'] }; } } });
  await assert.rejects(generator.generate({ generationMode: 'comparison', serviceKeys: ['alloy', 'alpha-rsi'], count: 1 }), { code: 'QUESTION_GENERATION_EMPTY' });
  assert.equal(calls, 2);
});

test('批次优化出题只保留带具体数值约束并要求候选比较的题目', async () => {
  let prompt = '';
  const generator = createQuestionBankGenerationService({ llm: { isConfigured: () => true, callJson: async value => { prompt = value; return { questions: [
    '请解释镍基高温合金中γ′相沉淀强化的机制。',
    '某高温合金在700℃，要求室温屈服≥假设门槛，请给出 2 组 wt.% 配比候选并排序。',
    '请针对700℃、屈服强度≥900 MPa 的航空高温合金，给出 2–3 组 wt.% 成分候选并排序。',
  ] }; } } });
  const result = await generator.generate({ serviceKey: 'literature-aircraft', focus: 'optimization', topic: '航空航天高温合金', count: 2 });
  assert.equal(result.items.length, 1);
  assert.match(result.items[0].question, /配比|成分/);
  assert.match(prompt, /配比\/配方或工艺优化任务/);
  assert.match(prompt, /本批题型安排/);
  assert.match(prompt, /数值约束/);
  assert.match(prompt, /不能用“假设门槛\/待定上限”代替/);
});

test('服务题确认保存后保留绑定，其他服务不能使用该题', async () => {
  const generator = createQuestionBankGenerationService({ llm: { isConfigured: () => true, callJson: async () => ({ questions: ['请检索航空发动机高温合金研究文献并归纳结果。'] }) } });
  const generated = await generator.generate({ generationMode: 'service', serviceKey: 'literature-aircraft', count: 1 });
  const bank = createQuestionBankService({
    insertRandomQuestionsAtomic: async items => ({ items, created: items.length, reused: 0 }),
    insertFixedQuestionsAtomic: async items => items,
  });
  for (const result of [await bank.saveRandom(generated), await bank.import(generated)]) {
    const item = result.items[0];
    assert.equal(item.serviceKey, 'literature-aircraft');
    const resolve = createRunQuestionResolver({ getQuestion: async () => ({ ...item, layer: 'base', status: 'active', sourceType: 'random' }) });
    const input = { question: item.question, questionId: item.id, datasetVersion: item.datasetVersion, sourceType: 'random', serviceKey: 'literature-aircraft' };
    assert.equal(await resolve(input), null);
    await assert.rejects(() => resolve({ ...input, serviceKey: 'literature' }), e => e.code === 'QUESTION_NOT_RUNNABLE');
  }
});

test('测试集题标记适用服务后可被两个材料服务使用', async () => {
  const row = { layer: 'base', status: 'active', sourceType: 'fixed', serviceKey: 'alloy', applicableServices: ['alloy', 'alpha-rsi'], question: '测试题面内容', criteria: null };
  const resolve = createRunQuestionResolver({ getQuestion: async () => row });
  const base = { question: '测试题面内容', questionId: 'q', datasetVersion: 'v', sourceType: 'fixed' };
  assert.equal(await resolve({ ...base, serviceKey: 'alloy' }), null);
  assert.equal(await resolve({ ...base, serviceKey: 'alpha-rsi' }), null);
  await assert.rejects(() => resolve({ ...base, serviceKey: 'literature' }), e => e.code === 'QUESTION_NOT_RUNNABLE');
  const limited = createRunQuestionResolver({ getQuestion: async () => ({ ...row, applicableServices: ['alloy'] }) });
  await assert.rejects(() => limited({ ...base, serviceKey: 'alpha-rsi' }), e => e.code === 'QUESTION_NOT_RUNNABLE');
});

test('合金与材料 RSI 出题会参考测试集案例', async () => {
  let prompt = '';
  const generator = createQuestionBankGenerationService({
    caseExamples: async keys => { assert.deepEqual(keys, ['alloy', 'alpha-rsi']); return ['案例：某高温合金要求700℃、抗拉强度≥800 MPa，请给出 2–3 组 wt.% 配比候选并排序。']; },
    llm: { isConfigured: () => true, callJson: async value => { prompt = value; return { questions: ['某高温合金要求700℃、抗拉强度≥800 MPa，请给出 2–3 组 wt.% 配比候选并排序。'] }; } },
  });
  await generator.generate({ generationMode: 'comparison', serviceKeys: ['alloy', 'alpha-rsi'], count: 1 });
  assert.match(prompt, /参考案例/); assert.match(prompt, /不要照抄或复述原题/);
  const serviceGenerator = createQuestionBankGenerationService({
    caseExamples: async keys => { assert.deepEqual(keys, ['alpha-rsi']); return ['案例：某高温合金要求700℃、抗拉强度≥800 MPa，请给出 2–3 组 wt.% 配比候选并排序。']; },
    llm: { isConfigured: () => true, callJson: async value => { prompt = value; return { questions: ['某高温合金要求700℃、抗拉强度≥800 MPa，请给出 2–3 组 wt.% 配比候选并排序。'] }; } },
  });
  await serviceGenerator.generate({ generationMode: 'service', serviceKey: 'alpha-rsi', count: 1 });
  assert.match(prompt, /参考案例/);
});

test('服务题过滤无效、重复及超长候选，模型无有效结果时返回错误', async () => {  let candidates = ['请说明适合该材料的制备条件和验证方法。', '请说明适合该材料的制备条件和验证方法。', '太短', '过'.repeat(201)];
  const generator = createQuestionBankGenerationService({ llm: { isConfigured: () => true, callJson: async () => ({ questions: candidates }) } });
  const result = await generator.generate({ generationMode: 'service', serviceKey: 'synthesis', count: 4 });
  assert.deepEqual(result.items, [{ serviceKey: 'synthesis', question: candidates[0] }]);
  candidates = ['太短'];
  await assert.rejects(() => generator.generate({ generationMode: 'service', serviceKey: 'synthesis', count: 1 }), e => e.code === 'QUESTION_GENERATION_EMPTY');
});

test('题库只接受 science_admin 连接', async () => {
  const repo = createEvalQuestionBankRepository({ pool: { query: async () => ({ rows: [{ name: 'other' }] }), connect: async () => { throw new Error('must not connect'); } } });
  await assert.rejects(() => repo.listQuestionsPaged(), /science_admin/);
});

test('双服务题库筛选校验两服务并传递长度限制', async () => {
  let query;
  const service = createQuestionBankService({ findMissingFixedCaseBaselines: async () => [], listQuestionsPaged: async input => { query = input; return { items: [], total: 0 }; } });
  const valid = new URLSearchParams({ runnableFor: 'alloy', comparisonWith: 'alpha-rsi', maxLength: '500', testSet: '材料研发测试案例集' });
  assert.equal((await service.list(valid)).comparisonFiltered, true);
  assert.equal(query.runnableFor, 'alloy'); assert.equal(query.comparisonWith, 'alpha-rsi'); assert.equal(query.maxLength, 500); assert.equal(query.testSet, '材料研发测试案例集');
  for (const params of [
    { comparisonWith: 'alpha-rsi' }, { runnableFor: 'alloy', comparisonWith: 'alloy' },
    { runnableFor: 'alloy', comparisonWith: 'unknown' }, { runnableFor: 'alloy', maxLength: '0' },
    { runnableFor: 'alloy', maxLength: '201.5' }, { runnableFor: 'alloy', maxLength: '501' },
    { runnableFor: 'alloy', testSet: '过'.repeat(101) },
  ]) await assert.rejects(service.list(new URLSearchParams(params)), { code: 'INVALID_QUERY' });
  const sets = createQuestionBankService({ listTestSets: async () => [{ name: '材料研发测试案例集', count: 2 }] });
  assert.deepEqual(await sets.testSets(), { items: [{ name: '材料研发测试案例集', count: 2 }] });
});

test('双服务检索在数据库中同时限制两个服务、题型规则和题长', async () => {
  let selected;
  const repo = createEvalQuestionBankRepository({ pool: { connect: async () => { throw Error('不应写入'); }, async query(sql, params) {
    if (sql.includes('current_database()')) return { rows: [{ name: 'science_admin' }] };
    selected = { sql, params }; return { rows: [] };
  } } });
  await repo.listQuestionsPaged({ runnableFor: 'alloy', comparisonWith: 'alpha-rsi', maxLength: 500 });
  assert.match(selected.sql, /service_key = \$2 OR applicable_services @> ARRAY\[\$2\]::text\[\]/);
  assert.match(selected.sql, /service_key = \$3 OR applicable_services @> ARRAY\[\$3\]::text\[\]/);
  assert.match(selected.sql, /criteria IS NULL/);
  assert.match(selected.sql, /char_length\(btrim\(question\)\) <= \$4/);
  assert.deepEqual(selected.params.slice(0, 4), ['active', 'alloy', 'alpha-rsi', 500]);
});

test('题库接口校验登录、读写权限、来源与写入开关', async t => {
  const authService = { authenticate: async token => {
    if (token === 'reader') return { permissions: ['team-services:read'] };
    if (token === 'writer') return { permissions: ['team-services:read', 'team-services:write'] };
    throw Object.assign(new Error('请先登录'), { status: 401, code: 'UNAUTHORIZED' });
  } };
  const bank = { list: async () => ({ items: [], total: 0 }), testSets: async () => ({ items: [] }), get: async (id, datasetVersion) => ({ id, datasetVersion, question: '测试题目内容' }), import: async () => ({ items: [] }) };
  const server = createApp({ token: 'x'.repeat(32), authService, questionBank: bank, publicOrigin: 'http://localhost:6715' });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); t.after(() => server.close());
  const base = `http://127.0.0.1:${server.address().port}`;
  const get = (path, cookie = '') => fetch(base + '/api/question-bank/' + path, { headers: { cookie } });
  const post = (cookie, origin = 'http://localhost:6715') => fetch(base + '/api/question-bank/import', { method: 'POST', headers: { cookie, origin, 'content-type': 'application/json' }, body: JSON.stringify({ items: [] }) });
  assert.equal((await get('questions')).status, 401);
  assert.equal((await get('questions', 'evaluation_session=reader')).status, 200);
  assert.equal((await get('test-sets')).status, 401);
  assert.equal((await get('test-sets', 'evaluation_session=reader')).status, 200);
  const detail = await get('question?id=q&datasetVersion=v1', 'evaluation_session=reader');
  assert.equal(detail.status, 200);
  assert.equal((await detail.json()).question.datasetVersion, 'v1');
  assert.equal((await get('question?id=q&datasetVersion=v1')).status, 401);
  assert.equal((await post('evaluation_session=reader')).status, 403);
  const randomDenied = await fetch(base + '/api/question-bank/random-save', { method: 'POST', headers: { cookie: 'evaluation_session=reader', origin: 'http://localhost:6715', 'content-type': 'application/json' }, body: '{"items":[]}' });
  assert.equal(randomDenied.status, 403);
  assert.equal((await post('evaluation_session=writer', 'http://evil.invalid')).status, 403);
  const disabled = await post('evaluation_session=writer');
  assert.equal(disabled.status, 503); assert.equal((await disabled.json()).error.code, 'QUESTION_BANK_WRITE_DISABLED');
});

test('内置题去重和输入校验发生在写入前', async () => {
  const service = createQuestionBankService({ insertFixedQuestionsAtomic: async () => { throw new Error('must not write'); } });
  const original = require('../src/question-bank/builtin-cases.json')[0];
  await assert.rejects(() => service.import({ items: [{ serviceKey: original.serviceKey, question: original.question }] }), e => e.code === 'FIXED_CASE_DUPLICATE');
  await assert.rejects(() => service.import({ items: [{ serviceKey: 'alloy', question: '短题' }] }), e => e.code === 'FIXED_CASE_QUESTION_INVALID');
});

test('随机题保存校验并沿用旧系统身份，按批次拒绝重复', async () => {
  const service = createQuestionBankService({ insertRandomQuestionsAtomic: async items => ({ items, created: items.length, reused: 0 }) });
  const item = { serviceKey: 'alloy', question: '请比较两种合金在高温环境中的力学性能。' };
  const result = await service.saveRandom({ items: [item] });
  assert.match(result.items[0].id, /^rnd:alloy:[a-f0-9]{12}$/);
  assert.equal(result.items[0].datasetVersion, 'gen-v1');
  await assert.rejects(() => service.saveRandom({ items: [item, item] }), e => e.code === 'RANDOM_QUESTION_DUPLICATE');
  await assert.rejects(() => service.saveRandom({ items: [] }), e => e.code === 'RANDOM_QUESTION_ITEMS_INVALID');
});
