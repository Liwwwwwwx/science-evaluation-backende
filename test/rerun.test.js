const test = require('node:test');
const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const { createUnifiedEvaluationService } = require('../src/runs/unified-evaluation.service');
const { createUnifiedEvaluationRepository } = require('../src/runs/unified-evaluation.repository');

function fixture(changes={}) {
  const old={runId:'old',nativeRunId:'native-old',origin:'manual',serviceKey:'literature',question:'重新测评的原始题目内容',questionId:'q',datasetVersion:'v1',questionSourceType:'fixed',batchId:null,status:'error',answer:'旧输出',run:{status:'error',serviceAddress:'ws://example.test/start',ruleSnapshot:{id:'original-rule'}},scores:{deepSeekScore:{status:'ready'}},...changes};
  const rows=new Map([['old',structuredClone(old)]]),keys=new Map();let calls=0,created=0,resolved;
  const repository={get:async id=>structuredClone(rows.get(id)),findIdempotent:async(scope,key)=>keys.get(scope+key),createIdempotent:async()=>{throw Error('必须使用事务创建');},
    async createRerun(job,scope,key,hash,id){created++;keys.set(scope+key,{runId:job.runId,hash});rows.set(job.runId,structuredClone(job));return{created:true,runId:job.runId};},
    async save(job){rows.set(job.runId,structuredClone(job));}};
  const evaluator={scoreMode:'none',serviceAddress:'ws://example.test/start',async startQuestionRun(body,{onText}){calls++;assert.equal(body.question,old.question);onText('新输出');return{run:{id:'new-native'},completion:Promise.resolve({status:'done'})};},async getRunQuality(){return{status:'absent'};}};
  const service=createUnifiedEvaluationService({repository,evaluators:{literature:evaluator},resolveQuestion:async input=>{resolved=input;return null;}});
  return{service,repository,rows,old,evaluator,stats:()=>({calls,created,resolved})};
}
test('重新测评保留原题、版本、规则和旧输出并按同键恢复',async()=>{
  const f=fixture();const result=await f.service.rerun('old',{scope:'user',key:'same'});
  await new Promise(resolve=>setImmediate(resolve));
  const next=await f.service.get(result.runId);
  assert.equal(next.answer,'新输出');assert.equal(next.run.ruleSnapshot.id,'original-rule');assert.equal(next.run.previousRunId,'old');
  assert.equal(f.stats().resolved.datasetVersion,'v1');assert.equal(f.stats().calls,1);
  assert.equal((await f.service.get('old')).answer,'旧输出');assert.equal((await f.service.get('old')).scores.deepSeekScore.status,'ready');
  assert.equal((await f.service.rerun('old',{scope:'user',key:'same'})).runId,result.runId);
  assert.equal(f.stats().created,1);

});
test('执行中、自动批次或服务变化时不清理旧输出，也不触发新执行',async()=>{
  for(const changes of [{status:'running'},{origin:'automation'},{batchId:'batch'},{run:{status:'error',serviceAddress:'ws://other.test/start'}}]){
    const f=fixture(changes);await assert.rejects(f.service.rerun('old',{scope:'user',key:'new'}));assert.equal(f.stats().created,0);assert.equal(f.stats().calls,0);assert.equal(f.rows.get('old').answer,'旧输出');
  }
});
test('评分租约过期后可重新测评，未过期或无效租约不能重跑',async()=>{
  const run={status:'done',serviceAddress:'ws://example.test/start',scoring:{attemptId:'old',finishedAt:null,expiresAt:'2000-01-01T00:00:00Z'}};
  const expired=fixture({status:'scoring',run});
  assert.equal((await expired.service.get('old')).status,'done');
  await expired.service.rerun('old',{scope:'user',key:'expired'});
  assert.equal(expired.stats().created,1);
  for(const expiresAt of ['2999-01-01T00:00:00Z','invalid']) {
    const active=fixture({status:'scoring',run:{...run,scoring:{...run.scoring,expiresAt}}});
    await assert.rejects(active.service.rerun('old',{scope:'user',key:'active'}),{code:'RUN_NOT_RERUNNABLE'});
    assert.equal(active.rows.get('old').answer,'旧输出');
  }
});
test('事务内重新检查评分租约，只有已过期的评分可重新测评',async()=>{
  for (const [expiresAt, allowed] of [['2000-01-01T00:00:00Z',true],['2999-01-01T00:00:00Z',false],['invalid',false]]) {
    const queries=[];
    const previous={owner_user_id:'user',origin:'manual',batch_id:null,status:'scoring',run:{status:'done',serviceAddress:'ws://example.test',scoring:{attemptId:'attempt',finishedAt:null,expiresAt}}};
    const client={async query(sql,args){queries.push({sql,args});if(sql.startsWith('SELECT *'))return{rows:[previous]};if(sql.startsWith('INSERT'))return{rowCount:1};return{rows:[],rowCount:1};},release(){}};
    const pool={async query(){return{rows:[{name:'science_admin'}]};},async connect(){return client;}};
    const repo=createUnifiedEvaluationRepository({pgPool:pool});
    const job={runId:'new',run:{},startedAt:new Date().toISOString()};
    const action=repo.createRerun(job,'evaluation-user:user','key','hash','old','request');
    if(allowed){
      assert.equal((await action).created,true);
      assert.equal(queries.some(item=>item.sql.startsWith('UPDATE')),false);
      assert.ok(queries.some(item=>item.sql==='COMMIT'));
    }else{
      await assert.rejects(action,{code:'RUN_NOT_RERUNNABLE'});
      assert.ok(queries.some(item=>item.sql==='ROLLBACK'));
      assert.equal(queries.some(item=>item.sql.startsWith('INSERT')||item.sql.startsWith('UPDATE')),false);
    }
  }
});
test('同键请求查询与原记录清理交错时，仍返回已创建的新运行',async()=>{
  const f=fixture();
  f.repository.findIdempotent=async()=>{
    f.rows.set('old',{...f.old,answer:'',scores:null,run:{status:'error',outputClearedAt:'now',replacementRunId:'already-created',rerunRequestHash:createHash('sha256').update(JSON.stringify(['user','same'])).digest('hex')}});
    return null;
  };
  assert.deepEqual(await f.service.rerun('old',{scope:'user',key:'same'}),{runId:'already-created',reused:true});
  assert.equal(f.stats().created,0);assert.equal(f.stats().calls,0);
});
