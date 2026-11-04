// 仅显式启用时在 127.0.0.1:5432 创建随机命名的独立测试库；不连接或清理任何已有库。
// 为避免使用保留的生产库名，测试库用本地函数模拟库名守卫；其余 SQL 与应用代码均为原样。
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { randomBytes, randomUUID } = require('node:crypto');
const { Pool } = require('pg');
const { DEFAULT_SCHEME, SERVICE_KEYS } = require('../src/runs/batch-scheme');
const { createBatchSchemeRepository } = require('../src/runs/batch-scheme.repository');
const { createManualBatchRepository } = require('../src/runs/manual-batch.repository');
const { createManualBatchService } = require('../src/runs/manual-batch.service');
const { createTrialBatchRepository } = require('../src/runs/trial-batch.repository');
const { createTrialBatchService } = require('../src/runs/trial-batch.service');
const { createMissionDailyRepository } = require('../src/runs/mission-daily.repository');
const { createBatchReadRepository } = require('../src/runs/batch-read.repository');
const { createBatchReadService } = require('../src/runs/batch-read.service');
const { createUnifiedEvaluationRepository } = require('../src/runs/unified-evaluation.repository');
const { createUnifiedEvaluationService } = require('../src/runs/unified-evaluation.service');
const { createDailyReportRepository } = require('../src/daily-reports/repository');

