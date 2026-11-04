// 可选隔离集成验证：PGLITE_PACKAGE 指向独立安装的 @electric-sql/pglite，绝不连接现有数据库。
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { DEFAULT_SCHEME, SERVICE_KEYS } = require('../src/runs/batch-scheme');
const { createBatchSchemeRepository } = require('../src/runs/batch-scheme.repository');
const { createManualBatchRepository } = require('../src/runs/manual-batch.repository');
const { createManualBatchService } = require('../src/runs/manual-batch.service');
const { createTrialBatchRepository } = require('../src/runs/trial-batch.repository');
const { createTrialBatchService } = require('../src/runs/trial-batch.service');
const { createBatchReadRepository } = require('../src/runs/batch-read.repository');
const { createBatchReadService } = require('../src/runs/batch-read.service');
const { createUnifiedEvaluationRepository } = require('../src/runs/unified-evaluation.repository');
const { createUnifiedEvaluationService } = require('../src/runs/unified-evaluation.service');
const { createMissionDailyRepository } = require('../src/runs/mission-daily.repository');
const { createDailyReportRepository } = require('../src/daily-reports/repository');

test('隔离 PostgreSQL 兼容库：方案版本、手动批次、同题配对、归属与互斥', { skip: !process.env.PGLITE_PACKAGE }, async t => {
  const { PGlite } = require(process.env.PGLITE_PACKAGE);
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'science-batch-pglite-'));
  let db = new PGlite(root);
  await db.exec('CREATE DATABASE science_evaluation'); await db.close();
  db = new PGlite(root, { database: 'science_evaluation' });
  t.after(() => db.close());
  const query = async (sql, args = []) => {
    const result = await db.query(sql, args);
    for (const row of result.rows) if (row.plan_date instanceof Date) row.plan_date = row.plan_date.toISOString().slice(0, 10);
    return { ...result, rowCount: result.rowCount ?? result.affectedRows };
  };
  const pool = { query, async connect() { return { query, release() {} }; } };
  await db.exec("CREATE TABLE auth_users(id text PRIMARY KEY,username text NOT NULL UNIQUE); INSERT INTO auth_users VALUES ('admin','admin'),('alice','alice'),('bob','bob')");
  await db.exec('CREATE TABLE eval_questions(id text,dataset_version text,domain_key text,UNIQUE(id,dataset_version))');
  for (const name of ['003_evaluation_runs.sql', '005_mission_daily_plans.sql', '007_daily_evaluation_reports.sql', '008_trial_batch_plans.sql', '011_run_ownership.sql', '012_comparison_groups.sql', '013_batch_schemes.sql']) await db.exec(fs.readFileSync(path.join(__dirname, '../migrations', name), 'utf8'));
  const schemes = createBatchSchemeRepository({ pgPool: pool });
  const config = structuredClone(DEFAULT_SCHEME); config.pools = { aviation: 0, synthesis: 3 };
  for (const key of SERVICE_KEYS) config.services[key] = { aviation: 0, synthesis: ['synthesis', 'alpha-rsi'].includes(key) ? 3 : 0 };
  const scheme = await schemes.save({ id: randomUUID(), name: '隔离测试方案', config, version: 0, userId: 'admin', nightly: true });
  assert.equal((await schemes.nightly()).version, 1);
  await assert.rejects(schemes.save({ id: scheme.id, name: '冲突', config, version: 0, userId: 'admin', nightly: true }), { code: 'BATCH_SCHEME_CONFLICT' });
  const addresses = { synthesis: 'ws://synthesis.test', 'alpha-rsi': 'ws://alpha.test' };
  let n = 0;
  const generator = { async generate(input) { return { items: Array.from({ length: input.count }, () => ({ question: `请分析合成材料测试案例第 ${++n} 题。` })) }; } };
  const evaluator = key => ({ scoreMode: 'none', serviceAddress: addresses[key], async startQuestionRun() { return { run: { id: randomUUID() }, completion: Promise.resolve({ status: 'done' }) }; }, async getRunQuality() { return { status: 'absent' }; } });
  const evaluations = createUnifiedEvaluationService({ repository: createUnifiedEvaluationRepository({ pgPool: pool }), evaluators: { synthesis: evaluator('synthesis'), 'alpha-rsi': evaluator('alpha-rsi') } });
  const trialRepo = createTrialBatchRepository({ pgPool: pool });
  const trial = createTrialBatchService({ repository: trialRepo, evaluations, generator, serviceAddresses: addresses, schemes });
  const manualRepo = createManualBatchRepository({ pgPool: pool, schemes });
  const manual = createManualBatchService({ repository: manualRepo, evaluations, generator, serviceAddresses: addresses, trialService: trial, schemes });
  const first = await manual.create({ config, userId: 'alice', key: 'same-request', schemeId: scheme.id, schemeVersion: scheme.version });
  let manualFinished = 0;
  for (let i = 0; i < 200; i++) {
    const result = await pool.query('SELECT count(*)::int AS n FROM unified_evaluation_runs WHERE batch_id=$1 AND finished_at IS NOT NULL', [first.batchId]);
    manualFinished = result.rows[0].n; if (manualFinished === 6) break;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  assert.equal(manualFinished, 6);
  const records = await pool.query('SELECT origin,owner_user_id,question,comparison_group_id FROM unified_evaluation_runs WHERE batch_id=$1', [first.batchId]);
  assert.equal(records.rows.length, 6);
  assert.ok(records.rows.every(row => row.origin === 'manual' && row.owner_user_id === 'alice'));
  for (const group of new Set(records.rows.map(row => row.comparison_group_id))) assert.equal(new Set(records.rows.filter(row => row.comparison_group_id === group).map(row => row.question)).size, 1);
  assert.equal(new Set(records.rows.map(row => row.comparison_group_id)).size, 3);
  const read = createBatchReadService({ repository: createBatchReadRepository({ pgPool: pool }) });
  assert.equal((await read.get(first.batchId, 'alice')).batch.planned, 6);
  await assert.rejects(read.get(first.batchId, 'bob'), { code: 'BATCH_NOT_FOUND' });
  assert.equal((await read.list({ userId: 'alice' })).total, 1);
  assert.equal((await read.list({ userId: 'bob' })).total, 0);
  assert.equal((await createDailyReportRepository(pool, { trialEnabled: true }).source('2026-11-04')).runs.length, 0);
  await schemes.save({ id: scheme.id, name: '改名后的方案', config, version: 1, userId: 'admin', nightly: true });
  assert.equal((await manual.create({ config, userId: 'alice', key: 'same-request', schemeId: scheme.id, schemeVersion: scheme.version })).reused, true);
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM unified_evaluation_runs')).rows[0].n, 6);
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM evaluation_batch_scheme_history WHERE scheme_id=$1', [scheme.id])).rows[0].n, 2);
  await pool.query(`INSERT INTO evaluation_manual_batch_plans(id,plan_date,state,service_addresses,config_snapshot,created_by,request_key,request_hash)
    VALUES($1,'2026-11-04','generating',$2::jsonb,$3::jsonb,'bob','pending','hash')`, [randomUUID(), JSON.stringify(addresses), JSON.stringify({ config })]);
  assert.equal(await trialRepo.hasManualBusy(), true);
  await assert.rejects(trial.prepare('2026-11-04'), /手动测评批次尚未结束/);
  assert.equal(await trialRepo.get('2026-11-04'), null);
  const mission = createMissionDailyRepository({ pgPool: pool });
  const blocked = await mission.create({ date: '2026-11-04', id: randomUUID(), serviceAddress: 'ws://mission.test', items: [{ question: '测试题目' }], state: 'dispatching' });
  assert.equal(blocked.state, 'skipped'); assert.match(blocked.reason, /手动组合批次/);
  await pool.query("UPDATE evaluation_manual_batch_plans SET state='failed' WHERE request_key='pending'");
  await trial.prepare('2026-11-05'); await trial.dispatch('2026-11-05');
  const scheduled = await trialRepo.get('2026-11-05');
  assert.equal(scheduled.configSnapshot.scheme.version, 2);
  assert.equal((await read.get(scheduled.id, 'bob')).batch.planned, 6);
  const scheduledRuns = await pool.query('SELECT origin,owner_user_id FROM unified_evaluation_runs WHERE batch_id=$1', [scheduled.id]);
  assert.equal(scheduledRuns.rows.length, 6);
  assert.ok(scheduledRuns.rows.every(row => row.origin === 'automation' && row.owner_user_id === null));
  let scheduledFinished = 0;
  for (let i = 0; i < 200; i++) {
    scheduledFinished = (await pool.query('SELECT count(*)::int AS n FROM unified_evaluation_runs WHERE batch_id=$1 AND finished_at IS NOT NULL', [scheduled.id])).rows[0].n;
    if (scheduledFinished === 6) break;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  assert.equal(scheduledFinished, 6);
});
