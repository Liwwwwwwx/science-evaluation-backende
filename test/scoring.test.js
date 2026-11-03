const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createScoringService, normalizeRubric, normalizeJudge, packInput } = require('../src/scoring/service');
const { checkMarkdown } = require('../src/scoring/markdown');
const { createJudgeClient, createScoringClients } = require('../src/scoring/clients');
const { createApp } = require('../src/app');
const rubricData = { requirements:[{requirement:'提供单位',critical:true},{requirement:'解释含义',critical:false}],visualAidsApplicable:false,visualAidsReason:'简单说明不需要图表' };
const answer = '热导率的单位为 W/(m·K)，表示材料传导热量的能力。';
function judgement(){return { dimensions:Object.fromEntries(['readability','professionalism','visualAids'].map((k,i)=>[k,{score:80+i*10,note:'表述和单位清楚',evidence:'W/(m·K)'}])), requirements:[{id:'R1',status:'met',evidence:'W/(m·K)',note:'已说明单位'},{id:'R2',status:'met',evidence:'材料传导热量的能力',note:'已解释'}],comment:'单位清楚，含义简洁',highlights:['单位清楚'],gaps:['可提供适用条件'],suggestions:['补充温度依赖说明'] };}
const client = (fn, model='test')=>({model,isConfigured:()=>true,callJson:fn});
const job = ()=>({question:'说明热导率单位和含义',answer,run:{status:'done'}});
test('双模型独立使用同一冻结清单，权重程序归一化且逐模型更新',async()=>{
 let rubricCalls=0,judgeCalls=0;const prompts=[],updates=[];
 const clients=Object.fromEntries(['deepSeekScore','qwenScore'].map(k=>[k,client(async prompt=>{prompts.push(prompt);if(prompt.includes('仅根据题目')){rubricCalls++; assert.ok(!prompt.includes(answer));return rubricData;}judgeCalls++;return judgement();},k)]));
 const result=await createScoringService({clients}).score(job(),v=>updates.push(v));
 assert.equal(rubricCalls,1);assert.equal(judgeCalls,2);assert.equal(result.scores.deepSeekScore.quality.total,85);assert.equal(result.scores.qwenScore.quality.total,85);
 assert.equal(result.scores.deepSeekScore.quality.dimensions.visualAids.score,null);assert.equal(result.scores.deepSeekScore.quality.dimensions.readability.weight,.5);
 assert.equal(result.scores.deepSeekScore.quality.taskCompletion.status,'completed');assert.ok(result.scoring.finishedAt);assert.ok(updates.some(v=>Object.values(v.scores).some(s=>s.status==='pending')));
 assert.ok(prompts.slice(1).every(p=>p.includes(JSON.stringify(result.scoring.rubric))));
});
test('证据不在原文、遗漏项与截断缺失不伪造完成；关键缺失不被高分抵消',()=>{
 const rubric=normalizeRubric(rubricData,'题目','test'),input={answer,structured:'{}',truncated:false},value=judgement();value.requirements[0].evidence='虚构证据';const result=normalizeJudge(value,rubric,input,{status:'passed'});
 assert.equal(result.taskCompletion.requirements[0].status,'unclear');assert.equal(result.taskCompletion.qualified,false);assert.equal(result.total,85);
 value.requirements[0].status='missing';assert.equal(normalizeJudge(value,rubric,{...input,truncated:true},{status:'passed'}).taskCompletion.requirements[0].status,'unclear');
 value.requirements=[];assert.equal(normalizeJudge(value,rubric,input,{status:'passed'}).taskCompletion.status,'unclear');value.dimensions.readability.score=101;assert.throws(()=>normalizeJudge(value,rubric,input,{status:'passed'}));
});
test('Markdown原文机检识别KaTeX、开放围栏、链接与HTML，代码/货币/文献编号不误报',async()=>{
 const good=await checkMarkdown('# 单位\n\n公式 $K_{\\mathrm{TIM}}$ 与 \\(R_c\\)\n\n`$\\wrong$`\n\n```text\n$$\\wrong\n```\n\n价格$20元与$30元。\n\\[12\\] 文献标题\n\n|A|B|\n|-|-|\n|1|2|');assert.equal(good.status,'passed',JSON.stringify(good));
 const bad=await checkMarkdown('公式 $\\notARealCommand{x}$\n\n<div>隐藏</div>\n\n![坏图](javascript:alert)\n\n```js\ncode');assert.equal(bad.status,'failed');for(const id of ['MATH_INVALID','HTML_HIDDEN','URL_UNSAFE','FENCE_OPEN'])assert.ok(bad.issues.some(i=>i.id===id),id);
 assert.ok(bad.issues.every(i=>i.line>0&&i.snippet&&i.suggestion));assert.equal((await checkMarkdown('完整文字',{truncated:true})).status,'not_evaluable');assert.equal((await checkMarkdown('')).status,'not_evaluable');
});
test('评分缺配置/单模型失败/超时与并发限流不产生零分',async()=>{
 const missing=createScoringClients({}),absent=await createScoringService({clients:missing}).score(job());assert.ok(Object.values(absent.scores).every(s=>s.status==='unavailable'&&s.quality===null));assert.equal(absent.markdownSyntax.status,'passed');
 const clients={deepSeekScore:client(async p=>p.includes('仅根据题目')?rubricData:judgement()),qwenScore:client(async()=>{throw Error('sensitive upstream body');})};const partial=await createScoringService({clients}).score(job());assert.equal(partial.scores.deepSeekScore.status,'ready');assert.equal(partial.scores.qwenScore.status,'failed');assert.ok(!JSON.stringify(partial).includes('sensitive'));
 const timeout=await createScoringService({clients:{deepSeekScore:client(()=>new Promise(()=>{}))},timeoutMs:15}).score(job());assert.equal(timeout.scores.deepSeekScore.status,'failed');assert.ok(timeout.scoring.finishedAt);
 assert.equal((await createScoringService({clients,maxActive:0}).score(job())).scores.deepSeekScore.status,'failed');const failedJob=job();failedJob.run.status='error';assert.equal((await createScoringService({clients}).score(failedJob)).scores.deepSeekScore.status,'skipped');
});
test('评分客户端发送JSON参数并拒绝截断/无内容，不把凭据写入提示',async()=>{
 let body;const c=createJudgeClient({apiKey:'secret-test',baseUrl:'https://example.test/v1',model:'qwen-test',qwen:true,fetch:async(url,options)=>{assert.equal(url,'https://example.test/v1/chat/completions');body=JSON.parse(options.body);return new Response(JSON.stringify({choices:[{finish_reason:'stop',message:{content:'{"ok":true}'}}]}));}});assert.deepEqual(await c.callJson('输出JSON'),{ok:true});assert.deepEqual(body.response_format,{type:'json_object'});assert.equal(body.enable_thinking,false);assert.ok(!JSON.stringify(body).includes('secret-test'));
 for(const response of [{choices:[{finish_reason:'length',message:{content:'{}'}}]},{choices:[{finish_reason:'stop',message:{content:''}}]}]){const c=createJudgeClient({apiKey:'x',baseUrl:'https://e.test',model:'m',fetch:async()=>new Response(JSON.stringify(response))});await assert.rejects(c.callJson('JSON'));}
});
test('评分HTTP沿用会话/读写权限/同源/写开关，GET不触发评分',async t=>{
 let calls=0;const id='11111111-1111-4111-8111-111111111111';const evaluations={assertRunAccess:async()=>({owned:true}),scoringEnabled:true,get:async()=>({runId:id,run:{status:'done'}}),rescore:async(_,options)=>{calls++;assert.equal(options.key,'once');return {runId:id};},questionScores:async items=>({items})};
 const authService={authenticate:async token=>{if(!token)throw Object.assign(Error('请登录'),{status:401});return {id:token,permissions:token==='reader'?['team-services:read']:['team-services:read','team-services:write']};}};
 for(const enabled of [true,false]){const server=createApp({token:'x'.repeat(32),authService,evaluations,runWriteEnabled:enabled,publicOrigin:'http://localhost'});await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));t.after(()=>server.close());const base=`http://127.0.0.1:${server.address().port}/api/evaluation/unified`,post=(user='writer',origin='http://localhost')=>fetch(`${base}/runs/${id}/score`,{method:'POST',headers:{cookie:`evaluation_session=${user}`,origin,'content-type':'application/json','Idempotency-Key':'once'},body:'{}'});
 assert.equal((await fetch(`${base}/runs/${id}/score`,{method:'POST'})).status,401);assert.equal((await post('reader')).status,403);assert.equal((await post('writer','http://evil.test')).status,403);assert.equal((await post()).status,enabled?202:503);assert.equal((await(await fetch(`${base}/runs/${id}`,{headers:{cookie:'evaluation_session=reader'}})).json()).canRescore,false);assert.equal((await fetch(`${base}/question-scores?items=bad`,{headers:{cookie:'evaluation_session=reader'}})).status,400);}
 assert.equal(calls,1);
});

