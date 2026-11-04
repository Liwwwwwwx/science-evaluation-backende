const test = require('node:test');
const assert = require('node:assert/strict');
const { createUnifiedEvaluationService } = require('../src/runs/unified-evaluation.service');

function createRepository() {
  const rows = new Map();
  const keys = new Map();
  return {
    rows,
    keys,
    async findIdempotent(scope, key) {
      const entry = keys.get(`${scope}:${key}`);
      return entry ? { runId: entry.runId, hash: entry.hash } : null;
    },
    async createIdempotent(job, scope, key, hash) {
      const identity = `${scope}:${key}`;
      const existing = keys.get(identity);
      if (existing) return { created: false, runId: existing.runId, matches: existing.hash === hash };
      keys.set(identity, { runId: job.runId, hash });
      rows.set(job.runId, { ...structuredClone(job), ownerScope: scope });
      return { created: true, runId: job.runId };
    },
    async save(job) { rows.set(job.runId, { ...structuredClone(job), ownerScope: rows.get(job.runId)?.ownerScope || null }); },
    async get(id) { return rows.has(id) ? structuredClone(rows.get(id)) : null; },
    async comparisonReady() { return true; },
    async getComparison(groupId, userId) {
      return [...rows.values()]
        .filter((row) => row.comparisonGroupId === groupId && (row.origin === 'automation' || row.ownerScope === `evaluation-user:${userId}`))
        .map((row) => structuredClone(row));
    },
  };
}

function evaluator() {
  return {
    scoreMode: 'none',
    async startQuestionRun() { return { run: { id: `native-${Math.random()}` }, completion: Promise.resolve({ status: 'done', details: {} }) }; },
    async getRunQuality() { return { status: 'absent', quality: null, error: null }; },
  };
}

function scoring(snapshots) {
  return {
    async snapshotRule() { const value = { id: 'rule-1', version: 3, name: '默认规则', hash: 'hash-1', config: {} }; snapshots.push(value); return value; },
    pending() { return { deepSeekScore: { status: 'unavailable' }, qwenScore: { status: 'unavailable' } }; },
    async score(input, publish) {
      await publish({
        scoring: { version: 'evaluation-v1', attemptId: 'attempt', startedAt: new Date().toISOString(), finishedAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 60_000).toISOString(), history: [] },
        scores: { deepSeekScore: { status: 'unavailable' }, qwenScore: { status: 'unavailable' } },
        markdownSyntax: { status: 'not_evaluable', issues: [] },
      });
    },
  };
}

function serviceWith(repository, snapshots = []) {
  return createUnifiedEvaluationService({
    evaluators: { synthesis: evaluator(), 'alpha-rsi': evaluator() },
    repository,
    scoring: scoring(snapshots),
  });
}

test('自动批次同题对比保留组和规则，重复派发复用原运行', async () => {
  const repository = createRepository(); const service = serviceWith(repository);
  const group = 'a'.repeat(64);
  const ruleSnapshot = { id: 'rule-1', version: 3, name: '默认规则', hash: 'hash-1', config: {} };
  const question = '请比较两种材料在 900°C 下的强度并说明依据。';
  for (const key of ['synthesis', 'alpha-rsi']) {
    const input = { serviceKey: key, question, batchId: 'batch-1', sourceType: 'random', comparisonGroupId: group };
    const options = { key: `batch-1:${key}:0`, ruleSnapshot };
    const first = await service.createBatchRun(input, options);
    const again = await service.createBatchRun(input, options);
    assert.equal(again.runId, first.runId); assert.equal(again.reused, true);
  }
  await new Promise(resolve => setImmediate(resolve));
  const comparison = await service.getComparison(group, 'reader');
  assert.equal(comparison.runs.length, 2);
  assert.ok(comparison.runs.every(run => run.question === question && run.run.ruleSnapshot.hash === 'hash-1'));
});

