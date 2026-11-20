const { randomUUID } = require('node:crypto');
const { TeamServiceError } = require('../errors');
const { canManageAccounts } = require('../auth/accounts');
const { validDate } = require('../daily-reports/summary');
const { loadRates, measure } = require('./usage-pricing');

const totals = `count(*)::int AS calls, count(DISTINCT c.evaluation_id)::int AS evaluations,
  sum(input_tokens)::float8 AS "inputTokens", sum(output_tokens)::float8 AS "outputTokens",
  sum(total_tokens)::float8 AS "totalTokens", sum(estimated_cny)::float8 AS "estimatedCny",
  count(*) FILTER (WHERE total_tokens IS NULL OR input_tokens IS NULL OR output_tokens IS NULL)::int AS "missingUsage",
  count(*) FILTER (WHERE estimated_cny IS NULL)::int AS "missingCost"`;

function createScoringUsage(pool, rates = loadRates(process.env.EVALUATION_SCORE_RATES_JSON)) {
  async function start(context, { provider, model, baseUrl }) {
    const id = randomUUID();
    const host = new URL(baseUrl).hostname;
    const at = new Date();
    await pool.query(`INSERT INTO public.evaluation_scoring_calls
      (id,evaluation_id,attempt_id,actor,kind,stage,provider,model,started_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
      [id, context.evaluationId, context.attemptId, context.actor, context.kind, context.stage, provider, model, at]);
    // 调用前持久化；中断、响应不含 usage 或进程退出时仍可查到这笔待确认用量。
    return async data => {
      const actualModel = typeof data?.model === 'string' && data.model.length <= 200 && data.model ? data.model : model;
      const m = measure(data?.usage, host, actualModel, model, rates, at);
      const sql = `UPDATE public.evaluation_scoring_calls SET model=$2, input_tokens=$3, output_tokens=$4,
        cached_tokens=$5,total_tokens=$6,rate_snapshot=$7,estimated_cny=$8 WHERE id=$1`;
      const args = [id, actualModel, m.input, m.output, m.cached, m.total, m.rate, m.cost];
      try { await pool.query(sql, args); }
      catch {
        // 同一明细覆写可安全重试，数据库写失败不应触发重复的付费模型请求。
        try { await pool.query(sql, args); }
        catch { console.error('评分用量回写失败，已保留未确认记录', id); }
      }
    };
  }

  async function report(user, params) {
    if (!canManageAccounts(user)) throw new TeamServiceError(403, 'FORBIDDEN', '仅管理员可以查看评分用量');
    const from = params.get('from'), to = params.get('to'), actor = params.get('actor');
    const page = Number(params.get('page') ?? 1);
    if ((from && !validDate(from)) || (to && !validDate(to)) || (from && to && from > to) ||
        (actor !== null && (!actor || actor.length > 300)) || !Number.isSafeInteger(page) || page < 1 || page > 1000000) {
      throw new TeamServiceError(400, 'INVALID_INPUT', '日期或分页参数无效');
    }
    const args = [], where = [];
    if (from) { args.push(from); where.push(`c.started_at >= ($${args.length}::date::timestamp AT TIME ZONE 'Asia/Shanghai')`); }
    if (to) { args.push(to); where.push(`c.started_at < (($${args.length}::date + 1)::timestamp AT TIME ZONE 'Asia/Shanghai')`); }
    if (actor) { args.push(actor); where.push(`c.actor=$${args.length}`); }
    const filter = where.length ? ' WHERE ' + where.join(' AND ') : '';
    const group = actor
      ? `SELECT c.evaluation_id AS "evaluationId", max(r.service_key) AS "serviceKey", max(r.batch_id) AS "batchId",
          bool_or(c.kind='direct') AS direct, count(DISTINCT c.attempt_id)::int AS rounds,
          bool_or(c.kind='rescore') AS rescored, max(c.started_at) AS "lastUsed", ${totals}
        FROM public.evaluation_scoring_calls c LEFT JOIN public.unified_evaluation_runs r ON r.id=c.evaluation_id AND c.kind<>'direct'
        ${filter} GROUP BY c.evaluation_id`
      : `SELECT c.actor, u.username, u.display_name AS "displayName", ${totals}
        FROM public.evaluation_scoring_calls c LEFT JOIN public.auth_users u ON c.actor='evaluation-user:' || u.id
        ${filter} GROUP BY c.actor,u.username,u.display_name`;
    const order = actor ? '"lastUsed" DESC, "evaluationId"' : '"estimatedCny" DESC NULLS LAST, actor';
    args.push((page - 1) * 25);
    try {
      const result = await pool.query(`WITH grouped AS (${group}), page AS
        (SELECT * FROM grouped ORDER BY ${order} LIMIT 25 OFFSET $${args.length})
        SELECT page.*, n.total FROM (SELECT count(*)::int AS total FROM grouped) n LEFT JOIN page ON true
        ORDER BY ${order}`, args);
      return { page, pageSize: 25, total: result.rows[0].total, items: result.rows.filter(r => r.calls != null).map(({ total, ...item }) => item) };
    } catch (error) {
      if (error.code === '42P01') throw new TeamServiceError(503, 'USAGE_UNAVAILABLE', '评分用量存储尚未迁移');
      throw error;
    }
  }

  async function byBatch(batchIds, userId) {
    if (!batchIds.length) return new Map();
    try {
      const { rows } = await pool.query(`SELECT r.batch_id, ${totals}
        FROM public.unified_evaluation_runs r JOIN public.evaluation_scoring_calls c ON c.evaluation_id=r.id AND c.kind<>'direct'
        WHERE r.batch_id=ANY($1::text[]) AND (r.origin='automation' OR (r.origin='manual' AND r.owner_user_id=$2))
        GROUP BY r.batch_id`, [batchIds, userId]);
      return new Map(rows.map(({ batch_id, ...usage }) => [batch_id, usage]));
    } catch (error) {
      if (['42P01','42703'].includes(error.code)) return new Map();
      throw error;
    }
  }
  async function byRun(runId) {
    try {
      const { rows } = await pool.query(`SELECT ${totals} FROM public.evaluation_scoring_calls c
        WHERE evaluation_id=$1 AND kind<>'direct'`, [runId]);
      return rows[0].calls ? rows[0] : null;
    } catch (error) {
      if (error.code === '42P01') return null;
      throw error;
    }
  }
  return { start, report, byBatch, byRun };
}
module.exports = { createScoringUsage };
