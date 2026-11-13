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
    evaluators: { synthesis: evaluator(), alloy: evaluator(), 'alpha-rsi': evaluator() },
    repository,
    scoring: scoring(snapshots),
  });
}

test('停用新建对比，保留历史对比的读取和访问控制', async () => {
  const repository = createRepository(); const service = serviceWith(repository); const group = 'a'.repeat(64);
  await assert.rejects(service.createComparison({ serviceKeys: ['alloy', 'alpha-rsi'], question: '比较材料强度和温度条件' }, { scope: 'evaluation-user:u1', key: 'new' }), { code: 'COMPARISON_DISABLED' });
  await assert.rejects(service.createBatchRun({ serviceKey: 'alpha-rsi', question: '比较材料强度和温度条件', batchId: 'batch', comparisonGroupId: group }, { key: 'batch:alpha:1' }), { code: 'COMPARISON_DISABLED' });
  assert.equal(repository.rows.size, 0);
  for (const [index, serviceKey] of ['alloy', 'alpha-rsi'].entries()) repository.rows.set(`legacy-${index}`, { runId: `legacy-${index}`, serviceKey, comparisonGroupId: group, ownerScope: 'evaluation-user:u1', origin: 'manual', status: 'done' });
  assert.deepEqual((await service.getComparison(group, 'u1')).runs.map(row => row.serviceKey), ['alloy', 'alpha-rsi']);
  await assert.rejects(service.getComparison(group, 'u2'), { code: 'COMPARISON_NOT_FOUND' });
});

test('历史自动对比对团队可读，非法标识仍被拒绝', async () => {
  const repository = createRepository(); const group = 'b'.repeat(64);
  repository.rows.set('legacy-auto', { runId: 'legacy-auto', serviceKey: 'synthesis', comparisonGroupId: group, origin: 'automation', status: 'done' });
  const service = serviceWith(repository);
  assert.equal((await service.getComparison(group, 'reader')).runs[0].serviceKey, 'synthesis');
  await assert.rejects(service.getComparison('invalid', 'reader'), { code: 'COMPARISON_ID_INVALID' });
});

test('停用服务不能新建或自动恢复，旧对比排队记录也不会被恢复', async () => {
  let recoveredKeys; let claims = 0;
  const repository = {
    async listRecoverableQueued(keys) { recoveredKeys = keys; return [{ runId: 'old', comparisonGroupId: 'a'.repeat(64) }]; },
    async claimQueued() { claims++; },
  };
  const service = createUnifiedEvaluationService({ evaluators: { alloy: evaluator(), synthesis: evaluator(), 'new-material': evaluator(), 'alpha-rsi': evaluator(), 'alpha-combined-rsi': evaluator() }, repository });
  for (const serviceKey of ['alloy', 'synthesis', 'new-material']) {
    await assert.rejects(service.start({ serviceKey, question: '请分析材料的组成和目标性能。' }), { code: 'UNIFIED_EVAL_SERVICE_INVALID' });
  }
  assert.deepEqual(service.availableServices(), ['alpha-rsi', 'alpha-combined-rsi']);
  await service.recoverQueued();
  assert.deepEqual(recoveredKeys, ['alpha-rsi', 'alpha-combined-rsi']);
  assert.equal(claims, 0);
});