test('手动组合批次保留个人归属，不允许其他账号读取对比组', async () => {
  const repository = createRepository(); const service = serviceWith(repository); const group = 'b'.repeat(64);
  for (const serviceKey of ['synthesis', 'alpha-rsi']) await service.createBatchRun({ serviceKey, question: '请分析材料的合成条件与性能变化。', batchId: 'batch-2', ownerUserId: 'alice', comparisonGroupId: group }, { key: `batch-2:${serviceKey}:0` });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal((await service.getComparison(group, 'alice')).runs.length, 2);
  await assert.rejects(service.getComparison(group, 'bob'), { code: 'COMPARISON_NOT_FOUND' });
  assert.ok([...repository.rows.values()].every(row => row.origin === 'manual' && row.ownerScope === 'evaluation-user:alice'));
});

test('对比组用一份规则快照创建两条运行，并按幂等键恢复', async () => {
  const repository = createRepository();
  const snapshots = [];
  const service = serviceWith(repository, snapshots);
  const input = { serviceKeys: ['synthesis', 'alpha-rsi'], question: '请比较两种材料在 900°C 下的强度并说明依据。' };
  const first = await service.createComparison(input, { scope: 'evaluation-user:u1', key: 'compare-1' });
  assert.equal(first.runs.length, 2);
  assert.match(first.groupId, /^[a-f0-9]{64}$/);
  assert.notEqual(first.runs[0].runId, first.runs[1].runId);
  assert.deepEqual(first.runs.map((item) => item.serviceKey), ['synthesis', 'alpha-rsi']);
  assert.equal(snapshots.length, 1);
  await new Promise((resolve) => setImmediate(resolve));
  const left = await service.get(first.runs[0].runId);
  const right = await service.get(first.runs[1].runId);
  assert.equal(left.comparisonGroupId, first.groupId);
  assert.equal(right.comparisonGroupId, first.groupId);
  assert.equal(left.run.ruleSnapshot.id, 'rule-1');
  assert.equal(right.run.ruleSnapshot.id, 'rule-1');

  const second = await service.createComparison(input, { scope: 'evaluation-user:u1', key: 'compare-1' });
  assert.equal(second.groupId, first.groupId);
  assert.deepEqual(second.runs.map((item) => item.runId), first.runs.map((item) => item.runId));
  assert.ok(second.runs.every((item) => item.reused === true));
  assert.equal(repository.keys.size, 2);
});

test('新建对比仅允许已接入的合成制备与 1110，支持两种顺序', async () => {
  const service = serviceWith(createRepository());
  const question = '请比较两种材料在 900°C 下的强度并说明依据。';
  for (const serviceKeys of [['mission-material', 'alpha-rsi'], ['synthesis', 'synthesis'], ['synthesis'], ['synthesis', 'literature']]) {
    await assert.rejects(service.createComparison({ serviceKeys, question }, { scope: 'evaluation-user:u1', key: 'invalid' }), { code: 'COMPARISON_SERVICES_INVALID' });
  }
  const reverse = await service.createComparison({ serviceKeys: ['alpha-rsi', 'synthesis'], question }, { scope: 'evaluation-user:u1', key: 'reverse' });
  assert.deepEqual(reverse.runs.map(item => item.serviceKey), ['alpha-rsi', 'synthesis']);
  const missing = createUnifiedEvaluationService({ evaluators: { 'alpha-rsi': evaluator() }, repository: createRepository() });
  await assert.rejects(missing.createComparison({ serviceKeys: ['synthesis', 'alpha-rsi'], question }, { scope: 'evaluation-user:u1', key: 'missing' }), { code: 'COMPARISON_SERVICES_INVALID' });
});