test('未闭合数学环境/行内公式/GFM多余单元格给提示；结构化敏感字段不进入评分材料',async()=>{
 for(const [text,id] of [['$$\nx+1','DISPLAY_MATH_OPEN'],['\\begin{aligned}a&=b','MATH_ENV_OPEN'],['未闭合 $K_{TIM}','INLINE_MATH_OPEN'],['|A|B|\n|-|-|\n|1|2|3|','TABLE_EXTRA_CELLS']])assert.ok((await checkMarkdown(text)).issues.some(v=>v.id===id),id);
 const input=packInput({answer:'普通答案',run:{details:{result:{api_key:'do-not-send',nested:{Authorization:'Bearer hidden'},url:'https://user:pass@example.test/a?token=secret&ok=1'}}}});assert.ok(!JSON.stringify(input).includes('do-not-send'));assert.ok(!input.structured.includes('Bearer hidden'));assert.ok(!input.structured.includes('user:pass'));assert.ok(!input.structured.includes('token=secret'));
});
test('模型结构不合法只重试一次，不能把null适用分数自动记零',async()=>{
 let attempts=0;const clients={deepSeekScore:client(async p=>{if(p.includes('仅根据题目'))return {...rubricData,visualAidsApplicable:true};attempts++;const value=judgement();value.dimensions.visualAids.score=attempts===1?null:0;return value;})};
 const result=await createScoringService({clients}).score(job());assert.equal(attempts,2);assert.equal(result.scores.deepSeekScore.status,'ready');assert.equal(result.scores.deepSeekScore.quality.dimensions.visualAids.score,0);
});
test('评分异常不把成功执行标失败；快速结束时取消旧保存定时器',async()=>{
 const {createUnifiedEvaluationService}=require('../src/runs/unified-evaluation.service');let saves=0,record;
 const repository={create:async value=>{record=structuredClone(value);},save:async value=>{saves++;record=structuredClone(value);},get:async()=>record};
 const service=createUnifiedEvaluationService({repository,scoring:{pending:()=>({deepSeekScore:{status:'pending'}}),score:async()=>{throw Error('judge infrastructure failed');}},evaluators:{literature:{scoreMode:'none',startQuestionRun:async(_,{onText})=>{onText('保留的成功服务回答');return {run:{id:'native'},completion:Promise.resolve({status:'done'})};}}}});
 const created=await service.start({serviceKey:'literature',question:'说明热导率单位和含义。'});
 for(let i=0;i<50;i++){const value=await service.get(created.runId);if(value.status==='done')break;await new Promise(r=>setTimeout(r,2));}
 const done=await service.get(created.runId);assert.equal(done.executionStatus,'succeeded');assert.equal(done.scoringStatus,'unknown');assert.equal(done.answer,'保留的成功服务回答');const count=saves;await new Promise(r=>setTimeout(r,1100));assert.equal(saves,count);
});

test('只有传输标记和进度不生成假零分；无正文但有结构化成果仍可评分',async()=>{
 let calls=0;const clients={deepSeekScore:client(async p=>{calls++;return p.includes('仅根据题目')?rubricData:judgement();})};
 const empty=await createScoringService({clients}).score({question:'说明热导率单位和含义',answer:'[start][end]',run:{status:'done',details:{progress:[{text:'执行完毕'}],snapshot:{ok:false}}}});assert.equal(empty.scores.deepSeekScore.status,'skipped');assert.equal(calls,0);
 const structured=await createScoringService({clients}).score({question:'说明热导率单位和含义',answer:'',run:{status:'done',details:{result:{unit:'W/(m·K)',meaning:'材料传导热量的能力'}}}});assert.equal(structured.scores.deepSeekScore.status,'ready');assert.equal(structured.scores.deepSeekScore.quality.taskCompletion.status,'completed');
});
