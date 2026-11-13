const { scoreProjection } = require('./score-projection');
function createBatchReadRepository({ pgPool } = {}) {
  if (!pgPool || typeof pgPool.query !== 'function') throw new Error('必须显式提供测评数据库');

  let verified;
  let hasComparisonColumn = false;
  let hasOwnerColumn = false;
  async function database() {
    if (!verified) {
      verified = pgPool.query(`SELECT current_database() AS name,
        EXISTS (SELECT 1 FROM pg_attribute WHERE attrelid=to_regclass('public.unified_evaluation_runs') AND attname='comparison_group_id' AND attnum>0 AND NOT attisdropped) AS has_comparison,
        EXISTS (SELECT 1 FROM pg_attribute WHERE attrelid=to_regclass('public.unified_evaluation_runs') AND attname='owner_user_id' AND attnum>0 AND NOT attisdropped) AS has_owner`).then((result) => {
        if (!['science_admin', 'science_evaluation'].includes(result.rows[0]?.name)) throw new Error('批次读取只能使用 science_admin 或 science_evaluation 数据库');
        hasComparisonColumn = result.rows[0]?.has_comparison === true;
        hasOwnerColumn = result.rows[0]?.has_owner === true;
        return pgPool;
      }).catch((error) => { verified = null; throw error; });
    }
    return verified;
  }

  async function available() {
    const result = await (await database()).query("SELECT to_regclass('public.evaluation_trial_batch_plans') IS NOT NULL AS trial, to_regclass('public.evaluation_mission_daily_plans') IS NOT NULL AS mission, to_regclass('public.evaluation_manual_batch_plans') IS NOT NULL AS manual");
    return { trial: result.rows[0]?.trial === true, mission: result.rows[0]?.mission === true, manual: result.rows[0]?.manual === true };
  }

  function planSelect(source) {
    if (source === 'manual') return `SELECT 'manual'::text AS source, plan_date, plan_date::text AS calendar_date, id::text AS id, state, items, rule_snapshot, error, created_at, updated_at, config_snapshot FROM public.evaluation_manual_batch_plans WHERE created_by=$1`;
    if (source === 'trial') {
      return `SELECT 'trial'::text AS source, plan_date, plan_date::text AS calendar_date, id::text AS id, state, items, rule_snapshot, error, created_at, updated_at, to_jsonb(evaluation_trial_batch_plans)->'config_snapshot' AS config_snapshot
        FROM public.evaluation_trial_batch_plans`;
    }
    return `SELECT 'mission'::text AS source, plan_date, plan_date::text AS calendar_date, id::text AS id, state, items, rule_snapshot, reason AS error, created_at, updated_at, NULL::jsonb AS config_snapshot
      FROM public.evaluation_mission_daily_plans`;
  }

  return {
    async plans({ source = 'all', from = '', to = '', limit = 200, offset = 0, userId = null } = {}) {
      const tables = await available();
      const sources = source === 'all' ? ['trial', 'mission', 'manual'] : source === 'nightly' ? ['trial', 'mission'] : [source];
      const selected = sources.filter((key) => tables[key]);
      if (!selected.length) return { storageReady: false, items: [] };
      const params = selected.includes('manual') ? [String(userId || '')] : [];
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

    // 无状态筛选时，先在数据库确定页码与总数，避免读取其他页的运行记录。
    async pagePlans({ source = 'all', from = '', to = '', schemeId = '', limit = 20, offset = 0, userId = null } = {}) {
      const tables = await available();
      const sources = source === 'all' ? ['trial', 'mission', 'manual'] : source === 'nightly' ? ['trial', 'mission'] : [source];
      const selected = sources.filter(key => tables[key]);
      if (!selected.length) return { storageReady: false, items: [], total: 0 };
      const params = selected.includes('manual') ? [String(userId || '')] : [];
      const where = [];
      if (from) { params.push(from); where.push(`plan_date >= $${params.length}::date`); }
      if (to) { params.push(to); where.push(`plan_date <= $${params.length}::date`); }
      if (schemeId) { params.push(schemeId); where.push(`config_snapshot->'scheme'->>'id' = $${params.length}`); }
      params.push(Math.min(Math.max(Number(limit) || 20, 1), 100)); const limitIndex = params.length;
      params.push(Math.max(Number(offset) || 0, 0)); const offsetIndex = params.length;
      const sql = `WITH filtered AS MATERIALIZED (
        SELECT * FROM (${selected.map(planSelect).join(' UNION ALL ')}) plans ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
      ), page AS (
          SELECT source,plan_date,calendar_date,id,state,error,created_at,updated_at,config_snapshot,
            CASE WHEN jsonb_typeof(items)='array' THEN jsonb_array_length(items) ELSE NULL END AS item_count,
            CASE WHEN jsonb_typeof(items)='object' THEN (SELECT jsonb_object_agg(entry.key, CASE WHEN jsonb_typeof(entry.value)='array' THEN jsonb_array_length(entry.value) ELSE NULL END) FROM jsonb_each(items) entry) ELSE NULL END AS item_counts
          FROM filtered ORDER BY plan_date DESC,created_at DESC,id DESC LIMIT $${limitIndex} OFFSET $${offsetIndex}
      ) SELECT counts.total,page.* FROM (SELECT count(*)::int AS total FROM filtered) counts
        LEFT JOIN page ON true ORDER BY page.plan_date DESC,page.created_at DESC,page.id DESC`;
      const result = await (await database()).query(sql, params);
      return { storageReady: true, items: result.rows.filter(row => row.id != null).map(({ total, ...row }) => row), total: result.rows[0]?.total || 0 };
    },

    async plan(id, userId = null) {
      const tables = await available();
      for (const source of ['trial', 'mission', 'manual']) {
        if (!tables[source]) continue;
        const result = source === 'manual'
          ? await (await database()).query(`${planSelect(source)} AND id::text=$2`, [String(userId || ''), String(id)])
          : await (await database()).query(`${planSelect(source)} WHERE id::text=$1`, [String(id)]);
        if (result.rows[0]) return { storageReady: true, plan: result.rows[0] };
      }
      return { storageReady: tables.trial || tables.mission || tables.manual, plan: null };
    },

    async previousPlan(source, date, userId = null) {
      const tables = await available();
      if (!tables[source]) return null;
      const result = source === 'manual'
        ? await (await database()).query(`${planSelect(source)} AND plan_date < $2::date ORDER BY plan_date DESC LIMIT 1`, [String(userId || ''), String(date)])
        : await (await database()).query(`${planSelect(source)} WHERE plan_date < $1::date ORDER BY plan_date DESC LIMIT 1`, [String(date)]);
      return result.rows[0] || null;
    },

    async runsByBatchIds(batchIds, userId = null) {
      if (!batchIds.length) return [];
      const current = await database();
      const comparison = hasComparisonColumn ? 'comparison_group_id' : "to_jsonb(unified_evaluation_runs)->>'comparison_group_id'";
      const owner = hasOwnerColumn ? 'owner_user_id' : "to_jsonb(unified_evaluation_runs)->>'owner_user_id'";
      const result = await current.query(`SELECT id::text AS id, batch_id, service_key, question_id, dataset_version, question,
        status, error, ${scoreProjection('scores')} AS scores, answer_truncated, started_at, finished_at, ${comparison} AS comparison_group_id,
        run->>'elapsedMs' AS elapsed_ms, run->>'status' AS run_status, run->>'questionKind' AS question_kind,
        jsonb_build_object('hash', COALESCE(run->'scoring'->'ruleSnapshot', run->'ruleSnapshot')->'hash') AS rule_snapshot
        FROM public.unified_evaluation_runs
        WHERE (origin='automation' OR (origin='manual' AND ${owner}=$2)) AND batch_id = ANY($1::text[])
        ORDER BY started_at, id`, [batchIds.map(String), String(userId || '')]);
      return result.rows;
    },

    // 只传输列表汇总所需的状态和评分字段，详情页仍使用完整运行读取。
    async summariesByBatchIds(batchIds, userId = null) {
      if (!batchIds.length) return [];
      const current = await database();
      const owner = hasOwnerColumn ? 'owner_user_id' : "to_jsonb(unified_evaluation_runs)->>'owner_user_id'";
      const judge = key => `jsonb_typeof(scores)='object' AND scores ? '${key}', scores #> '{${key},status}', scores #> '{${key},model}', scores #> '{${key},quality,total}', scores #> '{${key},quality,source,truncated}'`;
      const result = await current.query(`SELECT batch_id, jsonb_agg(jsonb_build_array(
        status, run->>'status', COALESCE(error,'') ~* '(超时|timeout)', answer_truncated,
        ${judge('deepSeekScore')}, ${judge('qwenScore')}
      ) ORDER BY started_at,id) AS entries FROM public.unified_evaluation_runs
      WHERE (origin='automation' OR (origin='manual' AND ${owner}=$2)) AND batch_id=ANY($1::text[])
      GROUP BY batch_id`, [batchIds.map(String), String(userId || '')]);
      return result.rows;
    },
  };
}

module.exports = { createBatchReadRepository };
