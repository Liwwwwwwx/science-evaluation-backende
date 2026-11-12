// 使用隔离的 PostgreSQL 兼容库验证裁剪后的响应与原始评分一致。
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createUnifiedEvaluationRepository } = require('../src/runs/unified-evaluation.repository');
const { createBatchReadRepository } = require('../src/runs/batch-read.repository');
const { createBatchReadService } = require('../src/runs/batch-read.service');

test('裁剪评分后列表、批次统计和权限保持一致，并兼容旧对比列', { skip: !process.env.PGLITE_PACKAGE }, async t => {
  const { PGlite } = require(process.env.PGLITE_PACKAGE);
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'science-score-projection-'));
  let db = new PGlite(root);
  await db.exec('CREATE DATABASE science_evaluation'); await db.close();
  db = new PGlite(root, { database: 'science_evaluation' });
  t.after(() => db.close());
  await db.exec(`CREATE TABLE unified_evaluation_runs (
    id text PRIMARY KEY, service_key text, origin text, owner_user_id text, question text,
    question_id text, dataset_version text, question_source_type text, batch_id text,
    status text, error text, score_error text, scores jsonb, run jsonb, answer_truncated boolean,
    started_at timestamptz, finished_at timestamptz, updated_at timestamptz DEFAULT now()
  );
  CREATE TABLE eval_questions (id text, dataset_version text, domain_key text);
  CREATE TABLE evaluation_user_run_history (user_id text, run_id text, title text, hidden boolean);
  CREATE TABLE evaluation_trial_batch_plans (plan_date date, id text, state text, items jsonb, rule_snapshot jsonb, error text, created_at timestamptz, updated_at timestamptz);`);
  const detailed = { deepSeekScore: { status: 'ready', model: 'judge-a', quality: { total: 80, taskCompletion: { status: 'completed', note: 'x'.repeat(100000) }, source: { truncated: false, imageCoverage: { found: 2, sent: 2, overflow: false } }, extra: 'y'.repeat(100000) } }, qwenScore: { status: 'ready', model: 'judge-b', quality: { total: 72, source: { truncated: true } } }, other: { report: 'z'.repeat(100000) } };
  const pending = { deepSeekScore: { status: 'pending', model: null }, qwenScore: null, quality: { status: 'absent' } };
  const run = { status: 'done', elapsedMs: 1200, ruleSnapshot: { hash: 'rule-1' } };
  const insert = `INSERT INTO unified_evaluation_runs (id,service_key,origin,owner_user_id,question,question_id,dataset_version,batch_id,status,scores,run,answer_truncated,started_at)
    VALUES ($1,'alloy',$2,$3,'测试题',$4,'v1',$5,'done',$6::jsonb,$7::jsonb,false,'2026-11-01')`;
  await db.query(insert, ['auto', 'automation', null, 'q1', 'batch-1', JSON.stringify(detailed), JSON.stringify(run)]);
  await db.query(insert, ['mine', 'manual', 'alice', 'q2', 'batch-1', JSON.stringify(pending), JSON.stringify(run)]);
  await db.query(insert, ['other', 'manual', 'bob', 'q3', 'batch-1', JSON.stringify(detailed), JSON.stringify(run)]);
  await db.exec("INSERT INTO evaluation_trial_batch_plans VALUES ('2026-11-01','batch-1','submitted','{\"alloy\":[\"q1\",\"q2\"]}','{\"hash\":\"rule-1\"}',NULL,'2026-11-01','2026-11-01')");
  const queries = [];
  const pool = { async query(sql, args = []) { queries.push(sql); const result = await db.query(sql, args); return { ...result, rowCount: result.rowCount ?? result.affectedRows }; } };
  const unified = createUnifiedEvaluationRepository({ pgPool: pool });
  const list = await unified.list({ userId: 'alice' });
  assert.deepEqual(new Set(list.items.map(item => item.runId)), new Set(['auto', 'mine']));
  assert.deepEqual(list.items.find(item => item.runId === 'auto').scores.deepSeekScore, { status: 'ready', model: 'judge-a', total: 80, taskStatus: 'completed', provisional: false });
  assert.deepEqual(list.items.find(item => item.runId === 'mine').scores.qwenScore, { status: undefined, model: undefined, total: null, taskStatus: null, provisional: false });
  assert.ok(list.items.every(item => item.comparisonGroupId == null));
  await db.exec('ALTER TABLE unified_evaluation_runs ADD COLUMN comparison_group_id text');
  await db.query("UPDATE unified_evaluation_runs SET comparison_group_id='group-1' WHERE id='auto'");
  assert.equal((await unified.list({ userId: 'alice' })).items.find(item => item.runId === 'auto').comparisonGroupId, 'group-1');
  const fresh = createUnifiedEvaluationRepository({ pgPool: pool });
  assert.equal((await fresh.list({ userId: 'alice' })).items.find(item => item.runId === 'auto').comparisonGroupId, 'group-1');
  assert.doesNotMatch(queries.at(-1), /to_jsonb\(r\)/);
  const repo = createBatchReadRepository({ pgPool: pool });
  const compact = await repo.runsByBatchIds(['batch-1'], 'alice');
  assert.doesNotMatch(queries.at(-1), /to_jsonb\(unified_evaluation_runs\)/);
  assert.deepEqual(new Set(compact.map(row => row.id)), new Set(['auto', 'mine']));
  assert.deepEqual(compact.find(row => row.id === 'auto').scores.deepSeekScore.quality.source.imageCoverage, { found: 2, sent: 2, overflow: false });
  assert.ok(JSON.stringify(compact).length < 5000);
  const originalScores = { auto: detailed, mine: pending };
  const baseline = compact.map(row => ({ ...row, scores: originalScores[row.id] }));
  const plan = { source: 'trial', plan_date: '2026-11-01', id: 'batch-1', state: 'submitted', items: { alloy: ['q1', 'q2'] }, rule_snapshot: { hash: 'rule-1' }, created_at: '2026-11-01', updated_at: '2026-11-01' };
  const service = rows => createBatchReadService({ repository: { async plans() { return { storageReady: true, items: [plan] }; }, async plan() { return { storageReady: true, plan }; }, async runsByBatchIds() { return rows; } } });
  assert.deepEqual(await service(compact).list({ userId: 'alice' }), await service(baseline).list({ userId: 'alice' }));
  assert.deepEqual(await service(compact).get('batch-1', 'alice'), await service(baseline).get('batch-1', 'alice'));
  assert.deepEqual(await service(compact).runs('batch-1', { userId: 'alice' }), await service(baseline).runs('batch-1', { userId: 'alice' }));
  // 对照同一数据库中的旧读取路径，覆盖分页、状态筛选、评分截断与个人归属。
  for (let i = 0; i < 5; i++) {
    const id = `batch-extra-${i}`;
    await db.query("INSERT INTO evaluation_trial_batch_plans VALUES ($1::date,$2,$3,'{\"alloy\":[\"q\"]}'::jsonb,NULL,NULL,$1::date,$1::date)", [`2026-11-0${i + 2}`, id, i === 1 ? 'failed' : 'submitted']);
    const scores = i === 0 ? { deepSeekScore: { status: 'ready', model: 'a', quality: { total: 72.5, source: { truncated: true } } } } : i === 1 ? { deepSeekScore: { status: 'failed' } } : i === 2 ? { deepSeekScore: { status: 'ready', model: 'b', quality: { total: 120 } } } : detailed;
    await db.query(insert, [`extra-${i}`, 'automation', null, `q${i}`, id, JSON.stringify(scores), JSON.stringify({ status: i === 3 ? 'error' : 'done' })]);
  }
  const optimized = createBatchReadService({ repository: repo });
  const legacy = createBatchReadService({ repository: { plans: (...args) => repo.plans(...args), runsByBatchIds: (...args) => repo.runsByBatchIds(...args) } });
  for (const options of [{ page: 1, pageSize: 2 }, { page: 2, pageSize: 2 }, { page: 99, pageSize: 2 }, { state: 'failed', page: 1, pageSize: 2 }, { state: 'done', page: 2, pageSize: 2 }]) {
    assert.deepEqual(await optimized.list({ ...options, userId: 'alice' }), await legacy.list({ ...options, userId: 'alice' }), JSON.stringify(options));
  }
  const day = await optimized.list({ userId: 'alice', from: '2026-11-03', to: '2026-11-03' });
  assert.equal(day.items.length, 1); assert.equal(day.items[0].date, '2026-11-03');
  const detail = await optimized.get('batch-extra-1', 'alice');
  assert.equal(detail.batch.date, '2026-11-03'); assert.equal(detail.links.dailyReport, '/daily-reports/2026-11-03');
  const comparison = await optimized.comparison('batch-extra-1', { userId: 'alice' });
  assert.equal(comparison.base.date, '2026-11-03'); assert.equal(comparison.previous.date, '2026-11-02');
  await db.exec(`CREATE TABLE evaluation_mission_daily_plans (plan_date date, id text, state text, items jsonb, rule_snapshot jsonb, reason text, created_at timestamptz, updated_at timestamptz);
    CREATE TABLE evaluation_manual_batch_plans (plan_date date, id text, state text, items jsonb, rule_snapshot jsonb, error text, created_at timestamptz, updated_at timestamptz, config_snapshot jsonb, created_by text);
    INSERT INTO evaluation_mission_daily_plans VALUES ('2026-11-04','mission-1','submitted','[]',NULL,NULL,'2026-11-04','2026-11-04');
    INSERT INTO evaluation_manual_batch_plans VALUES ('2026-11-04','manual-1','submitted','{}',NULL,NULL,'2026-11-04','2026-11-04',NULL,'alice');`);
  assert.equal((await optimized.get('mission-1', 'alice')).batch.date, '2026-11-04');
  assert.equal((await optimized.get('mission-1', 'alice')).links.dailyReport, '/daily-reports/2026-11-04');
  assert.equal((await optimized.get('manual-1', 'alice')).batch.date, '2026-11-04');
  assert.equal((await optimized.list({ source: 'nightly', from: '2026-11-04', to: '2026-11-04', userId: 'alice' })).items.every(item => item.date === '2026-11-04'), true);
  // 已取消记录保留执行状态，同时以评分轮次原子抢占和更新结果。
  await db.query("INSERT INTO unified_evaluation_runs (id,origin,owner_user_id,status,run) VALUES ('cancelled','manual','alice','cancelled',$1::jsonb)", [JSON.stringify({ status: 'running' })]);
  assert.equal(await unified.claimScoring('cancelled', null, { attemptId: 'partial-1' }, pending), true);
  assert.equal(await unified.claimScoring('cancelled', null, { attemptId: 'partial-2' }, pending), false);
  assert.equal((await db.query("SELECT status FROM unified_evaluation_runs WHERE id='cancelled'")).rows[0].status, 'cancelled');
  assert.equal(await unified.updateScoring('cancelled', 'partial-1', { scoring: { attemptId: 'partial-1', finishedAt: '2026-11-12' }, markdownSyntax: {}, scores: detailed, status: 'cancelled' }), true);
  assert.equal((await db.query("SELECT status FROM unified_evaluation_runs WHERE id='cancelled'")).rows[0].status, 'cancelled');
  assert.equal(await unified.claimScoring('auto', null, { attemptId: 'shared-1', expiresAt: new Date(Date.now() + 60000).toISOString() }, pending), true);
  assert.equal(await unified.claimScoring('auto', null, { attemptId: 'shared-2' }, pending), false);
  assert.equal((await unified.list({ userId: 'alice' })).items.find(item => item.runId === 'auto').scoringInProgress, true);
});
