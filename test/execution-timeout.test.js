const test = require('node:test');
const assert = require('node:assert/strict');
const { createUnifiedEvaluationService } = require('../src/runs/unified-evaluation.service');
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

function fixture({ timeout = 25, maxActive = 1 } = {}) {
  const rows = new Map(); const starts = []; let cancelled = 0;
  const repository = {
    async findIdempotent() { return null; },
    async createIdempotent(job) { rows.set(job.runId, structuredClone(job)); return { created: true, runId: job.runId }; },
    async save(job) { rows.set(job.runId, structuredClone(job)); },
    async get(id) { return structuredClone(rows.get(id)); },
  };
  const evaluator = { scoreMode: 'none', async startQuestionRun(body, callbacks) {
    let finish; const completion = new Promise(resolve => { finish = resolve; });
    starts.push({ question: body.question, callbacks, finish });
    return { run: { id: `native-${starts.length}` }, completion, cancel() { cancelled++; } };
  }, async getRunQuality() { return { status: 'absent' }; } };
  const service = createUnifiedEvaluationService({ repository, evaluators: { literature: evaluator }, executionTimeoutMs: timeout, maxActive, maxQueued: 5 });
  return { rows, starts, service, repository, cancelled: () => cancelled };
}

test('达到执行时限后停止本地任务、保留输出并忽略迟到数据', async () => {
  const f = fixture();
  const run = await f.service.createRun({ serviceKey:'literature', question:'这是用于超时处理的测试问题' }, { scope:'user', key:'one' });
  await delay(5);
  f.starts[0].callbacks.onText('已有内容');
  await delay(45);
  let value = await f.service.get(run.runId);
  assert.equal(value.status, 'error'); assert.match(value.error, /超时/); assert.equal(value.answer, '已有内容');
  assert.equal(value.run.executionTimeout, true); assert.equal(f.cancelled(), 1); assert.ok(value.finishedAt);
  f.starts[0].callbacks.onText('迟到内容'); f.starts[0].finish({ status:'done' });
  await delay(10);
  value = await f.service.get(run.runId);
  assert.equal(value.status, 'error'); assert.equal(value.answer, '已有内容');
});

test('排队时间不计入执行时限，任务按实际派发时间超时', async () => {
  const f = fixture({ timeout: 80 });
  const first = await f.service.createRun({ serviceKey:'literature', question:'第一个超时排队测试问题' }, { scope:'user', key:'first' });
  const second = await f.service.createRun({ serviceKey:'literature', question:'第二个超时排队测试问题' }, { scope:'user', key:'second' });
  await delay(50); assert.equal((await f.service.get(second.runId)).status, 'queued');
  f.starts[0].finish({ status:'done' });
  await delay(45);
  assert.equal(f.starts.length, 2); assert.equal((await f.service.get(first.runId)).status, 'done');
  assert.equal((await f.service.get(second.runId)).status, 'running');
  f.starts[1].finish({ status:'done' });
  await delay(10); assert.equal((await f.service.get(second.runId)).status, 'done');
});

test('恢复超时快照时跳过当前仍由本进程执行的运行', async () => {
  const f = fixture({ timeout: 5000 });
  const active = await f.service.createRun({ serviceKey:'literature', question:'恢复检查中应保留的运行' }, { scope:'user', key:'active' });
  await delay(5);
  const checked = [];
  f.repository.listStaleRunning = async () => [{runId:active.runId,version:'2'}, {runId:'orphan',version:'1'}];
  f.repository.timeoutStaleRunning = async (id, version) => { checked.push([id,version]); };
  await f.service.recoverTimedOutRuns();
  assert.deepEqual(checked, [['orphan','1']]);
  f.starts[0].finish({ status:'done' }); await delay(5);
  assert.equal((await f.service.get(active.runId)).status, 'done');
});
