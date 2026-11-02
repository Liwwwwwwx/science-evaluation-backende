const test = require('node:test');
const assert = require('node:assert/strict');
const { createUnifiedEvaluationRepository } = require('../src/runs/unified-evaluation.repository');
const { createUnifiedEvaluationService } = require('../src/runs/unified-evaluation.service');
const { publicServiceAddress } = require('../src/runs/service-address');

test('服务地址去掉认证信息、查询参数和片段', () => {
  assert.equal(publicServiceAddress('wss://user:password@example.com:1115/new-material/start?token=secret#key'), 'wss://example.com:1115/new-material/start');
  assert.equal(publicServiceAddress('javascript:alert(1)'), null);
  assert.equal(publicServiceAddress(undefined), null);
});

test('运行保留当时地址，配置变化不覆盖历史；旧记录标注当前配置且不回写', async () => {
  const rows = new Map(); let writes = 0; let finish;
  const repository = {
    findIdempotent: async () => null,
    createIdempotent: async job => { rows.set(job.runId, structuredClone(job)); return { created: true, runId: job.runId }; },
    save: async job => { writes++; rows.set(job.runId, structuredClone(job)); },
    get: async id => structuredClone(rows.get(id)),
  };
  const evaluator = { serviceAddress: 'ws://original.example:1106/start', scoreMode: 'none', startQuestionRun: async () => ({ run: { id: 'native' }, completion: new Promise(resolve => { finish = resolve; }) }) };
  const first = createUnifiedEvaluationService({ repository, evaluators: { literature: evaluator } });
  const created = await first.createRun({ serviceKey: 'literature', question: '检索材料相关的文献并说明依据。' }, { scope: 'user', key: 'once' });
  assert.equal((await first.get(created.runId)).run.serviceAddress, evaluator.serviceAddress);
  finish({ status: 'done' }); await new Promise(resolve => setImmediate(resolve));
  const restarted = createUnifiedEvaluationService({ repository, evaluators: { literature: { ...evaluator, serviceAddress: 'ws://new.example:1106/start' } } });
  const saved = await restarted.get(created.runId);
  assert.equal(saved.run.serviceAddress, 'ws://original.example:1106/start'); assert.equal(saved.run.serviceAddressSource, 'run');
  rows.set('old', { serviceKey: 'literature', status: 'done', run: { status: 'done' } });
  const before = writes; const old = await restarted.get('old');
  assert.equal(old.run.serviceAddress, 'ws://new.example:1106/start'); assert.equal(old.run.serviceAddressSource, 'configuration');
  assert.equal(rows.get('old').run.serviceAddress, undefined); assert.equal(writes, before);
});

test('运行记录仅接受指定数据库，拒绝写入其他数据库', async () => {
  assert.throws(() => createUnifiedEvaluationRepository());
  let writes = 0;
  const repository = createUnifiedEvaluationRepository({ pgPool: { async query(sql) {
    if (sql.includes('current_database()')) return { rows: [{ name: 'other_database' }] };
    writes++; return { rows: [] };
  } } });
  await assert.rejects(repository.create({}), /science_admin/);
  assert.equal(writes, 0);
});

test('幂等键命中已有记录时只执行一次并返回原运行', async () => {
  const rows = new Map();
  const keys = new Map();
  const pool = { async query(sql, args = []) {
    if (sql.includes('current_database()')) return { rows: [{ name: 'science_admin' }] };
    if (sql.includes('INSERT INTO public.unified_evaluation_runs')) {
      const [id, service_key, origin, question, question_id, dataset_version, question_source_type, batch_id, status, started_at, scope, key, hash] = args;
      const identity = `${scope}:${key}`;
      if (keys.has(identity)) return { rows: [], rowCount: 0 };
      keys.set(identity, { id, idempotency_hash: hash });
      rows.set(id, { id, service_key, origin, question, question_id, dataset_version, question_source_type, batch_id, status, started_at, answer: '' });
      return { rows: [{ id }], rowCount: 1 };
    }
    if (sql.includes('WHERE idempotency_scope=$1')) {
      const row = keys.get(`${args[0]}:${args[1]}`);
      return { rows: row ? [row] : [] };
    }
    if (sql.includes("SET status='running'") && sql.includes("status='queued'")) {
      const row = rows.get(args[0]);
      if (!row || row.status !== 'queued') return { rows: [], rowCount: 0 };
      Object.assign(row, { status: 'running', run: args[1], scores: args[2] });
      return { rows: [{ id: args[0] }], rowCount: 1 };
    }
    if (sql.startsWith('UPDATE public.unified_evaluation_runs SET native_run_id=')) {
      const row = rows.get(args[0]);
      if (!row) return { rowCount: 0 };
      Object.assign(row, { native_run_id: args[1], status: args[2], answer: args[3], answer_truncated: args[4], run: args[5], scores: args[6], score_error: args[7], error: args[8], finished_at: args[9] });
      return { rowCount: 1 };
    }
    if (sql.startsWith('SELECT * FROM public.unified_evaluation_runs')) return { rows: rows.has(args[0]) ? [rows.get(args[0])] : [] };
    throw new Error(`unexpected SQL: ${sql}`);
  } };
  let starts = 0;
  const evaluator = { async askQuestionStream(_, { onText }) { starts++; onText('回答'); return { run: { id: 'native-1' }, completion: Promise.resolve({ status: 'done' }) }; }, async getAskResult() { return { deepSeekScore: { status: 'unavailable' }, qwenScore: { status: 'unavailable' } }; } };
  const repository = createUnifiedEvaluationRepository({ pgPool: pool });
  const service = createUnifiedEvaluationService({ repository, evaluators: { 'alpha-rsi': evaluator }, scoreWaitMs: 0 });
  const input = { serviceKey: 'alpha-rsi', question: '这是一个测试问题' };
  const first = await service.createRun(input, { scope: 'user-1', key: 'request-1' });
  const second = await service.createRun(input, { scope: 'user-1', key: 'request-1' });
  assert.equal(first.runId, second.runId);
  assert.equal(starts, 1);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal((await repository.get(first.runId)).answer, '回答');
  await assert.rejects(service.createRun({ ...input, question: '另一道测试问题' }, { scope: 'user-1', key: 'request-1' }), (error) => error.status === 409);
});
