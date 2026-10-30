function scoreSummary(scores) {
  return Object.fromEntries(Object.entries(scores || {}).filter(([key]) => ['deepSeekScore','qwenScore','quality'].includes(key)).map(([key, value]) => [key, { status: value?.status, model: value?.model, total: value?.quality?.total ?? null, taskStatus: value?.quality?.taskCompletion?.status || null, provisional: value?.quality?.source?.truncated === true }]));
}
function date(value) { return value ? new Date(value).toISOString() : null; }
function map(row) {
  if (!row) return null;
  return {
    runId: row.id, serviceKey: row.service_key, origin: row.origin, nativeRunId: row.native_run_id,
    question: row.question, questionId: row.question_id, datasetVersion: row.dataset_version,
    questionSourceType: row.question_source_type, batchId: row.batch_id,
    status: row.status, answer: row.answer, answerTruncated: row.answer_truncated === true,
    run: row.run, scores: row.scores, scoreError: row.score_error, error: row.error,
    startedAt: date(row.started_at), finishedAt: date(row.finished_at), updatedAt: date(row.updated_at),
  };
}
function createUnifiedEvaluationRepository({ pgPool } = {}) {
  if (!pgPool || typeof pgPool.query !== 'function') throw new Error('必须显式提供运行记录数据库连接');
  const pool = () => pgPool;
  let verified;
  async function adminPool() {
    const current = pool();
    if (!verified) verified = current.query('SELECT current_database() AS name').then((result) => {
      if (result.rows[0]?.name !== 'science_admin') throw new Error('统一评测记录只能使用 science_admin 数据库');
      return current;
    }).catch((error) => { verified = null; throw error; });
    return verified;
  }
  return {
    async create(job) {
      await (await adminPool()).query(`INSERT INTO public.unified_evaluation_runs
        (id, service_key, origin, question, question_id, dataset_version, question_source_type, batch_id, status, started_at)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
      [job.runId, job.serviceKey, job.origin, job.question, job.questionId, job.datasetVersion, job.questionSourceType, job.batchId, job.status, job.startedAt]);
    },
    async createIdempotent(job, scope, key, hash) {
      const current = await adminPool();
      const result = await current.query(`INSERT INTO public.unified_evaluation_runs
        (id, service_key, origin, question, question_id, dataset_version, question_source_type, batch_id, status, started_at,
         idempotency_scope, idempotency_key, idempotency_hash)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
        ON CONFLICT (idempotency_scope, idempotency_key) WHERE idempotency_key IS NOT NULL DO NOTHING RETURNING id`,
      [job.runId, job.serviceKey, job.origin, job.question, job.questionId, job.datasetVersion, job.questionSourceType, job.batchId, job.status, job.startedAt, scope, key, hash]);
      if (result.rowCount === 1) return { created: true, runId: job.runId };
      const existing = await current.query('SELECT id, idempotency_hash FROM public.unified_evaluation_runs WHERE idempotency_scope=$1 AND idempotency_key=$2', [scope, key]);
      if (!existing.rows[0]) throw new Error('无法读取幂等运行');
      return { created: false, runId: existing.rows[0].id, matches: existing.rows[0].idempotency_hash === hash };
    },
    async findIdempotent(scope, key) {
      const result = await (await adminPool()).query('SELECT id, idempotency_hash FROM public.unified_evaluation_runs WHERE idempotency_scope=$1 AND idempotency_key=$2', [scope, key]);
      return result.rows[0] ? { runId: result.rows[0].id, hash: result.rows[0].idempotency_hash } : null;
    },
    async save(job) {
      const result = await (await adminPool()).query(`UPDATE public.unified_evaluation_runs SET native_run_id=$2, status=$3, answer=$4,
        answer_truncated=$5, run=$6, scores=$7, score_error=$8, error=$9, finished_at=$10, updated_at=now()
        WHERE id=$1`, [job.runId, job.nativeRunId, job.status, job.answer, job.answerTruncated,
        job.run, job.scores, job.scoreError, job.error, job.finishedAt]);
      if (result.rowCount !== 1) throw new Error('统一测评记录不存在');
    },
    async get(id) {
      const result = await (await adminPool()).query('SELECT * FROM public.unified_evaluation_runs WHERE id=$1', [id]);
      return map(result.rows[0]);
    },
    async refreshScores(id, scores, scoreError, status) {
      const result = await (await adminPool()).query(`UPDATE public.unified_evaluation_runs
        SET scores=$2, score_error=$3, status=$4, updated_at=now()
        WHERE id=$1 AND status='scoring' RETURNING *`, [id, scores, scoreError, status]);
      return map(result.rows[0]);
    },
    async claimScoring(id, previousId, scoring, scores) {
      const result = await (await adminPool()).query(`UPDATE public.unified_evaluation_runs
        SET run=jsonb_set(coalesce(run,'{}'::jsonb),'{scoring}',$3::jsonb),scores=$4,score_error=NULL,status=CASE WHEN run->>'status'='error' THEN 'error' ELSE 'scoring' END,updated_at=now()
        WHERE id=$1 AND run->'scoring'->>'attemptId' IS NOT DISTINCT FROM $2::text AND status IN ('done','error','scoring') RETURNING id`, [id, previousId, scoring, scores]);
      return result.rowCount === 1;
    },
    async updateScoring(id, attemptId, value) {
      const result = await (await adminPool()).query(`UPDATE public.unified_evaluation_runs
        SET run=jsonb_set(jsonb_set(coalesce(run,'{}'::jsonb),'{scoring}',$3::jsonb),'{markdownSyntax}',$4::jsonb),scores=$5,score_error=NULL,status=$6,updated_at=now()
        WHERE id=$1 AND run->'scoring'->>'attemptId'=$2 RETURNING id`, [id, attemptId, value.scoring, value.markdownSyntax, value.scores, value.status]);
      return result.rowCount === 1;
    },
    async questionScores(items) {
      if (!items.length) return [];
      const result = await (await adminPool()).query(`SELECT DISTINCT ON (r.question_id,r.dataset_version,r.service_key)
        r.id,r.question_id,r.dataset_version,r.service_key,r.scores,r.started_at,r.status
        FROM public.unified_evaluation_runs r JOIN jsonb_to_recordset($1::jsonb) AS q(id text,"datasetVersion" text)
        ON r.question_id=q.id AND r.dataset_version=q."datasetVersion"
        ORDER BY r.question_id,r.dataset_version,r.service_key,r.started_at DESC,r.id DESC`, [JSON.stringify(items)]);
      return result.rows.map(row => ({ runId: row.id, questionId: row.question_id, datasetVersion: row.dataset_version, serviceKey: row.service_key, status: row.status, startedAt: date(row.started_at), scores: scoreSummary(row.scores) }));
    },
    async list({ origin = null, page = 1, pageSize = 20 } = {}) {
      const requestedPage = Number(page);
      const requestedSize = Number(pageSize);
      const safePage = Number.isInteger(requestedPage) && requestedPage > 0 ? Math.min(requestedPage, 100000) : 1;
      const safeSize = Number.isInteger(requestedSize) && requestedSize > 0 ? Math.min(requestedSize, 100) : 20;
      const params = [origin];
      const current = await adminPool();
      const count = await current.query('SELECT count(*)::int AS total FROM public.unified_evaluation_runs WHERE ($1::text IS NULL OR origin=$1)', params);
      const result = await current.query(`SELECT id, service_key, origin, question, question_id, dataset_version, question_source_type,
        batch_id, status, scores, started_at, finished_at FROM public.unified_evaluation_runs WHERE ($1::text IS NULL OR origin=$1)
        ORDER BY started_at DESC, id DESC LIMIT $2 OFFSET $3`, [origin, safeSize, (safePage - 1) * safeSize]);
      return { items: result.rows.map(row => ({ ...map(row), scores: scoreSummary(row.scores) })), total: count.rows[0].total, page: safePage, pageSize: safeSize };
    },
  };
}
module.exports = { createUnifiedEvaluationRepository };
