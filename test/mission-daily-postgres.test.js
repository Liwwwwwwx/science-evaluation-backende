const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { Pool } = require('pg');
const { createMissionDailyRepository } = require('../src/runs/mission-daily.repository');
const { createMissionDailyService } = require('../src/runs/mission-daily.service');
const { createUnifiedEvaluationRepository } = require('../src/runs/unified-evaluation.repository');
const { createUnifiedEvaluationService } = require('../src/runs/unified-evaluation.service');

const socket = process.env.EVALUATION_MISSION_DAILY_TEST_PG_SOCKET || '';
test('隔离 PG：每日计划唯一、10 题快照固定、多实例不重复创建与重启恢复', { skip: !socket }, async t => {
  assert.match(socket, /^\/tmp\/evaluation-auth-pg\.[A-Za-z0-9]+$/);
  const pool = new Pool({ host: socket, port: 55481, database: 'science_admin' }); t.after(() => pool.end());
  for (const name of ['003_evaluation_runs.sql', '005_mission_daily_plans.sql']) await pool.query(fs.readFileSync(path.join(__dirname, '../migrations', name), 'utf8'));
  await pool.query(`CREATE TABLE eval_questions (id text, dataset_version text, question text, source_type text, service_key text,
    criteria jsonb, status text, layer text, created_at timestamptz DEFAULT now())`);
  for (let i = 0; i < 12; i++) await pool.query("INSERT INTO eval_questions VALUES ($1,'v1',$2,$3,NULL,'null'::jsonb,'active',$4,now())", [`q${i}`, `第 ${i} 个材料研发测试问题`, i < 6 ? 'fixed' : 'mission', i < 6 ? 'base' : 'mission']);
  await pool.query("INSERT INTO eval_questions VALUES ('downstream','v1','下游专属题目不应进入主服务计划','fixed','alloy',NULL,'active','base',now())");
  await pool.query("INSERT INTO eval_questions VALUES ('rules','v1','专属规则不能忽略的主服务题目','mission',NULL,'{\"required\":true}'::jsonb,'active','mission',now())");
  const repository = createUnifiedEvaluationRepository({ pgPool: pool });
  const plans = createMissionDailyRepository({ pgPool: pool });
  const calls = []; const completions = [];
  const evaluator = { serviceAddress: 'ws://mission.example/start', scoreMode: 'none', async startQuestionRun({ question }, { onText }) {
    calls.push(question); onText(question);
    const completion = new Promise(resolve => completions.push(resolve));
    return { run: { id: `native-${calls.length}` }, completion };
  } };
  let ruleId = 'frozen-v1';
  const scoring = { snapshotRule: async () => ({ id: ruleId }), pending: () => ({}), async score(_job, publish) { await publish({ scoring: { finishedAt: new Date().toISOString() }, scores: {}, markdownSyntax: {} }); } };
  const makeRun = () => createUnifiedEvaluationService({ repository, evaluators: { 'mission-material': evaluator }, scoring });
  const one = makeRun(); const two = makeRun();
  const makeDaily = evaluations => createMissionDailyService({ repository: plans, evaluations, scoring, serviceAddress: evaluator.serviceAddress, enabled: true, ready: true, now: () => new Date('2026-11-02T14:00:00Z') });
  await Promise.all([makeDaily(one).tick(), makeDaily(two).tick()]);
  const plan = await plans.get('2026-11-02');
  assert.equal(plan.state, 'submitted'); assert.equal(plan.items.length, 10); assert.equal(plan.ruleSnapshot.id, 'frozen-v1');
  assert.ok(plan.items.some(item => item.sourceType === 'mission'));
  assert.ok(plan.items.every(item => item.questionId !== 'downstream'));
  assert.ok(plan.items.every(item => item.questionId !== 'rules'));
  const rows = await pool.query("SELECT * FROM unified_evaluation_runs WHERE service_key='mission-material' AND origin='automation'");
  assert.equal(rows.rowCount, 10); assert.equal(new Set(rows.rows.map(row => row.idempotency_key)).size, 10);
  assert.ok(rows.rows.every(row => row.run.ruleSnapshot.id === 'frozen-v1'));
  await Promise.all([makeDaily(one).tick(), makeDaily(two).tick()]);
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM unified_evaluation_runs')).rows[0].n, 10);
  const otherDay = await plans.create({ date: '2026-11-03', id: require('node:crypto').randomUUID(), serviceAddress: evaluator.serviceAddress, items: [], ruleSnapshot: null, state: 'skipped', reason: 'test' });
  assert.equal(otherDay.date, '2026-11-03');
  // 执行已有排队项，数据库抢占保证两台进程不会发送同一个运行两次。
  await Promise.all([one.recoverQueued(), two.recoverQueued()]);
  for (let i = 0; i < 50 && calls.length < 10; i++) await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(calls.length, 10); assert.equal(new Set(calls).size, 10);
  for (const finish of completions) finish({ status: 'done' });
  let done = false;
  for (let i = 0; i < 100; i++) {
    if ((await pool.query("SELECT count(*)::int AS n FROM unified_evaluation_runs WHERE status='done'")).rows[0].n === 10) { done = true; break; }
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  assert.equal(done, true, '每日运行应完成并写入记录');

  // 创建第三题后模拟进程退出；次日重启只补齐原计划，沿用旧题和旧规则。
  ruleId = 'frozen-v2'; let attempts = 0;
  const interrupted = { async createMissionDailyRun(...args) { if (++attempts === 4) throw Error('模拟进程中断'); return one.createMissionDailyRun(...args); } };
  const later = createMissionDailyService({ repository: plans, evaluations: interrupted, scoring, serviceAddress: evaluator.serviceAddress, enabled: true, ready: true, now: () => new Date('2026-11-04T14:00:00Z') });
  await assert.rejects(later.tick(), /中断/);
  const frozenPlan = await plans.get('2026-11-04');
  assert.equal(frozenPlan.state, 'dispatching');
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM unified_evaluation_runs WHERE batch_id=$1', [frozenPlan.id])).rows[0].n, 3);
  await pool.query("UPDATE eval_questions SET question='题库已变更的新题面'");
  ruleId = 'frozen-v3';
  const restarted = createMissionDailyService({ repository: plans, evaluations: makeRun(), scoring, serviceAddress: evaluator.serviceAddress, enabled: true, ready: true, now: () => new Date('2026-11-05T03:00:00Z') });
  await restarted.tick();
  const resumed = await pool.query('SELECT question,question_id,run FROM unified_evaluation_runs WHERE batch_id=$1', [frozenPlan.id]);
  assert.equal(resumed.rowCount, 10);
  assert.ok(resumed.rows.every(row => row.question === frozenPlan.items.find(item => item.questionId === row.question_id).question));
  assert.ok(resumed.rows.every(row => row.run.ruleSnapshot.id === 'frozen-v2'));
  for (let i = 0; i < 100; i++) {
    for (const finish of completions) finish({ status: 'done' });
    if ((await pool.query("SELECT count(*)::int AS n FROM unified_evaluation_runs WHERE batch_id=$1 AND status='done'", [frozenPlan.id])).rows[0].n === 10) return;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  assert.fail('恢复后的每日运行应全部写入完成状态');
});
