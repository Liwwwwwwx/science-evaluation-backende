const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { once } = require('node:events');
const { readFileSync } = require('node:fs');
const { test } = require('node:test');
const { Pool } = require('pg');
const { createApp } = require('../src/app');
const { TeamServiceError } = require('../src/errors');
const { createRunSharing } = require('../src/runs/sharing');
const { createUnifiedEvaluationRepository } = require('../src/runs/unified-evaluation.repository');
const { createUnifiedEvaluationService } = require('../src/runs/unified-evaluation.service');
const { setupRunOwnership } = require('./run-ownership-fixture');

const socket = process.env.EVALUATION_RUN_SHARE_TEST_PG_SOCKET || '';

test('隔离 PG：团队只读分享校验登录、归属、有效期、并发创建与撤销', { skip: !socket }, async t => {
  assert.match(socket, /^\/tmp\/evaluation-share-pg\.[A-Za-z0-9]+$/);
  const pool = new Pool({ host: socket, port: 55494, database: 'science_evaluation' });
  t.after(() => pool.end());
  const migrate = filename => pool.query(readFileSync(new URL(`../migrations/${filename}`, `file://${__filename}`), 'utf8'));
  await migrate('003_evaluation_runs.sql');
  await setupRunOwnership(pool);
  await migrate('018_run_shares.sql');
  const repository = createUnifiedEvaluationRepository({ pgPool: pool });
  const evaluations = createUnifiedEvaluationService({ repository, evaluators: {} });
  const runSharing = createRunSharing(pool);
  const manual = randomUUID();
  const automatic = randomUUID();
  const running = randomUUID();
  const answer = '<think>隐藏推理</think>可分享的回答\nAuthorization: Bearer fake-example';
  const run = { status: 'done', serviceAddress: 'http://backend.internal', details: {
    artifacts: [{ url: 'http://backend.internal/files/private.json' }],
    displayEvents: [{ type: 'display.final_answer', phase: 'end', content: '最终总结正文' },
      { type: 'display.process.step', description: '内部过程' }],
  }};
  const scores = { deepSeekScore: { status: 'ready', quality: {
    total: 85, taskCompletion: { status: 'completed', requirements: [{ evidence: '内部评分证据' }] }, qualification: { status: 'qualified' },
  }}};
  const insert = (id, origin, owner, status) => pool.query(`INSERT INTO public.unified_evaluation_runs
      (id,service_key,origin,owner_user_id,status,question,answer,run,scores,started_at,finished_at)
      VALUES ($1,'alpha-rsi',$2,$3,$4,'一条团队分享演示',$5,$6,$7,now(),now())`, [id, origin, owner, status, answer, run, scores]);
  await insert(manual, 'manual', 'owner', 'done');
  await insert(automatic, 'automation', null, 'done');
  await insert(running, 'manual', 'owner', 'running');
  const original = await repository.get(manual);

  const origin = 'http://localhost';
  const server = createApp({ token: 'local-fixture-token'.repeat(2), publicOrigin: origin, runWriteEnabled: true,
    evaluations, runSharing, authService: {
      async authenticate(id) {
        if (!id) throw new TeamServiceError(401, 'UNAUTHORIZED', '请先登录');
        return { id, permissions: id === 'guest' ? [] : id === 'reader' ? ['team-services:read'] : ['team-services:read', 'team-services:write'] };
      },
    },
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => server.close());
  const base = `http://127.0.0.1:${server.address().port}/api/evaluation/unified`;
  const get = (path, user) => fetch(base + path, { headers: user ? { Cookie: `evaluation_session=${user}` } : {} });
  const post = (id, user, body, requestOrigin = origin) => fetch(base + `/runs/${id}/share`, {
    method: 'POST', headers: { Cookie: `evaluation_session=${user}`, Origin: requestOrigin, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const create = { action: 'create' };
  assert.equal((await post(manual, 'other', create)).status, 404);
  assert.equal((await post(automatic, 'reader', create)).status, 403);
  assert.equal((await post(manual, 'owner', create, 'https://elsewhere.test')).status, 403);
  assert.equal((await post(running, 'owner', create)).status, 409);
  assert.equal((await (await get(`/runs/${manual}`, 'owner')).json()).canShare, true);
  assert.equal((await (await get(`/runs/${automatic}`, 'reader')).json()).canShare, false);
  assert.equal((await post(automatic, 'writer', create)).status, 200);

  const [first, repeated] = await Promise.all([post(manual, 'owner', create), post(manual, 'owner', create)]);
  assert.equal(first.status, 200);
  const { share } = await first.json();
  assert.deepEqual((await repeated.json()).share, share);
  assert.ok(Date.parse(share.expiresAt) > Date.now());
  const sharedPath = `/shared-runs/${share.id}`;
  assert.equal((await get(sharedPath)).status, 401);
  assert.equal((await get(sharedPath, 'guest')).status, 403);
  assert.equal((await get(`/runs/${manual}`, 'reader')).status, 404);
  assert.equal((await get(`/runs/${manual}/artifacts/0`, 'reader')).status, 404);
  const view = await get(sharedPath, 'reader');
  assert.equal(view.status, 200);
  assert.match(view.headers.get('cache-control'), /no-store/);
  const result = await view.json();
  assert.equal(result.question, '一条团队分享演示');
  assert.equal(result.sections[0].content, '最终总结正文');
  assert.deepEqual(result.scores.deepSeekScore, { status: 'ready', total: 85, taskStatus: 'completed', qualification: 'qualified', provisional: false });
  assert.doesNotMatch(JSON.stringify(result), /隐藏推理|fake-example|backend\.internal|内部评分证据|内部过程|ownerUserId/);

  assert.equal((await post(manual, 'owner', { action: 'revoke', shareId: share.id })).status, 200);
  assert.equal((await get(sharedPath, 'reader')).status, 404);
  const next = (await (await post(manual, 'owner', create)).json()).share;
  assert.notEqual(next.id, share.id);
  const staleRevoke = await post(manual, 'owner', { action: 'revoke', shareId: share.id });
  assert.deepEqual((await staleRevoke.json()).share, next);
  assert.deepEqual(await repository.get(manual), original);
  await pool.query("UPDATE public.evaluation_run_shares SET expires_at=now()-interval '1 second' WHERE share_id=$1", [next.id]);
  assert.equal((await get(`/shared-runs/${next.id}`, 'reader')).status, 404);
});
