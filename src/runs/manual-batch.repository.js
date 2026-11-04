const { TeamServiceError } = require('../errors');

function createManualBatchRepository({ pgPool, schemes } = {}) {
  async function requireStorage() { if (!await schemes.ready()) throw new TeamServiceError(503, 'BATCH_SCHEMES_NOT_MIGRATED', '手动批次存储尚未迁移'); }
  function map(row) { return row ? { id: row.id, date: String(row.plan_date).slice(0, 10), state: row.state, items: row.items, serviceAddresses: row.service_addresses, ruleSnapshot: row.rule_snapshot, configSnapshot: row.config_snapshot, ownerUserId: row.created_by, error: row.error } : null; }
  return {
    async ownershipReady() { await requireStorage(); const r = await pgPool.query("SELECT EXISTS(SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='unified_evaluation_runs' AND column_name='owner_user_id') AS ready"); return r.rows[0]?.ready === true; },
    async find(userId, key) { await requireStorage(); const r = await pgPool.query('SELECT p.*,p.plan_date::text AS plan_date FROM evaluation_manual_batch_plans p WHERE created_by=$1 AND request_key=$2', [userId, key]); return map(r.rows[0]); },
    async create({ id, date, userId, requestKey, requestHash, configSnapshot, serviceAddresses, ruleSnapshot }) {
      await requireStorage();
      const client = await pgPool.connect();
      try {
        await client.query('BEGIN');
        await client.query("SELECT pg_advisory_xact_lock(hashtext('evaluation-batch-start'))");
        const existing = await client.query('SELECT p.*,p.plan_date::text AS plan_date FROM evaluation_manual_batch_plans p WHERE created_by=$1 AND request_key=$2', [userId, requestKey]);
        if (existing.rows[0]) {
          if (existing.rows[0].request_hash !== requestHash) throw new TeamServiceError(409, 'BATCH_IDEMPOTENCY_CONFLICT', '幂等键已用于不同方案');
          await client.query('COMMIT'); return { plan: map(existing.rows[0]), reused: true };
        }
        const busy = await client.query(`SELECT
          EXISTS(SELECT 1 FROM evaluation_manual_batch_plans WHERE state IN ('generating','dispatching')) OR
          EXISTS(SELECT 1 FROM evaluation_trial_batch_plans WHERE state IN ('generating','dispatching')) OR
          EXISTS(SELECT 1 FROM evaluation_mission_daily_plans WHERE state='dispatching') OR
          EXISTS(SELECT 1 FROM unified_evaluation_runs u WHERE
            (EXISTS(SELECT 1 FROM evaluation_trial_batch_plans t WHERE t.id::text=u.batch_id) OR EXISTS(SELECT 1 FROM evaluation_manual_batch_plans m WHERE m.id::text=u.batch_id) OR EXISTS(SELECT 1 FROM evaluation_mission_daily_plans p WHERE p.id::text=u.batch_id))
            AND (u.status IN ('queued','running','scoring') OR u.finished_at IS NULL OR EXISTS(SELECT 1 FROM jsonb_each(CASE WHEN jsonb_typeof(u.scores)='object' THEN u.scores ELSE '{}'::jsonb END) s WHERE s.value->>'status'='pending'))) AS busy`);
        if (busy.rows[0]?.busy) throw new TeamServiceError(409, 'BATCH_BUSY', '已有批次正在准备、执行或评分，请等待结束');
        const result = await client.query(`INSERT INTO evaluation_manual_batch_plans(id,plan_date,state,service_addresses,rule_snapshot,config_snapshot,created_by,request_key,request_hash)
          VALUES($1,$2::date,'generating',$3::jsonb,$4::jsonb,$5::jsonb,$6,$7,$8) RETURNING *,plan_date::text AS plan_date`, [id, date, JSON.stringify(serviceAddresses), JSON.stringify(ruleSnapshot), JSON.stringify(configSnapshot), userId, requestKey, requestHash]);
        await client.query('COMMIT'); return { plan: map(result.rows[0]), reused: false };
      } catch (error) { await client.query('ROLLBACK'); throw error; } finally { client.release(); }
    },
    async get(id) { await requireStorage(); const r = await pgPool.query('SELECT p.*,p.plan_date::text AS plan_date FROM evaluation_manual_batch_plans p WHERE id=$1', [id]); return map(r.rows[0]); },
    async pending() { if (!await schemes.ready()) return null; const r = await pgPool.query("SELECT p.*,p.plan_date::text AS plan_date FROM evaluation_manual_batch_plans p WHERE state IN ('generating','dispatching') ORDER BY created_at LIMIT 1"); return map(r.rows[0]); },
    async ready(id, items) { const r = await pgPool.query("UPDATE evaluation_manual_batch_plans SET state='dispatching',items=$2::jsonb,updated_at=now() WHERE id=$1 AND state='generating' RETURNING id", [id, JSON.stringify(items)]); return r.rowCount === 1; },
    async fail(id, error) { await pgPool.query("UPDATE evaluation_manual_batch_plans SET state='failed',error=$2,updated_at=now() WHERE id=$1 AND state='generating'", [id, error]); },
    async failExpired(id) { await pgPool.query("UPDATE evaluation_manual_batch_plans SET state='failed',error='出题超时或进程中断，请重新发起',updated_at=now() WHERE id=$1 AND state='generating' AND created_at < now()-interval '2 hours'", [id]); },
    async submitted(id) { await pgPool.query("UPDATE evaluation_manual_batch_plans SET state='submitted',updated_at=now() WHERE id=$1 AND state='dispatching'", [id]); },
  };
}
module.exports = { createManualBatchRepository };
