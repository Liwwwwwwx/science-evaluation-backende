const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {randomUUID} = require('node:crypto');
const {Pool} = require('pg');
const {createRuleRepository} = require('../src/scoring/rule-repository');
const {createRuleService,builtinRule} = require('../src/scoring/rules');
const {createScoringService} = require('../src/scoring/service');
const {CHECKS} = require('../src/scoring/delivery-review');
const {createUnifiedEvaluationService} = require('../src/runs/unified-evaluation.service');
const {createUnifiedEvaluationRepository} = require('../src/runs/unified-evaluation.repository');
const socket=process.env.EVALUATION_RULES_TEST_PG_SOCKET || '';
test('隔离PG：规则版本、发布生效、并发冲突、审计、运行快照及重评保持原规则',{skip:!socket},async t=>{
 assert.match(socket,/^\/tmp\/evaluation-auth-pg\.[A-Za-z0-9]+$/);
 const pool=new Pool({host:socket,port:55481,database:'science_admin'});t.after(()=>pool.end());
 for(const file of ['004_evaluation_scoring_rules.sql','003_evaluation_runs.sql'])await pool.query(fs.readFileSync(path.join(__dirname,'../migrations',file),'utf8'));
 const rules=createRuleService(createRuleRepository(pool));assert.equal((await rules.catalog()).active.id,'builtin-v1');
 const firstInput={name:'规则验收第一版',changeNote:'验证自定义权重',config:structuredClone(builtinRule().config)};firstInput.config.weights={readability:20,professionalism:60,visualAids:20};
 const id1=randomUUID();let one=await rules.create(firstInput,'test-writer',id1);
 assert.equal((await rules.create(firstInput,'test-writer',id1)).id,id1);
 await assert.rejects(rules.create({...firstInput,name:'不同请求'},'test-writer',id1),e=>e.status===409);
 one=await rules.change(id1,'save',{...firstInput,revision:one.revision},'test-writer');
 await assert.rejects(rules.change(id1,'save',{...firstInput,revision:1},'test-writer'),e=>e.status===409);
 one=await rules.change(id1,'publish',{revision:one.revision},'test-writer');
 await assert.rejects(rules.change(id1,'save',{...firstInput,revision:one.revision},'test-writer'),e=>e.status===409);
 await rules.change(id1,'activate',{revision:one.revision,stateRevision:0},'test-writer');
 await assert.rejects(rules.change(id1,'archive',{revision:one.revision},'test-writer'),e=>e.status===409);
 const oldPolicy=await rules.activeSnapshot();assert.equal(oldPolicy.id,id1);
 let calls=0,extracts=0;const resolvers=[];const answer='材料热导率单位 W/(m·K)，描述导热能力。';
 const clients=Object.fromEntries(['deepSeekScore','qwenScore'].map(k=>[k,{model:k,isConfigured:()=>true,callJson:async p=>{
  if(p.includes('仅根据题目')){extracts++;return{requirements:[{requirement:'说明单位',critical:true}],visualAidsApplicable:false,visualAidsReason:'不需要图表'};}
  return{dimensions:Object.fromEntries(['readability','professionalism','visualAids'].map(k=>[k,{score:80,note:'表述清楚',evidence:'W/(m·K)'}])),requirements:[{id:'R1',status:'met',evidence:'W/(m·K)',note:'已说明单位'}],comment:'说明清楚',suggestions:['可补充条件'],deliveryReview:{status:'delivered',note:'有实际回答',evidence:answer},experienceChecks:Object.keys(CHECKS).map(id=>({id,status:'passed',note:'未发现此问题'}))};
 }}]));
 const repository=createUnifiedEvaluationRepository({pgPool:pool});const evaluator={scoreMode:'none',startQuestionRun:async(_,{onText})=>{calls++;onText(answer);return{run:{id:randomUUID()},completion:new Promise(resolve=>resolvers.push(resolve))};}};
 const make=()=>createUnifiedEvaluationService({evaluators:{literature:evaluator},repository,scoring:createScoringService({clients,rules})});
 const service=make();const started=await service.createRun({serviceKey:'literature',question:'请说明材料热导率的单位和含义。'},{scope:'writer',key:'first'});
 assert.equal((await repository.get(started.runId)).run.ruleSnapshot.hash,oldPolicy.hash,'创建时即持久化规则，不能等结束再读取当前版');
 let two=await rules.create({...firstInput,name:'规则验收第二版',changeNote:'切换后仅新任务生效',config:builtinRule().config},'test-writer',randomUUID());two=await rules.change(two.id,'publish',{revision:two.revision},'test-writer');
 await rules.change(two.id,'activate',{revision:two.revision,stateRevision:1},'test-writer');const currentPolicy=await rules.activeSnapshot();assert.notEqual(currentPolicy.hash,oldPolicy.hash);
 resolvers[0]({status:'done',elapsedMs:3000});
 async function wait(svc,id){for(let i=0;i<400;i++){const v=await svc.get(id);if(v.run?.scoring?.finishedAt)return v;await new Promise(r=>setTimeout(r,5));}throw Error('等待评分超时');}
 const done=await wait(service,started.runId);assert.equal(done.run.scoring.ruleSnapshot.hash,oldPolicy.hash);assert.equal(done.scores.deepSeekScore.status,'ready');
 const restarted=make();await restarted.rescore(started.runId,{scope:'writer',key:'again'});const rescored=await wait(restarted,started.runId);
 assert.equal(rescored.run.scoring.ruleSnapshot.id,id1);assert.equal(rescored.run.scoring.history.length,1);assert.equal(calls,1);assert.equal(extracts,1);
 const next=await make().createRun({serviceKey:'literature',question:'请说明材料热导率的单位和含义。'},{scope:'writer',key:'second'});assert.equal((await repository.get(next.runId)).run.ruleSnapshot.id,two.id);resolvers[1]({status:'done'});
 const cat=await rules.catalog();const race=await Promise.allSettled([rules.change(id1,'activate',{revision:one.revision,stateRevision:cat.stateRevision},'actor-a'),rules.change(two.id,'activate',{revision:two.revision,stateRevision:cat.stateRevision},'actor-b')]);assert.equal(race.filter(r=>r.status==='fulfilled').length,1);
 assert.ok((await rules.catalog()).events.some(e=>e.action==='activated' && ['actor-a','actor-b'].includes(e.actor)));
 // 等最后一个评分持久化完成后再关闭连接池。
 await wait(make(),next.runId);
});
test('规则仓储拒绝其他数据库',async()=>{
 const repo=createRuleRepository({query:async()=>({rows:[{name:'other_database'}]})});await assert.rejects(repo.active(),/science_admin/);
 const uninitialized=createRuleRepository({query:async sql=>({rows:sql.includes('current_database()')?[{name:'science_admin'}]:[]})});await assert.rejects(uninitialized.active(),/未初始化/);
});
