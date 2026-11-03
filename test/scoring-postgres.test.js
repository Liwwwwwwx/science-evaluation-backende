const { setupRunOwnership } = require('./run-ownership-fixture');
const {test}=require('node:test');const assert=require('node:assert/strict');const fs=require('node:fs');const path=require('node:path');const crypto=require('node:crypto');const {Pool}=require('pg');
const {createUnifiedEvaluationService}=require('../src/runs/unified-evaluation.service');const {createUnifiedEvaluationRepository}=require('../src/runs/unified-evaluation.repository');const {createScoringService}=require('../src/scoring/service');
const {CHECKS}=require('../src/scoring/delivery-review');
const socket=process.env.EVALUATION_SCORING_TEST_PG_SOCKET||'';
test('隔离PG：五服务评分/SSE、重启读取、重评幂等与并发租约、题库版本隔离', {skip:!socket},async t=>{
 assert.match(socket,/^\/tmp\/evaluation-auth-pg\.[A-Za-z0-9]+$/);const pool=new Pool({host:socket,port:55481,database:'science_admin'});t.after(()=>pool.end());await pool.query(fs.readFileSync(path.join(__dirname,'../migrations/003_evaluation_runs.sql'),'utf8'));
 await setupRunOwnership(pool);
 await pool.query('CREATE TABLE eval_questions (id text, dataset_version text, domain_key text)');
 const repo=createUnifiedEvaluationRepository({pgPool:pool});let executions=0,judges=0,extracts=0;
 const rubric={requirements:[{requirement:'给出热导率单位',critical:true}],visualAidsApplicable:true,visualAidsReason:'要求表格'};
 const value={dimensions:Object.fromEntries(['readability','professionalism','visualAids'].map(k=>[k,{score:80,note:'单位可读',evidence:'W/(m·K)'}])),requirements:[{id:'R1',status:'met',evidence:'W/(m·K)',note:'给出了单位'}],comment:'单位清楚，仍可补充数据条件',highlights:['单位'],gaps:['条件'],suggestions:['补充条件']};
 const clients=Object.fromEntries(['deepSeekScore','qwenScore'].map(k=>[k,{model:k,isConfigured:()=>true,callJson:async prompt=>{await new Promise(r=>setTimeout(r,8));if(prompt.includes('仅根据题目')){extracts++;return rubric;}judges++;return value;}}]));
 value.deliveryReview={status:'delivered',evidence:'热导率单位 W/(m·K)。',note:'提供实际回答'};value.experienceChecks=Object.keys(CHECKS).map(id=>({id,status:'passed',note:'未发现此问题'}));
 const scoring=createScoringService({clients});const evaluators=Object.fromEntries(['literature','literature-aircraft','alloy','synthesis','new-material'].map(key=>[key,{scoreMode:'none',startQuestionRun:async(_,{onText})=>{executions++;onText('热导率单位 W/(m·K)。');return {run:{id:crypto.randomUUID()},completion:Promise.resolve({status:'done'})};}}]));
 const make=()=>createUnifiedEvaluationService({evaluators,repository:repo,scoring});const service=make();
 const wait=async(id,svc=service)=>{for(let i=0;i<300;i++){const v=await svc.get(id);if(v.status==='done'&&v.run?.scoring?.finishedAt)return v;await new Promise(r=>setTimeout(r,5));}throw Error('score timeout');};
 const ids=[];
 for(const serviceKey of Object.keys(evaluators)){const started=await service.start({origin:'automation',serviceKey,question:'请给出热导率单位以及对比表格。',questionId:'same-id',datasetVersion:'v1'});ids.push(started.runId);const events=[];started.subscribe((event,data)=>events.push([event,data]));const done=await wait(started.runId);assert.equal(done.executionStatus,'succeeded');assert.equal(done.scores.deepSeekScore.quality.total,80);assert.equal(done.scores.qwenScore.quality.taskCompletion.status,'completed');assert.ok(events.some(([e])=>e==='score'));}
 assert.equal(executions,5);assert.equal(judges,10);assert.equal(extracts,5);
 const restarted=make(),id=ids[0],saved=await restarted.get(id);assert.equal(saved.recoveryState,'snapshot_only');assert.equal(saved.scores.deepSeekScore.status,'ready');assert.equal(judges,10);
 assert.equal((await restarted.list()).items[0].scores.qwenScore.total,80);assert.equal((await restarted.questionScores([{id:'same-id',datasetVersion:'v1'}])).items.length,5);assert.equal((await restarted.questionScores([{id:'same-id',datasetVersion:'v2'}])).items.length,0);
 await assert.rejects(restarted.questionScores([{id:'same-id'}]),e=>e.status===400);
 const pair=await Promise.allSettled([restarted.rescore(id,{scope:'writer',key:'once'}),make().rescore(id,{scope:'writer',key:'other'})]);assert.equal(pair.filter(v=>v.status==='fulfilled').length,1);const winner=pair.find(v=>v.status==='fulfilled').value;
 const done=await wait(id,restarted);assert.equal(done.run.scoring.history.length,1);assert.equal(executions,5);assert.equal(extracts,5);assert.equal(judges,12);
 const winnerKey=pair[0].status==='fulfilled'?'once':'other';assert.equal((await make().rescore(id,{scope:'writer',key:winnerKey})).reused,true);assert.equal((await make().get(id)).run.scoring.attemptId,winner.attemptId);
 assert.equal(await repo.updateScoring(id,'wrong-attempt',{scoring:{},markdownSyntax:{},scores:{},status:'done'}),false);
 // 过期 pending 的 GET 只做响应降级，不回写，不无限轮询；可显式恢复评分。
 const staleId=crypto.randomUUID();const old={...saved,runId:staleId,status:'scoring',run:{status:'done',scoring:{attemptId:'stale',version:'evaluation-v1',expiresAt:'2000-01-01T00:00:00Z',finishedAt:null}},scores:{deepSeekScore:{status:'pending'}}};await repo.create(old);await repo.save(old);const restored=await make().get(staleId);assert.equal(restored.scoringStatus,'failed');assert.equal(restored.status,'done');assert.equal((await repo.get(staleId)).status,'scoring');
 const recover=make();await recover.rescore(staleId,{scope:'writer',key:'recover'});assert.equal((await wait(staleId,recover)).scores.deepSeekScore.status,'ready');assert.equal(executions,5);
});
