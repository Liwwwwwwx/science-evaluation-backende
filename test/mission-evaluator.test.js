const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { createServer } = require('node:http');
const { createHash } = require('node:crypto');
const { createMissionEvaluator } = require('../src/runs/mission-evaluator');
const { createUnifiedEvaluationService } = require('../src/runs/unified-evaluation.service');

class Socket extends EventEmitter {
  addEventListener(...args) { this.on(...args); }
  close() {}
  message(data) { this.emit('message', { data: typeof data === 'string' ? data : JSON.stringify(data) }); }
}
function fixture() {
  const sockets = []; const sent = [];
  const evaluator = createMissionEvaluator({ url: 'ws://127.0.0.1:1234/start', timeoutMs: 1000, createSocket: () => {
    const socket = new Socket(); socket.send = text => sent.push({ socket, value: JSON.parse(text) });
    sockets.push(socket); queueMicrotask(() => socket.emit('open')); return socket;
  } });
  return { evaluator, sockets, sent };
}
const flush = () => new Promise(resolve => setImmediate(resolve));

test('主服务按 Mission 协议发送独立任务，记录显式进度并流式保留原回答', async () => {
  const { evaluator, sockets, sent } = fixture(); const chunks = []; let state;
  const started = await evaluator.startQuestionRun({ question: '请设计材料测试方案' }, { onText: text => chunks.push(text), onState: value => { state = value; } });
  await flush();
  assert.deepEqual(sent[0].value, { idea: '请设计材料测试方案', taskid: started.run.id, user_name: 'science-evaluation', file_metadata: [], has_context: false });
  const socket = sockets[0];
  socket.message('[start]回答');
  socket.message({ type: 'phase_start', data: { phaseKey: 'team_selection', message: '开始选择团队' } });
  socket.message({ type: 'phase_end', data: { phaseKey: 'team_selection', message: '团队选择结束' } });
  socket.message('[end]'); socket.emit('close', { code: 1000 });
  const result = await started.completion;
  assert.equal(result.status, 'done'); assert.equal(chunks.join(''), '[start]回答[end]');
  assert.deepEqual(state.process.events.map(event => event.kind), ['start', 'end']);
  assert.equal(result.details.process.messages.length, 2);
  assert.equal(result.taskid, started.run.id);
});

test('服务并发上限提示不被当作可评分回答', async () => {
  const { evaluator, sockets } = fixture();
  const started = await evaluator.startQuestionRun({ question: '请设计材料测试方案' }, { onText() {} });
  await flush(); const socket = sockets[0];
  socket.message('[start]');
  socket.message('Hermes is at the active session limit (32/32). Try again when another session finishes.');
  socket.emit('close', { code: 1000 });
  const result = await started.completion;
  assert.equal(result.status, 'error');
  assert.match(result.error, /并发上限/);
});

test('非正常关闭保留最后一段正文作为原因', async () => {
  const { evaluator, sockets } = fixture();
  const started = await evaluator.startQuestionRun({ question: '请设计材料测试方案' }, { onText() {} });
  await flush(); const socket = sockets[0];
  socket.message('[start]开始执行');
  socket.emit('close', { code: 1006 });
  const result = await started.completion;
  assert.equal(result.status, 'error');
  assert.match(result.error, /关闭码 1006/);
  assert.match(result.error, /开始执行/);
});

test('按旧协议答复下游确认和补充输入，重复请求不重复答复', async () => {
  const { evaluator, sockets, sent } = fixture();
  const started = await evaluator.startQuestionRun({ question: '请根据条件完成材料设计' }, { onText() {} });
  await flush(); const socket = sockets[0];
  const review = { type: 'requirement_review_request', taskid: 'child-review', request_id: 'r1', data: { title: '确认' } };
  const input = { type: 'user_input_request', taskid: 'child-input', message: '缺少基线', parameters: { reason: 'missing_baseline' } };
  socket.message(review); socket.message(review); socket.message(input); socket.message(input);
  socket.message('[start]结果'); socket.message('[end]'); socket.emit('close', { code: 1000 });
  const result = await started.completion;
  assert.equal(result.status, 'done'); assert.equal(sent.length, 3);
  assert.deepEqual(sent[1].value, { type: 'checkpoint.reply', schema_version: 1, taskid: 'child-review', request_id: 'r1', action: 'continue' });
  assert.deepEqual(sent[2].value, { type: 'checkpoint.reply', taskid: 'child-input', params: { message: '无' }, mission: true, approved: true });
  assert.equal(result.details.review.length, 2);
  assert.ok(result.details.review.every(record => record.source === 'automatic' && record.delivery === 'sent'));
});

