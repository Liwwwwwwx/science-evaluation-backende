const test = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { readFileSync } = require('node:fs');
const path = require('node:path');
const { Pool } = require('pg');
const { createScoringUsage } = require('../src/scoring/usage');
const { measure, loadRates } = require('../src/scoring/usage-pricing');
const { createJudgeClient } = require('../src/scoring/clients');
const { createDirectScoreService } = require('../src/scoring/direct-score');
const { createApp } = require('../src/app');

test('单价区分缓存、输入阶梯、北京时间高峰和自定义模型，未知与零用量分开', () => {
  const at = new Date('2026-11-20T01:00:00Z');
  const raw = { prompt_tokens: 100, completion_tokens: 50, prompt_cache_hit_tokens: 40 };
  const calc = (tokens, host = 'api.deepseek.com', model = 'deepseek-flash', when = at) =>
    measure(tokens, host, model, model, {}, when);
  assert.equal(calc(raw).cost, '0.0005216000');
  assert.equal(calc(raw, undefined, undefined, new Date('2026-11-20T10:00:00Z')).cost, '0.0002608000');
  assert.equal(calc({ ...raw, prompt_tokens: 32769 }, 'dashscope.aliyuncs.com', 'qwen3.7-flash').rate.output, 2.4);
  assert.equal(calc(undefined).cost, null);
  assert.equal(calc({ total_tokens: 150 }).total, 150);
  assert.equal(calc({ ...raw, prompt_tokens: 10 }).cost, null);
  assert.equal(calc({ prompt_tokens: 0, completion_tokens: 0 }).cost, '0.0000000000');
  assert.equal(calc(raw, 'custom.example').cost, null);
  assert.equal(calc(raw, undefined, 'unknown').cost, null);
  const rates = loadRates('{"custom.example/model":{"input":2,"cached":1,"output":3}}');
  assert.equal(measure(raw, 'custom.example', 'resolved-model', 'model', rates, at).cost, '0.0003100000');
  assert.throws(() => loadRates('{"unknown":{"input":-1,"output":4}}'));
});

test('供应商错误响应附带用量时保留用量，继续返回模型请求错误', async () => {
  let recorded;
  const usage = { async start() { return async data => { recorded = data.usage; }; } };
  const client = createJudgeClient({ usage, model: 'test', baseUrl: 'https://test.example', apiKey: 'fixture',
    fetch: async () => Response.json({ usage: { prompt_tokens: 12, completion_tokens: 0 } }, { status: 400 }) });
  await assert.rejects(client.callJson('test', { usageContext: {} }), /HTTP 400/);
  assert.deepEqual(recorded, { prompt_tokens: 12, completion_tokens: 0 });
});

