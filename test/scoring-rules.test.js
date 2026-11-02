const {test} = require('node:test');
const assert = require('node:assert/strict');
const {randomUUID} = require('node:crypto');
const {builtinRule,validateConfig,createRuleService,ruleDocument,snapshotRule} = require('../src/scoring/rules');
const {efficiencyReview,createProcessRecorder} = require('../src/scoring/process-review');
const {normalizeDelivery,CHECKS} = require('../src/scoring/delivery-review');
const {createScoringService,normalizeRubric,normalizeJudge,packInput} = require('../src/scoring/service');
const {createApp} = require('../src/app');
const config = () => structuredClone(builtinRule().config);
const answer = '热导率的单位为 W/(m·K)，表示材料传导热量的能力。';
const rubricRaw = {requirements:[{requirement:'说明单位和含义',critical:true}],visualAidsApplicable:false,visualAidsReason:'简单问答无需图表'};
function judgement(body=answer) {return {dimensions:Object.fromEntries(['readability','professionalism','visualAids'].map((k,i)=>[k,{score:80+i*10,note:'说明清楚',evidence:'W/(m·K)'}])),requirements:[{id:'R1',status:'met',evidence:'W/(m·K)',note:'已提供'}],comment:'简洁清楚',suggestions:['补充适用条件'],deliveryReview:{status:'delivered',evidence:body,note:'提供了实际解释'},experienceChecks:Object.keys(CHECKS).map(id=>({id,status:'passed',note:'根据题目判断未发现此问题',evidence:''}))};}
test('规则验证拒绝错误权重、空说明、无效阈值与重复阶段；文档使用同一配置',()=>{
 for(const alter of [c=>c.weights.readability=39,c=>c.weights={readability:0,professionalism:0,visualAids:100},c=>c.passScore=null,c=>c.completionInstructions='',c=>delete c.efficiencyRules[0].phaseKey,c=>c.efficiencyRules[0].criticalSeconds=1,c=>c.efficiencyRules.push({...c.efficiencyRules[0]})]){const c=config();alter(c);assert.throws(()=>validateConfig(c),e=>e.status===400);}
 assert.ok(ruleDocument(builtinRule()).includes('180秒'));const c=config();c.weights={readability:20,professionalism:60,visualAids:20};assert.equal(snapshotRule({...builtinRule(),config:c}).config.weights.professionalism,60);
});
test('规则未迁移时只读使用内置规则；普通数据库故障不能静默换标准',async()=>{
 const missing=()=>{throw Object.assign(Error('missing'),{code:'42P01'});};
 const s=createRuleService({catalog:missing,active:missing});assert.equal((await s.catalog()).storageReady,false);assert.equal((await s.activeSnapshot()).id,'builtin-v1');
 await assert.rejects(createRuleService({active:()=>{throw Error('offline');}}).activeSnapshot());
});
test('阶段效率不能用总耗时代替查询时间；只有明确边界或持续运行证据才命中阈值',()=>{
 const run={elapsedMs:400000,details:{process:{events:[]}}};assert.equal(efficiencyReview(run,'alloy',config()).status,'not_evaluable');
 run.details.process.events=[{id:'E1',phaseKey:'team-discovery',kind:'start',atMs:1000}];assert.equal(efficiencyReview(run,'alloy',config()).status,'not_evaluable');
 run.details.process.events.push({id:'E2',phaseKey:'team-discovery',kind:'running',atMs:301000});let r=efficiencyReview(run,'alloy',config());assert.equal(r.status,'critical');assert.equal(r.rows[0].open,true);assert.equal(r.rows[0].durationMs,300000);
 run.details.process.events.push({id:'E3',phaseKey:'team-discovery',kind:'end',atMs:302000});r=efficiencyReview(run,'alloy',config());assert.equal(r.rows[0].open,false);assert.deepEqual(r.rows[0].evidence,['E1','E3']);
 const c=config();c.efficiencyRules.push({...c.efficiencyRules[0],serviceKey:'alloy',warningSeconds:600,criticalSeconds:900});assert.equal(efficiencyReview(run,'alloy',c).status,'passed');
 assert.equal(efficiencyReview({elapsedMs:900000,details:{process:{events:[{phaseKey:'simulation',kind:'start',atMs:0},{phaseKey:'simulation',kind:'end',atMs:800000}]}}},'alloy',config()).status,'not_evaluable');
 const overlap={elapsedMs:400000,details:{process:{events:[{phaseKey:'team-discovery',kind:'start',atMs:0},{phaseKey:'team-discovery',kind:'start',atMs:300000},{phaseKey:'team-discovery',kind:'end',atMs:301000}]}}};assert.equal(efficiencyReview(overlap,'alloy',config()).status,'not_evaluable');
});
test('过程记录使用接收时间并限制大小，不从文字或上游声称的时间推断阶段',t=>{
 let now=100;t.mock.method(Date,'now',()=>now);const p=createProcessRecorder(100);
 p.record({type:'progress',data:{message:'正在查询团队，已持续5分钟',elapsed:300000}});assert.equal(p.data.events.length,0);
 now=200;p.record({type:'phase_start',data:{phaseKey:'team-discovery',atMs:999999}});assert.equal(p.data.events[0].atMs,100);
 for(let i=0;i<250;i++)p.record({type:'progress',data:{phaseKey:'team-discovery',status:'running',message:'a'.repeat(1500)}});
 assert.equal(p.data.events.length,200);assert.equal(p.data.messages.length,50);assert.equal(p.data.messages[1].text.length,1000);assert.equal(p.data.truncated,true);
});
test('交付体验按证据和上下文评估，不用技术关键词硬判；准备说明不能抵消实际缺失',()=>{
 const technical='使用 python-docx 生成文档，TMPDIR 用于临时目录。';
 const input={answer:technical,structured:'{}',process:{messages:[]},truncated:false};const j=judgement(technical);
 assert.equal(normalizeDelivery(j,input).experienceReview.checks.find(c=>c.id==='irrelevant_details').status,'passed');
 j.experienceChecks[0]={id:'irrelevant_details',status:'issue',note:'普通文档任务中无助于用户',evidence:'不存在的内容'};assert.equal(normalizeDelivery(j,input).experienceReview.checks[0].status,'unclear');
 j.experienceChecks[0].evidence='TMPDIR 用于临时目录';assert.equal(normalizeDelivery(j,input).experienceReview.status,'issue');
 j.deliveryReview={status:'not_delivered',note:'只描述准备',evidence:technical};j.requirements=[{id:'R1',status:'missing',note:'无交付'}];
 const result=normalizeJudge(j,normalizeRubric(rubricRaw,'题目','m'),input,{status:'passed'},builtinRule());assert.equal(result.taskCompletion.status,'failed');assert.equal(result.qualification.status,'not_qualified');
});
test('自定义权重程序计算；原文证据不完整时不判完整合格；机检门槛独立配置',()=>{
 const policy=builtinRule();policy.config.weights={readability:20,professionalism:60,visualAids:20};
 const rubric=normalizeRubric(rubricRaw,'题目','m');const input={answer,structured:'{}',process:{messages:[]},truncated:false};
 let r=normalizeJudge(judgement(),rubric,input,{status:'failed'},policy);assert.equal(r.total,87.5);assert.equal(r.qualification.status,'qualified');
 policy.config.markdownGate=true;r=normalizeJudge(judgement(),rubric,input,{status:'failed'},policy);assert.equal(r.qualification.status,'not_qualified');
 r=normalizeJudge(judgement(),rubric,{...input,truncated:true},{status:'passed'},policy);assert.equal(r.taskCompletion.qualified,false);assert.equal(r.qualification.status,'unclear');
});
test('双评委共用冻结规则与要求，带入已保存过程而不泄露认证字段，旧运行继续原标准',async()=>{
 const prompts=[];const clients=Object.fromEntries(['deepSeekScore','qwenScore'].map(key=>[key,{model:key,isConfigured:()=>true,callJson:async p=>{prompts.push(p);return p.includes('仅根据题目')?rubricRaw:judgement();}}]));
 const rule=builtinRule();rule.config.weights={readability:20,professionalism:60,visualAids:20};
 const j={question:'说明热导率单位和含义',serviceKey:'alloy',answer,run:{status:'done',ruleSnapshot:rule,elapsedMs:300000,details:{process:{messages:[{id:'P1',text:'处理完成',atMs:100},{text:'https://x.test/?token=do-not-send',atMs:200}],events:[]}}}};
 const result=await createScoringService({clients}).score(j);assert.equal(result.scores.deepSeekScore.quality.total,87.5);assert.equal(result.scores.qwenScore.quality.total,87.5);assert.equal(result.scoring.ruleSnapshot.config.weights.readability,20);
 assert.ok(prompts.slice(1).every(p=>p.includes('技术内容可以通过')&&p.includes('处理完成')&&!p.includes('do-not-send')));
 const old={...j,run:{status:'done'}};assert.equal((await createScoringService({clients}).score(old)).scores.deepSeekScore.quality.total,85);
 const large=packInput({...j,run:{details:{process:{messages:Array.from({length:50},()=>({text:'x'.repeat(1000)}))}}}});assert.equal(large.process.messages.length,12);assert.equal(large.process.truncated,true);
 const sensitive=packInput({...j,run:{details:{process:{messages:[{text:'DEEPSEEK_API_KEY=inline-private TOKEN="second-private" Authorization: Bearer third-private'}]}}}});for(const v of ['inline-private','second-private','third-private'])assert.ok(!JSON.stringify(sensitive).includes(v));
 const jsonSecret=packInput({...j,answer:'{\"api_key\":\"json-private\"}\nCookie: session=cookie-private; token=cookie-other'});for(const v of ['json-private','cookie-private','cookie-other'])assert.ok(!JSON.stringify(jsonSecret).includes(v));
});
test('规则HTTP校验会话、读写权限、同源和独立写开关；GET不做修改',async t=>{
 let mutations=0;const id=randomUUID();const rules={catalog:async()=>({items:[],active:builtinRule(),storageReady:true,stateRevision:0}),create:async()=>{mutations++;return{id};},change:async()=>{mutations++;return{id};}};
 const authService={authenticate:async token=>{if(!token)throw Object.assign(Error('请登录'),{status:401});return{id:token,permissions:token==='reader'?['team-services:read']:['team-services:read','team-services:write']};}};
 for(const enabled of [false,true]){
  const s=createApp({token:'x'.repeat(32),authService,rules,rulesWriteEnabled:enabled,publicOrigin:'http://localhost'});await new Promise(r=>s.listen(0,'127.0.0.1',r));t.after(()=>s.close());const base=`http://127.0.0.1:${s.address().port}/api/evaluation/rules`;
  const post=(user='writer',origin='http://localhost',key=randomUUID())=>fetch(base,{method:'POST',headers:{cookie:`evaluation_session=${user}`,origin,'content-type':'application/json','idempotency-key':key},body:'{}'});
  assert.equal((await fetch(base)).status,401);assert.equal((await post('reader')).status,403);assert.equal((await post('writer','http://evil.test')).status,403);
  const read=await(await fetch(base,{headers:{cookie:'evaluation_session=reader'}})).json();assert.equal(read.canWrite,false);assert.equal(mutations,enabled?0:0);
  assert.equal((await post()).status,enabled?201:503);
 }
 assert.equal(mutations,1);
});
