const test = require('node:test');
const assert = require('node:assert/strict');
const { createMissionDailyReportService } = require('../src/notifications/mission-daily-report.service');

function fixture() {
  const plan = { id: 'plan-1', date: '2026-11-02', state: 'submitted', items: [
    { questionId: 'q1', datasetVersion: 'v1' }, { questionId: 'q2', datasetVersion: 'v1' },
  ] };
  const runs = [
    { questionId: 'q1', datasetVersion: 'v1', status: 'done', finishedAt: new Date(), scores: { deepSeekScore: { status: 'ready', quality: { total: 80 } }, qwenScore: { status: 'ready', quality: { total: 60 } } } },
    { questionId: 'q2', datasetVersion: 'v1', status: 'error', finishedAt: new Date(), scores: { deepSeekScore: { status: 'failed' }, qwenScore: { status: 'ready', quality: { total: 70 } } } },
  ];
  const sent = []; let record = null; let result = { sent: true };
  const repository = { candidates: async () => record ? [] : [plan], runs: async () => runs, async claim() { if (record) return false; record = { state: 'sending' }; return true; },
    async finish(_id, state, reason) { record = { state, reason }; } };
  const notifier = { configured: true, async sendText(message) { sent.push(message); return result; } };
  const make = (options = {}) => createMissionDailyReportService({ repository, notifier, enabled: true, ready: true, ...options });
  return { plan, runs, sent, make, record: () => record, setResult: value => { result = value; } };
}

test('仅在整批完成且评分结束后向测试机器人发送一次汇总', async () => {
  const f = fixture(); f.runs[1].finishedAt = null;
  await f.make().tick(); assert.equal(f.sent.length, 0);
  f.runs[1].finishedAt = new Date();
  await Promise.all([f.make().tick(), f.make().tick()]);
  assert.equal(f.sent.length, 1); assert.equal(f.record().state, 'sent');
  assert.match(f.sent[0], /执行完成：1 道/); assert.match(f.sent[0], /执行失败：1 道/);
  assert.match(f.sent[0], /DeepSeek：80\.0 分（1\/2 题）/); assert.match(f.sent[0], /Qwen：65\.0 分（2\/2 题）/);
  await f.make().tick(); assert.equal(f.sent.length, 1);
});

test('发送结果不确定时记录 unknown，重启不会重新发送', async () => {
  const f = fixture(); f.setResult({ sent: false, reason: 'request-failed' });
  await f.make().tick(); assert.deepEqual(f.record(), { state: 'unknown', reason: 'request-failed' });
  await f.make().tick(); assert.equal(f.sent.length, 1);
});

test('跳过的计划有原因汇总，关闭或未就绪时不发送', async () => {
  const f = fixture(); f.plan.state = 'skipped'; f.plan.reason = '上一轮仍未结束';
  await f.make({ enabled: false }).tick(); await f.make({ ready: false }).tick(); assert.equal(f.sent.length, 0);
  await f.make().tick(); assert.equal(f.sent.length, 1); assert.match(f.sent[0], /本轮跳过/); assert.match(f.sent[0], /上一轮仍未结束/);
});

test('缺少任务、任务仍在执行或评分时不提前发送', async () => {
  const f = fixture(); f.runs.pop(); await f.make().tick(); assert.equal(f.sent.length, 0);
  f.runs.push({ questionId: 'q2', datasetVersion: 'v1', status: 'scoring', finishedAt: null });
  await f.make().tick(); assert.equal(f.sent.length, 0);
});
