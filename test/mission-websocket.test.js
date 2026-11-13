const test = require('node:test');
const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const { createServer } = require('node:http');
const { WebSocketServer } = require('ws');
const { createMissionEvaluator } = require('../src/runs/mission-evaluator');
const { runProbe } = require('../scripts/mission-stream-probe');

function frame(opcode, value) {
  const payload = Buffer.isBuffer(value) ? value : Buffer.from(value);
  const header = payload.length < 126 ? Buffer.from([0x80 | opcode, payload.length])
    : payload.length <= 0xffff ? Buffer.from([0x80 | opcode, 126, payload.length >> 8, payload.length & 0xff])
      : Buffer.alloc(10);
  if (header.length === 10) { header[0] = 0x80 | opcode; header[1] = 127; header.writeBigUInt64BE(BigInt(payload.length), 2); }
  return Buffer.concat([header, payload]);
}

const finalAnswer = '材料分析结果'.repeat(4000);
const finalFrames = [
  frame(1, '[start]'),
  frame(1, JSON.stringify({ type: 'display.final_answer', event_id: 'final', phase: 'delta', seq: 1, delta: finalAnswer.slice(0, 3000) })),
  frame(1, JSON.stringify({ type: 'display.final_answer', event_id: 'final', phase: 'delta', seq: 2, delta: finalAnswer.slice(3000) })),
  frame(1, JSON.stringify({ type: 'display.final_answer', event_id: 'final', phase: 'end', seq: 3, content: finalAnswer })),
  frame(1, JSON.stringify({ type: 'display.recommendations', items: [] })),
  frame(1, '[end]'),
];

async function mockMission(t, mode) {
  const server = createServer(); const sockets = new Set();
  server.on('connection', socket => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)); socket.on('error', () => {}); });
  server.on('upgrade', (request, socket, head) => {
    const accept = createHash('sha1').update(`${request.headers['sec-websocket-key']}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`).digest('base64');
    socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
    const respond = () => {
      if (mode === 'complete') {
        // 与 Mission 收尾一致：末尾业务帧紧接正常关闭帧，随后连接结束。
        socket.setNoDelay(true);
        for (const data of finalFrames) socket.write(data);
        socket.write(frame(8, Buffer.from([0x03, 0xe8])), () => socket.destroy());
      } else if (mode === 'abrupt') {
        // 发送部分内容后没有关闭帧，不能误判为成功。
        socket.end(Buffer.concat(finalFrames.slice(0, 2)));
      } else if (mode === 'boundary') {
        const empty = JSON.stringify({ type: 'progress', message: '' });
        const payload = JSON.stringify({ type: 'progress', message: 'x'.repeat(8 * 1024 * 1024 - Buffer.byteLength(empty)) });
        socket.end(Buffer.concat([frame(1, '[start]'), frame(1, payload), frame(1, '[end]'), frame(8, Buffer.from([0x03, 0xe8]))]));
      } else {
        // 只发送超限消息的长度头，验证客户端在分配完整消息前拒绝。
        const header = Buffer.alloc(10); header[0] = 0x81; header[1] = 127;
        header.writeBigUInt64BE(BigInt(8 * 1024 * 1024 + 1), 2);
        socket.write(Buffer.concat([frame(1, '[start]已有输出'), header]));
      }
    };
    if (head.length) respond(); else socket.once('data', respond);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { for (const socket of sockets) socket.destroy(); await new Promise(resolve => server.close(resolve)); });
  return `ws://127.0.0.1:${server.address().port}/start`;
}

function disableNativeWebSocket(t) {
  const original = globalThis.WebSocket;
  globalThis.WebSocket = class { constructor() { throw new Error('测试中禁用原生 WebSocket'); } };
  t.after(() => { globalThis.WebSocket = original; });
}

test('Mission 快速收尾时完整接收末尾消息与正常关闭帧', async t => {
  disableNativeWebSocket(t);
  const url = await mockMission(t, 'complete');
  const evaluator = createMissionEvaluator({ url, timeoutMs: 2000 });
  for (let i = 0; i < 20; i++) {
    const started = await evaluator.startQuestionRun({ question: '本机测试 Mission 正常结束' }, { onText() {} });
    const result = await started.completion;
    assert.equal(result.status, 'done', `第 ${i + 1} 次：${result.error}`);
    assert.equal(result.details.transport.closeCode, 1000);
    assert.equal(result.details.transport.receivedFrames, 6);
    assert.equal(result.details.displayEvents.find(event => event.event_id === 'final')?.content, finalAnswer);
  }
});

