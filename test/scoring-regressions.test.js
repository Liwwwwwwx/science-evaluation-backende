const {test} = require('node:test');
const assert = require('node:assert/strict');
const {evidence,passages} = require('../src/scoring/evidence');
const {createScoringService,normalizeRubric,normalizeJudge} = require('../src/scoring/service');
const {createJudgeClient} = require('../src/scoring/clients');
const {builtinRule} = require('../src/scoring/rules');
const {CHECKS} = require('../src/scoring/delivery-review');

const answer='热导率单位为 W/(m·K)，描述材料传导热量的能力。';
const question='说明热导率单位和含义，不要输出安装过程。';
const data={requirements:[{requirement:'解释单位和含义',critical:true,kind:'deliverable',scope:'output'},{requirement:'不输出安装过程',critical:false,kind:'constraint',scope:'all'}],visualAidsApplicable:false,visualAidsReason:'简单说明无需图表'};
const input=()=>({answer,structured:'{}',truncated:false,process:{recorded:true,truncated:false,messages:[{id:'P1',text:'正在整理说明。'},{id:'P2',text:'说明正文已整理完成。'}]}});
const citation=()=>[{source:'answer',quote:'W/(m·K)'}];
function judgement(){return{
 dimensions:Object.fromEntries(['readability','professionalism','visualAids'].map(k=>[k,{score:k==='visualAids'?null:90,note:'单位含义清楚',evidence:citation()}])),
 requirements:[{id:'R1',status:'met',evidence:citation(),note:'包含单位与含义'},{id:'R2',status:'met',evidence:[],verification:{method:'scope_review',scope:'all'},note:'检查完整输出和已记录过程，没有安装说明'}],
 comment:'简洁清楚',highlights:['包含单位和含义'],gaps:['可补充条件'],suggestions:['补充温度条件'],
 deliveryReview:{status:'delivered',evidence:citation(),note:'实际解释已交付'},
 experienceChecks:Object.keys(CHECKS).map(id=>({id,status:'passed',evidence:[],note:'未发现此问题'})),
};}
const rubric=()=>normalizeRubric(data,question,'fixture');
const job=()=>({question,answer,serviceKey:'literature',run:{status:'done',ruleSnapshot:builtinRule(),details:{process:{messages:input().process.messages,events:[],truncated:false}}}});
const mock=fn=>({model:'fixture',isConfigured:()=>true,callJson:fn});

test('证据允许可核验的来源对象和旧字段包装，拒绝省略号、错误来源和拼接消息',()=>{
 assert.equal(evidence("answer: 'W/(m·K)'",input()).valid,true);
 assert.equal(evidence("P1: '正在整理说明。'",input(),'all').valid,true);
 assert.equal(evidence([{source:'P1',quote:'正在整理说明。'},{source:'P2',quote:'说明正文已整理完成。'}],input(),'all').refs.length,2);
 for(const value of ['热导率单位为...传导热量的能力',"P1: '正在整理说明。'; P2: '说明正文已整理完成。'",{source:'P1',quote:'W/(m·K)'},{source:'answer',quote:'题面中声称已交付'}])assert.equal(evidence(value,input(),'all').valid,false);
 assert.equal(evidence([{source:'answer',quote:'W/(m·K)'},{source:'answer',quote:'不存在的内容'}],input()).valid,false);
 assert.equal(evidence('a'.repeat(501),{answer:'a'.repeat(600)}).valid,false);
 assert.equal(evidence({source:'P1',quote:'正在整理说明。'},input()).valid,false);
});

