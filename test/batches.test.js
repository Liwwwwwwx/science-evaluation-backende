const test = require('node:test');
const assert = require('node:assert/strict');
const { createBatchReadService } = require('../src/runs/batch-read.service');

const TRIAL = '11111111-1111-4111-8111-111111111111';
const MISSION = '22222222-2222-4222-8222-222222222222';
const MISSION_PREVIOUS = '33333333-3333-4333-8333-333333333333';
const TRIAL_PREVIOUS = '44444444-4444-4444-8444-444444444444';

function plan(overrides = {}) {
  return {
    source: 'mission',
    plan_date: '2026-11-02',
    id: MISSION,
    state: 'submitted',
    items: [{ questionId: 'q1', datasetVersion: 'v1', question: '题目一' }],
    rule_snapshot: { name: '规则', version: 'v1', hash: 'h1' },
    error: null,
    created_at: '2026-11-02T14:00:00.000Z',
    updated_at: '2026-11-02T15:00:00.000Z',
    ...overrides,
  };
}

function run(overrides = {}) {
  return {
    id: 'run-1',
    batch_id: MISSION,
    service_key: 'mission-material',
    question_id: 'q1',
    dataset_version: 'v1',
    question: '题目一',
    status: 'done',
    error: null,
    scores: {
      deepSeekScore: { status: 'ready', model: 'deepseek-chat', quality: { total: 80 } },
      qwenScore: { status: 'ready', model: 'qwen', quality: { total: 82 } },
    },
    answer_truncated: false,
    started_at: '2026-11-02T14:01:00.000Z',
    finished_at: '2026-11-02T14:02:00.000Z',
    elapsed_ms: 60000,
    run_status: 'done',
    rule_snapshot: { hash: 'h1' },
    ...overrides,
  };
}

function repository({ plans = [], runs = [] } = {}) {
  return {
    async plans({ limit = 200, offset = 0 } = {}) { return { storageReady: true, items: plans.slice(offset, offset + limit) }; },
    async plan(id) { return { storageReady: true, plan: plans.find((item) => item.id === id) || null }; },
    async previousPlan(source, date) { return plans.filter((item) => item.source === source && item.plan_date < date).sort((a, b) => b.plan_date.localeCompare(a.plan_date))[0] || null; },
    async runsByBatchIds(ids) { return runs.filter((item) => ids.includes(item.batch_id)); },
  };
}

function trialPlan(overrides = {}) {
  return plan({
    source: 'trial',
    id: TRIAL,
    items: { alloy: ['合金题一', '合金题二'], literature: ['文献题一'] },
    ...overrides,
  });
}

test('批次列表按计划和运行聚合，区分完成、失败和服务计划', async () => {
  const service = createBatchReadService({ repository: repository({
    plans: [trialPlan()],
    runs: [
      run({ id: 'a', batch_id: TRIAL, service_key: 'alloy', question_id: null, dataset_version: null, question: '合金题一', status: 'done', run_status: 'done' }),
      run({ id: 'b', batch_id: TRIAL, service_key: 'alloy', question_id: null, dataset_version: null, question: '合金题二', status: 'error', run_status: 'error', error: '执行超时（360 秒）', scores: {} }),
      run({ id: 'c', batch_id: TRIAL, service_key: 'literature', question_id: null, dataset_version: null, question: '文献题一', status: 'done', run_status: 'done' }),
    ],
  }) });
  const value = await service.list();
  assert.equal(value.storageReady, true);
  assert.equal(value.total, 1);
  const item = value.items[0];
  assert.equal(item.batchId, TRIAL);
  assert.equal(item.planned, 3);
  assert.equal(item.totals.total, 3);
  assert.equal(item.totals.completed, 2);
  assert.equal(item.totals.timeout, 1);
  assert.equal(item.state, 'done');
  assert.deepEqual(item.services.map((entry) => entry.expected), [0, 1, 0, 2, 0, 0]);
});

test('存储未迁移时列表返回空并标记 storageReady=false', async () => {
  const service = createBatchReadService({ repository: { async plans() { return { storageReady: false, items: [] }; } } });
  assert.deepEqual(await service.list(), { items: [], total: 0, page: 1, pageSize: 20, storageReady: false });
});