test('题库对比在创建前校验两个服务并给两条运行保留同一题目版本', async () => {
  const repository = createRepository(); const checks = [];
  const service = createUnifiedEvaluationService({ evaluators: { synthesis: evaluator(), 'alpha-rsi': evaluator() }, repository,
    resolveQuestion: async input => { checks.push(input.serviceKey); if (input.questionId === 'bound' && input.serviceKey === 'alpha-rsi') throw Object.assign(Error('不适用'), { code: 'QUESTION_NOT_RUNNABLE' }); } });
  const input = { serviceKeys: ['synthesis', 'alpha-rsi'], question: '请比较两种材料的强度并说明选择依据。', questionId: 'shared', datasetVersion: 'v1', sourceType: 'fixed' };
  const result = await service.createComparison(input, { scope: 'evaluation-user:u1', key: 'shared' });
  assert.deepEqual(checks, ['synthesis', 'alpha-rsi']);
  for (const item of result.runs) { const run = repository.rows.get(item.runId); assert.equal(run.questionId, 'shared'); assert.equal(run.datasetVersion, 'v1'); assert.equal(run.questionSourceType, 'fixed'); }
  const count = repository.rows.size;
  await assert.rejects(service.createComparison({ ...input, questionId: 'bound' }, { scope: 'evaluation-user:u1', key: 'bound' }), { code: 'QUESTION_NOT_RUNNABLE' });
  assert.equal(repository.rows.size, count);
});

test('对比题目长度按两个服务的较小上限校验', async () => {
  const service = createUnifiedEvaluationService({ evaluators: { 'alpha-rsi': evaluator(), synthesis: evaluator() }, repository: createRepository() });
  await assert.rejects(service.createComparison({ serviceKeys: ['alpha-rsi', 'synthesis'], question: '这是一个足够长的题目。' + '甲'.repeat(200) }, { scope: 'evaluation-user:u1', key: 'k1' }), (error) => error.code === 'UNIFIED_EVAL_QUESTION_INVALID');
  await assert.rejects(service.createComparison({ serviceKeys: ['alpha-rsi', 'synthesis'], question: '太短' }, { scope: 'evaluation-user:u1', key: 'k2' }), (error) => error.code === 'UNIFIED_EVAL_QUESTION_INVALID');
});

test('对比组读取只返回当前账号的运行', async () => {
  const repository = createRepository();
  const service = serviceWith(repository);
  const created = await service.createComparison({ serviceKeys: ['synthesis', 'alpha-rsi'], question: '请比较两种材料在 900°C 下的强度并说明依据。' }, { scope: 'evaluation-user:u1', key: 'compare-1' });
  await new Promise((resolve) => setImmediate(resolve));
  const mine = await service.getComparison(created.groupId, 'u1');
  assert.equal(mine.runs.length, 2);
  await assert.rejects(service.getComparison(created.groupId, 'u2'), (error) => error.status === 404);
  await assert.rejects(service.getComparison('not-a-group', 'u1'), (error) => error.code === 'COMPARISON_ID_INVALID');
});

test('其他组合的历史对比仍可读取', async () => {
  const repository = createRepository(); const groupId = 'a'.repeat(64);
  repository.rows.set('legacy-1', { runId: 'legacy-1', serviceKey: 'mission-material', comparisonGroupId: groupId, ownerScope: 'evaluation-user:u1', origin: 'manual', status: 'done' });
  repository.rows.set('legacy-2', { runId: 'legacy-2', serviceKey: 'alpha-rsi', comparisonGroupId: groupId, ownerScope: 'evaluation-user:u1', origin: 'manual', status: 'done' });
  assert.deepEqual((await serviceWith(repository).getComparison(groupId, 'u1')).runs.map(item => item.serviceKey), ['mission-material', 'alpha-rsi']);
});

test('同一对比幂等键绑定完整服务组合和题目', async () => {
  const repository = createRepository();
  const service = createUnifiedEvaluationService({ evaluators: { synthesis: evaluator(), 'alpha-rsi': evaluator(), literature: evaluator() }, repository, scoring: scoring([]) });
  const options = { scope: 'evaluation-user:u1', key: 'whole-request' };
  const original = { serviceKeys: ['synthesis', 'alpha-rsi'], question: '请比较材料在高温下的性能并说明理由。' };
  await service.createComparison(original, options);
  for (const changed of [ { ...original, serviceKeys: ['alpha-rsi', 'synthesis'] }, { ...original, question: '请比较材料在低温下的性能并说明理由。' } ]) {
    await assert.rejects(service.createComparison(changed, options), e => e.code === 'UNIFIED_EVAL_IDEMPOTENCY_CONFLICT');
  }
  assert.equal(repository.keys.size, 2);
});

