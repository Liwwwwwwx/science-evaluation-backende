const { setupRunOwnership } = require('./run-ownership-fixture');
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { Pool } = require('pg');
const { createTrialBatchRepository } = require('../src/runs/trial-batch.repository');
const { createDailyReportRepository } = require('../src/daily-reports/repository');
const { snapshotOf } = require('../src/daily-reports/summary');
const { createTrialBatchService } = require('../src/runs/trial-batch.service');
const { createUnifiedEvaluationRepository } = require('../src/runs/unified-evaluation.repository');
const { createUnifiedEvaluationService } = require('../src/runs/unified-evaluation.service');
const socket = process.env.EVALUATION_TRIAL_TEST_PG_SOCKET;

test('隔离数据库：试运行计划唯一、保存快照，跨日报日期仍可归属', { skip: !socket }, async t => {
  assert.match(socket, /^\/tmp\/evaluation-(trial|auth)-pg\.[A-Za-z0-9]+$/);
  const port = socket.includes('-auth-') ? 55481 : 55793;
  const pool = new Pool({ host: socket, port, database: 'science_evaluation' }); t.after(() => pool.end());
  for (const file of ['003_evaluation_runs.sql', '005_mission_daily_plans.sql', '007_daily_evaluation_reports.sql', '008_trial_batch_plans.sql']) await pool.query(fs.readFileSync(path.join(__dirname, '../migrations', file), 'utf8'));
  await pool.query('CREATE TABLE eval_questions (id text,dataset_version text,domain_key text,UNIQUE(id,dataset_version))');
  const repo = createTrialBatchRepository({ pgPool: pool }); const date = '2026-11-02'; const id = randomUUID();
  const input = { date, id, serviceAddresses: { alloy: 'ws://example.test' }, ruleSnapshot: { hash: 'v1' } };
  assert.equal(await repo.create(input), true);
  assert.equal(await repo.create({ ...input, id: randomUUID() }), false);
  assert.equal((await repo.pending()).id, id);
  assert.equal(await repo.ready(id, { alloy: ['用于测试的材料问题一', '用于测试的材料问题二'] }), true);
  assert.equal((await repo.pending()).state, 'dispatching');
  await repo.submitted(id);
  assert.equal(await repo.pending(), null);
  await pool.query("INSERT INTO unified_evaluation_runs(id,service_key,origin,question,batch_id,status,started_at,finished_at,run) VALUES ($1,'alloy','automation','材料问题一',$2,'done','2026-11-04T00:00:00+08:00','2026-11-04T00:01:00+08:00','{\"status\":\"done\"}')", [randomUUID(), id]);
  assert.equal(await repo.hasUnfinishedRuns(), false);
  await pool.query("UPDATE unified_evaluation_runs SET status='error',finished_at=NULL WHERE batch_id=$1", [id]);
  assert.equal(await repo.hasUnfinishedRuns(), true);
  await pool.query("UPDATE unified_evaluation_runs SET status='done',finished_at=now(),scores='{\"deepSeekScore\":{\"status\":\"pending\"}}' WHERE batch_id=$1", [id]);
  assert.equal(await repo.hasUnfinishedRuns(), true);
  await pool.query('UPDATE unified_evaluation_runs SET scores=NULL WHERE batch_id=$1', [id]);
  assert.equal(await repo.hasUnfinishedRuns(), false);
  const source = await createDailyReportRepository(pool, { trialEnabled: true }).source(date);
  assert.equal(source.runs.length, 1);
  assert.equal(source.trialPlan.id, id);
  const snapshot = snapshotOf(date, source);
  assert.equal(snapshot.missingPlanned, 1);
  assert.equal(snapshot.inProgress, true);
});

test('隔离数据库：完整320次批次持久化，失败后继续且重复派发不重复执行', { skip: !socket }, async t => {
  assert.match(socket, /^\/tmp\/evaluation-(trial|auth)-pg\.[A-Za-z0-9]+$/);
  const pool = new Pool({ host: socket, port: socket.includes('-auth-') ? 55481 : 55793, database: 'science_evaluation' }); t.after(() => pool.end());
  for (const file of ['003_evaluation_runs.sql', '005_mission_daily_plans.sql', '007_daily_evaluation_reports.sql', '008_trial_batch_plans.sql', '012_comparison_groups.sql']) await pool.query(fs.readFileSync(path.join(__dirname, '../migrations', file), 'utf8'));
  await setupRunOwnership(pool);
  const keys = ['mission-material', 'literature', 'literature-aircraft', 'alloy', 'synthesis', 'new-material', 'alpha-rsi'];
  const serviceAddresses = Object.fromEntries(keys.map(key => [key, `ws://${key}.example/start`]));
  const active = new Map(); const maxSeen = new Map(); let starts = 0; let generated = 0;
  const evaluators = Object.fromEntries(keys.map(key => [key, { scoreMode: 'none', serviceAddress: serviceAddresses[key], async startQuestionRun() {
    starts++; active.set(key, (active.get(key) || 0) + 1); maxSeen.set(key, Math.max(maxSeen.get(key) || 0, active.get(key)));
    const number = starts;
    const completion = new Promise(resolve => setTimeout(() => { active.set(key, active.get(key) - 1); resolve(number === 1 ? { status: 'error', error: '模拟服务故障' } : { status: 'done' }); }, 5));
    return { run: { id: randomUUID() }, completion };
  } }]));
  const evaluations = createUnifiedEvaluationService({ evaluators, repository: createUnifiedEvaluationRepository({ pgPool: pool }), maxActive: 26, maxQueued: 350, serviceLimits: { 'literature-aircraft': 1 } });
  const repository = createTrialBatchRepository({ pgPool: pool });
  const generator = { async generate(input) { return { items: Array.from({ length: input.count }, () => ({ question: `请分析材料结构与性能案例第${++generated}题。` })) }; } };
  const service = createTrialBatchService({ repository, evaluations, generator, serviceAddresses });
  const date = '2026-11-03'; await service.prepare(date); await service.dispatch(date); await service.dispatch(date);
  for (let i = 0; i < 400; i++) {
    const result = await pool.query("SELECT count(*)::int AS total,count(*) FILTER (WHERE status IN ('done','error'))::int AS finished,count(*) FILTER (WHERE status='error' AND error='模拟服务故障')::int AS failed FROM unified_evaluation_runs WHERE batch_id=$1", [(await repository.get(date)).id]);
    if (result.rows[0].finished === 320) {
      assert.equal(result.rows[0].total, 320); assert.equal(result.rows[0].failed, 1); assert.equal(starts, 320);
      const pairs = await pool.query("SELECT comparison_group_id FROM unified_evaluation_runs WHERE batch_id=$1 AND comparison_group_id IS NOT NULL GROUP BY comparison_group_id HAVING count(*)=2 AND count(DISTINCT service_key)=2 AND count(DISTINCT question)=1", [(await repository.get(date)).id]);
      assert.equal(pairs.rowCount, 50);
      assert.equal(generated, 100); assert.equal(maxSeen.get('literature-aircraft'), 1);
      assert.ok([...maxSeen.values()].every(value => value <= 5)); return;
    }
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  assert.fail('320条运行未全部保存为终态');
});
