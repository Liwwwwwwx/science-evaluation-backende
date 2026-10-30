const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { Pool } = require('pg');
const { createApp } = require('../src/app');
const { createUnifiedEvaluationService } = require('../src/runs/unified-evaluation.service');
const { createUnifiedEvaluationRepository } = require('../src/runs/unified-evaluation.repository');
const { createRunQuestionResolver } = require('../src/runs/question-resolver');
const { createEvalQuestionBankRepository } = require('../src/question-bank/repository');

const socket = process.env.EVALUATION_RUN_TEST_PG_SOCKET || '';
test('隔离 PostgreSQL：领域题执行/SSE断线重连/幂等/历史及重启快照', { skip: !socket }, async t => {
  if (!/^\/tmp\/evaluation-auth-pg\.[A-Za-z0-9]+$/.test(socket)) throw Error('仅允许临时数据库');
  const pool = new Pool({ host: socket, port: 55481, database: 'science_admin' }); t.after(() => pool.end());
  await pool.query(fs.readFileSync(path.join(__dirname, '../migrations/003_evaluation_runs.sql'), 'utf8'));
  await pool.query(`CREATE TABLE eval_questions (id text, layer text, service_key text, source_type text, domain_key text, question text, dataset_version text, status text, criteria jsonb, created_at timestamptz DEFAULT now())`);
  const text = '请检索芯片封装导热界面材料相关文献。';
  await pool.query(`INSERT INTO eval_questions VALUES ('domain-question','base',NULL,'random','chip-packaging',$1,'gen-v1','active',NULL)`, [text]);
  const questionRepository = createEvalQuestionBankRepository({pool});
  const repository = createUnifiedEvaluationRepository({pgPool:pool}); let calls = 0;
  const evaluator = {
    async startQuestionRun(_, {onText}) {
      calls++; onText('[start]');
      return {run:{id:'native-'+calls},completion:new Promise(resolve=>{
        setTimeout(()=>onText('真实格式的模拟回答'),30);
        setTimeout(()=>{onText('[end]');resolve({status:'done'});},120);
      })};
    },
    async getRunQuality(){return {status:'absent'};},
  };
  const createService = () => createUnifiedEvaluationService({evaluators:{literature:evaluator},repository,resolveQuestion:createRunQuestionResolver(questionRepository)});
  const authService = {authenticate:async token=>{if(!token)throw Object.assign(Error('请登录'),{status:401});return {id:'1',permissions:['team-services:read','team-services:write']};}};
  const startServer = async evaluations => {
    const server=createApp({token:'x'.repeat(32),authService,evaluations,runWriteEnabled:true,publicOrigin:'http://localhost'});
    await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));t.after(()=>server.close());
    return `http://127.0.0.1:${server.address().port}/api/evaluation/unified`;
  };
  const base=await startServer(createService());const headers={cookie:'evaluation_session=test',origin:'http://localhost','content-type':'application/json'};
  const input={serviceKey:'literature',question:text,questionId:'domain-question',datasetVersion:'gen-v1',sourceType:'random'};
  const post=(body,key='once')=>fetch(base+'/runs',{method:'POST',headers:{...headers,'Idempotency-Key':key},body:JSON.stringify(body)});
  const pair=await Promise.all([post(input),post(input)]);assert.ok(pair.every(r=>r.status===201));
  const created=await Promise.all(pair.map(r=>r.json()));assert.equal(created[0].runId,created[1].runId);assert.equal(calls,1);
  const id=created[0].runId;
  const controller=new AbortController();const interrupted=await fetch(base+`/runs/${id}/events`,{headers,signal:controller.signal});
  const reader=interrupted.body.getReader();await reader.read();controller.abort();await reader.cancel().catch(()=>{});
  const response=await fetch(base+`/runs/${id}/events`,{headers});assert.equal(response.status,200);const stream=await response.text();
  assert.match(stream,/event: snapshot/);assert.match(stream,/event: done/);
  const saved=await (await fetch(base+`/runs/${id}`,{headers})).json();
  assert.equal(saved.answer,'[start]真实格式的模拟回答[end]');assert.equal(saved.status,'done');assert.equal(saved.scoringStatus,'absent');assert.equal(saved.questionId,'domain-question');
  const restarted=await startServer(createService());
  const restored=await (await fetch(restarted+`/runs/${id}`,{headers})).json();assert.equal(restored.answer,saved.answer);assert.equal(restored.recoveryState,'snapshot_only');
  assert.equal((await (await fetch(restarted+'/runs',{headers})).json()).total,1);
  const snapshotStream=await (await fetch(restarted+`/runs/${id}/events`,{headers})).text();assert.match(snapshotStream,/"live":false/);
  assert.equal((await post({...input,question:'另一道不同的题目需要检索文献。'})).status,409);
  assert.equal((await post(input,'')).status,400);
  assert.equal((await post({...input,question:'被篡改的题面需要检索文献。'},'tamper')).status,409);
  assert.equal((await post({...input,serviceKey:'alloy'},'unsupported')).status,400);
  await pool.query("UPDATE eval_questions SET status='retired' WHERE id='domain-question'");
  assert.equal((await post(input)).status,201);assert.equal((await post(input,'retired')).status,409);assert.equal(calls,1);
  await pool.query("UPDATE eval_questions SET status='active',criteria='{}'::jsonb WHERE id='domain-question'");
  assert.equal((await post(input,'rules')).status,409);
  assert.equal((await questionRepository.listQuestionsPaged({sourceType:'random',runnableFor:'literature'})).total,0);
  assert.equal((await post({serviceKey:'literature',question:'临时问题也应保存完整回答。'},'temporary')).status,201);
  await new Promise(resolve=>setTimeout(resolve,160));assert.equal(calls,2);
});
