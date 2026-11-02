const test=require('node:test');
const assert=require('node:assert/strict');
const {randomUUID}=require('node:crypto');
const {snapshotOf,analysisCases,cleanAnalysis,markdownOf,nightDate,deadline,validDate}=require('../src/daily-reports/summary');
const {createDailyReportService}=require('../src/daily-reports/service');
const {createApp}=require('../src/app');
const id=randomUUID();
const score=(total,hash='v1')=>({runId:randomUUID(),serviceKey:'literature',status:'done',question:'导热材料文献',answer:'可用回答',finishedAt:'2026-11-02T15:00:00Z',updatedAt:'2026-11-02T15:00:00Z',run:{status:'done',elapsedMs:1000},ruleSnapshot:{hash,name:hash},scores:{deepSeekScore:{status:'ready',model:'test',quality:{total,comment:'交付清楚',taskCompletion:{status:'completed'}}}}});
function memoryRepo(source){let row=null,sent=false;return {source:async()=>source,dates:async()=>['2026-11-02'],list:async()=>({items:[],total:0}),get:async()=>row,async claim(day,snapshot,token,force){if(row?.status==='generating'||row?.sourceHash===snapshot.sourceHash&&!force)return false;row={date:day,sourceHash:snapshot.sourceHash,snapshot,status:'generating',token};return true;},async finish(day,token,result){if(row?.token!==token)return false;row={...row,...result,status:'ready'};return true;},async claimNotification(){if(sent)return false;sent=true;return true;},async finishNotification(day,hash,state){row.notificationState=state;}};}