test('部分创建后规则变化，重试仍使用首条运行的原始快照', async () => {
  const repository = createRepository();
  const create = repository.createIdempotent;
  let fail = true;
  repository.createIdempotent = async (...args) => { if (args[0].serviceKey === 'alpha-rsi' && fail) { fail = false; throw new Error('模拟中断'); } return create(...args); };
  let version = 1;
  const judge = scoring([]);
  judge.snapshotRule = async () => ({ id: 'rule', version, name: '规则', hash: `hash-${version}` });
  const service = createUnifiedEvaluationService({ evaluators: { synthesis: evaluator(), 'alpha-rsi': evaluator() }, repository, scoring: judge });
  const input = { serviceKeys: ['synthesis', 'alpha-rsi'], question: '请比较材料在高温下的性能并说明理由。' };
  const options = { scope: 'evaluation-user:u1', key: 'retry-rule' };
  await assert.rejects(service.createComparison(input, options), /模拟中断/);
  version = 2;
  const result = await service.createComparison(input, options);
  assert.equal((await repository.get(result.runs[0].runId)).run.ruleSnapshot.version, 1);
  assert.equal((await repository.get(result.runs[1].runId)).run.ruleSnapshot.version, 1);
});

test('并发使用同一键但不同组合时只允许一个完整对比组', async () => {
  const repository = createRepository();
  let version = 0;
  const judge = scoring([]);
  judge.snapshotRule = async () => ({ id: 'rule', version: ++version, hash: `hash-${version}` });
  const service = createUnifiedEvaluationService({ evaluators: { synthesis: evaluator(), 'alpha-rsi': evaluator(), literature: evaluator() }, repository, scoring: judge });
  const options = { scope: 'evaluation-user:u1', key: 'concurrent' };
  const question = '请比较材料在高温下的性能并说明理由。';
  const attempts = await Promise.allSettled([
    service.createComparison({ serviceKeys: ['synthesis', 'alpha-rsi'], question }, options),
    service.createComparison({ serviceKeys: ['alpha-rsi', 'synthesis'], question }, options),
  ]);
  assert.equal(attempts.filter(item => item.status === 'fulfilled').length, 1);
  assert.equal(attempts.find(item => item.status === 'rejected').reason.code, 'UNIFIED_EVAL_IDEMPOTENCY_CONFLICT');
  const group = attempts.find(item => item.status === 'fulfilled').value;
  assert.equal(repository.keys.size, 2);
  const left = await repository.get(group.runs[0].runId), right = await repository.get(group.runs[1].runId);
  assert.equal(left.run.ruleSnapshot.hash, right.run.ruleSnapshot.hash);
});

test('并发重复请求共享首条运行的规则快照', async () => {
  const repository = createRepository();
  let version = 0;
  const judge = scoring([]);
  judge.snapshotRule = async () => ({ id: 'rule', version: ++version, hash: `hash-${version}` });
  const service = createUnifiedEvaluationService({ evaluators: { synthesis: evaluator(), 'alpha-rsi': evaluator() }, repository, scoring: judge });
  const input = { serviceKeys: ['synthesis', 'alpha-rsi'], question: '请比较材料在高温下的性能并说明理由。' };
  const options = { scope: 'evaluation-user:u1', key: 'concurrent-same' };
  const results = await Promise.all(Array.from({ length: 8 }, () => service.createComparison(input, options)));
  assert.equal(new Set(results.map(item => item.runs[0].runId)).size, 1);
  assert.equal(new Set(results.map(item => item.runs[1].runId)).size, 1);
  const left = await repository.get(results[0].runs[0].runId), right = await repository.get(results[0].runs[1].runId);
  assert.equal(left.run.ruleSnapshot.hash, right.run.ruleSnapshot.hash);
});