test('片段编号只解析实际原文，拒绝不存在或跨来源编号，长行和Unicode不丢内容',()=>{
 const i=input();i.answer='a'.repeat(299)+'🧪'+'b'.repeat(320)+'\n\n下一行原文。';
 const chunks=passages(i).filter(p=>p.source==='answer');assert.equal(chunks.map(p=>p.text).join(''),i.answer);assert.ok(chunks.every(p=>!/[\uD800-\uDBFF]$/.test(p.text)));
 assert.equal(evidence([chunks[0].id],i).text,chunks[0].text);assert.equal(evidence(['P1:0'],i,'all').text,'正在整理说明。');assert.equal(evidence(['P1:0'],i).valid,false);assert.equal(evidence(['answer:999999'],i).valid,false);
 assert.equal(evidence([chunks[0].id,'answer:999999'],i).valid,false);assert.equal(evidence([{ref:chunks[0].id}],i).valid,true);
});

test('否定约束通过范围核验，不要求引用不存在的文字；无法伪造成果证据',()=>{
 const q=normalizeJudge(judgement(),rubric(),input(),{status:'passed'},builtinRule());
 assert.equal(q.taskCompletion.status,'completed');assert.equal(q.qualification.status,'qualified');assert.equal(q.taskCompletion.requirements[1].verification.method,'scope_review');
 const withoutScope=judgement();delete withoutScope.requirements[1].verification.scope;
 const frozenScope=normalizeJudge(withoutScope,rubric(),input(),{status:'passed'},builtinRule());assert.equal(frozenScope.qualification.status,'qualified');assert.equal(frozenScope.taskCompletion.requirements[1].verification.scope,'all');
 for(const mutate of [j=>j.requirements[0]={...j.requirements[0],evidence:[],verification:{method:'scope_review',scope:'output'}},j=>j.requirements[1].verification.scope='output']){
  const j=judgement();mutate(j);const q=normalizeJudge(j,rubric(),input(),{status:'passed'},builtinRule());assert.equal(q.qualification.status,'unclear');assert.ok(q.evaluationIssues.length);
 }
 for(const i of [{...input(),truncated:true},{...input(),process:{...input().process,recorded:false}},{...input(),process:{...input().process,truncated:true}}]){
  const q=normalizeJudge(judgement(),rubric(),i,{status:'passed'},builtinRule());assert.equal(q.qualification.status,'unclear');
 }
});

test('评委引用错误保留为不确定，不把完整答案判为内容缺失',()=>{
 const j=judgement();j.requirements[0].evidence=[{source:'answer',quote:'热导率单位...解释完整'}];
 const q=normalizeJudge(j,rubric(),input(),{status:'passed'},builtinRule());
 assert.equal(q.total,90);assert.equal(q.taskCompletion.status,'unclear');assert.equal(q.qualification.status,'unclear');assert.equal(q.taskCompletion.qualified,false);assert.equal(q.evaluationIssues[0].path,'requirements.R1');
 const old=rubric();delete old.evidenceVersion;for(const item of old.requirements){delete item.kind;delete item.scope;}
 assert.equal(normalizeJudge(j,old,input(),{status:'passed'},builtinRule()).qualification.status,'unclear');
});

test('约束和交付分别判断：非关键体验约束不能否认已交付，关键约束仍能阻止合格',()=>{
 const i=input();i.process.messages.push({id:'P3',text:'先安装依赖再输出结果。'});
 const j=judgement();j.requirements[1]={id:'R2',status:'missing',evidence:[{source:'P3',quote:'先安装依赖再输出结果。'}],note:'过程含安装细节'};
 const r=rubric();let q=normalizeJudge(j,r,i,{status:'passed'},builtinRule());assert.equal(q.taskCompletion.status,'completed');assert.equal(q.qualification.status,'qualified');assert.equal(q.taskCompletion.requirements[1].status,'missing');
 r.requirements[1].critical=true;q=normalizeJudge(j,r,i,{status:'passed'},builtinRule());assert.equal(q.taskCompletion.status,'completed');assert.equal(q.qualification.status,'not_qualified');
});

