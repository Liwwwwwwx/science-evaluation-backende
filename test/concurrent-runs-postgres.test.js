const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { Pool } = require('pg');
const { createUnifiedEvaluationRepository } = require('../src/runs/unified-evaluation.repository');
const { createUnifiedEvaluationService } = require('../src/runs/unified-evaluation.service');

const socket = process.env.EVALUATION_CONCURRENCY_TEST_PG_SOCKET || '';
test('隔离 PostgreSQL：排队记录持久化，释放名额后启动且不重复执行', { skip: !socket }, async t => {
  assert.match(socket, /^\/tmp\/evaluation-auth-pg\.[A-Za-z0-9]+$/);
  const pool = new Pool({ host: socket, port: 55481, database: 'science_admin' });
  t.after(() => pool.end());
  await pool.query(fs.readFileSync(path.join(__dirname, '../migrations/003_evaluation_runs.sql'), 'utf8'));
  const repository = createUnifiedEvaluationRepository({ pgPool: pool });
  const pending = new Map();
  const evaluator = { scoreMode: 'none', async startQuestionRun({ question }, { onText }) {
    onText(question);
    let complete; const completion = new Promise(resolve => { complete = resolve; });
    pending.set(question, complete);
    return { run: { id: question }, completion };
  } };
  const service = createUnifiedEvaluationService({ repository, evaluators: { literature: evaluator }, maxActive: 5, maxPerService: 5 });
  const jobs = [];
  for (let i = 0; i < 6; i++) jobs.push(await service.createRun({ serviceKey: 'literature', question: `数据库并发运行测试问题 ${i}` }, { scope: 'user', key: `key-${i}` }));
  assert.equal(pending.size, 5);
  assert.equal((await repository.get(jobs[5].runId)).status, 'queued');
  const duplicate = await service.createRun({ serviceKey: 'literature', question: '数据库并发运行测试问题 5' }, { scope: 'user', key: 'key-5' });
  assert.equal(duplicate.runId, jobs[5].runId); assert.equal(duplicate.reused, true);
  pending.get('数据库并发运行测试问题 0')({ status: 'done' });
  for (let i = 0; i < 100 && !pending.has('数据库并发运行测试问题 5'); i++) await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(pending.size, 6);
  assert.equal((await repository.get(jobs[5].runId)).status, 'running');
  for (const complete of pending.values()) complete({ status: 'done' });
  for (let i = 0; i < 100; i++) {
    const result = await pool.query("SELECT count(*)::int AS n FROM unified_evaluation_runs WHERE status='done'");
    if (result.rows[0].n === 6) return;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  assert.fail('所有运行应完成并持久化');
});