test('超过 500 个批次时列表和状态筛选仍包含旧记录', async () => {
  const plans = Array.from({ length: 501 }, (_, index) => plan({ id: `batch-${index}`, state: index === 500 ? 'failed' : 'submitted' }));
  const service = createBatchReadService({ repository: repository({ plans }) });
  const last = await service.list({ page: 26, pageSize: 20 });
  assert.equal(last.total, 501);
  assert.equal(last.items[0].batchId, 'batch-500');
  const failed = await service.list({ state: 'failed' });
  assert.equal(failed.total, 1);
  assert.equal(failed.items[0].batchId, 'batch-500');
});

test('未开始的运行耗时保持空值', async () => {
  const service = createBatchReadService({ repository: repository({ plans: [plan()], runs: [run({ status: 'queued', run_status: null, elapsed_ms: null })] }) });
  const detail = await service.get(MISSION);
  assert.equal(detail.services[0].maxElapsedMs, null);
  const runs = await service.runs(MISSION);
  assert.equal(runs.items[0].elapsedMs, null);
});

test('不同来源的批次不能计算环比', async () => {
  const service = createBatchReadService({ repository: repository({ plans: [plan(), trialPlan()] }) });
  const result = await service.comparison(MISSION, { against: TRIAL });
  assert.equal(result.comparable, false);
  assert.equal(result.mode, 'none');
  assert.match(result.reason, /不同来源/);
});

test('批次详情聚合服务指标，低分和失败列表只返回公开运行字段', async () => {
  const service = createBatchReadService({ repository: repository({
    plans: [trialPlan()],
    runs: [
      run({ id: 'a', batch_id: TRIAL, service_key: 'alloy', question_id: null, dataset_version: null, question: '合金题一', scores: { deepSeekScore: { status: 'ready', model: 'deepseek-chat', quality: { total: 60 } }, qwenScore: { status: 'ready', model: 'qwen', quality: { total: 58 } } } }),
      run({ id: 'b', batch_id: TRIAL, service_key: 'alloy', question_id: null, dataset_version: null, question: '合金题二', status: 'error', run_status: 'error', error: '执行失败', scores: {} }),
    ],
  }) });
  const value = await service.get(TRIAL);
  assert.equal(value.batch.batchId, TRIAL);
  assert.equal(value.coverage.planned, 3);
  assert.equal(value.coverage.persisted, 2);
  assert.equal(value.coverage.missing, 1);
  const alloy = value.services.find((entry) => entry.serviceKey === 'alloy');
  assert.equal(alloy.lowScores.length, 1);
  assert.equal(alloy.failures.length, 1);
  assert.equal(alloy.lowScores[0].runId, 'a');
  assert.equal('rawScores' in alloy.lowScores[0], false);
  assert.equal('ruleSnapshot' in alloy.failures[0], false);
  assert.equal(value.links.comparison, `/batches/${TRIAL}/comparison`);
});

test('批次运行列表支持服务筛选、执行状态和分数排序', async () => {
  const service = createBatchReadService({ repository: repository({
    plans: [trialPlan()],
    runs: [
      run({ id: 'a', batch_id: TRIAL, service_key: 'alloy', question_id: null, dataset_version: null, question: '合金题一', scores: { deepSeekScore: { status: 'ready', model: 'deepseek-chat', quality: { total: 50 } }, qwenScore: { status: 'ready', model: 'qwen', quality: { total: 55 } } } }),
      run({ id: 'b', batch_id: TRIAL, service_key: 'alloy', question_id: null, dataset_version: null, question: '合金题二', status: 'error', run_status: 'error', error: '执行失败', scores: {} }),
      run({ id: 'c', batch_id: TRIAL, service_key: 'literature', question_id: null, dataset_version: null, question: '文献题一' }),
    ],
  }) });
  const value = await service.runs(TRIAL, { serviceKey: 'alloy', sort: 'scoreAsc' });
  assert.equal(value.total, 2);
  assert.equal(value.items[0].runId, 'a');
  const failed = await service.runs(TRIAL, { execution: 'failed' });
  assert.equal(failed.total, 1);
  assert.equal(failed.items[0].runId, 'b');
});