const socket = process.env.EVALUATION_USAGE_TEST_PG_SOCKET;
test('隔离 PG：真实采集、重试、未知用量、人员和批次归属及 HTTP 权限', { skip: !socket }, async t => {
  assert.match(socket, /^\/tmp\/eval-scoring-usage\.[a-zA-Z0-9]+$/);
  const pool = new Pool({ host: socket, database: 'science_evaluation' });
  t.after(() => pool.end());
  await pool.query(readFileSync(path.join(__dirname, '../migrations/003_evaluation_runs.sql'), 'utf8'));
  await pool.query("CREATE TABLE auth_users(id text PRIMARY KEY, username text, display_name text); INSERT INTO auth_users VALUES ('admin','admin',NULL),('alice','alice','测试成员')");
  for (const file of ['011_run_ownership.sql', '017_scoring_usage.sql']) {
    await pool.query(readFileSync(path.join(__dirname, '../migrations', file), 'utf8'));
  }
  const batch = randomUUID(), shared = randomUUID(), privateId = randomUUID();
  await pool.query(`INSERT INTO unified_evaluation_runs(id,service_key,origin,owner_user_id,question,batch_id,status,started_at)
    VALUES ($1,'literature','automation',NULL,'Q',$3,'done',now()), ($2,'literature','manual','admin','Q',$3,'done',now())`, [shared, privateId, batch]);

  const usage = createScoringUsage(pool);
  const provider = { provider: 'qwen', model: 'qwen3.7-flash', baseUrl: 'https://dashscope.aliyuncs.com' };
  const usageData = { prompt_tokens: 100, completion_tokens: 50, prompt_tokens_details: { cached_tokens: 20 } };
  const account = 'evaluation-user:alice';
  const context = { evaluationId: shared, actor: 'automation', kind: 'initial', stage: 'rubric', attemptId: randomUUID() };
  const record = async (params, data) => { const finish = await usage.start({ ...context, ...params }, provider); if (data) await finish(data); };
  await record({}, { usage: usageData });
  await record({ actor: account, kind: 'rescore', stage: 'judge', attemptId: randomUUID() }, { usage: usageData });
  await record({ evaluationId: privateId, actor: 'evaluation-user:admin' }, { usage: usageData });
  await record({ evaluationId: privateId, actor: 'evaluation-user:admin' }, null);

  let calls = 0;
  const judge = createJudgeClient({ ...provider, qwen: true, usage, apiKey: 'fixture', fetch: async () => {
    calls++;
    const content = calls === 1 ? '{invalid' : JSON.stringify({ score: 85, summary: '完整', criteria: [{ criterion: '给出颜色', status: 'met', reason: '已给出', evidence: '天空是蓝色。' }], suggestions: [] });
    return Response.json({ choices: [{ finish_reason: 'stop', message: { content } }], usage: usageData });
  } });
  const directScore = createDirectScoreService({ clients: { qwenScore: judge } });
  const authService = { authenticate: async token => {
    if (!token) throw Object.assign(new Error('未登录'), { status: 401 });
    return { id: token, username: token, permissions: ['team-services:read','team-services:write'] };
  } };
  const server = createApp({ token: 'x'.repeat(32), authService, directScore, scoringUsage: usage, publicOrigin: 'http://localhost' });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  const base = 'http://127.0.0.1:' + server.address().port + '/api/evaluation';
  const body = JSON.stringify({ question: '请给出白天天空的颜色', answer: '天空是蓝色。', standard: { type: 'text', text: '给出颜色' } });
  const post = await fetch(base + '/direct-score', { method: 'POST', body, headers: { 'content-type': 'application/json', origin: 'http://localhost', cookie: 'evaluation_session=alice' } });
  assert.equal(post.status, 200);
  assert.equal((await post.json()).scores.qwenScore.status, 'ready');
  assert.equal(calls, 2);
  const report = (query = '', session = 'admin') => fetch(base + '/unified/scoring-usage' + query, { headers: { cookie: 'evaluation_session=' + session } });
  assert.equal((await report('', 'alice')).status, 403);
  assert.equal((await report('', '')).status, 401);
  assert.equal((await report('?from=2026-02-31')).status, 400);
  assert.equal((await (await report('?to=2020-01-01')).json()).total, 0);
  const people = await (await report()).json();
  const alice = people.items.find(item => item.actor === account);
  assert.equal(alice.evaluations, 2);
  assert.equal(alice.calls, 3);
  assert.equal(alice.totalTokens, 450);
  assert.equal(alice.estimatedCny, 0.0001704);
  const details = await (await report('?actor=' + encodeURIComponent(account))).json();
  assert.equal(details.total, 2);
  assert.equal(details.items.find(item => item.direct).calls, 2);
  assert.equal(details.items.find(item => item.rescored).batchId, batch);
  const sharedUsage = await usage.byRun(shared);
  assert.equal(sharedUsage.calls, 2);
  assert.equal((await usage.byBatch([batch], 'alice')).get(batch).calls, 2);
  const all = (await usage.byBatch([batch], 'admin')).get(batch);
  assert.equal(all.calls, 4);
  assert.equal(all.missingCost, 1);
  assert.equal(all.missingUsage, 1);
  assert.equal(await usage.byRun(randomUUID()), null);
});
