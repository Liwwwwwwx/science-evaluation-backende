function createMissionDailyReportRepository({ pgPool } = {}) {
  if (!pgPool || typeof pgPool.query !== 'function') throw new Error('每日通知依赖测评数据库');
  let verified;
  async function database() {
    if (!verified) verified = pgPool.query('SELECT current_database() AS name').then(result => {
      if (!['science_admin', 'science_evaluation'].includes(result.rows[0]?.name)) throw new Error('每日通知只能使用 science_admin 或 science_evaluation 数据库');
      return pgPool;
    }).catch(error => { verified = null; throw error; });
    return verified;
  }
  return {
    async candidates() {
      const result = await (await database()).query(`SELECT p.id,p.plan_date::text AS date,p.state,p.reason,p.items
        FROM public.evaluation_mission_daily_plans p LEFT JOIN public.evaluation_mission_daily_notifications n ON n.plan_id=p.id
        WHERE n.plan_id IS NULL AND p.state IN ('submitted','empty','skipped')
          AND p.created_at >= now() - interval '48 hours' ORDER BY p.plan_date DESC LIMIT 500`);
      return result.rows;
    },
    async runs(batchId) {
      const result = await (await database()).query(`SELECT id,question_id,dataset_version,status,finished_at,scores FROM public.unified_evaluation_runs
        WHERE batch_id=$1 AND origin='automation' AND service_key='mission-material' ORDER BY started_at,id`, [batchId]);
      return result.rows.map(row => ({ id: row.id, questionId: row.question_id, datasetVersion: row.dataset_version,
        status: row.status, finishedAt: row.finished_at, scores: row.scores || {} }));
    },
    async claim(planId) {
      const result = await (await database()).query(`INSERT INTO public.evaluation_mission_daily_notifications(plan_id,state)
        VALUES ($1,'sending') ON CONFLICT (plan_id) DO NOTHING RETURNING plan_id`, [planId]);
      return result.rowCount === 1;
    },
    async finish(planId, state, reason) {
      await (await database()).query(`UPDATE public.evaluation_mission_daily_notifications SET state=$2,reason=$3,updated_at=now()
        WHERE plan_id=$1 AND state='sending'`, [planId, state, reason || null]);
    },
    async status(planId) {
      const result = await (await database()).query('SELECT state,reason,updated_at FROM public.evaluation_mission_daily_notifications WHERE plan_id=$1', [planId]);
      const row = result.rows[0];
      return row ? { state: row.state, reason: row.reason, updatedAt: row.updated_at } : null;
    },
  };
}
module.exports = { createMissionDailyReportRepository };
