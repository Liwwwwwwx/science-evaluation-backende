const { setupRunOwnership } = require('./run-ownership-fixture');
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { Pool } = require('pg');
const { createUnifiedEvaluationRepository } = require('../src/runs/unified-evaluation.repository');
const { createUnifiedEvaluationService } = require('../src/runs/unified-evaluation.service');

const socket = process.env.EVALUATION_RECOVERY_TEST_PG_SOCKET || '';
const waitFor = async fn => {
  for (let i = 0; i < 200; i++) { const value = await fn(); if (value) return value; await new Promise(resolve => setTimeout(resolve, 10)); }
  throw new Error('等待队列恢复超时');
};

test('隔离 PostgreSQL：进程退出后恢复未派发任务，竞争和不确定结果不重复派发', { skip: !socket }, async t => {
  assert.match(socket, /^\/tmp\/evaluation-auth-pg\.[A-Za-z0-9]+$/);
  const pool = new Pool({ host: socket, port: 55481, database: 'science_admin' });
  t.after(() => pool.end());
  await pool.query(fs.readFileSync(path.join(__dirname, '../migrations/003_evaluation_runs.sql'), 'utf8'));
  await setupRunOwnership(pool);

  // 子进程直接退出，模拟服务在五个运行已派发、第六个仍在排队时崩溃。
  const script = `
    const { Pool } = require('pg');
    const { createUnifiedEvaluationRepository } = require('./src/runs/unified-evaluation.repository');
    const { createUnifiedEvaluationService } = require('./src/runs/unified-evaluation.service');
    (async () => {
      const pool = new Pool({host:process.env.TEST_SOCKET,port:55481,database:'science_admin'});
      const repository = createUnifiedEvaluationRepository({pgPool:pool});
      const evaluator = {serviceAddress:'ws://service.example/start',scoreMode:'none',startQuestionRun:async ({question}) => ({run:{id:question},completion:new Promise(()=>{})})};
      const scoring = { snapshotRule: async () => ({version:'frozen-v1'}) };
      const service = createUnifiedEvaluationService({repository,evaluators:{literature:evaluator},scoring,maxActive:5,maxPerService:5});
      let last;
      for (let i=0;i<6;i++) last = await service.createRun({serviceKey:'literature',question:'重启恢复并发测试题 '+i},{scope:'evaluation-user:test',key:'crash-'+i});
      process.exit(0);
    })().catch(error => { console.error(error.message); process.exit(1); });`;
  const child = spawnSync(process.execPath, ['-e', script], { cwd: path.join(__dirname, '..'), env: { PATH: process.env.PATH, PGUSER: process.env.PGUSER || require('node:os').userInfo().username, TEST_SOCKET: socket }, encoding: 'utf8', timeout: 15000 });
  assert.equal(child.status, 0, child.stderr);
  const repository = createUnifiedEvaluationRepository({ pgPool: pool });
  const rows = await pool.query('SELECT id,status,question FROM unified_evaluation_runs ORDER BY question');
  assert.deepEqual(rows.rows.map(row => row.status), ['running', 'running', 'running', 'running', 'running', 'queued']);
  const queuedId = rows.rows[5].id;
  let starts = 0;
  const evaluator = { serviceAddress: 'ws://service.example/start', scoreMode: 'none', async startQuestionRun({ question }, { onText }) {
    starts++; onText(question); return { run: { id: 'resumed' }, completion: Promise.resolve({ status: 'done' }) };
  } };
  const one = createUnifiedEvaluationService({ repository, evaluators: { literature: evaluator } });
  const two = createUnifiedEvaluationService({ repository, evaluators: { literature: evaluator } });
  one.startQueueRecovery({ intervalMs: 10 }); two.startQueueRecovery({ intervalMs: 10 });
  t.after(() => { one.stopQueueRecovery(); two.stopQueueRecovery(); });
  const done = await waitFor(async () => { const row = await repository.get(queuedId); return row?.status === 'done' ? row : null; });
  assert.equal(starts, 1);
  assert.equal(done.answer, '重启恢复并发测试题 5');
  assert.equal(done.run.ruleSnapshot.version, 'frozen-v1');
  assert.equal((await pool.query("SELECT count(*)::int AS n FROM unified_evaluation_runs WHERE status='running'")).rows[0].n, 5);
  await Promise.all([one.recoverQueued(), two.recoverQueued()]);
  assert.equal(starts, 1);

  // 恢复运行按创建时的案例快照执行，不重新查询可能已修改的题库。
  let seenCase;
  evaluator.startCaseRun = async (caseDef, { beginCase }) => {
    seenCase = caseDef;
    beginCase({ id: 'fixed-native' }, onText => { onText('保留的案例快照'); return { status: 'done' }; });
    return { id: 'fixed-native' };
  };
  const fixed = { runId: require('node:crypto').randomUUID(), serviceKey: 'literature', origin: 'manual', question: '固定案例的题面快照', questionId: 'fixed-1', datasetVersion: 'v1', questionSourceType: 'fixed', batchId: null, status: 'queued', startedAt: new Date().toISOString(), run: { serviceAddress: 'ws://service.example/start', queuePayload: { version: 1, caseDef: { id: 'fixed-1', question: '固定案例的题面快照' }, scoreMode: 'none' } } };
  await repository.createIdempotent(fixed, 'evaluation-user:test', 'fixed', 'h-fixed');
  await Promise.all([one.recoverQueued(), two.recoverQueued()]);
  await waitFor(async () => (await repository.get(fixed.runId))?.status === 'done');
  assert.deepEqual(seenCase, fixed.run.queuePayload.caseDef);

  // 数据库已经提交抢占、但响应丢失时，不能重试派发或改写状态。
  const uncertainRepo = { ...repository, async claimQueued(job) { await repository.claimQueued(job); throw Error('模拟响应丢失'); } };
  const uncertain = createUnifiedEvaluationService({ repository: uncertainRepo, evaluators: { literature: evaluator } });
  const result = await uncertain.createRun({ serviceKey: 'literature', question: '提交抢占响应丢失测试题目' }, { scope: 'evaluation-user:test', key: 'uncertain' });
  assert.equal((await repository.get(result.runId)).status, 'running');
  await Promise.all([one.recoverQueued(), two.recoverQueued()]);
  assert.equal(starts, 1);

  // 地址发生变化的任务和缺少可恢复快照的历史队列不能盲目派发。
  const template = { serviceKey: 'literature', origin: 'manual', question: '无法安全恢复的队列任务', questionId: null, datasetVersion: null, questionSourceType: null, batchId: null, status: 'queued', startedAt: new Date().toISOString() };
  const legacy = { ...template, runId: require('node:crypto').randomUUID(), run: null };
  const changed = { ...template, runId: require('node:crypto').randomUUID(), run: { serviceAddress: 'ws://other.example/start', queuePayload: { version: 1, caseDef: null, scoreMode: 'none' } } };
  await repository.createIdempotent(legacy, 'evaluation-user:test', 'legacy', 'h1');
  await repository.createIdempotent(changed, 'evaluation-user:test', 'changed', 'h2');
  await Promise.all([one.recoverQueued(), two.recoverQueued()]);
  assert.equal(starts, 1);
  assert.equal((await repository.get(legacy.runId)).status, 'queued');
  assert.equal((await repository.get(changed.runId)).status, 'queued');

  // 旧对比队列要保留，但不能恢复，也不能占满正常队列的读取上限。
  one.stopQueueRecovery(); two.stopQueueRecovery();
  await pool.query(fs.readFileSync(path.join(__dirname, '../migrations/012_comparison_groups.sql'), 'utf8'));
  const afterMigration = createUnifiedEvaluationRepository({ pgPool: pool });
  const queueRun = { serviceAddress: 'ws://service.example/start', queuePayload: { version: 1, caseDef: null, scoreMode: 'none' } };
  const grouped = { ...template, runId: require('node:crypto').randomUUID(), comparisonGroupId: 'a'.repeat(64), startedAt: '2020-01-01T00:00:00.000Z', run: queueRun };
  const normal = { ...template, runId: require('node:crypto').randomUUID(), startedAt: '2021-01-01T00:00:00.000Z', run: queueRun };
  await afterMigration.createIdempotent(grouped, 'evaluation-user:test', 'grouped', 'grouped-hash');
  await afterMigration.createIdempotent(normal, 'evaluation-user:test', 'normal', 'normal-hash');
  const recoverable = await afterMigration.listRecoverableQueued(['literature'], 1, { literature: 'ws://service.example/start' });
  assert.deepEqual(recoverable.map(row => row.runId), [normal.runId]);
  assert.equal((await afterMigration.get(grouped.runId)).status, 'queued');
});
