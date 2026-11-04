const test = require('node:test');
const assert = require('node:assert/strict');
const { createUnifiedEvaluationService } = require('../src/runs/unified-evaluation.service');

function fixture() {
  const rows = new Map(); const keys = new Map(); const starts = []; const completions = new Map();
  let releasePause;
  const pauseBarrier = new Promise(resolve => { releasePause = resolve; });
  const repository = {
    async findIdempotent(scope, key) { const id = keys.get(`${scope}:${key}`); return id ? { runId: id, hash: rows.get(id).hash } : null; },
    async createIdempotent(job, scope, key, hash) {
      const id = keys.get(`${scope}:${key}`); if (id) return { created: false, runId: id, matches: rows.get(id).hash === hash };
      keys.set(`${scope}:${key}`, job.runId); rows.set(job.runId, { ...structuredClone(job), hash }); return { created: true, runId: job.runId };
    },
    async claimQueued(job) { const row = rows.get(job.runId); if (row.status !== 'queued') return false; row.status = 'running'; return true; },
    async save(job) { const row = rows.get(job.runId); rows.set(job.runId, { ...structuredClone(job), hash: row.hash }); },
    async get(id) { return structuredClone(rows.get(id)); },
    async isMissionBatchPaused(batchId) { return [...rows.values()].some(row => row.batchId === batchId && row.run?.missionBatchPaused); },
    async pauseQueuedMissionRun(id, reason, { claimed = false } = {}) {
      const row = rows.get(id); if (!row || !['queued', ...(claimed ? ['running'] : [])].includes(row.status)) return false;
      row.status = 'paused'; row.error = reason; row.finishedAt = new Date().toISOString(); return true;
    },
    async pauseMissionBatch(job, reason) {
      await pauseBarrier;
      const current = rows.get(job.runId); rows.set(job.runId, { ...structuredClone(job), hash: current.hash });
      for (const row of rows.values()) if (row.batchId === job.batchId && row.origin === 'automation' && row.serviceKey === 'mission-material' && row.status === 'queued') {
        row.status = 'paused'; row.error = reason; row.finishedAt = new Date().toISOString();
      }
    },
  };
  const evaluator = key => ({ scoreMode: 'none', serviceAddress: `ws://${key}.example/start`, async startQuestionRun({ question }) {
    starts.push({ key, question }); let resolve; const completion = new Promise(done => { resolve = done; }); completions.set(question, resolve);
    return { run: { id: `native-${question}` }, completion };
  }, async getRunQuality() { return { status: 'absent', quality: null, error: null }; } });
  const evaluators = { 'mission-material': evaluator('mission-material'), alloy: evaluator('alloy') };
  return { rows, repository, evaluators, starts, completions, releasePause };
}
const tick = () => new Promise(resolve => setImmediate(resolve));
async function until(fn) { for (let i = 0; i < 100; i++) { if (fn()) return; await tick(); } assert.fail('未达到预期状态'); }
const input = (serviceKey, question, batchId = 'batch-a') => ({ serviceKey, question, batchId, sourceType: 'random' });

test('Mission 异常断连时先暂停同批队列；持久化等待期间不派发，其他服务和其他批次不受影响', async () => {
  const f = fixture();
  const service = createUnifiedEvaluationService({ repository: f.repository, evaluators: f.evaluators, maxActive: 3, maxPerService: 2, scoreWaitMs: 0 });
  const one = await service.createBatchRun(input('mission-material', '第一条 Mission 问题'), { key: 'one' });
  await service.createBatchRun(input('mission-material', '第二条 Mission 问题'), { key: 'two' });
  const queued = await service.createBatchRun(input('mission-material', '第三条 Mission 问题'), { key: 'three' });
  const other = await service.createBatchRun(input('alloy', '合金材料对比问题'), { key: 'alloy' });
  assert.equal(f.starts.length, 3);
  f.completions.get('第一条 Mission 问题')({ status: 'error', error: 'Mission 连接中断（关闭码 1006）', details: { transport: { closeCode: 1006 } } });
  await until(() => f.rows.get(queued.runId).status === 'paused');
  f.completions.get('第二条 Mission 问题')({ status: 'done' });
  f.completions.get('合金材料对比问题')({ status: 'done' });
  const future = await service.createBatchRun(input('mission-material', '暂停之后创建的问题'), { key: 'four' });
  await until(() => f.rows.get(future.runId).status === 'paused');
  assert.equal(f.starts.filter(item => item.key === 'mission-material').length, 2);
  f.releasePause();
  await until(() => f.rows.get(one.runId).run?.missionBatchPaused === true);
  assert.ok(f.rows.get(one.runId).finishedAt, '触发暂停的失败记录须在提交暂停时有结束时间');
  assert.equal(f.rows.get(other.runId).status, 'done');
  const restarted = createUnifiedEvaluationService({ repository: f.repository, evaluators: f.evaluators, maxActive: 2, scoreWaitMs: 0 });
  const recovered = await restarted.createBatchRun(input('mission-material', '进程重启后的同批问题'), { key: 'five' });
  await until(() => f.rows.get(recovered.runId).status === 'paused');
  assert.equal(f.starts.filter(item => item.key === 'mission-material').length, 2);
  await restarted.createBatchRun(input('mission-material', '另一批正常开始问题', 'batch-b'), { key: 'other-batch' });
  assert.equal(f.starts.filter(item => item.key === 'mission-material').length, 3);
  f.completions.get('另一批正常开始问题')({ status: 'done' });
});

