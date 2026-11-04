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
    evaluators: { 'mission-material': evaluator(), 'alpha-rsi': evaluator() },
    repository,
    scoring: scoring(snapshots),
  });
}

test('对比组用一份规则快照创建两条运行，并按幂等键恢复', async () => {
  const repository = createRepository();
  const snapshots = [];
  const service = serviceWith(repository, snapshots);
  const input = { serviceKeys: ['mission-material', 'alpha-rsi'], question: '请比较两种材料在 900°C 下的强度并说明依据。' };
  const first = await service.createComparison(input, { scope: 'evaluation-user:u1', key: 'compare-1' });
  assert.equal(first.runs.length, 2);
  assert.match(first.groupId, /^[a-f0-9]{64}$/);
  assert.notEqual(first.runs[0].runId, first.runs[1].runId);
  assert.deepEqual(first.runs.map((item) => item.serviceKey), ['mission-material', 'alpha-rsi']);
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

test('对比组只允许两个不同且已接入的服务', async () => {
  const service = serviceWith(createRepository());
  await assert.rejects(service.createComparison({ serviceKeys: ['mission-material', 'mission-material'], question: '请比较两种材料在 900°C 下的强度并说明依据。' }, { scope: 'evaluation-user:u1', key: 'k1' }), (error) => error.code === 'COMPARISON_SERVICES_INVALID');
  await assert.rejects(service.createComparison({ serviceKeys: ['mission-material', 'literature'], question: '请比较两种材料在 900°C 下的强度并说明依据。' }, { scope: 'evaluation-user:u1', key: 'k2' }), (error) => error.code === 'COMPARISON_SERVICES_INVALID');
  await assert.rejects(service.createComparison({ serviceKeys: ['mission-material'], question: '请比较两种材料在 900°C 下的强度并说明依据。' }, { scope: 'evaluation-user:u1', key: 'k3' }), (error) => error.code === 'COMPARISON_SERVICES_INVALID');
});

test('对比题目长度按两个服务的较小上限校验', async () => {
  const service = createUnifiedEvaluationService({ evaluators: { 'mission-material': evaluator(), synthesis: evaluator() }, repository: createRepository() });
  await assert.rejects(service.createComparison({ serviceKeys: ['mission-material', 'synthesis'], question: '这是一个足够长的题目。' + '甲'.repeat(200) }, { scope: 'evaluation-user:u1', key: 'k1' }), (error) => error.code === 'UNIFIED_EVAL_QUESTION_INVALID');
  await assert.rejects(service.createComparison({ serviceKeys: ['mission-material', 'synthesis'], question: '太短' }, { scope: 'evaluation-user:u1', key: 'k2' }), (error) => error.code === 'UNIFIED_EVAL_QUESTION_INVALID');
});

test('对比组读取只返回当前账号的运行', async () => {
  const repository = createRepository();
  const service = serviceWith(repository);
  const created = await service.createComparison({ serviceKeys: ['mission-material', 'alpha-rsi'], question: '请比较两种材料在 900°C 下的强度并说明依据。' }, { scope: 'evaluation-user:u1', key: 'compare-1' });
  await new Promise((resolve) => setImmediate(resolve));
  const mine = await service.getComparison(created.groupId, 'u1');
  assert.equal(mine.runs.length, 2);
  await assert.rejects(service.getComparison(created.groupId, 'u2'), (error) => error.status === 404);
  await assert.rejects(service.getComparison('not-a-group', 'u1'), (error) => error.code === 'COMPARISON_ID_INVALID');
});
