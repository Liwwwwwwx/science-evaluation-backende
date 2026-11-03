const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { Pool } = require('pg');
const { createApp } = require('../src/app');
const { createUnifiedEvaluationRepository } = require('../src/runs/unified-evaluation.repository');
const { createUnifiedEvaluationService } = require('../src/runs/unified-evaluation.service');

const socket = process.env.EVALUATION_OWNERSHIP_TEST_PG_SOCKET || '';
test('隔离数据库：旧记录归 admin，个人运行及所有入口隔离，团队记录共享且重测保留原结果', { skip: !socket }, async t => {
  assert.match(socket, /^\/tmp\/evaluation-ownership-pg\.[A-Za-z0-9]+$/);
  const pool = new Pool({ host: socket, port: 55487, database: 'science_evaluation' });
  t.after(() => pool.end());
  const first = await pool.connect(), second = await pool.connect();
  try {
    const [left,right] = await Promise.all([first.query('SELECT pg_backend_pid() AS pid'),second.query('SELECT pg_backend_pid() AS pid')]);
    assert.notEqual(left.rows[0].pid, right.rows[0].pid, '多连接验证需要两个独立 PostgreSQL 后端进程');
  } finally { first.release(); second.release(); }
  const migration = name => fs.readFileSync(path.join(__dirname, '../migrations', name), 'utf8');
  await pool.query('CREATE TABLE auth_users (id text PRIMARY KEY, username text NOT NULL UNIQUE)');
  await pool.query("INSERT INTO auth_users VALUES ('admin-id','admin'),('a','alice'),('b','bob')");
  await pool.query('CREATE TABLE eval_questions (id text, dataset_version text, domain_key text)');
  await pool.query(migration('003_evaluation_runs.sql'));
  await pool.query(migration('010_user_run_history.sql'));
  const old = randomUUID(), legacy = randomUUID(), team = randomUUID();
  await pool.query(`INSERT INTO unified_evaluation_runs (id,service_key,origin,question,status,started_at,run,answer)
    VALUES ($1,'literature','manual','旧个人题','done',now(),'{"status":"done"}','旧回答'),
           ($2,'literature','legacy','旧系统题','done',now(),'{"status":"done"}','旧系统回答'),
           ($3,'literature','automation','团队题','done',now(),'{"status":"done"}','团队回答')`, [old,legacy,team]);
  await pool.query("UPDATE unified_evaluation_runs SET idempotency_scope='evaluation-user:a', idempotency_key='old-key', idempotency_hash='old-hash' WHERE id=$1", [old]);
  await pool.query(migration('011_run_ownership.sql'));
  const client = await pool.connect();
  try {
    await assert.rejects(client.query(migration('011_run_ownership.sql')), /already been applied/);
    await client.query('ROLLBACK');
  } finally { client.release(); }
  const owners = (await pool.query('SELECT id,owner_user_id FROM unified_evaluation_runs ORDER BY id')).rows;
  assert.equal(owners.find(row => row.id === old).owner_user_id, 'admin-id');
  assert.equal(owners.find(row => row.id === legacy).owner_user_id, 'admin-id');
  assert.equal(owners.find(row => row.id === team).owner_user_id, null);
  const repo = createUnifiedEvaluationRepository({ pgPool: pool });
  const a = randomUUID(), b = randomUUID();
  const job = (id, text) => ({ runId:id, serviceKey:'literature', origin:'manual', question:text, questionId:'q', datasetVersion:'v1', questionSourceType:'fixed', batchId:null, status:'done', startedAt:new Date().toISOString(), run:{status:'done',serviceAddress:'ws://example.test/start'} });
  assert.equal(await repo.findIdempotent('evaluation-user:a', 'old-key'), null);
  await assert.rejects(repo.createIdempotent(job(randomUUID(),'不应返回旧记录'), 'evaluation-user:a', 'old-key', 'old-hash'), { status:409 });
  await repo.createIdempotent(job(a,'用户 A 的题目'), 'evaluation-user:a', 'key-a', 'hash-a');
  await repo.createIdempotent(job(b,'用户 B 的题目'), 'evaluation-user:b', 'key-b', 'hash-b');
  await pool.query("UPDATE unified_evaluation_runs SET answer='保留的回答', scores='{\"quality\":{\"status\":\"ready\"}}' WHERE id=$1", [a]);
  assert.equal((await repo.listHistory('a')).some(row => row.runId === a), true);
  assert.equal((await repo.listHistory('b')).some(row => row.runId === a), false);
  assert.equal(await repo.updateHistory('b', a, 'remove', ''), false);
  assert.equal(await repo.updateHistory('a', a, 'rename', '我的题目'), true);
  const evaluator = { serviceAddress:'ws://example.test/start', scoreMode:'none', async startQuestionRun() { return { run:{id:randomUUID()}, completion:Promise.resolve({status:'done'}) }; }, async getRunQuality() { return {status:'absent'}; } };
  const evaluations = createUnifiedEvaluationService({ repository:repo, evaluators:{literature:evaluator}, resolveQuestion:async()=>null });
  const authService = { authenticate: async token => { if (!token) throw Object.assign(Error('请登录'),{status:401}); return {id:token,permissions:['team-services:read','team-services:write']}; } };
  const server = createApp({token:'x'.repeat(32), authService, evaluations, runWriteEnabled:true, publicOrigin:'http://localhost'});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  t.after(()=>server.close());
  const base=`http://127.0.0.1:${server.address().port}/api/evaluation/unified`;
  const get=(user,url)=>fetch(`${base}${url}`,{headers:{cookie:`evaluation_session=${user}`}});
  const post=(user,url)=>fetch(`${base}${url}`,{method:'POST',headers:{cookie:`evaluation_session=${user}`,origin:'http://localhost','content-type':'application/json','idempotency-key':'rerun-test'},body:'{}'});
  const listA = await (await get('a','/runs')).json();
  assert.ok(listA.items.some(row=>row.runId===a));
  assert.ok(listA.items.some(row=>row.runId===team));
  assert.ok(!listA.items.some(row=>[b,old,legacy].includes(row.runId)));
  assert.equal((await get('a',`/runs/${a}`)).status,200);
  assert.equal((await get('b',`/runs/${a}`)).status,404);
  assert.equal((await get('b',`/runs/${a}/events`)).status,404);
  assert.equal((await get('b',`/runs/${a}/artifacts/0`)).status,404);
  for (const action of ['end','reply','score','rerun']) assert.equal((await post('b',`/runs/${a}/${action}`)).status,404);
  assert.equal((await get('b',`/runs/${team}`)).status,200);
  assert.equal((await post('b',`/runs/${team}/score`)).status,404);
  assert.equal((await get('admin-id',`/runs/${old}`)).status,200);
  const scores=await (await get('b',`/question-scores?items=${encodeURIComponent(JSON.stringify([{id:'q',datasetVersion:'v1'}]))}`)).json();
  assert.ok(!scores.items.some(row=>row.runId===a));
  const reruns=await Promise.all([post('a',`/runs/${a}/rerun`),post('a',`/runs/${a}/rerun`)]);
  assert.deepEqual(reruns.map(result=>result.status),[201,201]);
  const created=await Promise.all(reruns.map(result=>result.json()));
  assert.equal(created[0].runId,created[1].runId);
  assert.equal((await repo.get(a)).answer,'保留的回答');
  assert.equal((await repo.get(a)).scores.quality.status,'ready');
});
