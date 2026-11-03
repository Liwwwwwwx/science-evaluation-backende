const { setupRunOwnership } = require('./run-ownership-fixture');
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
const { createLiteratureEvaluator } = require('../src/runs/literature-evaluator');
const { EventEmitter } = require('node:events');

const socket = process.env.EVALUATION_RUN_TEST_PG_SOCKET || '';
test('隔离 PostgreSQL：领域题执行/SSE断线重连/幂等/历史及重启快照', { skip: !socket }, async t => {
  if (!/^\/tmp\/evaluation-auth-pg\.[A-Za-z0-9]+$/.test(socket)) throw Error('仅允许临时数据库');
  const pool = new Pool({ host: socket, port: 55481, database: 'science_admin' }); t.after(() => pool.end());
  await pool.query(fs.readFileSync(path.join(__dirname, '../migrations/003_evaluation_runs.sql'), 'utf8'));
  await setupRunOwnership(pool);
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
  let aircraftCalls = 0;
  const aircraftEvaluator = createLiteratureEvaluator({ serviceKey: 'literature-aircraft', url: 'ws://127.0.0.1:1108/start', createSocket: () => {
    const socket = new EventEmitter(); socket.addEventListener = socket.on;
    socket.close = () => socket.emit('close');
    socket.send = payload => {
      aircraftCalls++; assert.match(JSON.parse(payload).taskid, /^evaluation-literature-aircraft-/);
      socket.emit('message', {data:'[start]'});
      setTimeout(() => { socket.emit('message', {data:'航空文献回答与公式 $q=mc\\Delta T$[end]'}); socket.emit('close'); }, 60);
    };
    queueMicrotask(() => socket.emit('open')); return socket;
  } });
  const createService = () => createUnifiedEvaluationService({evaluators:{literature:evaluator,'literature-aircraft':aircraftEvaluator},repository,resolveQuestion:createRunQuestionResolver(questionRepository)});
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

  // 同一领域题可在另一个服务执行，服务切换不能复用旧请求的幂等键。
  await pool.query("UPDATE eval_questions SET status='active',criteria=NULL WHERE id='domain-question'");
  const aircraftInput={...input,serviceKey:'literature-aircraft'};
  assert.equal((await post(aircraftInput)).status,409);
  const aircraftPair=await Promise.all([post(aircraftInput,'aircraft-once'),post(aircraftInput,'aircraft-once')]);
  assert.ok(aircraftPair.every(r=>r.status===201));
  const aircraftCreated=await Promise.all(aircraftPair.map(r=>r.json()));
  assert.equal(aircraftCreated[0].runId,aircraftCreated[1].runId);assert.equal(aircraftCalls,1);
  const aircraftId=aircraftCreated[0].runId;
  const abort=new AbortController();
  const aircraftSse=await fetch(base+`/runs/${aircraftId}/events`,{headers,signal:abort.signal});
  const aircraftReader=aircraftSse.body.getReader();await aircraftReader.read();abort.abort();await aircraftReader.cancel().catch(()=>{});
  assert.match(await(await fetch(base+`/runs/${aircraftId}/events`,{headers})).text(),/event: done/);
  const aircraftSaved=await(await fetch(base+`/runs/${aircraftId}`,{headers})).json();
  assert.equal(aircraftSaved.serviceKey,'literature-aircraft');assert.equal(aircraftSaved.status,'done');
  assert.equal(aircraftSaved.answer,'[start]航空文献回答与公式 $q=mc\\Delta T$[end]');
  assert.equal(aircraftSaved.executionStatus,'succeeded');assert.equal(aircraftSaved.scoringStatus,'absent');
  assert.equal(aircraftSaved.questionId,'domain-question');assert.equal(aircraftSaved.datasetVersion,'gen-v1');
  const afterAircraftRestart=await startServer(createService());
  const aircraftRestored=await(await fetch(afterAircraftRestart+`/runs/${aircraftId}`,{headers})).json();
  assert.equal(aircraftRestored.answer,aircraftSaved.answer);assert.equal(aircraftRestored.recoveryState,'snapshot_only');
  const replay=await fetch(afterAircraftRestart+'/runs',{method:'POST',headers:{...headers,'Idempotency-Key':'aircraft-once'},body:JSON.stringify(aircraftInput)});
  const replayed=await replay.json();assert.equal(replayed.runId,aircraftId);assert.equal(replayed.reused,true);assert.equal(aircraftCalls,1);
  assert.equal((await(await fetch(afterAircraftRestart+'/runs',{headers})).json()).total,3);
  // 旧服务题仍保持服务约束，跨服务不可执行；带专属规则的旧题仍被过滤。
  await pool.query("UPDATE eval_questions SET service_key='literature' WHERE id='domain-question'");
  assert.equal((await post(aircraftInput,'wrong-service')).status,409);
  assert.equal((await questionRepository.listQuestionsPaged({sourceType:'random',runnableFor:'literature-aircraft'})).total,0);
  await pool.query("UPDATE eval_questions SET service_key='literature-aircraft' WHERE id='domain-question'");
  assert.equal((await questionRepository.listQuestionsPaged({sourceType:'random',runnableFor:'literature-aircraft'})).total,1);
  assert.equal((await questionRepository.listQuestionsPaged({sourceType:'random',runnableFor:'literature'})).total,0);
});