test('新版多题追问按 XIMUALPHA 默认回复，重复事件不重复发送', async () => {
  const { evaluator, sockets, sent } = fixture(); let state;
  const started = await evaluator.startQuestionRun({ question: '请设计材料测试方案' }, { onText() {}, onState: value => { state = value; } });
  await flush(); const socket = sockets[0];
  const question = { type: 'display.followup_request', event_id: 'followup-1', kind: 'clarify', questions: [
    { id: 'q1', question: '目标功率？', items: [{ id: 'a', text: '10 W' }] },
    { id: 'q2', question: '绝缘要求？', items: [{ id: 'b', text: '绝缘' }] },
  ] };
  socket.message(question); socket.message({ ...question, seq: 2 });
  await flush();
  assert.equal(sent.length, 2);
  assert.deepEqual(sent[1].value, { type: 'checkpoint.reply', taskid: started.run.id, params: { message: '无' }, mission: true, approved: true });
  assert.equal(state.review.length, 1); assert.equal(state.review[0].delivery, 'sent');
  assert.deepEqual(state.review[0].request.questions, question.questions);
  socket.message({ ...question, event_id: 'followup-2', taskid: 'child-task' });
  await flush();
  assert.equal(sent.length, 3); assert.equal(sent[2].value.taskid, 'child-task');
  socket.message('[start]继续执行[end]'); socket.emit('close', { code: 1000 });
  assert.equal((await started.completion).status, 'done');
});

test('新版审批请求不会作为普通追问自动批准', async () => {
  const { evaluator, sockets, sent } = fixture();
  const started = await evaluator.startQuestionRun({ question: '请设计材料测试方案' }, { onText() {} });
  await flush();
  sockets[0].message({ type: 'display.followup_request', event_id: 'approval-1', kind: 'approval', questions: [{ id: 'q1', question: '执行操作？' }] });
  const result = await started.completion;
  assert.equal(result.status, 'error'); assert.match(result.error, /审批请求未自动批准/);
  assert.deepEqual(sent[1].value, { type: 'checkpoint.reply', taskid: started.run.id, approved: false, params: { message: '' } });
  assert.equal(result.details.review[0].action, 'stop');
});

test('回答后的反馈门拒绝追加任务，正常收尾才成功', async () => {
  const { evaluator, sockets, sent } = fixture();
  const started = await evaluator.startQuestionRun({ question: '请说明材料设计思路' }, { onText() {} });
  await flush(); const socket = sockets[0];
  socket.message('[start]完成的回答');
  socket.message({ type: 'user_input_request', taskid: 'feedback-child', message: '本次生成是否符合用户需求', parameters: { reason: 'adaptive_refactor' } });
  socket.message('[end]'); socket.emit('close', { code: 1000 });
  const result = await started.completion;
  assert.equal(result.status, 'done'); assert.equal(sent[1].value.taskid, 'feedback-child'); assert.equal(sent[1].value.approved, false);
});

test('五个任务各自独立标识与连接，输出不会串到其他任务', async () => {
  const { evaluator, sockets, sent } = fixture();
  const outputs = Array.from({ length: 5 }, () => []);
  const starts = await Promise.all(outputs.map((out, i) => evaluator.startQuestionRun({ question: `并发任务测试问题 ${i}` }, { onText: text => out.push(text) })));
  await flush();
  assert.equal(new Set(sent.map(entry => entry.value.taskid)).size, 5);
  sockets.forEach((socket, i) => { socket.message(`[start]回答${i}[end]`); socket.emit('close', { code: 1000 }); });
  assert.ok((await Promise.all(starts.map(start => start.completion))).every(value => value.status === 'done'));
  assert.deepEqual(outputs.map(chunks => chunks.join('')), Array.from({ length: 5 }, (_, i) => `[start]回答${i}[end]`));
});

