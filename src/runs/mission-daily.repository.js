function createMissionDailyRepository({ pgPool } = {}) {
  if (!pgPool || typeof pgPool.query !== 'function') throw new Error('必须显式提供测评数据库');
  let verified;
  async function database() {
    if (!verified) verified = pgPool.query('SELECT current_database() AS name').then(result => {
      if (!['science_admin', 'science_evaluation'].includes(result.rows[0]?.name)) throw new Error('每日测评只能使用 science_admin 或 science_evaluation 数据库');
      return pgPool;
    }).catch(error => { verified = null; throw error; });
    return verified;
  }
  const map = row => row ? { date: String(row.plan_date).slice(0, 10), id: row.id, serviceAddress: row.service_address, items: row.items, ruleSnapshot: row.rule_snapshot, state: row.state, reason: row.reason } : null;
  return {
    async selectQuestions(day) {
      const result = await (await database()).query(`SELECT id,dataset_version,question,source_type FROM (
        SELECT DISTINCT ON (id) id,dataset_version,question,source_type,created_at FROM public.eval_questions
        WHERE status='active' AND ((layer='base' AND source_type IN ('fixed','random'))
          OR (layer='mission' AND source_type='mission'))
          AND (service_key IS NULL OR service_key='mission-material') AND (criteria IS NULL OR criteria='null'::jsonb)
        ORDER BY id,created_at DESC,dataset_version DESC
      ) q ORDER BY md5($1::text || ':' || id || ':' || dataset_version),id LIMIT 1000`, [day]);
      return result.rows.filter(row => typeof row.question === 'string' && row.question.trim().length >= 8 && row.question.trim().length <= 500 && typeof row.id === 'string' && row.id.length > 0 && row.id.length <= 200 && typeof row.dataset_version === 'string' && row.dataset_version.length > 0 && row.dataset_version.length <= 200)
        .slice(0, 10).map(row => ({ questionId: row.id, datasetVersion: row.dataset_version, question: row.question.trim(), sourceType: row.source_type }));
    },
    async get(day) {
      const result = await (await database()).query('SELECT p.*,p.plan_date::text AS plan_date FROM public.evaluation_mission_daily_plans p WHERE p.plan_date=$1::date', [day]);
      return map(result.rows[0]);
    },
    async create(plan) {
      const current = await database();
      await current.query(`INSERT INTO public.evaluation_mission_daily_plans(plan_date,id,service_address,items,rule_snapshot,state,reason)
        VALUES ($1::date,$2,$3,$4::jsonb,$5::jsonb,$6,$7) ON CONFLICT (plan_date) DO NOTHING`,
      [plan.date, plan.id, plan.serviceAddress, JSON.stringify(plan.items), plan.ruleSnapshot == null ? null : JSON.stringify(plan.ruleSnapshot), plan.state, plan.reason || null]);
      return this.get(plan.date);
    },
    async markSubmitted(id) {
      await (await database()).query("UPDATE public.evaluation_mission_daily_plans SET state='submitted',updated_at=now() WHERE id=$1 AND state='dispatching'", [id]);
    },
    async pending() {
      const result = await (await database()).query("SELECT p.*,p.plan_date::text AS plan_date FROM public.evaluation_mission_daily_plans p WHERE p.state='dispatching' ORDER BY p.plan_date LIMIT 1");
      return map(result.rows[0]);
    },
    async hasUnfinishedRuns(exceptBatchId = null) {
      const result = await (await database()).query(`SELECT EXISTS(SELECT 1 FROM public.unified_evaluation_runs
        WHERE idempotency_scope='evaluation-automation:mission-material' AND status IN ('queued','running','scoring')
          AND ($1::text IS NULL OR batch_id IS DISTINCT FROM $1)) AS present`, [exceptBatchId]);
      return result.rows[0]?.present === true;
    },
    async latest() {
      const result = await (await database()).query('SELECT p.*,p.plan_date::text AS plan_date FROM public.evaluation_mission_daily_plans p ORDER BY p.plan_date DESC LIMIT 1');
      return map(result.rows[0]);
    },
    async runs(batchId) {
      const result = await (await database()).query(`SELECT id,question_id,dataset_version,status,scores,question FROM public.unified_evaluation_runs
        WHERE batch_id=$1 AND origin='automation' AND service_key='mission-material' ORDER BY started_at,id`, [batchId]);
      return result.rows.map(row => ({ runId: row.id, questionId: row.question_id, datasetVersion: row.dataset_version, question: row.question, status: row.status,
        scores: Object.fromEntries(Object.entries(row.scores || {}).filter(([key]) => ['deepSeekScore', 'qwenScore'].includes(key)).map(([key, value]) => [key, { status: value?.status, total: value?.quality?.total ?? null }])) }));
    },
  };
}
module.exports = { createMissionDailyRepository };
