const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createApp } = require('../src/app');
const { createUnifiedEvaluationService } = require('../src/runs/unified-evaluation.service');
const { createScoringService } = require('../src/scoring/service');

test('共享批次可重评，中断记录的已保存输出仅产生参考分，私人边界不变', async t => {
  const ids = ['11111111-1111-4111-8111-111111111111', '22222222-2222-4222-8222-222222222222', '33333333-3333-4333-8333-333333333333', '44444444-4444-4444-8444-444444444444', '55555555-5555-4555-8555-555555555555', '66666666-6666-4666-8666-666666666666'];
  const make = (id, origin, owner, status, nativeStatus, answer = '保留的材料结果') => ({ runId: id, origin, owner, status, answer, serviceKey: 'alloy', question: '请说明保留的材料结果', run: { status: nativeStatus, details: {} }, scores: null });
  const records = new Map([
    [ids[0], make(ids[0], 'automation', null, 'done', 'done')],
    [ids[1], make(ids[1], 'manual', 'alice', 'done', 'done')],
    [ids[2], make(ids[2], 'manual', 'bob', 'cancelled', 'running')],
    [ids[3], make(ids[3], 'manual', 'bob', 'error', 'error')],
    [ids[4], make(ids[4], 'manual', 'bob', 'cancelled', 'running', '')],
    [ids[5], make(ids[5], 'manual', 'bob', 'running', 'running')],
  ]);
  let claims = 0;
  const repo = {
    async getAccess(id) { const r = records.get(id); return r ? { origin: r.origin, owner_user_id: r.owner } : null; },
    async get(id) { const r = records.get(id); return r && structuredClone(r); },
    async list({ userId }) { const items = [...records.values()].filter(r => r.origin === 'automation' || r.owner === userId).map(r => structuredClone(r)); return { items, total: items.length }; },
    async claimScoring(id, previousId, scoring, scores) {
      const r = records.get(id);
      if ((r.run.scoring?.attemptId || null) !== previousId || !['done', 'error', 'cancelled', 'scoring'].includes(r.status)) return false;
      claims++; r.run.scoring = structuredClone(scoring); r.scores = structuredClone(scores);
      if (!['error', 'cancelled'].includes(r.status)) r.status = 'scoring';
      return true;
    },
    async updateScoring(id, attemptId, value) {
      const r = records.get(id); if (r.run.scoring?.attemptId !== attemptId) return false;
      r.run.scoring = structuredClone(value.scoring); r.run.markdownSyntax = value.markdownSyntax;
      r.scores = structuredClone(value.scores); r.status = value.status; r.scoreError = null; return true;
    },
  };
  const rubric = { requirements: [{ requirement: '说明材料结果', critical: true }], visualAidsApplicable: false, visualAidsReason: '无需额外图表' };
  let holdScoring = false; let releaseScoring;
  const scoringGate = new Promise(resolve => { releaseScoring = resolve; });
  const client = { model: 'fixture', isConfigured: () => true, callJson: async prompt => {
    if (holdScoring) await scoringGate;
    return prompt.startsWith('仅根据题目') ? rubric : {
      dimensions: { readability: { score: 80, note: '清楚' }, professionalism: { score: 80, note: '有说明' }, visualAids: { score: null, note: '不适用' } },
      requirements: [{ id: 'R1', status: 'met', evidence: ['answer:0'], note: '已给出内容' }], comment: '已检查', suggestions: ['继续核对'] };
  } };
  const evaluations = createUnifiedEvaluationService({ repository: repo, evaluators: { alloy: {} }, scoring: createScoringService({ clients: { deepSeekScore: client } }) });
  const authService = { authenticate: async token => ({ id: token, permissions: token === 'reader' ? ['team-services:read'] : ['team-services:read', 'team-services:write'] }) };
  const server = createApp({ token: 'x'.repeat(32), authService, evaluations, runWriteEnabled: true, publicOrigin: 'http://localhost' });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); t.after(() => server.close());
  const base = `http://127.0.0.1:${server.address().port}/api/evaluation/unified`;
  const get = (user, url) => fetch(base + url, { headers: { cookie: `evaluation_session=${user}` } });
  const post = (user, id, action, key = id) => fetch(`${base}/runs/${id}/${action}`, { method: 'POST', headers: { cookie: `evaluation_session=${user}`, origin: 'http://localhost', 'content-type': 'application/json', 'idempotency-key': key }, body: '{}' });
  const waitForScore = async id => {
    for (let i = 0; i < 200; i++) { const value = await evaluations.get(id); if (value.run?.scoring?.finishedAt) return value; await new Promise(resolve => setTimeout(resolve, 5)); }
    throw Error('等待重评超时');
  };

  const list = await (await get('bob', '/runs')).json();
  assert.equal(list.items.find(item => item.runId === ids[0]).canRescore, true);
  assert.equal(list.items.find(item => item.runId === ids[2]).canRescore, true);
  assert.equal((await (await get('reader', `/runs/${ids[0]}`)).json()).canRescore, false);
  assert.equal((await post('reader', ids[0], 'score')).status, 403);
  assert.equal((await get('bob', `/runs/${ids[1]}`)).status, 404);
  assert.equal((await post('bob', ids[1], 'score')).status, 404);
  for (const action of ['rerun', 'end', 'reply']) assert.equal((await post('bob', ids[0], action)).status, 404);

  assert.equal((await (await get('bob', `/runs/${ids[0]}`)).json()).canRescore, true);
  assert.equal((await post('bob', ids[0], 'score')).status, 202);
  const shared = await waitForScore(ids[0]);
  assert.equal(shared.scores.deepSeekScore.status, 'ready');
  assert.equal(shared.scores.deepSeekScore.quality.source.truncated, false);
  assert.equal(shared.answer, '保留的材料结果');

  const cancelledBefore = await (await get('bob', `/runs/${ids[2]}`)).json();
  assert.equal(cancelledBefore.canRescore, true); assert.equal(cancelledBefore.canRerun, false);
  holdScoring = true;
  assert.equal((await post('bob', ids[2], 'score')).status, 202);
  const during = await (await get('bob', '/runs')).json();
  assert.equal(during.items.find(item => item.runId === ids[2]).canRescore, false);
  assert.equal((await (await get('bob', `/runs/${ids[2]}`)).json()).canRescore, false);
  assert.equal((await post('bob', ids[2], 'score', 'another-attempt')).status, 409);
  releaseScoring(); holdScoring = false;
  const cancelled = await waitForScore(ids[2]);
  assert.equal(cancelled.status, 'cancelled'); assert.equal(cancelled.executionStatus, 'cancelled');
  assert.equal(cancelled.scores.deepSeekScore.status, 'ready');
  assert.equal(cancelled.scores.deepSeekScore.quality.source.truncated, true);
  assert.equal(cancelled.scores.deepSeekScore.quality.taskCompletion.status, 'unclear');
  assert.equal(cancelled.scores.deepSeekScore.quality.taskCompletion.qualified, false);

  assert.equal((await post('bob', ids[3], 'score')).status, 202);
  const failed = await waitForScore(ids[3]);
  assert.equal(failed.status, 'error'); assert.equal(failed.scores.deepSeekScore.quality.source.truncated, true);
  const before = claims; const empty = await post('bob', ids[4], 'score');
  assert.equal(empty.status, 409); assert.equal((await empty.json()).error.code, 'RUN_NO_OUTPUT'); assert.equal(claims, before);
  assert.equal((await (await get('bob', `/runs/${ids[5]}`)).json()).canRescore, false);
  assert.equal((await post('bob', ids[5], 'score')).status, 409);
});
