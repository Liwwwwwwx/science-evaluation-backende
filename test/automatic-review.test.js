const { test } = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { createMaterialEvaluator } = require('../src/runs/material-evaluator');
const { createLiteratureEvaluator } = require('../src/runs/literature-evaluator');

for (const serviceKey of ['literature', 'literature-aircraft', 'alloy', 'synthesis', 'new-material']) test(`${serviceKey}默认立即自动继续，重复请求只答复一次且不伪造答案`, async () => {
  const sent = []; const chunks = []; const states = [];
  const factory = serviceKey.startsWith('literature') ? createLiteratureEvaluator : createMaterialEvaluator;
  const evaluator = factory({ serviceKey, url: `ws://127.0.0.1/${serviceKey}/start`, endSettleMs: 1,
    fetchImpl: async () => Response.json({ candidates: [] }),
    createSocket: () => {
      const socket = new EventEmitter(); socket.addEventListener = socket.on; socket.close = () => socket.emit('close');
      const frame = value => socket.emit('message', { data: typeof value === 'string' ? value : JSON.stringify(value) });
      socket.send = value => {
        const payload = JSON.parse(value); sent.push(payload);
        if (payload.type === 'checkpoint.reply') { setTimeout(() => { frame('正文[end]'); socket.close(); }, 5); return; }
        frame('[start]');
        const review = { type: 'requirement_review_request', taskid: payload.taskid, request_id: 'r1', data: { title: '确认条件', questions: [{ id: 'q1', question: '补充条件', required: true, answer: '服务建议' }] } };
        frame(review); frame(review);
      };
      queueMicrotask(() => socket.emit('open')); return socket;
    },
  });
  const started = await evaluator.startQuestionRun({ question: '测试材料服务自动继续功能。' }, { onText: value => chunks.push(value), onState: value => states.push(value) });
  const result = await started.completion;
  assert.equal(result.status, 'done'); assert.equal(sent.length, 2);
  assert.deepEqual(sent[1], { type: 'checkpoint.reply', schema_version: 1, taskid: sent[0].taskid, request_id: 'r1', action: 'continue' });
  assert.equal(chunks.join(''), '[start]正文[end]');
  assert.equal(result.details.pendingReview, null); assert.equal(result.details.review.length, 2);
  assert.equal(result.details.review[0].source, 'service');
  assert.equal(result.details.review[1].source, 'automatic'); assert.equal(result.details.review[1].delivery, 'sent');
  assert.deepEqual(result.details.review[1].answers, []); assert.ok(states.every(state => !state.pendingReview));
});

test('自动继续发送失败、服务拒绝、错误身份和循环请求如实失败', async () => {
  for (const mode of ['send-failed', 'rejected', 'wrong-task', 'loop']) {
    let first; let replies = 0;
    const evaluator = createMaterialEvaluator({ serviceKey: 'new-material', url: 'ws://127.0.0.1/new-material/start', endSettleMs: 0,
      createSocket: () => {
        const socket = new EventEmitter(); socket.addEventListener = socket.on; socket.close = () => socket.emit('close');
        const emit = payload => socket.emit('message', { data: JSON.stringify(payload) });
        const request = n => emit({ type: 'requirement_review_request', taskid: mode === 'wrong-task' ? 'foreign' : first.taskid, request_id: String(n), data: { questions: [] } });
        socket.send = value => {
          const payload = JSON.parse(value);
          if (payload.type !== 'checkpoint.reply') { first = payload; request(1); return; }
          replies++;
          if (mode === 'send-failed') throw Error('模拟发送失败');
          if (mode === 'rejected') emit({ type: 'requirement_review_error' });
          if (mode === 'loop') request(replies + 1);
        };
        queueMicrotask(() => socket.emit('open')); return socket;
      },
    });
    const started = await evaluator.startQuestionRun({ question: '测试自动继续的异常状态。' }, { onText() {} });
    const result = await started.completion; assert.equal(result.status, 'error');
    if (mode === 'send-failed') assert.equal(result.details.review.at(-1).delivery, 'failed');
    if (mode === 'rejected') assert.match(result.error, /拒绝自动继续/);
    if (mode === 'wrong-task') assert.equal(replies, 0);
    if (mode === 'loop') assert.equal(replies, 10);
  }
});
