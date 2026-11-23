const { randomUUID } = require('node:crypto');
const { TeamServiceError } = require('../errors');
const { redact } = require('../scoring/service');
const { scoreView } = require('../scoring/score-view');

const TERMINAL = "('done','error','cancelled')";
const MAX_TEXT = 300000;
const SCORE_STATUS = new Set(['ready', 'pending', 'failed', 'absent', 'unavailable', 'skipped']);
const TASK_STATUS = new Set(['completed', 'partial', 'failed', 'unclear']);
const QUALIFICATION = new Set(['qualified', 'not_qualified', 'unclear']);

function shareInfo(row) {
  return row ? { id: row.share_id, path: `/shared/runs/${row.share_id}`, expiresAt: new Date(row.expires_at).toISOString() } : null;
}

function sharedScores(scores) {
  return Object.fromEntries(['deepSeekScore', 'qwenScore'].flatMap(key => {
    const item = scores?.[key];
    if (!item) return [];
    const quality = item.quality;
    const status = SCORE_STATUS.has(item.status) ? item.status : 'absent';
    const raw = quality?.total;
    const old = quality?.clarity?.score;
    const total = typeof raw === 'number' && Number.isFinite(raw) && raw >= 0 && raw <= 100 ? raw
      : typeof old === 'number' && Number.isFinite(old) && old >= 1 && old <= 5 ? Math.round(old * 200) / 10 : null;
    const taskStatus = quality?.taskCompletion?.status;
    const qualification = quality?.qualification?.status;
    return [[key, { status, total, taskStatus: TASK_STATUS.has(taskStatus) ? taskStatus : null,
      qualification: QUALIFICATION.has(qualification) ? qualification : null, provisional: quality?.source?.truncated === true }]];
  }));
}

function sharedRun(row) {
  let remaining = MAX_TEXT;
  let truncated = row.answer_truncated === true || row.details_truncated === true;
  function visible(value) {
    if (typeof value !== 'string' || !value) return '';
    let bounded = value.slice(0, remaining);
    if (bounded.length < value.length && /[\uD800-\uDBFF]$/.test(bounded)) bounded = bounded.slice(0, -1);
    if (bounded.length < value.length) truncated = true;
    remaining -= bounded.length;
    return redact(scoreView(bounded, { hideHtml: false }).compact);
  }
  const answer = visible(row.answer);
  const sections = (Array.isArray(row.display_events) ? row.display_events : []).flatMap(event => {
    if (!['display.team_output', 'display.final_answer'].includes(event?.type)) return [];
    const content = visible(event.phase === 'end' && typeof event.content === 'string' ? event.content : event.delta);
    if (!content.trim()) return [];
    const team = typeof event.team?.name === 'string' ? redact(event.team.name.slice(0, 100)) : '';
    return [{ title: event.type === 'display.final_answer' ? '最终总结' : team || '团队输出', content }];
  });
  return { question: redact(row.question || ''), answer, sections, serviceKey: row.service_key,
    status: row.status, truncated, finishedAt: row.finished_at ? new Date(row.finished_at).toISOString() : null,
    expiresAt: new Date(row.expires_at).toISOString(), scores: sharedScores(row.scores) };
}

function createRunSharing(pool) {
  let database;
  async function rows(sql, params) {
    if (!database) database = pool.query('SELECT current_database() AS name').then(({ rows }) => {
      if (!['science_admin', 'science_evaluation'].includes(rows[0]?.name)) throw Error('测评分享数据库不受支持');
    }).catch(error => { database = null; throw error; });
    await database;
    try { return (await pool.query(sql, params)).rows; }
    catch (error) {
      if (error.code === '42P01') throw new TeamServiceError(503, 'RUN_SHARE_STORAGE_UNAVAILABLE', '分享存储尚未开通');
      throw error;
    }
  }
  return {
    async get(runId) {
      const [row] = await rows('SELECT share_id, expires_at FROM public.evaluation_run_shares WHERE run_id=$1 AND expires_at>now()', [runId]);
      return shareInfo(row);
    },
    async create(runId, userId) {
      const [row] = await rows(`INSERT INTO public.evaluation_run_shares AS share (run_id, share_id, expires_at)
        SELECT id, $3, now() + interval '30 days' FROM public.unified_evaluation_runs
        WHERE id=$1 AND (origin='automation' OR owner_user_id=$2)
          AND status IN ${TERMINAL} AND NOT (coalesce(run,'{}'::jsonb) ? 'outputClearedAt')
        ON CONFLICT (run_id) DO UPDATE SET
          share_id=CASE WHEN share.expires_at>now() THEN share.share_id ELSE excluded.share_id END,
          expires_at=CASE WHEN share.expires_at>now() THEN share.expires_at ELSE excluded.expires_at END
        RETURNING share_id, expires_at`, [runId, userId, randomUUID()]);
      if (!row) throw new TeamServiceError(409, 'RUN_SHARE_INELIGIBLE', '只有保留输出的已结束运行可以分享');
      return shareInfo(row);
    },
    async revoke(runId, userId, shareId) {
      await rows(`UPDATE public.evaluation_run_shares s SET expires_at=now()
        FROM public.unified_evaluation_runs r WHERE s.run_id=r.id AND r.id=$1
        AND (r.origin='automation' OR r.owner_user_id=$2) AND s.share_id=$3 AND s.expires_at>now()`, [runId, userId, shareId]);
    },
    async read(shareId) {
      const [row] = await rows(`SELECT s.expires_at, r.question, r.answer, r.answer_truncated, r.finished_at, r.service_key, r.status, r.scores,
        r.run#>'{details,displayEvents}' AS display_events, r.run#>'{details,truncated}' AS details_truncated
        FROM public.evaluation_run_shares s JOIN public.unified_evaluation_runs r ON r.id=s.run_id
        WHERE s.share_id=$1 AND s.expires_at>now() AND NOT (coalesce(r.run,'{}'::jsonb) ? 'outputClearedAt')
        AND (r.status IN ${TERMINAL} OR (r.status='scoring' AND r.run->>'status' IN ${TERMINAL}))`, [shareId]);
      if (!row) throw new TeamServiceError(404, 'RUN_SHARE_INVALID', '分享链接无效或已过期');
      return sharedRun(row);
    },
  };
}

module.exports = { createRunSharing };