test('普通业务失败不暂停同批其他问题', async () => {
  const f = fixture(); f.releasePause();
  const service = createUnifiedEvaluationService({ repository: f.repository, evaluators: f.evaluators, maxActive: 1, maxPerService: 1, scoreWaitMs: 0 });
  await service.createBatchRun(input('mission-material', '第一条普通失败问题'), { key: 'ordinary-one' });
  await service.createBatchRun(input('mission-material', '第二条仍应执行的问题'), { key: 'ordinary-two' });
  f.completions.get('第一条普通失败问题')({ status: 'error', error: 'Mission 返回执行错误', details: { transport: { closeCode: null } } });
  await until(() => f.starts.length === 2);
  f.completions.get('第二条仍应执行的问题')({ status: 'done' });
});

test('Mission 执行超时后不派发同批排队题目', async () => {
  const f = fixture(); f.releasePause();
  const service = createUnifiedEvaluationService({ repository: f.repository, evaluators: f.evaluators, maxActive: 1, maxPerService: 1, scoreWaitMs: 0 });
  await service.createBatchRun(input('mission-material', '第一条运行超时的问题'), { key: 'timeout-one' });
  const queued = await service.createBatchRun(input('mission-material', '第二条超时后暂停问题'), { key: 'timeout-two' });
  f.completions.get('第一条运行超时的问题')({ status: 'error', error: 'Mission 执行超时', details: { transport: { closeCode: null } } });
  await until(() => f.rows.get(queued.runId).status === 'paused');
  assert.equal(f.starts.length, 1);
});

test('抢占时发现数据库已暂停则展示暂停，不启动 Mission', async () => {
  const f = fixture();
  f.repository.claimQueued = async (job) => {
    const row = f.rows.get(job.runId);
    row.status = 'paused'; row.error = '同批次已暂停'; row.finishedAt = new Date().toISOString();
    return false;
  };
  const service = createUnifiedEvaluationService({ repository: f.repository, evaluators: f.evaluators, scoreWaitMs: 0 });
  const run = await service.createBatchRun(input('mission-material', '数据库抢占发现暂停的问题'), { key: 'already-paused' });
  assert.equal((await service.get(run.runId)).status, 'paused');
  assert.equal(f.starts.length, 0);
});

test('暂停的题目使批次显示部分完成，日报不会一直等待该题', async () => {
  const { createBatchReadService } = require('../src/runs/batch-read.service');
  const { pending } = require('../src/daily-reports/summary');
  const plan = { id: 'batch-a', source: 'mission', plan_date: '2026-11-03', state: 'submitted', items: [{ questionId: 'q' }] };
  const row = { id: 'run-a', batch_id: 'batch-a', service_key: 'mission-material', question: '测试问题', status: 'paused', run_status: null, scores: null, started_at: '2026-11-03T18:00:00Z', finished_at: '2026-11-03T18:01:00Z' };
  const repository = { async plans() { return { storageReady: true, items: [plan] }; }, async plan() { return { storageReady: true, plan }; }, async runsByBatchIds() { return [row]; } };
  const service = createBatchReadService({ repository });
  assert.equal((await service.list()).items[0].state, 'partial');
  assert.equal((await service.get('batch-a')).batch.state, 'partial');
  assert.equal((await service.runs('batch-a')).items[0].status, 'paused');
  assert.equal(pending({ status: 'paused', finishedAt: row.finished_at, scores: null }), false);
});
