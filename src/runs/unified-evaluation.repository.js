const { TeamServiceError } = require('../errors');
const { scoreProjection } = require('./score-projection');
function scoreSummary(scores) {
  return Object.fromEntries(Object.entries(scores || {}).filter(([key]) => ['deepSeekScore','qwenScore','quality'].includes(key)).map(([key, value]) => [key, { status: value?.status, model: value?.model, total: value?.quality?.total ?? null, taskStatus: value?.quality?.taskCompletion?.status || null, provisional: value?.quality?.source?.truncated === true }]));
}
function date(value) { return value ? new Date(value).toISOString() : null; }
function insertSql(columns) { return `(${columns.join(',')}) VALUES (${columns.map((_, index) => `$${index + 1}`).join(',')})`; }
function ownerFromScope(scope) {
  return typeof scope === 'string' && scope.startsWith('evaluation-user:') ? scope.slice('evaluation-user:'.length) || null : null;
}
function map(row) {
  if (!row) return null;
  return {
    runId: row.id, serviceKey: row.service_key, origin: row.origin, nativeRunId: row.native_run_id,
    question: row.question, questionId: row.question_id, datasetVersion: row.dataset_version,
    questionSourceType: row.question_source_type, batchId: row.batch_id, comparisonGroupId: row.comparison_group_id,
    status: row.status, answer: row.answer, answerTruncated: row.answer_truncated === true,
    run: row.run, scores: row.scores, scoreError: row.score_error, error: row.error,
    startedAt: date(row.started_at), finishedAt: date(row.finished_at), updatedAt: date(row.updated_at),
    outputClearedAt: row.output_cleared_at || row.run?.outputClearedAt || null,
  };
}
function createUnifiedEvaluationRepository({ pgPool } = {}) {
  if (!pgPool || typeof pgPool.query !== 'function') throw new Error('必须显式提供运行记录数据库连接');
  const pool = () => pgPool;
  let verified;
  let hasComparisonColumn = false;
  async function adminPool() {
    const current = pool();
    if (!verified) verified = current.query(`SELECT current_database() AS name,
      EXISTS (SELECT 1 FROM pg_attribute WHERE attrelid=to_regclass('public.unified_evaluation_runs') AND attname='comparison_group_id' AND attnum>0 AND NOT attisdropped) AS has_comparison`).then((result) => {
      if (!['science_admin', 'science_evaluation'].includes(result.rows[0]?.name)) throw new Error('统一评测记录只能使用 science_admin 或 science_evaluation 数据库');
      hasComparisonColumn = result.rows[0]?.has_comparison === true;
      return current;
    }).catch((error) => { verified = null; throw error; });
    return verified;
  }
  return {
    async create(job) {
      const withGroup = job.comparisonGroupId != null;
      const columns = ['id', 'service_key', 'origin', 'question', 'question_id', 'dataset_version', 'question_source_type', 'batch_id',
        ...(withGroup ? ['comparison_group_id'] : []), 'status', 'started_at', 'run'];
      await (await adminPool()).query(`INSERT INTO public.unified_evaluation_runs ${insertSql(columns)}`,
      [job.runId, job.serviceKey, job.origin, job.question, job.questionId, job.datasetVersion, job.questionSourceType, job.batchId,
        ...(withGroup ? [job.comparisonGroupId] : []), job.status, job.startedAt, job.run]);
    },
    async createIdempotent(job, scope, key, hash) {
      const current = await adminPool();
      const withGroup = job.comparisonGroupId != null;
      const columns = ['id', 'service_key', 'origin', 'question', 'question_id', 'dataset_version', 'question_source_type', 'batch_id',
        ...(withGroup ? ['comparison_group_id'] : []), 'status', 'started_at', 'idempotency_scope', 'idempotency_key', 'idempotency_hash', 'run', 'owner_user_id'];
      const result = await current.query(`INSERT INTO public.unified_evaluation_runs ${insertSql(columns)}
        ON CONFLICT (idempotency_scope, idempotency_key) WHERE idempotency_key IS NOT NULL DO NOTHING RETURNING id`,
      [job.runId, job.serviceKey, job.origin, job.question, job.questionId, job.datasetVersion, job.questionSourceType, job.batchId,
        ...(withGroup ? [job.comparisonGroupId] : []), job.status, job.startedAt, scope, key, hash, job.run, ownerFromScope(scope)]);
      if (result.rowCount === 1) return { created: true, runId: job.runId };
      const existing = await current.query("SELECT id, idempotency_hash FROM public.unified_evaluation_runs WHERE idempotency_scope=$1 AND idempotency_key=$2 AND (origin='automation' OR owner_user_id=$3)", [scope, key, ownerFromScope(scope)]);
      if (!existing.rows[0]) throw new TeamServiceError(409, 'UNIFIED_EVAL_IDEMPOTENCY_CONFLICT', '该请求标识不可用，请使用新请求');
      return { created: false, runId: existing.rows[0].id, matches: existing.rows[0].idempotency_hash === hash };
    },
    async findIdempotent(scope, key) {
      const result = await (await adminPool()).query("SELECT id, idempotency_hash FROM public.unified_evaluation_runs WHERE idempotency_scope=$1 AND idempotency_key=$2 AND (origin='automation' OR owner_user_id=$3)", [scope, key, ownerFromScope(scope)]);
      return result.rows[0] ? { runId: result.rows[0].id, hash: result.rows[0].idempotency_hash } : null;
    },
    async createRerun(job, scope, key, hash, previousId, requestHash) {
      const client = await (await adminPool()).connect();
      try {
        await client.query('BEGIN');
        const previous = (await client.query('SELECT * FROM public.unified_evaluation_runs WHERE id=$1 FOR UPDATE', [previousId])).rows[0];
        if (!previous) throw new TeamServiceError(404, 'NOT_FOUND', '原运行不存在');
        if (!ownerFromScope(scope) || previous.owner_user_id !== ownerFromScope(scope)) throw new TeamServiceError(404, 'NOT_FOUND', '原运行不存在');
        if (previous.run?.outputClearedAt) {
          if (previous.run.rerunRequestHash === requestHash) { await client.query('COMMIT'); return { created: false, runId: previous.run.replacementRunId, matches: true }; }
          throw new TeamServiceError(409, 'RUN_ALREADY_RERUN', '此记录的输出已清除，请查看新一轮运行');
        }
        const lease = previous.run?.scoring;
        const expired = lease && !lease.finishedAt && Date.parse(lease.expiresAt) <= Date.now();
        if (previous.origin !== 'manual' || previous.batch_id || (!['done', 'error'].includes(previous.status) && !(previous.status === 'scoring' && expired)) || !['done', 'error'].includes(previous.run?.status) || (lease && !lease.finishedAt && !expired)) throw new TeamServiceError(409, 'RUN_NOT_RERUNNABLE', '仅可重新测评已结束的人工运行，请等待执行和评分结束');
        const withGroup = job.comparisonGroupId != null;
        const columns = ['id', 'service_key', 'origin', 'question', 'question_id', 'dataset_version', 'question_source_type', 'batch_id',
          ...(withGroup ? ['comparison_group_id'] : []), 'status', 'started_at', 'idempotency_scope', 'idempotency_key', 'idempotency_hash', 'run', 'owner_user_id'];
        const created = await client.query(`INSERT INTO public.unified_evaluation_runs ${insertSql(columns)}
          ON CONFLICT (idempotency_scope,idempotency_key) WHERE idempotency_key IS NOT NULL DO NOTHING RETURNING id`,
        [job.runId,job.serviceKey,job.origin,job.question,job.questionId,job.datasetVersion,job.questionSourceType,job.batchId,
          ...(withGroup ? [job.comparisonGroupId] : []),job.status,job.startedAt,scope,key,hash,job.run,ownerFromScope(scope)]);
        if (!created.rowCount) {
          const existing = (await client.query('SELECT id,idempotency_hash FROM public.unified_evaluation_runs WHERE idempotency_scope=$1 AND idempotency_key=$2 AND owner_user_id=$3', [scope,key,ownerFromScope(scope)])).rows[0];
          await client.query('ROLLBACK');
          return { created: false, runId: existing?.id, matches: existing?.idempotency_hash === hash };
        }
        await client.query('COMMIT');
        return { created: true, runId: job.runId };
      } catch (error) { await client.query('ROLLBACK').catch(() => {}); throw error; }
      finally { client.release(); }
    },
    async listRecoverableQueued(serviceKeys, limit = 300, addresses = {}) {
      const result = await (await adminPool()).query(`SELECT * FROM public.unified_evaluation_runs
        WHERE status='queued' AND native_run_id IS NULL AND idempotency_key IS NOT NULL
          AND ((origin='manual' AND idempotency_scope LIKE 'evaluation-user:%')
            OR (origin='automation' AND idempotency_scope IN ('evaluation-automation:mission-material','evaluation-automation:batch')))
          AND run->'queuePayload'->>'version' = '1'
          AND service_key=ANY($1::text[])
          AND run->>'serviceAddress' IS NOT DISTINCT FROM ($3::jsonb->>service_key)
        ORDER BY started_at, id LIMIT $2`, [serviceKeys, limit, JSON.stringify(addresses)]);
      return result.rows.map(row => ({ ...map(row), ownerScope: row.owner_user_id ? `evaluation-user:${row.owner_user_id}` : row.idempotency_scope }));
    },
    async claimQueued(job, { pausedReason = '同批次 Mission 已暂停，本题未派发' } = {}) {
      if (job.origin === 'automation' && job.serviceKey === 'mission-material' && job.batchId) {
        const client = await (await adminPool()).connect();
        try {
          await client.query('BEGIN');
          await client.query("SELECT pg_advisory_xact_lock(hashtext('science-evaluation-mission-pause'), hashtext($1))", [job.batchId]);
          const state = await client.query(`SELECT EXISTS(SELECT 1 FROM public.unified_evaluation_runs
            WHERE batch_id=$1 AND origin='automation' AND service_key='mission-material'
              AND run->>'missionBatchPaused'='true') AS paused`, [job.batchId]);
          if (state.rows[0]?.paused === true) {
            await client.query(`UPDATE public.unified_evaluation_runs
              SET status='paused',error=$2,finished_at=now(),updated_at=now()
              WHERE id=$1 AND batch_id=$3 AND origin='automation' AND service_key='mission-material'
                AND status='queued' AND native_run_id IS NULL`, [job.runId, pausedReason, job.batchId]);
            await client.query('COMMIT');
            return false;
          }
          const claimed = await client.query(`UPDATE public.unified_evaluation_runs
            SET status='running', run=$2, scores=$3, updated_at=now()
            WHERE id=$1 AND status='queued' AND native_run_id IS NULL RETURNING id`, [job.runId, job.run, job.scores]);
          await client.query('COMMIT');
          return claimed.rowCount === 1;
        } catch (error) { await client.query('ROLLBACK').catch(() => {}); throw error; }
        finally { client.release(); }
      }
      const result = await (await adminPool()).query(`UPDATE public.unified_evaluation_runs
        SET status='running', run=$2, scores=$3, updated_at=now()
        WHERE id=$1 AND status='queued' AND native_run_id IS NULL RETURNING id`,
      [job.runId, job.run, job.scores]);
      return result.rowCount === 1;
    },
    async isMissionBatchPaused(batchId) {
      const result = await (await adminPool()).query(`SELECT EXISTS(SELECT 1 FROM public.unified_evaluation_runs
        WHERE batch_id=$1 AND origin='automation' AND service_key='mission-material'
          AND run->>'missionBatchPaused'='true') AS paused`, [batchId]);
      return result.rows[0]?.paused === true;
    },
    async pauseQueuedMissionRun(runId, reason, { claimed = false } = {}) {
      const result = await (await adminPool()).query(`UPDATE public.unified_evaluation_runs
        SET status='paused',error=$2,finished_at=now(),updated_at=now()
        WHERE id=$1 AND origin='automation' AND service_key='mission-material'
          AND (status='queued' OR ($3 AND status='running')) AND native_run_id IS NULL RETURNING id`, [runId, reason, claimed]);
      return result.rowCount === 1;
    },
    async pauseMissionBatch(job, reason) {
      const current = await adminPool();
      const client = await current.connect();
      try {
        await client.query('BEGIN');
        await client.query("SELECT pg_advisory_xact_lock(hashtext('science-evaluation-mission-pause'), hashtext($1))", [job.batchId]);
        const failed = await client.query(`UPDATE public.unified_evaluation_runs SET native_run_id=$2,status=$3,answer=$4,
          answer_truncated=$5,run=$6,scores=$7,score_error=$8,error=$9,finished_at=$10,updated_at=now()
          WHERE id=$1 AND origin='automation' AND service_key='mission-material' AND batch_id=$11
            AND NOT (coalesce(run->>'executionTimeout','false')='true' AND coalesce($6::jsonb->>'executionTimeout','false') <> 'true') RETURNING id`,
        [job.runId,job.nativeRunId,job.status,job.answer,job.answerTruncated,job.run,job.scores,job.scoreError,job.error,job.finishedAt,job.batchId]);
        if (failed.rowCount !== 1) {
          const saved = await client.query("SELECT run->>'executionTimeout' AS timed_out FROM public.unified_evaluation_runs WHERE id=$1", [job.runId]);
          if (saved.rows[0]?.timed_out === 'true') { await client.query('COMMIT'); return { superseded: true }; }
          throw new Error('无法保存触发暂停的运行');
        }
        await client.query(`UPDATE public.unified_evaluation_runs SET status='paused',error=$2,finished_at=now(),updated_at=now()
          WHERE batch_id=$1 AND origin='automation' AND service_key='mission-material'
            AND status='queued' AND native_run_id IS NULL`, [job.batchId, reason]);
        await client.query('COMMIT');
      } catch (error) { await client.query('ROLLBACK').catch(() => {}); throw error; }
      finally { client.release(); }
    },
    async listStaleRunning(timeouts) {
      const values = typeof timeouts === 'number' ? { default: timeouts } : timeouts || {};
      const fallback = Number(values.default) || 60 * 60 * 1000;
      const mission = Number(values['mission-material']) || fallback;
      const result = await (await adminPool()).query(`SELECT id,xmin::text AS version,service_key FROM public.unified_evaluation_runs
        WHERE status='running' AND finished_at IS NULL
          AND updated_at < now() - (CASE WHEN service_key='mission-material' THEN $1::double precision ELSE $2::double precision END * interval '1 millisecond')
        ORDER BY updated_at LIMIT 100`, [mission, fallback]);
      return result.rows.map(row => ({ runId: row.id, version: row.version, serviceKey: row.service_key }));
    },
    async timeoutStaleRunning(runId, version, timeoutMs) {
      const message = '执行超时：超过执行时限未完成，已结束本次评测；上游任务是否停止无法确认。';
      const client = await (await adminPool()).connect();
      try {
        await client.query('BEGIN');
        const candidate = await client.query('SELECT origin,service_key,batch_id FROM public.unified_evaluation_runs WHERE id=$1', [runId]);
        const row = candidate.rows[0];
        const pauseMission = row?.origin === 'automation' && row.service_key === 'mission-material' && row.batch_id;
        if (pauseMission) await client.query("SELECT pg_advisory_xact_lock(hashtext('science-evaluation-mission-pause'), hashtext($1))", [row.batch_id]);
        const result = await client.query(`UPDATE public.unified_evaluation_runs
          SET status='error',error=$4,run=(CASE WHEN jsonb_typeof(run)='object' THEN run ELSE '{}'::jsonb END) || jsonb_build_object('status','error','error',$4::text,'executionTimeout',true) || CASE WHEN $5::boolean THEN '{"missionBatchPaused":true}'::jsonb ELSE '{}'::jsonb END,
            finished_at=now(),updated_at=now()
          WHERE id=$1 AND xmin::text=$2 AND status='running' AND finished_at IS NULL
            AND updated_at < now() - ($3::double precision * interval '1 millisecond') RETURNING id`, [runId, version, timeoutMs, message, !!pauseMission]);
        if (result.rowCount && pauseMission) await client.query(`UPDATE public.unified_evaluation_runs
          SET status='paused',error=$2,finished_at=now(),updated_at=now()
          WHERE batch_id=$1 AND origin='automation' AND service_key='mission-material' AND status='queued' AND native_run_id IS NULL`, [row.batch_id, '同批次 Mission 连接中断或执行超时，上游状态未确认，本题未派发']);
        await client.query('COMMIT');
        return result.rowCount === 1;
      } catch (error) { await client.query('ROLLBACK').catch(() => {}); throw error; }
      finally { client.release(); }
    },
    async save(job) {
      const result = await (await adminPool()).query(`UPDATE public.unified_evaluation_runs SET native_run_id=$2, status=$3, answer=$4,
        answer_truncated=$5, run=$6, scores=$7, score_error=$8, error=$9, finished_at=$10, updated_at=now()
        WHERE id=$1 AND NOT (coalesce(run,'{}'::jsonb) ? 'outputClearedAt')
          AND NOT (coalesce(run->>'executionTimeout','false')='true' AND coalesce($6::jsonb->>'executionTimeout','false') <> 'true')`, [job.runId, job.nativeRunId, job.status, job.answer, job.answerTruncated,
        job.run, job.scores, job.scoreError, job.error, job.finishedAt]);
      if (result.rowCount !== 1) throw new Error('统一测评记录不存在');
    },
    async get(id) {
      const result = await (await adminPool()).query('SELECT * FROM public.unified_evaluation_runs WHERE id=$1', [id]);
      return map(result.rows[0]);
    },
    async getAccess(id) {
      const result = await (await adminPool()).query('SELECT origin, owner_user_id FROM public.unified_evaluation_runs WHERE id=$1', [id]);
      return result.rows[0] || null;
    },
    async refreshScores(id, scores, scoreError, status) {
      const result = await (await adminPool()).query(`UPDATE public.unified_evaluation_runs
        SET scores=$2, score_error=$3, status=$4, updated_at=now()
        WHERE id=$1 AND status='scoring' AND NOT (coalesce(run,'{}'::jsonb) ? 'outputClearedAt') RETURNING *`, [id, scores, scoreError, status]);
      return map(result.rows[0]);
    },
    async claimScoring(id, previousId, scoring, scores) {
      const result = await (await adminPool()).query(`UPDATE public.unified_evaluation_runs
        SET run=jsonb_set(coalesce(run,'{}'::jsonb),'{scoring}',$3::jsonb),scores=$4,score_error=NULL,
          status=CASE WHEN status='cancelled' OR run->>'status'='cancelled' THEN 'cancelled'
            WHEN run->>'status'='error' OR (status='error' AND run->>'status' IS DISTINCT FROM 'done') THEN 'error' ELSE 'scoring' END,updated_at=now()
        WHERE id=$1 AND run->'scoring'->>'attemptId' IS NOT DISTINCT FROM $2::text AND status IN ('done','error','cancelled','scoring') AND NOT (coalesce(run,'{}'::jsonb) ? 'outputClearedAt') RETURNING id`, [id, previousId, scoring, scores]);
      return result.rowCount === 1;
    },
    async updateScoring(id, attemptId, value) {
      const result = await (await adminPool()).query(`UPDATE public.unified_evaluation_runs
        SET run=jsonb_set(jsonb_set(coalesce(run,'{}'::jsonb),'{scoring}',$3::jsonb),'{markdownSyntax}',$4::jsonb),scores=$5,score_error=NULL,status=$6,updated_at=now()
        WHERE id=$1 AND run->'scoring'->>'attemptId'=$2 AND NOT (coalesce(run,'{}'::jsonb) ? 'outputClearedAt') RETURNING id`, [id, attemptId, value.scoring, value.markdownSyntax, value.scores, value.status]);
      return result.rowCount === 1;
    },
    async questionScores(items, userId) {
      if (!items.length) return [];
      const result = await (await adminPool()).query(`SELECT DISTINCT ON (r.question_id,r.dataset_version,r.service_key)
        r.id,r.question_id,r.dataset_version,r.service_key,${scoreProjection('r.scores')} AS scores,r.started_at,r.status
        FROM public.unified_evaluation_runs r JOIN jsonb_to_recordset($1::jsonb) AS q(id text,"datasetVersion" text)
        ON r.question_id=q.id AND r.dataset_version=q."datasetVersion"
        WHERE r.origin='automation' OR r.owner_user_id=$2
        ORDER BY r.question_id,r.dataset_version,r.service_key,r.started_at DESC,r.id DESC`, [JSON.stringify(items), userId]);
      return result.rows.map(row => ({ runId: row.id, questionId: row.question_id, datasetVersion: row.dataset_version, serviceKey: row.service_key, status: row.status, startedAt: date(row.started_at), scores: scoreSummary(row.scores) }));
    },
    async listHistory(userId) {
      const current = await adminPool();
      const comparison = hasComparisonColumn ? 'r.comparison_group_id' : "to_jsonb(r)->>'comparison_group_id'";
      const result = await current.query(`SELECT r.id,r.question,r.status,r.started_at,h.title,${comparison} AS comparison_group_id
        FROM public.unified_evaluation_runs r
        LEFT JOIN public.evaluation_user_run_history h ON h.run_id=r.id AND h.user_id=$1
        WHERE r.origin IN ('manual','legacy') AND r.owner_user_id=$1 AND r.batch_id IS NULL AND coalesce(h.hidden,false)=false
        ORDER BY r.started_at DESC,r.id DESC LIMIT 50`, [userId]);
      return result.rows.map(row => ({ runId: row.id, question: row.question, title: row.title || null, status: row.status, startedAt: date(row.started_at), comparisonGroupId: row.comparison_group_id || null }));
    },
    async comparisonReady() {
      const result = await (await adminPool()).query("SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='unified_evaluation_runs' AND column_name='comparison_group_id' LIMIT 1");
      return result.rowCount === 1;
    },
    async getComparison(groupId, userId) {
      const result = await (await adminPool()).query(`SELECT * FROM public.unified_evaluation_runs
        WHERE comparison_group_id=$1 AND (origin='automation' OR owner_user_id=$2)
        ORDER BY started_at, id`, [groupId, userId]);
      return result.rows.map(map);
    },
    async updateHistory(userId, runId, action, title) {
      const result = await (await adminPool()).query(`INSERT INTO public.evaluation_user_run_history (user_id,run_id,title,hidden)
        SELECT $1,r.id,$3,$4 FROM public.unified_evaluation_runs r WHERE r.id=$2 AND r.origin IN ('manual','legacy') AND r.owner_user_id=$1
        ON CONFLICT (user_id,run_id) DO UPDATE SET
          title=CASE WHEN $4 THEN evaluation_user_run_history.title ELSE EXCLUDED.title END,
          hidden=CASE WHEN $4 THEN true ELSE evaluation_user_run_history.hidden END, updated_at=now()
        WHERE $4 OR NOT evaluation_user_run_history.hidden RETURNING run_id`, [userId, runId, title || null, action === 'remove']);
      return result.rowCount === 1;
    },
    async list({ origin = null, page = 1, pageSize = 20, q = '', domain = '', questionId = '', datasetVersion = '', from = '', to = '', userId = null } = {}) {
      const requestedPage = Number(page);
      const requestedSize = Number(pageSize);
      const safePage = Number.isInteger(requestedPage) && requestedPage > 0 ? Math.min(requestedPage, 100000) : 1;
      const safeSize = Number.isInteger(requestedSize) && requestedSize > 0 ? Math.min(requestedSize, 100) : 20;
      const term = typeof q === 'string' ? q.trim().toLowerCase() || null : null;
      const domainFilter = typeof domain === 'string' ? domain.trim() : '';
      const fromDate = typeof from === 'string' ? from.trim() : '';
      const toDate = typeof to === 'string' ? to.trim() : '';
      const source = `FROM public.unified_evaluation_runs r
        LEFT JOIN LATERAL (
          SELECT domain_key FROM eval_questions
          WHERE id = r.question_id AND dataset_version = r.dataset_version
          LIMIT 1
        ) q ON true`;
      const where = ["(r.origin='automation' OR r.owner_user_id=$1)"]; const params = [userId];
      if (origin) { params.push(origin); where.push(`r.origin=$${params.length}`); }
      if (questionId) { params.push(questionId); where.push(`r.question_id=$${params.length}`); }
      if (datasetVersion) { params.push(datasetVersion); where.push(`r.dataset_version=$${params.length}`); }
      if (term) { params.push(term); const index = params.length; where.push(`(POSITION($${index} IN lower(r.question)) > 0 OR POSITION($${index} IN r.id::text) > 0)`); }
      if (domainFilter) { if (domainFilter === 'unclassified') where.push('q.domain_key IS NULL'); else { params.push(domainFilter); where.push(`q.domain_key=$${params.length}`); } }
      if (fromDate) { params.push(fromDate); where.push(`(r.started_at AT TIME ZONE 'Asia/Shanghai')::date >= $${params.length}::date`); }
      if (toDate) { params.push(toDate); where.push(`(r.started_at AT TIME ZONE 'Asia/Shanghai')::date <= $${params.length}::date`); }
      const filter = where.length ? `WHERE ${where.join(' AND ')}` : '';
      const current = await adminPool();
      const comparison = hasComparisonColumn ? 'r.comparison_group_id' : "to_jsonb(r)->>'comparison_group_id'";
      const count = await current.query(`SELECT count(*)::int AS total ${source} ${filter}`, params);
      const result = await current.query(`SELECT r.id, r.service_key, r.origin, r.question, r.question_id, r.dataset_version, r.question_source_type,
        r.batch_id, ${comparison} AS comparison_group_id, r.status, ${scoreProjection('r.scores')} AS scores, r.started_at, r.finished_at,
        r.run->>'outputClearedAt' AS output_cleared_at, r.run #>> '{scoring,finishedAt}' AS scoring_finished_at,
        r.run #>> '{scoring,expiresAt}' AS scoring_expires_at, q.domain_key ${source} ${filter}
        ORDER BY r.started_at DESC, r.id DESC LIMIT $${params.length + 1} OFFSET $${params.length + 2}`, [...params, safeSize, (safePage - 1) * safeSize]);
      return { items: result.rows.map(row => ({ ...map(row), domainKey: row.domain_key || null, scores: scoreSummary(row.scores), scoringInProgress: !row.scoring_finished_at && Date.parse(row.scoring_expires_at) > Date.now() })), total: count.rows[0].total, page: safePage, pageSize: safeSize };
    },
  };
}
module.exports = { createUnifiedEvaluationRepository };