test('Mission 真实中断仍标记失败并保留已收到的内容', async t => {
  const url = await mockMission(t, 'abrupt');
  const evaluator = createMissionEvaluator({ url, timeoutMs: 2000 });
  const started = await evaluator.startQuestionRun({ question: '本机测试 Mission 异常断连' }, { onText() {} });
  const result = await started.completion;
  assert.equal(result.status, 'error');
  assert.equal(result.details.transport.closeCode, 1006);
  assert.match(result.error, /关闭码 1006/);
  assert.equal(result.details.displayEvents.find(event => event.event_id === 'final')?.delta, finalAnswer.slice(0, 3000));
});

test('Mission 实际连接收到超限消息时保留已接收内容并明确报错', async t => {
  const url = await mockMission(t, 'oversized'); const chunks = [];
  const evaluator = createMissionEvaluator({ url, timeoutMs: 2000 });
  const started = await evaluator.startQuestionRun({ question: '本机测试 Mission 超限消息' }, { onText: text => chunks.push(text) });
  const result = await started.completion;
  assert.equal(result.status, 'error');
  assert.match(result.error, /数据帧超过接收上限/);
  assert.equal(result.details.transport.maxFrameBytes, 8 * 1024 * 1024);
  assert.equal(chunks.join(''), '[start]已有输出');
});

test('Mission 实际连接允许恰好 8 MiB 的消息', async t => {
  const url = await mockMission(t, 'boundary');
  const evaluator = createMissionEvaluator({ url, timeoutMs: 5000 });
  const started = await evaluator.startQuestionRun({ question: '本机测试 Mission 消息边界' }, { onText() {} });
  const result = await started.completion;
  assert.equal(result.status, 'done');
  assert.equal(result.details.transport.receivedFrames, 3);
  assert.equal(result.details.progress[0].text.length, 1000);
});

test('Mission 连接协商压缩并按解压后大小限制消息', async t => {
  const server = new WebSocketServer({ host: '127.0.0.1', port: 0, perMessageDeflate: true });
  await new Promise(resolve => server.once('listening', resolve));
  t.after(async () => { for (const client of server.clients) client.terminate(); await new Promise(resolve => server.close(resolve)); });
  let extensions;
  server.on('connection', socket => {
    extensions = socket.extensions;
    socket.once('message', () => {
      socket.send('[start]已有输出');
      socket.send(JSON.stringify({ type: 'progress', message: 'x'.repeat(8 * 1024 * 1024) }));
    });
  });
  const chunks = [];
  const evaluator = createMissionEvaluator({ url: `ws://127.0.0.1:${server.address().port}`, timeoutMs: 5000 });
  const started = await evaluator.startQuestionRun({ question: '本机测试压缩后的超限消息' }, { onText: text => chunks.push(text) });
  const result = await started.completion;
  assert.equal(extensions, 'permessage-deflate');
  assert.equal(result.status, 'error');
  assert.match(result.error, /数据帧超过接收上限/);
  assert.equal(result.details.transport.maxFrameBytes, 8 * 1024 * 1024);
  assert.equal(chunks.join(''), '[start]已有输出');
});

test('Mission 实际连接支持自动答复追问并正常结束', async t => {
  const server = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  await new Promise(resolve => server.once('listening', resolve));
  t.after(async () => { for (const client of server.clients) client.terminate(); await new Promise(resolve => server.close(resolve)); });
  const replies = [];
  server.on('connection', socket => {
    socket.on('message', data => {
      const value = JSON.parse(data.toString());
      if (value.idea) {
        socket.send(JSON.stringify({ type: 'display.followup_request', event_id: 'followup', kind: 'clarify', message: '目标温度？' }));
      } else {
        replies.push(value);
        socket.send('[start]已完成[end]');
        socket.close(1000);
      }
    });
  });
  const evaluator = createMissionEvaluator({ url: `ws://127.0.0.1:${server.address().port}`, timeoutMs: 2000,
    generateSupplement: async () => ({ message: '按 600℃ 假设继续。', model: 'test-model' }) });
  const started = await evaluator.startQuestionRun({ question: '本机测试 Mission 自动追问' }, { onText() {} });
  const result = await started.completion;
  assert.equal(result.status, 'done');
  assert.equal(replies.length, 1);
  assert.deepEqual(replies[0], { type: 'checkpoint.reply', taskid: started.run.id, params: { message: '按 600℃ 假设继续。' }, mission: true, approved: true });
  assert.equal(result.details.review[0].delivery, 'sent');
});

test('Mission 流式探针默认使用与平台一致的 WebSocket 客户端', async t => {
  disableNativeWebSocket(t);
  const url = await mockMission(t, 'complete');
  const rows = await runProbe({ url, count: 1, question: '本机测试 Mission 探针', timeoutMinutes: 1, intervalSeconds: 1 }, { write() {} });
  assert.equal(rows[0].result.status, 'done');
  assert.equal(rows[0].frameCount, 6);
  assert.equal(rows[0].closeCode, 1000);
});
