const test = require('node:test');
const assert = require('node:assert/strict');
const { createAlphaRsiEvaluator } = require('../src/runs/alpha-rsi-evaluator');

class FakeSocket {
  constructor() { this.listeners = new Map(); this.sent = []; this.closed = false; }
  addEventListener(type, listener) { const list = this.listeners.get(type) || []; list.push(listener); this.listeners.set(type, list); }
  send(value) { this.sent.push(JSON.parse(value)); }
  close() { this.closed = true; }
  emit(type, event = {}) { for (const listener of this.listeners.get(type) || []) listener(event); }
  open() { this.emit('open'); }
  message(data) { this.emit('message', { data }); }
}

function createHarness(overrides = {}) {
  const socket = new FakeSocket();
  const evaluator = createAlphaRsiEvaluator({
    url: 'ws://111.14.140.20:1110/start',
    createSocket: () => socket,
    endSettleMs: 10,
    closeSettleMs: 10,
    timeoutMs: 1000,
    ...overrides,
  });
  return { socket, evaluator };
}

test('1110 发送 idea 首帧，流式正文去掉起止标记', async () => {
  const { socket, evaluator } = createHarness();
  const chunks = [];
  const started = await evaluator.startQuestionRun({ question: '预测 Co20Cr20Fe20Ni40 在 900°C 的屈服强度。' }, { onText: (text) => chunks.push(text) });
  socket.open();
  assert.equal(socket.sent[0].idea, '预测 Co20Cr20Fe20Ni40 在 900°C 的屈服强度。');
  assert.equal(socket.sent[0].taskid, started.run.id);
  assert.deepEqual(socket.sent[0].file_metadata, []);
  socket.message('[start]第一段 ');
  socket.message('第二段[end]');
  const result = await started.completion;
  assert.equal(result.status, 'done');
  assert.equal(result.error, null);
  assert.equal(chunks.join(''), '第一段 第二段');
  assert.equal(result.details.process.events.length, 0);
});

test('起止标记跨帧时仍正确剥离正文', async () => {
  const { socket, evaluator } = createHarness();
  const chunks = [];
  const started = await evaluator.startQuestionRun({ question: '这是一个足够长的测试问题。' }, { onText: (text) => chunks.push(text) });
  socket.open();
  socket.message('[sta');
  socket.message('rt]正文');
  socket.message('继续');
  socket.message('[en');
  socket.message('d]');
  const result = await started.completion;
  assert.equal(result.status, 'done');
  assert.equal(chunks.join(''), '正文继续');
});

test('开工确认与补充条件自动答复，记录实际发送内容', async () => {
  const { socket, evaluator } = createHarness();
  const started = await evaluator.startQuestionRun({ question: '这是一个足够长的测试问题。' }, {});
  socket.open();
  socket.message(JSON.stringify({ type: 'user_input_request', request_id: 'r1', parameters: { reason: 'checkpoint' }, message: '确认开工' }));
  assert.deepEqual(socket.sent[1], { type: 'checkpoint.reply', taskid: started.run.id, request_id: 'r1', approved: true, params: { message: '' } });
  socket.message('[start]完成[end]');
  const ok = await started.completion;
  assert.equal(ok.status, 'done');
  assert.equal(ok.details.review.length, 1);
  assert.equal(ok.details.review[0].source, 'automatic');
  assert.equal(ok.details.review[0].delivery, 'sent');

  const second = createHarness({ generateSupplement: async ({ question, title, questions }) => {
    assert.match(question, /测试问题/); assert.equal(title, '请补充晶粒度'); assert.deepEqual(questions, ['晶粒度是多少？']);
    return { message: '假设晶粒度为 10 μm。', model: 'test-model' };
  } });
  const pending = await second.evaluator.startQuestionRun({ question: '这是一个足够长的测试问题。' }, {});
  second.socket.open();
  const request = JSON.stringify({ type: 'user_input_request', request_id: 'r2', parameters: { reason: 'requirements' }, message: '请补充晶粒度', data: { questions: ['晶粒度是多少？'] } });
  second.socket.message(request); second.socket.message(request);
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(second.socket.sent[1], { type: 'checkpoint.reply', taskid: pending.run.id, request_id: 'r2', approved: true, params: { message: '假设晶粒度为 10 μm。' } });
  assert.equal(second.socket.sent.length, 2);
  second.socket.message('[start]继续完成[end]');
  const result = await pending.completion;
  assert.equal(result.status, 'done');
  assert.deepEqual(result.details.review[0].answers, [{ answer: '假设晶粒度为 10 μm。' }]);
  assert.equal(result.details.review[0].model, 'test-model');
});

