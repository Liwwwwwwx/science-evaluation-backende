function map(row) {
  if(!row)return null;
  return {date:row.report_date,sourceHash:row.source_hash,status:row.status==='generating'&&new Date(row.lease_until)<new Date()?'failed':row.status,analysisState:row.analysis_state,provider:row.provider,model:row.model,snapshot:row.snapshot,analysis:row.analysis,markdown:row.markdown,error:row.error,notificationState:row.notification_state,notificationHash:row.notification_hash,updatedAt:new Date(row.updated_at).toISOString(),leaseUntil:new Date(row.lease_until).toISOString()};
}
function createDailyReportRepository(pool, { trialEnabled = false } = {}) {
  let checked;
  async function db(){if(!checked)checked=pool.query('SELECT current_database() AS name').then(r=>{if(!['science_admin','science_evaluation'].includes(r.rows[0]?.name))throw new Error('每日报告仅允许使用测评数据库');return pool;}).catch(e=>{checked=null;throw e;});return checked;}
  async function hasTrial(){if(trialEnabled!=='auto')return trialEnabled;const r=await(await db()).query("SELECT to_regclass('public.evaluation_trial_batch_plans') IS NOT NULL AS present");return r.rows[0]?.present===true;}
  return {
    async dates(){const trial=await hasTrial();const r=await(await db()).query(`SELECT day::text AS day FROM (
      SELECT ((started_at AT TIME ZONE 'Asia/Shanghai') - interval '22 hours')::date AS day
      FROM unified_evaluation_runs WHERE origin='automation' AND started_at>=now()-interval '48 hours'
      UNION SELECT plan_date FROM evaluation_mission_daily_plans WHERE created_at>=now()-interval '48 hours'
      ${trial ? "UNION SELECT plan_date FROM evaluation_trial_batch_plans WHERE created_at>=now()-interval '48 hours'" : ''}
      ) d ORDER BY day DESC LIMIT 3`);return r.rows.map(row=>row.day);},
    async source(day){
      const current=await db();
      const hasTrialPlan=await hasTrial();
      const plan=await current.query('SELECT id,state,reason,items,updated_at FROM evaluation_mission_daily_plans WHERE plan_date=$1::date',[day]);
      const trial=hasTrialPlan ? await current.query('SELECT id,state,error,items,updated_at FROM evaluation_trial_batch_plans WHERE plan_date=$1::date',[day]) : null;
      const runs=await current.query(`SELECT u.id,u.service_key,u.batch_id,u.question_id,u.dataset_version,u.status,u.question,
        substring(u.answer,1,1200) AS answer,u.answer_truncated,u.scores,u.error,u.finished_at,u.updated_at,q.domain_key,
        jsonb_build_object('status',u.run->'status','error',u.run->'error','elapsedMs',u.run->'elapsedMs') AS run,
        COALESCE(u.run->'scoring'->'ruleSnapshot',u.run->'ruleSnapshot') AS rule_snapshot
        FROM unified_evaluation_runs u
        LEFT JOIN evaluation_mission_daily_plans p ON p.id::text=u.batch_id
        ${hasTrialPlan ? 'LEFT JOIN evaluation_trial_batch_plans tp ON tp.id::text=u.batch_id' : ''}
        LEFT JOIN eval_questions q ON q.id=u.question_id AND q.dataset_version=u.dataset_version
        WHERE u.origin='automation' AND (p.plan_date=$1::date ${hasTrialPlan ? 'OR tp.plan_date=$1::date' : ''} OR (p.id IS NULL ${hasTrialPlan ? 'AND tp.id IS NULL' : ''}
          AND u.started_at >= ($1::date + time '22:00') AT TIME ZONE 'Asia/Shanghai'
          AND u.started_at < (($1::date + 1) + time '22:00') AT TIME ZONE 'Asia/Shanghai'))
        ORDER BY u.started_at,u.id LIMIT 2001`,[day]);
      if(runs.rows.length>2000)throw Object.assign(new Error('本轮自动测评超过2000条，请缩小报告范围'),{status:413,code:'REPORT_TOO_LARGE'});
      return {plan:plan.rows[0]?{...plan.rows[0],updatedAt:new Date(plan.rows[0].updated_at).toISOString()}:null,trialPlan:trial?.rows[0]?{...trial.rows[0],updatedAt:new Date(trial.rows[0].updated_at).toISOString()}:null,runs:runs.rows.map(r=>({runId:r.id,serviceKey:r.service_key,batchId:r.batch_id,questionId:r.question_id,datasetVersion:r.dataset_version,status:r.status,question:r.question,answer:r.answer,answerTruncated:r.answer_truncated,scores:r.scores,error:r.error,finishedAt:r.finished_at?new Date(r.finished_at).toISOString():null,updatedAt:new Date(r.updated_at).toISOString(),domainKey:r.domain_key,run:r.run,ruleSnapshot:r.rule_snapshot}))};
    },
    async list(page){const r=await(await db()).query('SELECT report_date::text,status,analysis_state,provider,model,snapshot,updated_at,lease_until,notification_state FROM evaluation_daily_reports ORDER BY report_date DESC LIMIT 20 OFFSET $1',[(page-1)*20]);const n=await(await db()).query('SELECT count(*)::int AS total FROM evaluation_daily_reports');return {items:r.rows.map(row=>({date:row.report_date,status:row.status,analysisState:row.analysis_state,provider:row.provider,model:row.model,total:row.snapshot?.total||0,completed:row.snapshot?.completed||0,unfinished:row.snapshot?.unfinished||0,updatedAt:new Date(row.updated_at).toISOString(),notificationState:row.notification_state})),total:n.rows[0].total};},
    async get(day){const r=await(await db()).query('SELECT *,report_date::text AS report_date FROM evaluation_daily_reports WHERE report_date=$1::date',[day]);return map(r.rows[0]);},
    async claim(day,snapshot,token,force=false){
      const r=await(await db()).query(`INSERT INTO evaluation_daily_reports(report_date,source_hash,status,claim_token,lease_until,snapshot)
        VALUES ($1::date,$2,'generating',$3,now()+interval '10 minutes',$4::jsonb)
        ON CONFLICT (report_date) DO UPDATE SET source_hash=EXCLUDED.source_hash,status='generating',claim_token=EXCLUDED.claim_token,
          lease_until=EXCLUDED.lease_until,snapshot=EXCLUDED.snapshot,analysis_state='pending',error=NULL,updated_at=now(),
          attempts=CASE WHEN evaluation_daily_reports.source_hash=EXCLUDED.source_hash THEN evaluation_daily_reports.attempts+1 ELSE 1 END
        WHERE (evaluation_daily_reports.status<>'generating' OR evaluation_daily_reports.lease_until<now())
          AND (evaluation_daily_reports.source_hash<>EXCLUDED.source_hash
            OR (evaluation_daily_reports.status='generating' AND evaluation_daily_reports.attempts<3)
            OR ($5 AND (evaluation_daily_reports.analysis_state IN ('failed','unavailable') OR (evaluation_daily_reports.status='generating' AND evaluation_daily_reports.lease_until<now()))))
        RETURNING report_date`,[day,snapshot.sourceHash,token,JSON.stringify(snapshot),force]);
      return r.rowCount===1;
    },
    async finish(day,token,result){const r=await(await db()).query(`UPDATE evaluation_daily_reports SET status='ready',analysis=$3::jsonb,analysis_state=$4,
      provider=$5,model=$6,markdown=$7,error=$8,updated_at=now() WHERE report_date=$1::date AND claim_token=$2 AND status='generating'`,[day,token,JSON.stringify(result.analysis),result.analysisState,result.provider,result.model,result.markdown,result.error||null]);return r.rowCount===1;},
    async claimNotification(day,hash){const r=await(await db()).query("UPDATE evaluation_daily_reports SET notification_state='sending',notification_hash=$2 WHERE report_date=$1::date AND source_hash=$2 AND status='ready' AND notification_state IS NULL RETURNING report_date",[day,hash]);return r.rowCount===1;},
    async finishNotification(day,hash,state){await(await db()).query("UPDATE evaluation_daily_reports SET notification_state=$3 WHERE report_date=$1::date AND notification_hash=$2 AND notification_state='sending'",[day,hash,state]);},
  };
}
module.exports={createDailyReportRepository};
