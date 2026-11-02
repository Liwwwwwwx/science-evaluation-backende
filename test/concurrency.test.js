const test = require('node:test');
const assert = require('node:assert/strict');
const { createConcurrency } = require('../src/runs/concurrency');

test('同服务并发受限，其他服务可以使用空闲容量', async () => {
  const gate = createConcurrency({ maxActive: 3, maxPerKey: 2 });
  const releaseA1 = await gate.acquire('a');
  const releaseA2 = await gate.acquire('a');
  let a3Started = false;
  const a3 = gate.acquire('a').then(release => { a3Started = true; return release; });
  const releaseB = await gate.acquire('b');
  assert.deepEqual(gate.stats(), { active: 3, queued: 1 });
  assert.equal(a3Started, false);
  releaseA1();
  const releaseA3 = await a3;
  assert.equal(a3Started, true);
  assert.deepEqual(gate.stats(), { active: 3, queued: 0 });
  releaseA1(); // 重复释放不能让同服务超额。
  releaseA2(); releaseA3(); releaseB();
  assert.deepEqual(gate.stats(), { active: 0, queued: 0 });
});

test('总并发与队列上限生效，按同服务提交顺序派发', async () => {
  const gate = createConcurrency({ maxActive: 1, maxPerKey: 1, maxQueued: 2 });
  const first = await gate.acquire('a');
  const started = [];
  const second = gate.acquire('a').then(release => { started.push(2); return release; });
  const third = gate.acquire('a').then(release => { started.push(3); return release; });
  assert.throws(() => gate.acquire('a'), { code: 'CONCURRENCY_QUEUE_FULL' });
  first();
  (await second)();
  (await third)();
  assert.deepEqual(started, [2, 3]);
  assert.deepEqual(gate.stats(), { active: 0, queued: 0 });
});

test('配置或分组无效时拒绝', () => {
  assert.throws(() => createConcurrency({ maxActive: 0 }), RangeError);
  assert.throws(() => createConcurrency({ maxActive: 1, maxQueued: -1 }), RangeError);
  assert.throws(() => createConcurrency({ maxActive: 1 }).acquire(''), TypeError);
});

test('取消等待中的预约释放队列容量，不影响已经开始的任务', async () => {
  const gate = createConcurrency({ maxActive: 1, maxQueued: 1 });
  const first = gate.reserve('a');
  const release = await first.ready;
  assert.equal(first.cancel(), false);
  const waiting = gate.reserve('a');
  assert.equal(waiting.cancel(), true);
  assert.equal(await waiting.ready, null);
  const next = gate.acquire('b');
  release();
  (await next)();
  assert.deepEqual(gate.stats(), { active: 0, queued: 0 });
});