test('独立 PostgreSQL：方案并发、幂等、调度互斥、归属和日报隔离', { skip: process.env.EVALUATION_LOCAL_PG_VERIFY !== '1', timeout: 60000 }, async t => {
  const database = `science_batch_verify_${randomBytes(6).toString('hex')}`;
  const admin = new Pool({ host: '127.0.0.1', port: 5432, database: 'postgres', max: 1, connectionTimeoutMillis: 5000 });
  const remote = await admin.query('SELECT inet_server_addr()::text AS address,inet_server_port() AS port,pg_is_in_recovery() AS recovery');
  assert.equal(remote.rows[0].address, '127.0.0.1/32'); assert.equal(remote.rows[0].port, 5432); assert.equal(remote.rows[0].recovery, false);
  await admin.query(`CREATE DATABASE "${database}"`);
  await admin.end();
  const pool = new Pool({ host: '127.0.0.1', port: 5432, database, max: 12, options: '-c search_path=public,pg_catalog', connectionTimeoutMillis: 5000 });
  t.after(() => pool.end());
  const actual = await pool.query('SELECT pg_catalog.current_database() AS name');
  assert.equal(actual.rows[0].name, database);
  await pool.query("CREATE FUNCTION public.current_database() RETURNS name LANGUAGE sql IMMUTABLE AS $$ SELECT 'science_evaluation'::name $$");
  const guard = await pool.query('SELECT current_database() AS effective,pg_catalog.current_database() AS actual');
  assert.equal(guard.rows[0].effective, 'science_evaluation'); assert.equal(guard.rows[0].actual, database);
  await pool.query("CREATE TABLE auth_users(id text PRIMARY KEY,username text NOT NULL UNIQUE); INSERT INTO auth_users VALUES ('admin','admin'),('alice','alice'),('bob','bob')");
  await pool.query('CREATE TABLE eval_questions(id text,dataset_version text,domain_key text,UNIQUE(id,dataset_version))');
  for (const file of ['003_evaluation_runs.sql', '005_mission_daily_plans.sql', '007_daily_evaluation_reports.sql', '008_trial_batch_plans.sql', '011_run_ownership.sql', '012_comparison_groups.sql', '013_batch_schemes.sql']) await pool.query(fs.readFileSync(path.join(__dirname, '../migrations', file), 'utf8'));
  const config = structuredClone(DEFAULT_SCHEME); config.pools = { aviation: 0, synthesis: 3 };
  for (const key of SERVICE_KEYS) config.services[key] = { aviation: 0, synthesis: ['synthesis', 'alpha-rsi'].includes(key) ? 3 : 0 };
  const schemes = createBatchSchemeRepository({ pgPool: pool });
  const scheme = await schemes.save({ id: randomUUID(), name: '并发验证', config, version: 0, userId: 'admin', nightly: true });
  const updates = await Promise.allSettled(['更新甲', '更新乙'].map(name => schemes.save({ id: scheme.id, name, config, version: 1, userId: 'admin', nightly: true })));
  assert.equal(updates.filter(item => item.status === 'fulfilled').length, 1);
  assert.equal(updates.filter(item => item.status === 'rejected' && item.reason.code === 'BATCH_SCHEME_CONFLICT').length, 1);
  const selected = await schemes.nightly(); assert.equal(selected.version, 2);
  const addresses = { synthesis: 'ws://synthesis.invalid', 'alpha-rsi': 'ws://alpha.invalid' };
  let releaseGeneration; const generationGate = new Promise(resolve => { releaseGeneration = resolve; }); let generated = 0;
  const generator = { async generate(input) { await generationGate; return { items: Array.from({ length: input.count }, () => ({ question: `隔离合成测评问题第 ${++generated} 题，请解释材料性能。` })) }; } };
  const evaluator = key => ({ scoreMode: 'none', serviceAddress: addresses[key], async startQuestionRun() { return { run: { id: randomUUID() }, completion: Promise.resolve({ status: 'done' }) }; }, async getRunQuality() { return { status: 'absent' }; } });
  const evaluations = createUnifiedEvaluationService({ repository: createUnifiedEvaluationRepository({ pgPool: pool }), evaluators: { synthesis: evaluator('synthesis'), 'alpha-rsi': evaluator('alpha-rsi') } });
  const trialRepo = createTrialBatchRepository({ pgPool: pool });
  const trial = createTrialBatchService({ repository: trialRepo, evaluations, generator, serviceAddresses: addresses, schemes });
  const manualRepo = createManualBatchRepository({ pgPool: pool, schemes });
  const manual = createManualBatchService({ repository: manualRepo, evaluations, generator, serviceAddresses: addresses, trialService: trial, schemes });
  const request = { config, userId: 'alice', key: 'duplicate-request', schemeId: selected.id, schemeVersion: selected.version };
  const duplicated = await Promise.all([manual.create(request), manual.create(request)]);
  assert.equal(duplicated[0].batchId, duplicated[1].batchId);
  assert.deepEqual(duplicated.map(item => item.reused).sort(), [false, true]);
  await assert.rejects(manual.create({ config, userId: 'bob', key: 'other-request' }), { code: 'BATCH_BUSY' });
  await assert.rejects(trial.prepare('2026-11-04'), /手动测评批次尚未结束/);
  const mission = createMissionDailyRepository({ pgPool: pool });
  const skipped = await mission.create({ date: '2026-11-04', id: randomUUID(), serviceAddress: 'ws://mission.invalid', items: [{ question: '模拟题' }], state: 'dispatching' });
  assert.equal(skipped.state, 'skipped');
  releaseGeneration();
  const batchId = duplicated[0].batchId;
  let finished = 0;
  for (let i = 0; i < 500; i++) {
    finished = (await pool.query('SELECT count(*)::int AS n FROM unified_evaluation_runs WHERE batch_id=$1 AND finished_at IS NOT NULL', [batchId])).rows[0].n;
    if (finished === 6) break;
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  assert.equal(finished, 6);
  assert.equal(generated, 3);
  const pairs = await pool.query(`SELECT comparison_group_id FROM unified_evaluation_runs WHERE batch_id=$1
    GROUP BY comparison_group_id HAVING count(*)=2 AND count(DISTINCT service_key)=2 AND count(DISTINCT question)=1 AND bool_and(owner_user_id='alice')`, [batchId]);
  assert.equal(pairs.rowCount, 3);
  const read = createBatchReadService({ repository: createBatchReadRepository({ pgPool: pool }) });
  assert.equal((await read.get(batchId, 'alice')).batch.planned, 6);
  await assert.rejects(read.get(batchId, 'bob'), { code: 'BATCH_NOT_FOUND' });
  assert.equal((await read.list({ userId: 'alice', source: 'manual' })).total, 1);
  assert.equal((await read.list({ userId: 'bob', source: 'manual' })).total, 0);
  const actualDate = (await manualRepo.get(batchId)).date;
  assert.match(actualDate, /^\d{4}-\d{2}-\d{2}$/);
  assert.equal((await createDailyReportRepository(pool, { trialEnabled: true }).source(actualDate)).runs.length, 0);
  for (let i = 1; i <= 20; i++) {
    const raceDate = `2027-01-${String(i).padStart(2, '0')}`;
    const race = await Promise.allSettled([
      manualRepo.create({ id: randomUUID(), date: raceDate, userId: 'bob', requestKey: `race-${i}`, requestHash: 'hash', configSnapshot: { config }, serviceAddresses: addresses, ruleSnapshot: null }),
      trialRepo.create({ id: randomUUID(), date: raceDate, serviceAddresses: addresses, ruleSnapshot: null, configSnapshot: { config } }),
    ]);
    assert.equal(race.filter(item => item.status === 'fulfilled').length, 1);
    assert.equal(race.filter(item => item.status === 'rejected').length, 1);
    const states = await pool.query(`SELECT (SELECT count(*) FROM evaluation_manual_batch_plans WHERE state IN ('generating','dispatching')) +
      (SELECT count(*) FROM evaluation_trial_batch_plans WHERE state IN ('generating','dispatching')) AS active`);
    assert.equal(Number(states.rows[0].active), 1);
    await pool.query("UPDATE evaluation_manual_batch_plans SET state='failed' WHERE state IN ('generating','dispatching')");
    await pool.query("UPDATE evaluation_trial_batch_plans SET state='failed' WHERE state IN ('generating','dispatching')");
  }
  for (let i = 1; i <= 10; i++) {
    const raceDate = `2027-02-${String(i).padStart(2, '0')}`;
    const race = await Promise.allSettled([
      manualRepo.create({ id: randomUUID(), date: raceDate, userId: 'bob', requestKey: `mission-race-${i}`, requestHash: 'hash', configSnapshot: { config }, serviceAddresses: addresses, ruleSnapshot: null }),
      mission.create({ date: raceDate, id: randomUUID(), serviceAddress: 'ws://mission.invalid', items: [{ question: '模拟题' }], state: 'dispatching' }),
    ]);
    const manualAccepted = race[0].status === 'fulfilled';
    assert.equal(race[1].status, 'fulfilled');
    assert.equal(race[1].value.state, manualAccepted ? 'skipped' : 'dispatching');
    if (!manualAccepted) assert.equal(race[0].reason.code, 'BATCH_BUSY');
    await pool.query("UPDATE evaluation_manual_batch_plans SET state='failed' WHERE state IN ('generating','dispatching')");
    await pool.query("UPDATE evaluation_mission_daily_plans SET state='skipped',reason='隔离测试结束' WHERE state='dispatching'");
  }
  // 完整默认配比只连接本地模拟适配器，真实 PostgreSQL 承载 320 条运行。
  const allAddresses = Object.fromEntries(SERVICE_KEYS.map(key => [key, `ws://${key}.invalid`]));
  let active = 0; let highest = 0; let started = 0; let generatedLarge = 0;
  const byService = new Map(); const maxByService = new Map();
  const allEvaluators = Object.fromEntries(SERVICE_KEYS.map(key => [key, {
    serviceAddress: allAddresses[key], scoreMode: 'none',
    async startQuestionRun() {
      started++; active++; highest = Math.max(highest, active);
      const count = (byService.get(key) || 0) + 1; byService.set(key, count); maxByService.set(key, Math.max(maxByService.get(key) || 0, count));
      return { run: { id: randomUUID() }, completion: new Promise(resolve => setTimeout(() => { active--; byService.set(key, byService.get(key) - 1); resolve({ status: 'done' }); }, 20)) };
    },
    async getRunQuality() { return { status: 'absent' }; },
  }]));
  const allEvaluations = createUnifiedEvaluationService({ repository: createUnifiedEvaluationRepository({ pgPool: pool }), evaluators: allEvaluators, maxActive: 26, maxQueued: 350, serviceLimits: { 'literature-aircraft': 1 } });
  const largeGenerator = { async generate(input) { return { items: Array.from({ length: input.count }, () => ({ question: `隔离材料性能测评问题第 ${++generatedLarge} 题，请给出研究依据。` })) }; } };
  const large = createTrialBatchService({ repository: trialRepo, evaluations: allEvaluations, generator: largeGenerator, serviceAddresses: allAddresses });
  await large.prepare('2027-03-01'); await large.dispatch('2027-03-01');
  const largePlan = await trialRepo.get('2027-03-01'); let completedLarge = 0;
  for (let i = 0; i < 1500; i++) {
    completedLarge = (await pool.query('SELECT count(*)::int AS n FROM unified_evaluation_runs WHERE batch_id=$1 AND finished_at IS NOT NULL', [largePlan.id])).rows[0].n;
    if (completedLarge === 320) break;
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  assert.equal(completedLarge, 320); assert.equal(started, 320); assert.equal(generatedLarge, 100);
  assert.ok(highest <= 26); assert.equal(maxByService.get('literature-aircraft'), 1);
  assert.ok([...maxByService.values()].every(value => value <= 5));
  const groups = await pool.query(`SELECT comparison_group_id FROM unified_evaluation_runs WHERE batch_id=$1 AND comparison_group_id IS NOT NULL
    GROUP BY comparison_group_id HAVING count(*)=2 AND count(DISTINCT service_key)=2 AND count(DISTINCT question)=1`, [largePlan.id]);
  assert.equal(groups.rowCount, 50);
  await large.dispatch('2027-03-01');
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM unified_evaluation_runs WHERE batch_id=$1', [largePlan.id])).rows[0].n, 320);
  const compareOptions = { scope: 'evaluation-user:alice', key: 'pg-comparison-retry' };
  const compareInput = { serviceKeys: ['synthesis', 'alpha-rsi'], question: '请比较新材料的合成路线与性能依据。' };
  const comparisons = await Promise.all(Array.from({ length: 8 }, () => allEvaluations.createComparison(compareInput, compareOptions)));
  assert.equal(new Set(comparisons.map(item => item.runs[0].runId)).size, 1);
  assert.equal(new Set(comparisons.map(item => item.runs[1].runId)).size, 1);
  await assert.rejects(allEvaluations.createComparison({ ...compareInput, serviceKeys: ['alpha-rsi', 'synthesis'] }, compareOptions), { code: 'UNIFIED_EVAL_IDEMPOTENCY_CONFLICT' });
  const compareCount = await pool.query('SELECT count(*)::int AS n FROM unified_evaluation_runs WHERE comparison_group_id=$1', [comparisons[0].groupId]);
  assert.equal(compareCount.rows[0].n, 2);
  for (let i = 0; i < 200; i++) {
    const pending = await pool.query('SELECT count(*)::int AS n FROM unified_evaluation_runs WHERE comparison_group_id=$1 AND finished_at IS NULL', [comparisons[0].groupId]);
    if (!pending.rows[0].n) break;
    await new Promise(resolve => setTimeout(resolve, 20));
    if (i === 199) assert.fail('对比运行未完成');
  }
  t.diagnostic(`320 次运行完成，最高并发 ${highest}；航空文献最高并发 ${maxByService.get('literature-aircraft')}。`);
  t.diagnostic(`本机隔离测试库保留供检查：${database}`);
});
