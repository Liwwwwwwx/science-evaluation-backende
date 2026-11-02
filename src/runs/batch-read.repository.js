function createBatchReadRepository({ pgPool } = {}) {
  if (!pgPool || typeof pgPool.query !== 'function') throw new Error('必须显式提供测评数据库');

  let verified;
  async function database() {
    if (!verified) {
      verified = pgPool.query('SELECT current_database() AS name').then((result) => {
        if (!['science_admin', 'science_evaluation'].includes(result.rows[0]?.name)) throw new Error('批次读取只能使用 science_admin 或 science_evaluation 数据库');
        return pgPool;
      }).catch((error) => { verified = null; throw error; });
    }
    return verified;
  }

  async function available() {
    const result = await (await database()).query("SELECT to_regclass('public.evaluation_trial_batch_plans') IS NOT NULL AS trial, to_regclass('public.evaluation_mission_daily_plans') IS NOT NULL AS mission");
    return { trial: result.rows[0]?.trial === true, mission: result.rows[0]?.mission === true };
  }

  function planSelect(source) {
    if (source === 'trial') {
      return `SELECT 'trial'::text AS source, plan_date, id::text AS id, state, items, rule_snapshot, error, created_at, updated_at
        FROM public.evaluation_trial_batch_plans`;
    }
    return `SELECT 'mission'::text AS source, plan_date, id::text AS id, state, items, rule_snapshot, reason AS error, created_at, updated_at
      FROM public.evaluation_mission_daily_plans`;
  }

  return {
    async plans({ source = 'all', from = '', to = '', limit = 200, offset = 0 } = {}) {
      const tables = await available();
      const sources = source === 'all' ? ['trial', 'mission'] : [source];
      const selected = sources.filter((key) => tables[key]);
      if (!selected.length) return { storageReady: false, items: [] };
      const params = [];
      const where = [];
      if (from) { params.push(from); where.push(`plan_date >= $${params.length}::date`); }
      if (to) { params.push(to); where.push(`plan_date <= $${params.length}::date`); }
      params.push(Math.min(Math.max(Number(limit) || 200, 1), 500));
      const limitParameter = params.length;
      params.push(Math.max(Number(offset) || 0, 0));
      const sql = `SELECT * FROM (${selected.map(planSelect).join(' UNION ALL ')}) plans
        ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
        ORDER BY plan_date DESC, created_at DESC, id DESC LIMIT $${limitParameter} OFFSET $${params.length}`;
      const result = await (await database()).query(sql, params);
      return { storageReady: true, items: result.rows };
    },

    async plan(id) {
      const tables = await available();
      for (const source of ['trial', 'mission']) {
        if (!tables[source]) continue;
        const result = await (await database()).query(`${planSelect(source)} WHERE id::text=$1`, [String(id)]);
        if (result.rows[0]) return { storageReady: true, plan: result.rows[0] };
      }
      return { storageReady: tables.trial || tables.mission, plan: null };
    },

    async previousPlan(source, date) {
      const tables = await available();
      if (!tables[source]) return null;
      const result = await (await database()).query(`${planSelect(source)} WHERE plan_date < $1::date ORDER BY plan_date DESC LIMIT 1`, [String(date)]);
      return result.rows[0] || null;
    },

    async runsByBatchIds(batchIds) {
      if (!batchIds.length) return [];
      const result = await (await database()).query(`SELECT id::text AS id, batch_id, service_key, question_id, dataset_version, question,
        status, error, scores, answer_truncated, started_at, finished_at,
        run->>'elapsedMs' AS elapsed_ms, run->>'status' AS run_status,
        COALESCE(run->'scoring'->'ruleSnapshot', run->'ruleSnapshot') AS rule_snapshot
        FROM public.unified_evaluation_runs
        WHERE origin='automation' AND batch_id = ANY($1::text[])
        ORDER BY started_at, id`, [batchIds.map(String)]);
      return result.rows;
    },
  };
}

module.exports = { createBatchReadRepository };
