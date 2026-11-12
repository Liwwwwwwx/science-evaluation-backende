const test = require('node:test');
const assert = require('node:assert/strict');
const { createApp } = require('../src/app');
const { createUnifiedEvaluationService } = require('../src/runs/unified-evaluation.service');

test('运行详情、实时流、附件和写操作均按记录归属校验；自动化允许团队读取', async t => {
  const a='11111111-1111-4111-8111-111111111111', shared='22222222-2222-4222-8222-222222222222';
  const records = new Map([
    [a,{runId:a,origin:'manual',owner:'a',status:'done',serviceKey:'literature',answer:'A 私有答案',run:{status:'done'}}],
    [shared,{runId:shared,origin:'automation',owner:null,status:'done',serviceKey:'literature',answer:'团队答案',run:{status:'done'}}],
  ]);
  const repo = {
    async getAccess(id) { const row=records.get(id); return row ? {origin:row.origin,owner_user_id:row.owner} : null; },
    async get(id) { return records.get(id) || null; },
    async list({userId}) { const items=[...records.values()].filter(row=>row.origin==='automation'||row.owner===userId); return {items,total:items.length}; },
    async listHistory(user) { return [...records.values()].filter(row=>row.origin==='manual'&&row.owner===user); },
    async questionScores(_items,user) { return [...records.values()].filter(row=>row.origin==='automation'||row.owner===user).map(row=>({runId:row.runId})); },
  };
  const evaluations=createUnifiedEvaluationService({repository:repo,evaluators:{literature:{}}});
  const authService={authenticate:async token=>{if(!token)throw Object.assign(Error('登录'),{status:401});return {id:token,permissions:['team-services:read','team-services:write']};}};
  const server=createApp({token:'x'.repeat(32),authService,evaluations,runWriteEnabled:true,publicOrigin:'http://localhost'});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));t.after(()=>server.close());
  const base=`http://127.0.0.1:${server.address().port}/api/evaluation/unified`;
  const get=(user,url)=>fetch(base+url,{headers:{cookie:`evaluation_session=${user}`}});
  const post=(user,url)=>fetch(base+url,{method:'POST',headers:{cookie:`evaluation_session=${user}`,origin:'http://localhost','content-type':'application/json','idempotency-key':'x'},body:'{}'});
  const list=await (await get('b','/runs')).json();
  assert.deepEqual(list.items.map(row=>row.runId),[shared]);
  assert.equal(list.items[0].canRescore,false);
  assert.equal((await get('a',`/runs/${a}`)).status,200);
  assert.equal((await get('b',`/runs/${a}`)).status,404);
  assert.equal((await get('b',`/runs/${a}/events`)).status,404);
  assert.equal((await get('b',`/runs/${a}/artifacts/0`)).status,404);
  for (const action of ['end','reply','score','rerun']) assert.equal((await post('b',`/runs/${a}/${action}`)).status,404);
  assert.equal((await get('b',`/runs/${shared}`)).status,200);
  // 共享运行的评分权限已开放；此测试没有配置评分服务，因而返回 503。
  assert.equal((await post('b',`/runs/${shared}/score`)).status,503);
  for (const action of ['end','reply','rerun']) assert.equal((await post('b',`/runs/${shared}/${action}`)).status,404);
  const scores=await (await get('b',`/question-scores?items=${encodeURIComponent(JSON.stringify([{id:'q',datasetVersion:'v1'}]))}`)).json();
  assert.deepEqual(scores.items.map(row=>row.runId),[shared]);
});

test('权限存储不可用时拒绝访问，不能回退为公开读取', async()=>{
  const evaluations=createUnifiedEvaluationService({repository:{},evaluators:{}});
  await assert.rejects(evaluations.assertRunAccess('id','a'),{status:503});
});
