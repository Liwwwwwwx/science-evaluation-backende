const { setupRunOwnership } = require('./run-ownership-fixture');
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { Pool } = require('pg');
const { EventEmitter } = require('node:events');
const { createApp } = require('../src/app');
const { createMaterialEvaluator } = require('../src/runs/material-evaluator');
const { createUnifiedEvaluationService } = require('../src/runs/unified-evaluation.service');
const { createUnifiedEvaluationRepository } = require('../src/runs/unified-evaluation.repository');
const { createEvalQuestionBankRepository } = require('../src/question-bank/repository');
const { createRunQuestionResolver } = require('../src/runs/question-resolver');

const socketPath = process.env.EVALUATION_MATERIAL_TEST_PG_SOCKET || '';
test('隔离 PostgreSQL：三类材料运行、实时状态、本人确认、幂等、重启及领域版本约束', { skip: !socketPath }, async t => {
  assert.match(socketPath, /^\/tmp\/evaluation-auth-pg\.[A-Za-z0-9]+$/);
  const pool = new Pool({ host: socketPath, port: 55481, database: 'science_admin' }); t.after(() => pool.end());
  await pool.query(fs.readFileSync(path.join(__dirname, '../migrations/003_evaluation_runs.sql'), 'utf8'));
  await setupRunOwnership(pool);
  await pool.query("CREATE TABLE eval_questions(id text,layer text,service_key text,source_type text,domain_key text,question text,dataset_version text,status text,criteria jsonb,created_at timestamptz DEFAULT now())");
  const question = '请计算材料候选结构与性能，并说明结果局限。';
  await pool.query("INSERT INTO eval_questions VALUES('material-domain','base',NULL,'random','materials-rd',$1,'gen-v1','active',NULL)", [question]);
  const calls = { alloy: 0, synthesis: 0, 'new-material': 0 };
  const makeEvaluator = (serviceKey, autoContinueReview = false) => createMaterialEvaluator({
    serviceKey, autoContinueReview, url: `ws://127.0.0.1/${serviceKey}/start`, endSettleMs: 1,
    createSocket: () => {
      const socket = new EventEmitter(); socket.addEventListener = socket.on; socket.close = () => socket.emit('close');
      const send = value => socket.emit('message', { data: typeof value === 'string' ? value : JSON.stringify(value) });
      socket.send = value => {
        const payload = JSON.parse(value);
        const complete = () => { send({ type: 'result', data: { status: 'partially_completed', candidates: [{ candidate_id: 'C1' }] } }); send('[end]'); };
        if (payload.type === 'checkpoint.reply') { send({ type: 'progress', data: { text: '已收到明确答复' } }); setTimeout(complete, 40); return; }
        calls[serviceKey]++; send('[start]材料回答25');
        setTimeout(() => {
          send({ type: 'progress', data: { stage: '候选生成', percent: 50 } });
          if (serviceKey === 'new-material') send({ type: 'requirement_review_request', request_id: 'review-1', data: { questions: [{ id: 'formula', question: '确认化学式', required: true, answer: '服务建议' }] } });
          else { if (serviceKey === 'synthesis') send({ stage_id: 'S1', title: '生成', input_count: 10, output_count: 3 }); setTimeout(complete, 80); }
        }, 10);
      };
      queueMicrotask(() => socket.emit('open')); return socket;
    }, fetchImpl: async () => Response.json({ ranked_candidates: [{ candidate: { candidate_id: 'C1', formula_pretty: 'Al2O3' } }], largeEvidence: '证据'.repeat(150000) }),
  });
  const evaluators = Object.fromEntries(Object.keys(calls).map(key => [key, makeEvaluator(key)]));
  const repository = createUnifiedEvaluationRepository({ pgPool: pool });
  const questionRepository = createEvalQuestionBankRepository({ pool });
  const service = (configured = evaluators) => createUnifiedEvaluationService({ evaluators: configured, repository, resolveQuestion: createRunQuestionResolver(questionRepository) });
  const authService = { authenticate: async token => {
    if (!token) throw Object.assign(Error('请登录'), { status: 401 });
    return { id: token, permissions: token === 'reader' ? ['team-services:read'] : ['team-services:read', 'team-services:write'] };
  } };
  const start = async configured => {
    const server = createApp({ token: 'x'.repeat(32), authService, evaluations: service(configured), runWriteEnabled: true, publicOrigin: 'http://localhost' });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); t.after(() => server.close());
    return `http://127.0.0.1:${server.address().port}/api/evaluation/unified`;
  };
  const base = await start();
  const headers = (user = 'owner') => ({ cookie: `evaluation_session=${user}`, origin: 'http://localhost', 'content-type': 'application/json' });
  const get = async (url, user = 'owner') => (await fetch(url, { headers: headers(user) })).json();
  const post = (url, body, key, user = 'owner', origin = 'http://localhost') => fetch(url, { method: 'POST', headers: { ...headers(user), origin, 'Idempotency-Key': key }, body: JSON.stringify(body) });
  for (const serviceKey of Object.keys(calls)) {
    const body = { serviceKey, question, questionId: 'material-domain', datasetVersion: 'gen-v1', sourceType: 'random' };
    const pair = await Promise.all([post(base + '/runs', body, serviceKey), post(base + '/runs', body, serviceKey)]);
    assert.ok(pair.every(r => r.status === 201)); const created = await Promise.all(pair.map(r => r.json()));
    const id = created[0].runId; assert.equal(id, created[1].runId); assert.equal(calls[serviceKey], 1);
    const ssePromise = fetch(`${base}/runs/${id}/events`, { headers: headers() }).then(r => r.text());
    if (serviceKey === 'new-material') {
      await new Promise(resolve => setTimeout(resolve, 25));
      assert.equal((await get(`${base}/runs/${id}`)).canReply, true);
      assert.equal((await fetch(`${base}/runs/${id}`, {headers:headers('other')})).status, 404);
      assert.equal((await fetch(`${base}/runs/${id}`, {headers:headers('reader')})).status, 404);
      const reply = { requestId: 'review-1', action: 'apply', answers: [{ id: 'formula', answer: 'Al2O3' }] };
      assert.equal((await post(`${base}/runs/${id}/reply`, reply, 'r', 'reader')).status, 404);
      assert.equal((await post(`${base}/runs/${id}/reply`, reply, 'r', 'other')).status, 404);
      assert.equal((await post(`${base}/runs/${id}/reply`, reply, 'r', 'owner', 'http://evil.invalid')).status, 403);
      assert.equal((await post(`${base}/runs/${id}/reply`, { ...reply, answers: [{ id: 'formula', answer: '' }] }, 'r')).status, 400);
      await new Promise(resolve => setTimeout(resolve, 1100));
      const beforeRestart = await start();
      const pendingSnapshot = await get(`${beforeRestart}/runs/${id}`);
      assert.equal(pendingSnapshot.canReply, false); assert.equal(pendingSnapshot.run.details.pendingReview.requestId, 'review-1');
      assert.equal((await post(`${beforeRestart}/runs/${id}/reply`, reply, 'r')).status, 409);
      assert.equal((await post(`${base}/runs/${id}/reply`, reply, 'r')).status, 200);
      assert.equal((await post(`${base}/runs/${id}/reply`, reply, 'r')).status, 409);
    }
    const stream = await ssePromise; assert.match(stream, /event: state/); assert.match(stream, /event: done/);
    const saved = await get(`${base}/runs/${id}`); assert.equal(saved.status, 'done'); assert.equal(saved.scoringStatus, 'absent');
    assert.equal(saved.answer, '[start]材料回答25[end]'); assert.equal(saved.questionId, 'material-domain'); assert.ok(saved.run.details.result);
    if (serviceKey === 'new-material') assert.equal(saved.run.details.review.at(-1).source, 'user');
    const restarted = await start(); const restored = await get(`${restarted}/runs/${id}`);
    assert.deepEqual(restored.run.details, saved.run.details); assert.equal(restored.recoveryState, 'snapshot_only');
    const replay = await (await post(restarted + '/runs', body, serviceKey)).json(); assert.equal(replay.runId, id); assert.equal(replay.reused, true); assert.equal(calls[serviceKey], 1);
    assert.equal((await post(base + '/runs', { ...body, datasetVersion: 'stale' }, serviceKey + '-stale')).status, 404);
  }
  const rows = await get(base + '/runs'); assert.equal(rows.total, 3);
  // 平台默认自动继续，不需要任何POST答复；系统来源和完整请求持久化并可恢复。
  const automaticBase = await start({ ...evaluators, 'new-material': makeEvaluator('new-material', true) });
  const autoInput = { serviceKey: 'new-material', question };
  const autoCreated = await (await post(automaticBase + '/runs', autoInput, 'auto-once')).json();
  const autoStream = await (await fetch(`${automaticBase}/runs/${autoCreated.runId}/events`, { headers: headers() })).text();
  assert.match(autoStream, /event: done/);
  const autoSaved = await get(`${automaticBase}/runs/${autoCreated.runId}`);
  assert.equal(autoSaved.status, 'done'); assert.equal(autoSaved.run.details.pendingReview, null);
  assert.equal(autoSaved.run.details.review[0].action, 'requested');
  assert.equal(autoSaved.run.details.review[1].source, 'automatic');
  assert.equal(autoSaved.run.details.review[1].action, 'continue');
  assert.equal(autoSaved.run.details.review[1].delivery, 'sent');
  assert.deepEqual(autoSaved.run.details.review[1].answers, []);
  const autoRestarted = await start();
  const restoredAuto = await get(`${autoRestarted}/runs/${autoCreated.runId}`);
  assert.deepEqual(restoredAuto.run.details, autoSaved.run.details);
  assert.equal((await (await post(autoRestarted + '/runs', autoInput, 'auto-once')).json()).reused, true);

});