test('新批次统计1110并返回同题对比入口，旧批次不添加空服务', async () => {
  const group = 'a'.repeat(64);
  const current = trialPlan({ items: { synthesis: ['同一道合成问题'], 'alpha-rsi': ['同一道合成问题'] } });
  const service = createBatchReadService({ repository: repository({ plans: [current], runs: [
    run({ id: 's', batch_id: TRIAL, service_key: 'synthesis', question: '同一道合成问题', comparison_group_id: group }),
    run({ id: 'a', batch_id: TRIAL, service_key: 'alpha-rsi', question: '同一道合成问题', comparison_group_id: group }),
  ] }) });
  const detail = await service.get(TRIAL);
  assert.equal(detail.coverage.planned, 2);
  assert.equal(detail.services.find(item => item.serviceKey === 'alpha-rsi').totals.total, 1);
  const listed = await service.runs(TRIAL);
  assert.deepEqual(listed.items.map(item => item.comparisonGroupId), [group, group]);
  const legacy = createBatchReadService({ repository: repository({ plans: [trialPlan()] }) });
  assert.equal((await legacy.get(TRIAL)).services.some(item => item.serviceKey === 'alpha-rsi'), false);
});

test('手动批次读取与运行列表只向仓储传当前用户身份', async () => {
  const manual = trialPlan({ source: 'manual', items: { synthesis: ['同一题'] } }); const seen = [];
  const repo = {
    async plan(id, userId) { seen.push(['plan', userId]); return { storageReady: true, plan: userId === 'owner' ? manual : null }; },
    async runsByBatchIds(ids, userId) { seen.push(['runs', userId]); return []; },
  };
  const service = createBatchReadService({ repository: repo });
  assert.equal((await service.get(TRIAL, 'owner')).batch.source, 'manual');
  await service.runs(TRIAL, { userId: 'owner' });
  await assert.rejects(service.get(TRIAL, 'other'), { code: 'BATCH_NOT_FOUND' });
  assert.deepEqual(seen, [['plan', 'owner'], ['runs', 'owner'], ['plan', 'owner'], ['runs', 'owner'], ['plan', 'other']]);
});

test('出题期间依据冻结方案展示计划数量，不伪装成零次', async () => {
  const pending = trialPlan({ source: 'manual', state: 'generating', items: null, config_snapshot: { config: { services: { synthesis: { aviation: 0, synthesis: 3 }, 'alpha-rsi': { aviation: 0, synthesis: 3 } } } } });
  const service = createBatchReadService({ repository: repository({ plans: [pending] }) });
  const result = await service.get(TRIAL, 'owner');
  assert.equal(result.batch.planned, 6);
  assert.deepEqual(result.services.map(item => item.serviceKey), ['synthesis', 'alpha-rsi']);
  assert.equal(result.coverage.missing, 6);
});

test('Mission 同题批次输出逐题环比，包含回归、新增失败和修复', async () => {
  const current = plan({ id: MISSION, items: [
    { questionId: 'q1', datasetVersion: 'v1', question: '题一' },
    { questionId: 'q2', datasetVersion: 'v1', question: '题二' },
    { questionId: 'q3', datasetVersion: 'v1', question: '题三' },
    { questionId: 'q4', datasetVersion: 'v1', question: '题四' },
    { questionId: 'q5', datasetVersion: 'v1', question: '题五' },
  ] });
  const previous = plan({ id: MISSION_PREVIOUS, plan_date: '2026-11-01', items: current.items });
  const runs = [
    run({ id: 'c1', batch_id: MISSION, question_id: 'q1', question: '题一', scores: { deepSeekScore: { status: 'ready', model: 'deepseek-chat', quality: { total: 90 } } } }),
    run({ id: 'c2', batch_id: MISSION, question_id: 'q2', question: '题二', status: 'error', run_status: 'error', error: '执行失败', scores: {} }),
    run({ id: 'c3', batch_id: MISSION, question_id: 'q3', question: '题三', scores: { deepSeekScore: { status: 'ready', model: 'deepseek-chat', quality: { total: 80 } } } }),
    run({ id: 'c4', batch_id: MISSION, question_id: 'q4', question: '题四', scores: { deepSeekScore: { status: 'ready', model: 'deepseek-chat', quality: { total: 60 } } } }),
    run({ id: 'c5', batch_id: MISSION, question_id: 'q5', question: '题五', scores: { deepSeekScore: { status: 'ready', model: 'deepseek-chat', quality: { total: 80 } } } }),
    run({ id: 'p1', batch_id: MISSION_PREVIOUS, question_id: 'q1', question: '题一', scores: { deepSeekScore: { status: 'ready', model: 'deepseek-chat', quality: { total: 80 } } } }),
    run({ id: 'p2', batch_id: MISSION_PREVIOUS, question_id: 'q2', question: '题二', scores: { deepSeekScore: { status: 'ready', model: 'deepseek-chat', quality: { total: 70 } } } }),
    run({ id: 'p3', batch_id: MISSION_PREVIOUS, question_id: 'q3', question: '题三', status: 'error', run_status: 'error', error: '执行失败', scores: {} }),
    run({ id: 'p4', batch_id: MISSION_PREVIOUS, question_id: 'q4', question: '题四', scores: { deepSeekScore: { status: 'ready', model: 'deepseek-chat', quality: { total: 80 } } } }),
    run({ id: 'p5', batch_id: MISSION_PREVIOUS, question_id: 'q5', question: '题五', scores: { deepSeekScore: { status: 'ready', model: 'deepseek-chat', quality: { total: 78 } } } }),
  ];
  const service = createBatchReadService({ repository: repository({ plans: [current, previous], runs }) });
  const value = await service.comparison(MISSION);
  assert.equal(value.mode, 'question');
  assert.equal(value.matchedQuestions, 5);
  assert.equal(value.questions.find((item) => item.questionId === 'q1').level, 'improved');
  assert.equal(value.questions.find((item) => item.questionId === 'q2').level, 'new_failure');
  assert.equal(value.questions.find((item) => item.questionId === 'q3').level, 'fixed');
  assert.equal(value.questions.find((item) => item.questionId === 'q4').level, 'regressed');
  assert.equal(value.questions.find((item) => item.questionId === 'q5').level, 'stable');
  assert.equal(value.services[0].newFailureCount, 1);
  assert.equal(value.services[0].fixedCount, 1);
});

