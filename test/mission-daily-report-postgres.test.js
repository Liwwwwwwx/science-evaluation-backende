const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { Pool } = require('pg');
const { createMissionDailyReportRepository } = require('../src/notifications/mission-daily-report.repository');
const { createMissionDailyReportService } = require('../src/notifications/mission-daily-report.service');

const socket = process.env.EVALUATION_MISSION_DAILY_REPORT_TEST_PG_SOCKET || '';
test('隔离 PG：多实例通知仅发送一次，发送结果不确定时不重发', { skip: !socket }, async t => {
  assert.match(socket, /^\/tmp\/evaluation-auth-pg\.[A-Za-z0-9]+$/);
  const pool = new Pool({ host: socket, port: 55481, database: 'science_admin' }); t.after(() => pool.end());
  for (const name of ['003_evaluation_runs.sql', '005_mission_daily_plans.sql', '006_mission_daily_notifications.sql']) {
    await pool.query(fs.readFileSync(path.join(__dirname, '../migrations', name), 'utf8'));
  }
  const planId = randomUUID();
  const items = [{ questionId: 'q1', datasetVersion: 'v1' }];
  await pool.query("INSERT INTO evaluation_mission_daily_plans(plan_date,id,service_address,items,state) VALUES ('2026-11-02',$1,'ws://example.test/start',$2,'submitted')", [planId, JSON.stringify(items)]);
  await pool.query("INSERT INTO unified_evaluation_runs(id,service_key,origin,question,question_id,dataset_version,batch_id,status,started_at,finished_at,scores) VALUES ($1,'mission-material','automation','材料测试题目','q1','v1',$2,'done',now(),now(),$3)", [randomUUID(), planId, JSON.stringify({ deepSeekScore: { status: 'ready', quality: { total: 85 } } })]);
  let calls = 0;
  const notifier = { configured: true, async sendText() { calls++; await new Promise(resolve => setTimeout(resolve, 10)); return { sent: true }; } };
  const repository = createMissionDailyReportRepository({ pgPool: pool });
  const make = () => createMissionDailyReportService({ repository, notifier, enabled: true, ready: true });
  await Promise.all([make().tick(), make().tick()]);
  assert.equal(calls, 1); assert.equal((await repository.status(planId)).state, 'sent');
  await make().tick(); assert.equal(calls, 1);

  const nextPlan = randomUUID();
  await pool.query("INSERT INTO evaluation_mission_daily_plans(plan_date,id,service_address,items,state,reason) VALUES ('2026-11-03',$1,'ws://example.test/start','[]','skipped','上一轮未结束')", [nextPlan]);
  const uncertain = { configured: true, async sendText() { calls++; return { sent: false, reason: 'request-failed' }; } };
  await createMissionDailyReportService({ repository, notifier: uncertain, enabled: true, ready: true }).tick();
  assert.equal((await repository.status(nextPlan)).state, 'unknown');
  await createMissionDailyReportService({ repository, notifier: uncertain, enabled: true, ready: true }).tick();
  assert.equal(calls, 2);
});