test('模型不可用时不发送空答复；结果只有等待状态时不误报完成', async () => {
  const harness = createHarness({ generateSupplement: async () => { throw new Error('自动补充模型未配置'); } });
  const started = await harness.evaluator.startQuestionRun({ question: '测试条件缺失时的处理' });
  harness.socket.open();
  harness.socket.message(JSON.stringify({ type: 'user_input_request', request_id: 'r1', parameters: { reason: 'requirements' } }));
  const failed = await started.completion;
  assert.match(failed.error, /模型未配置/); assert.equal(harness.socket.sent.length, 1);

  const second = createHarness();
  const waiting = await second.evaluator.startQuestionRun({ question: '测试等待结果' });
  second.socket.open();
  second.socket.message(JSON.stringify({ type: 'result', data: { status: 'waiting_for_input' } }));
  second.socket.message('[start]需要更多条件[end]');
  const result = await waiting.completion;
  assert.equal(result.status, 'error'); assert.match(result.error, /未提供可回复/);
});

test('运行结束后迟到的模型答复不会发送', async () => {
  let resolveSupplement;
  const harness = createHarness({ timeoutMs: 20, generateSupplement: () => new Promise(resolve => { resolveSupplement = resolve; }) });
  const started = await harness.evaluator.startQuestionRun({ question: '测试迟到答复' });
  harness.socket.open();
  harness.socket.message(JSON.stringify({ type: 'user_input_request', request_id: 'r1', parameters: { reason: 'requirements' } }));
  assert.match((await started.completion).error, /超时/);
  resolveSupplement({ message: '迟到答复' }); await new Promise(resolve => setImmediate(resolve));
  assert.equal(harness.socket.sent.length, 1);
});

test('收集结果、产物与进度，不把协议对象混入正文', async () => {
  const { socket, evaluator } = createHarness();
  const chunks = [];
  const started = await evaluator.startQuestionRun({ question: '这是一个足够长的测试问题。' }, { onText: (text) => chunks.push(text) });
  socket.open();
  socket.message(JSON.stringify({ type: 'progress', data: { message: '正在计算' } }));
  socket.message(JSON.stringify({ type: 'result', data: { status: 'completed' } }));
  socket.message(JSON.stringify({ type: 'generated_files', file_metadata: [{ original_filename: 'report.md', preview_url: 'http://111.14.140.20:1110/download/report' }] }));
  socket.message('[start]正文[end]');
  const result = await started.completion;
  assert.equal(result.status, 'done');
  assert.equal(chunks.join(''), '正文');
  assert.equal(result.details.result.status, 'completed');
  assert.equal(result.details.progress[0].text, '正在计算');
  assert.equal(result.details.generatedFiles.length, 1);
  assert.equal(result.details.artifacts.length, 1);
  assert.equal(result.details.artifacts[0].url, 'http://111.14.140.20:1110/download/report');
});

test('未支持的交互、错误帧与超时都明确结束', async () => {
  const unsupported = createHarness();
  const pending = await unsupported.evaluator.startQuestionRun({ question: '这是一个足够长的测试问题。' }, {});
  unsupported.socket.open();
  unsupported.socket.message(JSON.stringify({ type: 'requirement_review_request', request_id: 'x' }));
  const failed = await pending.completion;
  assert.equal(failed.status, 'error');
  assert.match(failed.error, /交互尚未支持/);

  const errored = createHarness();
  const running = await errored.evaluator.startQuestionRun({ question: '这是一个足够长的测试问题。' }, {});
  errored.socket.open();
  errored.socket.message(JSON.stringify({ type: 'error', message: '内部错误' }));
  assert.match((await running.completion).error, /执行错误/);

  const timed = createHarness({ timeoutMs: 20 });
  const slow = await timed.evaluator.startQuestionRun({ question: '这是一个足够长的测试问题。' }, {});
  timed.socket.open();
  const timeout = await slow.completion;
  assert.equal(timeout.status, 'error');
  assert.match(timeout.error, /超时/);
});