test('异常关闭和超时不会冒充完成，保留已有回答', async () => {
  const { evaluator, sockets } = fixture(); const chunks = [];
  const started = await evaluator.startQuestionRun({ question: '请测试异常关闭行为' }, { onText: text => chunks.push(text) });
  await flush(); sockets[0].message('[start]部分输出[end]'); sockets[0].emit('close', { code: 1006 });
  const result = await started.completion;
  assert.equal(result.status, 'error'); assert.equal(chunks.join(''), '[start]部分输出[end]');
  const timeout = createMissionEvaluator({ url: 'ws://127.0.0.1/start', timeoutMs: 15, createSocket: () => new Socket() });
  assert.match((await (await timeout.startQuestionRun({ question: '请测试超时行为' }, { onText() {} })).completion).error, /超时/);
});

test('原生 WebSocket 同时执行五个 Mission 任务且连接与回答隔离', async t => {
  const server = createServer(); const sockets = new Set(); const requests = [];
  server.on('connection', socket => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)); });
  server.on('upgrade', (request, socket, head) => {
    assert.equal(request.url, '/start');
    const accept = createHash('sha1').update(`${request.headers['sec-websocket-key']}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`).digest('base64');
    socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
    let buffer = Buffer.alloc(0);
    const receive = chunk => {
      buffer = Buffer.concat([buffer, chunk]);
      while (buffer.length >= 2) {
        const opcode = buffer[0] & 15; let size = buffer[1] & 127; let offset = 2;
        if (!(buffer[1] & 128) || size === 127) return socket.destroy();
        if (size === 126) { if (buffer.length < 4) return; size = buffer.readUInt16BE(2); offset = 4; }
        if (buffer.length < offset + 4 + size) return;
        const mask = buffer.subarray(offset, offset + 4); const body = Buffer.from(buffer.subarray(offset + 4, offset + 4 + size));
        for (let i = 0; i < size; i++) body[i] ^= mask[i % 4];
        buffer = buffer.subarray(offset + 4 + size);
        if (opcode === 8) { socket.end(); continue; }
        if (opcode !== 1) continue;
        const data = JSON.parse(body.toString()); requests.push(data);
        const answer = Buffer.from(`[start]${data.idea}[end]`);
        socket.write(Buffer.concat([Buffer.from([0x81, answer.length]), answer, Buffer.from([0x88, 2, 0x03, 0xe8])]));
      }
    };
    socket.on('data', receive); if (head.length) receive(head);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { for (const socket of sockets) socket.destroy(); await new Promise(resolve => server.close(resolve)); });
  const evaluator = createMissionEvaluator({ url: `ws://127.0.0.1:${server.address().port}/start`, timeoutMs: 2000 });
  const outputs = Array.from({ length: 5 }, () => []);
  const jobs = await Promise.all(outputs.map((chunks, i) => evaluator.startQuestionRun({ question: `真实握手测试题${i}` }, { onText: text => chunks.push(text) })));
  const results = await Promise.all(jobs.map(job => job.completion));
  assert.equal(requests.length, 5); assert.equal(new Set(requests.map(request => request.taskid)).size, 5);
  assert.ok(results.every(result => result.status === 'done'));
  assert.deepEqual(outputs.map(chunks => chunks.join('')), Array.from({ length: 5 }, (_, i) => `[start]真实握手测试题${i}[end]`));
});

test('统一运行允许主服务五个并发，第六个排队且完成后自动开始', async () => {
  const { evaluator, sockets } = fixture(); const rows = new Map();
  const repository = {
    async findIdempotent() { return null; },
    async createIdempotent(job) { rows.set(job.runId, structuredClone(job)); return { created: true, runId: job.runId }; },
    async claimQueued(job) { const row = rows.get(job.runId); if (!row || row.status !== 'queued') return false; row.status = 'running'; return true; },
    async save(job) { rows.set(job.runId, structuredClone(job)); },
    async get(id) { return structuredClone(rows.get(id)); },
  };
  const service = createUnifiedEvaluationService({ repository, evaluators: { 'mission-material': evaluator } });
  const jobs = [];
  for (let i = 0; i < 6; i++) jobs.push(await service.createRun({ serviceKey: 'mission-material', question: `主服务统一并发题目 ${i}` }, { scope: 'evaluation-user:test', key: `mission-${i}` }));
  assert.equal(sockets.length, 5); assert.equal((await service.get(jobs[5].runId)).status, 'queued');
  sockets[0].message('[start]完成[end]'); sockets[0].emit('close', { code: 1000 });
  for (let i = 0; i < 50 && sockets.length < 6; i++) await new Promise(resolve => setTimeout(resolve, 5));
  assert.equal(sockets.length, 6);
  for (const socket of sockets.slice(1)) { socket.message('[start]完成[end]'); socket.emit('close', { code: 1000 }); }
  await flush();
});