test('逐题分差只使用双方都可用的同一评委，并排除暂定或无效评分', async (t) => {
  const score = (model, total, extra = {}) => ({ status: 'ready', model, quality: { total }, ...extra });
  const deep = (total, extra) => score('deepseek-chat', total, extra);
  const qwen = (total, extra) => score('qwen', total, extra);
  const cases = [
    { name: '单侧 DeepSeek 失败时改用双方 Qwen', before: { deepSeekScore: deep(80), qwenScore: qwen(50) }, after: { deepSeekScore: deep(30, { status: 'failed' }), qwenScore: qwen(50) }, expected: [50, 50, 0] },
    { name: '没有共同可用评委时不计算分差', before: { deepSeekScore: deep(80), qwenScore: qwen(50, { status: 'failed' }) }, after: { deepSeekScore: deep(30, { status: 'failed' }), qwenScore: qwen(50) }, expected: [null, null, null] },
    { name: '评分输入截断时排除该评委', before: { deepSeekScore: deep(80), qwenScore: qwen(50) }, after: { deepSeekScore: deep(30, { quality: { total: 30, source: { truncated: true } } }), qwenScore: qwen(50) }, expected: [50, 50, 0] },
    { name: '唯一评分输入截断时不计算分差', before: { deepSeekScore: deep(80) }, after: { deepSeekScore: deep(30, { quality: { total: 30, source: { truncated: true } } }) }, expected: [null, null, null] },
    { name: '回答截断时不使用任何评委分数', before: { deepSeekScore: deep(80), qwenScore: qwen(50) }, after: { deepSeekScore: deep(30), qwenScore: qwen(20) }, truncated: true, expected: [null, null, null] },
    { name: '无效分数不能参与比较', before: { deepSeekScore: deep(80), qwenScore: qwen(50) }, after: { deepSeekScore: deep(101), qwenScore: qwen(50) }, expected: [50, 50, 0] },
  ];
  for (const item of cases) await t.test(item.name, async () => {
    const service = createBatchReadService({ repository: repository({
      plans: [plan(), plan({ id: MISSION_PREVIOUS, plan_date: '2026-11-01' })],
      runs: [
        run({ id: 'current', scores: item.after, answer_truncated: item.truncated === true }),
        run({ id: 'previous', batch_id: MISSION_PREVIOUS, scores: item.before }),
      ],
    }) });
    const result = await service.comparison(MISSION);
    assert.equal(result.mode, 'question');
    const question = result.questions[0];
    if (item.expected[0] === null) assert.equal(question, undefined);
    else {
      assert.deepEqual([question.before.score, question.after.score, question.delta], item.expected);
      assert.equal(question.level, 'stable');
    }
  });
});

