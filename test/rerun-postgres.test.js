const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { Pool } = require('pg');
const { createUnifiedEvaluationRepository } = require('../src/runs/unified-evaluation.repository');
const { createUnifiedEvaluationService } = require('../src/runs/unified-evaluation.service');

const socket = process.env.EVALUATION_RERUN_TEST_PG_SOCKET || '';
test('隔离 PostgreSQL：重新测评保留原输出并按请求键去重', { skip: !socket }, async t => {
  assert.match(socket, /^\/tmp\/evaluation-rerun-pg\.[A-Za-z0-9]+$/);
  const pool = new Pool({ host: socket, port: 55484, database: 'science_admin' });
  t.after(() => pool.end());
  await pool.query('CREATE TABLE auth_users (id text PRIMARY KEY, username text NOT NULL UNIQUE)');
  await pool.query("INSERT INTO auth_users VALUES ('admin','admin'),('user','user')");
  await pool.query(fs.readFileSync(path.join(__dirname, '../migrations/003_evaluation_runs.sql'), 'utf8'));
  await pool.query(fs.readFileSync(path.join(__dirname, '../migrations/011_run_ownership.sql'), 'utf8'));
  const repository = createUnifiedEvaluationRepository({ pgPool: pool });
  let calls = 0;
  const evaluator = { serviceAddress: 'ws://example.test/start', scoreMode: 'none', async startQuestionRun(_input, { onText }) {
    calls++; onText('old-output-marker');
    return { run: { id: randomUUID() }, completion: Promise.resolve({ status: 'done', details: { displayEvents: [{ content: 'old-output-marker' }], artifacts: [{ url: 'http://example.test/files/output.txt' }] } }) };
  }, async getRunQuality() { return { status: 'absent' }; } };
  const service = createUnifiedEvaluationService({ repository, evaluators: { literature: evaluator } });
  async function create(key) {
    const created = await service.createRun({ serviceKey: 'literature', question: '用于重新测评的隔离测试题目' }, { scope: 'evaluation-user:user', key });
    for (let i = 0; i < 100; i++) {
      const run = await service.get(created.runId);
      if (run.finishedAt && run.recoveryState === 'snapshot_only') return run;
      await new Promise(resolve => setTimeout(resolve, 5));
    }
    throw Error('测试运行未完成');
  }
  const old = await create('original');
  const results = await Promise.all([service.rerun(old.runId, { scope: 'evaluation-user:user', key: 'rerun' }), service.rerun(old.runId, { scope: 'evaluation-user:user', key: 'rerun' })]);
  assert.equal(results[0].runId, results[1].runId);
  assert.notEqual(results[0].runId, old.runId);
  await new Promise(resolve => setTimeout(resolve, 30));
  assert.equal(calls, 2);
  const preserved = await repository.get(old.runId);
  assert.equal(preserved.answer, 'old-output-marker');
  assert.match(JSON.stringify(preserved), /output\.txt/);
  assert.equal((await service.get(old.runId)).answer, 'old-output-marker');
  assert.equal((await service.rerun(old.runId, { scope: 'evaluation-user:user', key: 'rerun' })).runId, results[0].runId);

  const concurrent = await create('concurrent-original');
  const raced = await Promise.allSettled(['a','b'].map(key => service.rerun(concurrent.runId, { scope: 'evaluation-user:user', key })));
  assert.equal(raced.filter(x => x.status === 'fulfilled').length, 2);
  assert.equal((await repository.get(concurrent.runId)).answer, 'old-output-marker');

  const rollback = await create('rollback-original');
  const next = { ...rollback, runId: randomUUID(), origin: 'invalid', status: 'queued', startedAt: new Date().toISOString(), run: {} };
  await assert.rejects(repository.createRerun(next, 'evaluation-user:user', 'rollback', 'hash', rollback.runId, 'request'));
  assert.equal((await repository.get(rollback.runId)).answer, 'old-output-marker');
  assert.equal(await repository.get(next.runId), null);
  await pool.query("UPDATE unified_evaluation_runs SET status='running' WHERE id=$1", [rollback.runId]);
  await assert.rejects(service.rerun(rollback.runId, { scope: 'evaluation-user:user', key: 'active' }), { code: 'RUN_NOT_RERUNNABLE' });

  const expired = await create('expired-original');
  await pool.query("UPDATE unified_evaluation_runs SET status='scoring',run=jsonb_set(run,'{scoring}',$2::jsonb) WHERE id=$1", [expired.runId, JSON.stringify({ attemptId: 'stale', expiresAt: '2000-01-01T00:00:00Z', finishedAt: null })]);
  const restarted = createUnifiedEvaluationService({ repository, evaluators: { literature: evaluator } });
  assert.equal((await restarted.get(expired.runId)).status, 'done');
  const replacement = await restarted.rerun(expired.runId, { scope: 'evaluation-user:user', key: 'expired-rerun' });
  const preservedExpired = await repository.get(expired.runId);
  assert.equal(preservedExpired.status, 'scoring');
  assert.equal(preservedExpired.answer, 'old-output-marker');
  assert.ok(replacement.runId);

  const leased = await create('leased-original');
  await pool.query("UPDATE unified_evaluation_runs SET status='scoring',run=jsonb_set(run,'{scoring}',$2::jsonb) WHERE id=$1", [leased.runId, JSON.stringify({ attemptId: 'active', expiresAt: '2999-01-01T00:00:00Z', finishedAt: null })]);
  await assert.rejects(restarted.rerun(leased.runId, { scope: 'evaluation-user:user', key: 'leased-rerun' }), { code: 'RUN_NOT_RERUNNABLE' });
  assert.equal((await repository.get(leased.runId)).answer, 'old-output-marker');
});
