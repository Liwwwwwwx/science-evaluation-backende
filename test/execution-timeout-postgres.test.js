const test = require('node:test');
const assert = require('node:assert/strict');
const { Pool } = require('pg');
const { createUnifiedEvaluationRepository } = require('../src/runs/unified-evaluation.repository');
const socket = process.env.EVALUATION_TIMEOUT_TEST_PG_SOCKET;
const pglite = process.env.PGLITE_PACKAGE;

test('隔离数据库：恢复超时、并发保护、Mission 排队暂停和迟到写入', { skip: !socket && !pglite }, async t => {
  let pool;
  if (socket) { pool = new Pool({ host:socket, port:Number(process.env.EVALUATION_TIMEOUT_TEST_PG_PORT || 55991), database:process.env.EVALUATION_TIMEOUT_TEST_PG_DATABASE || 'science_evaluation' }); t.after(() => pool.end()); }
  else {
    const { PGlite } = require(pglite); const fs = require('node:fs'); const os = require('node:os'); const path = require('node:path');
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'science-timeout-pglite-'));
    let db = new PGlite(root); await db.exec('CREATE DATABASE science_evaluation'); await db.close();
    db = new PGlite(root, { database:'science_evaluation' }); t.after(() => db.close());
    const query = async (sql, args = []) => { const r = await db.query(sql, args); return { ...r, rowCount:r.rowCount ?? r.affectedRows }; };
    pool = { query, async connect() { return { query, release() {} }; } };
  }
  await pool.query(`CREATE TABLE unified_evaluation_runs (
    id uuid PRIMARY KEY, service_key text, origin text, batch_id text, status text, native_run_id text,
    run jsonb, answer text, answer_truncated boolean, scores jsonb, score_error text, error text,
    finished_at timestamptz, updated_at timestamptz NOT NULL DEFAULT now()
  )`);
  const ids = ['00000000-0000-4000-8000-000000000001','00000000-0000-4000-8000-000000000002','00000000-0000-4000-8000-000000000003','00000000-0000-4000-8000-000000000004'];
  await pool.query(`INSERT INTO unified_evaluation_runs (id,service_key,origin,batch_id,status,run,answer,updated_at) VALUES
    ($1,'literature','automation','b1','running','{}','保留输出',now()-interval '2 hours'),
    ($2,'literature','automation','b1','running','{}','新输出',now()-interval '2 hours'),
    ($3,'mission-material','automation','b2','running','{}','Mission 输出',now()-interval '2 hours'),
    ($4,'mission-material','automation','b2','queued','{}','',now()-interval '2 hours')`, ids);
  const repo = createUnifiedEvaluationRepository({ pgPool:pool });
  const candidates = await repo.listStaleRunning(3600000);
  assert.equal(candidates.length, 3);
  const version = id => candidates.find(item => item.runId === id).version;
  await pool.query("UPDATE unified_evaluation_runs SET updated_at=now() WHERE id=$1", [ids[1]]);
  assert.equal(await repo.timeoutStaleRunning(ids[1], version(ids[1]), 3600000), false);
  assert.equal(await repo.timeoutStaleRunning(ids[0], version(ids[0]), 3600000), true);
  assert.equal(await repo.timeoutStaleRunning(ids[2], version(ids[2]), 3600000), true);
  const result = await pool.query('SELECT id,status,error,answer,run,finished_at FROM unified_evaluation_runs ORDER BY id');
  assert.equal(result.rows[0].status, 'error'); assert.match(result.rows[0].error, /超时/); assert.equal(result.rows[0].answer, '保留输出');
  assert.equal(result.rows[0].run.executionTimeout, true); assert.ok(result.rows[0].finished_at);
  assert.equal(result.rows[1].status, 'running'); assert.equal(result.rows[2].run.missionBatchPaused, true);
  assert.equal(result.rows[3].status, 'paused'); assert.match(result.rows[3].error, /上游状态未确认/);
  await assert.rejects(repo.save({ runId:ids[0], status:'done', answer:'迟到输出', run:{ status:'done' } }));
  const lateMission = await repo.pauseMissionBatch({ runId:ids[2], batchId:'b2', status:'error', answer:'迟到输出', run:{ status:'error' } }, '暂停');
  assert.equal(lateMission.superseded, true);
  const current = await pool.query('SELECT answer,status FROM unified_evaluation_runs WHERE id=$1', [ids[0]]);
  assert.equal(current.rows[0].answer, '保留输出'); assert.equal(current.rows[0].status, 'error');
});