test('超过256KiB的合法团队输出仍完整接收，正常结束后才完成', async () => {
  const { evaluator, sockets } = fixture();
  const started = await evaluator.startQuestionRun({ question: '比较材料性能并提供公开来源' }, { onText() {} });
  await flush();
  const content = '材料参数与来源。'.repeat(20000);
  const frame = { type: 'display.team_output', event_id: 'large-team', phase: 'end', content };
  assert.ok(Buffer.byteLength(JSON.stringify(frame)) > 256 * 1024);
  sockets[0].message(frame);
  sockets[0].message({ type: 'display.final_answer', event_id: 'final', phase: 'end', content: '已经完成材料对比。' });
  sockets[0].emit('close', { code: 1000 });
  const result = await started.completion;
  assert.equal(result.status, 'done');
  assert.equal(result.details.displayEvents.find(frame => frame.event_id === 'large-team').content, content);
  assert.equal(result.details.truncated, false);
});

test('超出接收上限仍明确失败并记录大小，不将不完整输出冒充完成', async () => {
  const { evaluator, sockets } = fixture();
  const started = await evaluator.startQuestionRun({ question: '检查超大帧失败行为' }, { onText() {} });
  await flush();
  const bytes = 8 * 1024 * 1024 + 1;
  sockets[0].message('x'.repeat(bytes));
  const result = await started.completion;
  assert.equal(result.status, 'error');
  assert.match(result.error, /超过接收上限/);
  assert.equal(result.details.transport.rejectedFrameBytes, bytes);
  assert.equal(result.details.transport.maxFrameBytes, 8 * 1024 * 1024);
});

test('最终总结超过归档预算仍必须收到同一总结的结束帧', async () => {
  for (const ending of ['missing', 'other', 'matching']) {
    const { evaluator, sockets } = fixture();
    const started = await evaluator.startQuestionRun({ question: '检查归档超限后的总结完成条件' }, { onText() {} });
    await flush();
    sockets[0].message({ type: 'display.final_answer', event_id: 'large', phase: 'delta', delta: 'x'.repeat(2 * 1024 * 1024) });
    if (ending !== 'missing') sockets[0].message({ type: 'display.final_answer', event_id: ending === 'matching' ? 'large' : 'other', phase: 'end', content: '总结结束' });
    sockets[0].emit('close', { code: 1000 });
    const result = await started.completion;
    assert.equal(result.details.truncated, true);
    assert.equal(result.status, ending === 'matching' ? 'done' : 'error');
    if (ending !== 'matching') assert.match(result.error, /未收到结束帧/);
  }
});

test('已结束总结的迟到增量不能重新打开生命周期', async () => {
  const { evaluator, sockets } = fixture();
  const started = await evaluator.startQuestionRun({ question: '检查总结迟到增量的完成状态' }, { onText() {} });
  await flush();
  sockets[0].message({ type: 'display.final_answer', event_id: 'f', phase: 'end', seq: 2, content: '完整总结' });
  sockets[0].message({ type: 'display.final_answer', event_id: 'f', phase: 'delta', seq: 1, delta: '旧草稿' });
  sockets[0].emit('close', { code: 1000 });
  assert.equal((await started.completion).status, 'done');
});

test('正文超过1MiB字符仍可接收，超过3MiB才失败', async () => {
  const accepted = fixture();
  const longRun = await accepted.evaluator.startQuestionRun({ question: '检查长正文接收' }, { onText() {} });
  await flush();
  accepted.sockets[0].message({ type: 'text.delta', delta: 'x'.repeat(1536 * 1024) });
  accepted.sockets[0].emit('close', { code: 1000 });
  assert.equal((await longRun.completion).status, 'done');

  const rejected = fixture();
  const tooLong = await rejected.evaluator.startQuestionRun({ question: '检查超长正文失败' }, { onText() {} });
  await flush();
  rejected.sockets[0].message({ type: 'text.delta', delta: 'x'.repeat(3 * 1024 * 1024 + 1) });
  const result = await tooLong.completion;
  assert.equal(result.status, 'error');
  assert.match(result.error, /保存上限/);
});
