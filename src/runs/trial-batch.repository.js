function createTrialBatchRepository({ pgPool } = {}) {
  if (!pgPool || typeof pgPool.query !== 'function') throw new Error('必须显式提供测评数据库');
  let checked;
  async function db() {
    if (!checked) checked = pgPool.query('SELECT current_database() AS name').then(result => {
      if (!['science_admin', 'science_evaluation'].includes(result.rows[0]?.name)) throw new Error('试运行只能使用测评数据库');
      return pgPool;
    }).catch(error => { checked = null; throw error; });
    return checked;
  }
  function map(row) {
    return row ? { date: String(row.plan_date).slice(0, 10), id: row.id, state: row.state, items: row.items,
      serviceAddresses: row.service_addresses, ruleSnapshot: row.rule_snapshot, error: row.error } : null;
  }
  return {
    async get(date) { const r = await (await db()).query('SELECT *,plan_date::text AS plan_date FROM evaluation_trial_batch_plans WHERE plan_date=$1::date', [date]); return map(r.rows[0]); },
    async pending() {
      const r = await (await db()).query("SELECT p.*,p.plan_date::text AS plan_date FROM evaluation_trial_batch_plans p WHERE p.state IN ('generating','dispatching') ORDER BY p.plan_date LIMIT 1");
      return map(r.rows[0]);
    },
    async hasUnfinishedRuns() {
      const r = await (await db()).query(`SELECT EXISTS(SELECT 1 FROM unified_evaluation_runs u
        JOIN evaluation_trial_batch_plans p ON p.id::text=u.batch_id
        WHERE u.origin='automation' AND (u.status IN ('queued','running','scoring') OR u.finished_at IS NULL
          OR EXISTS (SELECT 1 FROM jsonb_each(CASE WHEN jsonb_typeof(u.scores)='object' THEN u.scores ELSE '{}'::jsonb END) score
            WHERE score.value->>'status'='pending'))) AS present`);
      return r.rows[0]?.present === true;
    },
    async recordSkipped({ date, id, reason }) {
      await (await db()).query(`INSERT INTO evaluation_trial_batch_plans(plan_date,id,state,service_addresses,error)
        VALUES ($1::date,$2,'failed','{}'::jsonb,$3) ON CONFLICT (plan_date) DO NOTHING`, [date, id, reason]);
    },
    async create({ date, id, serviceAddresses, ruleSnapshot }) {
      const r = await (await db()).query(`INSERT INTO evaluation_trial_batch_plans(plan_date,id,state,service_addresses,rule_snapshot)
        VALUES ($1::date,$2,'generating',$3::jsonb,$4::jsonb) ON CONFLICT (plan_date) DO NOTHING RETURNING id`,
      [date, id, JSON.stringify(serviceAddresses), JSON.stringify(ruleSnapshot)]);
      return r.rowCount === 1;
    },
    async ready(id, items) {
      const r = await (await db()).query("UPDATE evaluation_trial_batch_plans SET state='dispatching',items=$2::jsonb,updated_at=now() WHERE id=$1 AND state='generating' RETURNING id", [id, JSON.stringify(items)]);
      return r.rowCount === 1;
    },
    async fail(id, error) { await (await db()).query("UPDATE evaluation_trial_batch_plans SET state='failed',error=$2,updated_at=now() WHERE id=$1 AND state='generating'", [id, error]); },
    async failExpiredGeneration(id) { await (await db()).query("UPDATE evaluation_trial_batch_plans SET state='failed',error='题目生成超时或进程中断，请检查后重新安排试运行',updated_at=now() WHERE id=$1 AND state='generating' AND created_at<now()-interval '2 hours'", [id]); },
    async submitted(id) { await (await db()).query("UPDATE evaluation_trial_batch_plans SET state='submitted',updated_at=now() WHERE id=$1 AND state='dispatching'", [id]); },
  };
}
module.exports = { createTrialBatchRepository };