test('程序统计有效分、零分、缺失和截断，按规则分组，执行状态不受评分影响',()=>{
  const a=score(0),b=score(100),c=score(90,'v2'),d=score(80);d.answerTruncated=true;
  const pending={...score(20),run:{status:'done'},scores:{qwenScore:{status:'pending'}}};
  const failed={...score(90),status:'error',error:'执行超时',run:{status:'error'},scores:null};
  const s=snapshotOf('2026-11-02',{plan:null,runs:[a,b,c,d,pending,failed]},new Date('2026-11-02T22:00:00Z'));
  assert.equal(s.completed,5);assert.equal(s.timeout,1);assert.equal(s.services[0].scores.deepSeekScore.groups[0].mean,50);
  assert.equal(s.services[0].scores.deepSeekScore.groups.length,2);assert.equal(s.services[0].scores.deepSeekScore.states.provisional,1);
  assert.equal(s.services[0].scores.qwenScore.states.pending,1);assert.equal(s.inProgress,true);
  assert.match(markdownOf(s),/参考分 1/);
});
test('夜间日期归属、06点截止、未派发计划和引用校验',()=>{
  assert.equal(nightDate(new Date('2026-11-03T01:00:00+08:00')),'2026-11-02');
  assert.equal(deadline('2026-11-02').toISOString(),'2026-11-02T22:00:00.000Z');
  assert.equal(validDate('2026-02-30'),false);
  const s=snapshotOf('2026-11-02',{runs:[],plan:{id:'batch',state:'submitted',items:[{questionId:'q',datasetVersion:'v'}]}},new Date('2026-11-02T15:00:00Z'));
  assert.equal(s.missingPlanned,1);assert.equal(s.inProgress,true);
  assert.throws(()=>cleanAnalysis({overview:'好',issues:[{text:'缺失',runIds:['unknown']}],highlights:[],recommendations:[]},[{runId:id}]),/REFERENCE/);
});
test('等待执行、评分及安静窗口；GET不触发生成；模型不可用保留统计',async()=>{
  let calls=0;const source={plan:null,runs:[{...score(80),scores:{deepSeekScore:{status:'pending'}}}]};
  const repo=memoryRepo(source);const service=createDailyReportService({repository:repo,clients:{},enabled:true,now:()=>new Date('2026-11-02T15:10:00Z')});
  assert.equal((await service.generate('2026-11-02')).reason,'waiting');
  source.runs[0]=score(80);await service.list(1);assert.equal(await repo.get(),null);
  await service.generate('2026-11-02');const report=await repo.get();assert.equal(report.analysisState,'unavailable');assert.match(report.markdown,/暂无|未配置/);assert.equal(calls,0);
});
test('试运行超过原截止时间仍等待全部计划完成，再发送汇总',async()=>{
  const source={plan:null,trialPlan:{id:'trial',state:'submitted',items:{alloy:['题一','题二']},updatedAt:'2026-11-02T14:00:00Z'},runs:[{...score(80),serviceKey:'alloy',batchId:'trial'}]};
  const repo=memoryRepo(source);let notifications=0;
  const service=createDailyReportService({repository:repo,clients:{},notifyEnabled:true,notifier:{configured:true,async sendText(){notifications++;return{sent:true};}},now:()=>new Date('2026-11-03T07:00:00+08:00')});
  assert.equal((await service.generate('2026-11-02',{automatic:true})).reason,'waiting');
  assert.equal(notifications,0);
  source.runs.push({...score(90),serviceKey:'alloy',batchId:'trial'});
  assert.equal((await service.generate('2026-11-02',{automatic:true})).accepted,true);
  assert.equal(notifications,1);
});
test('优先千问、失败回退DeepSeek；多实例抢占一次且通知未知不重发，迟到结果更新',async()=>{
  const source={plan:null,runs:[score(80)]};let modelCalls=0,notifications=0;
  const repo=memoryRepo(source);const clients={qwenScore:{model:'qwen',isConfigured:()=>true,callJson:async()=>{throw Error('failed');}},deepSeekScore:{model:'deepseek',isConfigured:()=>true,callJson:async prompt=>{modelCalls++;assert.doesNotMatch(prompt,/secret-value/);return {overview:'交付基本完成',issues:[],highlights:[{text:'表述清楚',runIds:[source.runs[0].runId]}],recommendations:[]};}}};
  source.runs[0].answer='TOKEN=secret-value';
  const make=()=>createDailyReportService({repository:repo,clients,preferred:'qwen',enabled:true,notifyEnabled:true,notifier:{configured:true,sendText:async()=>{notifications++;return {sent:false,reason:'request-failed'};}},now:()=>new Date('2026-11-02T22:00:00Z')});
  await Promise.all([make().tick(),make().tick()]);assert.equal(modelCalls,1);assert.equal(notifications,1);assert.equal((await repo.get()).provider,'deepseek');assert.equal((await repo.get()).notificationState,'unknown');
  await make().tick();assert.equal(modelCalls,1);assert.equal(notifications,1);
  source.runs.push(score(60));await make().tick();assert.equal((await repo.get()).snapshot.total,2);assert.equal(modelCalls,2);assert.equal(notifications,1);
});
test('分析摘要有预算且保留不同服务覆盖',()=>{
  const cases=analysisCases([{...score(50),answer:'x'.repeat(10000)},{...score(70),serviceKey:'alloy'}],3000);
  assert.equal(cases.length,2);assert.ok(cases[0].answerExcerpt.length<=400);
});
test('报告HTTP鉴权、来源、写开关和Markdown下载，读取不会调用模型',async t=>{
  let calls=0;const reports={list:async()=>({items:[],total:0}),get:async()=>({status:'ready',markdown:'# 总结\n',analysisState:'ready'}),request:async()=>{calls++;return{state:'generating'};}};
  const authService={authenticate:async token=>{if(!token)throw Object.assign(Error('请登录'),{status:401});return {permissions:token==='reader'?['team-services:read']:['team-services:read','team-services:write']};}};
  const server=createApp({token:'x'.repeat(32),authService,dailyReports:reports,reportWriteEnabled:true,publicOrigin:'http://localhost'});await new Promise(r=>server.listen(0,'127.0.0.1',r));t.after(()=>server.close());
  const base=`http://127.0.0.1:${server.address().port}/api/evaluation/unified/daily-reports`;
  assert.equal((await fetch(base)).status,401);
  const downloaded=await fetch(base+'/2026-11-02/markdown',{headers:{cookie:'evaluation_session=reader'}});assert.equal(downloaded.status,200);assert.match(downloaded.headers.get('content-type'),/markdown/);assert.match(downloaded.headers.get('content-disposition'),/attachment/);assert.equal(calls,0);
  const send=(who='writer',origin='http://localhost')=>fetch(base+'/2026-11-02/generate',{method:'POST',headers:{cookie:`evaluation_session=${who}`,origin,'Content-Type':'application/json','Idempotency-Key':'report-test'},body:'{}'});
  assert.equal((await send('reader')).status,403);assert.equal((await send('writer','http://evil.invalid')).status,403);assert.equal((await send()).status,202);assert.equal(calls,1);
});