test('规则或模型来源缺失时不展示分数差，截断评分不列入低分', async () => {
  const current = plan({ rule_snapshot: null });
  const previous = plan({ id: MISSION_PREVIOUS, plan_date: '2026-11-01', rule_snapshot: null });
  const runs = [
    run({ id: 'current', rule_snapshot: null, answer_truncated: true }),
    run({ id: 'previous', batch_id: MISSION_PREVIOUS, rule_snapshot: null }),
  ];
  const service = createBatchReadService({ repository: repository({ plans: [current, previous], runs }) });
  const comparison = await service.comparison(MISSION);
  assert.equal(comparison.mode, 'aggregate');
  assert.equal(comparison.services[0].scoreDelta.deepSeek, null);
  assert.match(comparison.reason, /无法确认/);
  const detail = await service.get(MISSION);
  assert.equal(detail.services[0].lowScores.length, 0);
  const listed = await service.runs(MISSION);
  assert.equal(listed.items[0].scores.deepSeek, null);
});

test('未结束的运行不判定为已修复或新增失败', async () => {
  const service = createBatchReadService({ repository: repository({
    plans: [plan(), plan({ id: MISSION_PREVIOUS, plan_date: '2026-11-01' })],
    runs: [
      run({ id: 'current-q1', question_id: 'q1', status: 'queued', run_status: null }),
      run({ id: 'previous-q1', batch_id: MISSION_PREVIOUS, question_id: 'q1', status: 'error', run_status: 'error' }),
      run({ id: 'current-q2', question_id: 'q2', status: 'error', run_status: 'error' }),
      run({ id: 'previous-q2', batch_id: MISSION_PREVIOUS, question_id: 'q2', status: 'running', run_status: null }),
      run({ id: 'current-q3', question_id: 'q3', status: 'running', run_status: 'running' }),
      run({ id: 'previous-q3', batch_id: MISSION_PREVIOUS, question_id: 'q3', status: 'error', run_status: 'error' }),
    ],
  }) });
  const result = await service.comparison(MISSION);
  assert.equal(result.mode, 'question');
  assert.equal(result.matchedQuestions, 3);
  assert.equal(result.questions.length, 0);
  assert.equal(result.services[0].fixedCount, 0);
  assert.equal(result.services[0].newFailureCount, 0);
});

test('试跑批次没有同题 ID 时只做服务汇总环比', async () => {
  const current = trialPlan({ id: TRIAL });
  const previous = trialPlan({ id: TRIAL_PREVIOUS, plan_date: '2026-11-01' });
  const service = createBatchReadService({ repository: repository({
    plans: [current, previous],
    runs: [
      run({ id: 'a', batch_id: TRIAL, service_key: 'alloy', question_id: null, dataset_version: null, scores: { deepSeekScore: { status: 'ready', model: 'deepseek-chat', quality: { total: 85 } } } }),
      run({ id: 'b', batch_id: TRIAL_PREVIOUS, service_key: 'alloy', question_id: null, dataset_version: null, scores: { deepSeekScore: { status: 'ready', model: 'deepseek-chat', quality: { total: 80 } } } }),
    ],
  }) });
  const value = await service.comparison(TRIAL);
  assert.equal(value.mode, 'aggregate');
  assert.equal(value.matchedQuestions, 0);
  assert.equal(value.questions.length, 0);
  assert.equal(value.services.find((item) => item.serviceKey === 'alloy').scoreDelta.deepSeek, 5);
  assert.equal(value.services.find((item) => item.serviceKey === 'alloy').newFailureCount, null);
  assert.equal(value.services.find((item) => item.serviceKey === 'alloy').fixedCount, null);
});

test('规则版本不同时标记不可比', async () => {
  const current = plan({ id: MISSION, rule_snapshot: { name: '规则', version: 'v2', hash: 'h2' } });
  const previous = plan({ id: MISSION_PREVIOUS, plan_date: '2026-11-01', rule_snapshot: { name: '规则', version: 'v1', hash: 'h1' } });
  const service = createBatchReadService({ repository: repository({
    plans: [current, previous],
    runs: [run({ id: 'c', batch_id: MISSION }), run({ id: 'p', batch_id: MISSION_PREVIOUS })],
  }) });
  const value = await service.comparison(MISSION);
  assert.equal(value.comparable, false);
  assert.equal(value.mode, 'none');
  assert.match(value.reason, /规则版本不同/);
});