test('实际JSON解析失败进入唯一一次修正，不能截取第一个对象或记零',async()=>{
 let calls=0;
 const client=createJudgeClient({apiKey:'fixture-key',baseUrl:'https://fixture.test',model:'fixture',fetch:async(_,options)=>{
  const prompt=JSON.parse(options.body).messages[1].content;
  if(prompt.startsWith('仅根据题目'))return new Response(JSON.stringify({choices:[{finish_reason:'stop',message:{content:JSON.stringify(data)}}]}));
  calls++;return new Response(JSON.stringify({choices:[{finish_reason:'stop',message:{content:calls===1?'{}{}':JSON.stringify(judgement())}}]}));
 }});
 const r=await createScoringService({clients:{deepSeekScore:client}}).score(job());
 assert.equal(calls,2);assert.equal(r.scores.deepSeekScore.status,'ready');assert.equal(r.scores.deepSeekScore.attempts,2);assert.equal(r.scores.deepSeekScore.repairStatus,'repaired');assert.equal(r.scores.deepSeekScore.quality.qualification.status,'qualified');
});

test('证据失败独立修正且沿用冻结要求；修正仍失败时保留待复核结果',async()=>{
 for(const repair of [true,false]){
  let calls=0;const prompts=[];
  const client=mock(async p=>{if(p.startsWith('仅根据题目'))return data;prompts.push(p);calls++;const j=judgement();if(!repair||calls===1)j.deliveryReview.evidence=[{source:'answer',quote:'原文...已交付'}];return j;});
  const r=await createScoringService({clients:{deepSeekScore:client}}).score(job());const s=r.scores.deepSeekScore;
  assert.equal(calls,2);assert.equal(s.status,'ready');assert.equal(s.quality.qualification.status,repair?'qualified':'unclear');assert.equal(s.repairStatus,repair?'repaired':'needs_review');assert.ok(prompts[1].includes('deliveryReview:EVIDENCE_INVALID'));assert.ok(prompts.every(p=>p.includes(JSON.stringify(r.scoring.rubric))));
 }
});

test('多次无效JSON最多两次，HTTP失败与超时不重发，不泄露上游内容',async()=>{
 for(const mode of ['json','http','timeout']){
  let calls=0;
  const client=createJudgeClient({apiKey:'fixture-key',baseUrl:'https://fixture.test',model:'fixture',timeoutMs:20,fetch:async(_,options)=>{
   calls++;
   if(mode==='http')return new Response('private-upstream-detail',{status:401});
   if(mode==='timeout')return new Promise((_,reject)=>options.signal.addEventListener('abort',()=>reject(new Error('private-upstream-detail')),{once:true}));
   return new Response(JSON.stringify({choices:[{finish_reason:'stop',message:{content:'{}{}'}}]}));
  }});
  const j=job();j.run.scoring={rubric:{...rubric(),ruleHash:j.run.ruleSnapshot.hash}};
  const r=await createScoringService({clients:{deepSeekScore:client},timeoutMs:50}).score(j);
  assert.equal(calls,mode==='json'?2:1);assert.equal(r.scores.deepSeekScore.status,'failed');assert.equal(r.scores.deepSeekScore.quality,null);assert.ok(!JSON.stringify(r).includes('private-upstream-detail'));
 }
});

test('再次请求失败时保留已得到的不确定结果，已保存的旧清单不被重写',async()=>{
 const j=job();const old=rubric();delete old.evidenceVersion;old.requirements=old.requirements.slice(0,1);for(const r of old.requirements){delete r.kind;delete r.scope;}old.ruleHash=j.run.ruleSnapshot.hash;j.run.scoring={rubric:old};const before=structuredClone(old);
 let calls=0;const c=mock(async()=>{calls++;if(calls===2)throw Error('network-error');const value=judgement();value.deliveryReview.evidence='不存在的证据';value.requirements=value.requirements.slice(0,1);return value;});
 const result=await createScoringService({clients:{deepSeekScore:c}}).score(j);
 assert.equal(result.scores.deepSeekScore.status,'ready');assert.equal(result.scores.deepSeekScore.quality.qualification.status,'unclear');assert.equal(result.scores.deepSeekScore.repairStatus,'needs_review');assert.equal(calls,2);assert.deepEqual(old,before);assert.deepEqual(result.scoring.rubric,before);
});
