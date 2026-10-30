const { test } = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { createApp } = require('../src/app');
const { createLiteratureEvaluator } = require('../src/runs/literature-evaluator');

class Socket extends EventEmitter {
  addEventListener(...args) { this.on(...args); }
  close() { this.emit('close'); }
}
test('文献适配器保留文本标量、过滤控制帧并拒绝不完整连接和超时', async () => {
  for (const mode of ['done', 'close', 'timeout']) {
    let payload; const chunks = []; const socket = new Socket();
    socket.send = text => {
      payload = JSON.parse(text);
      if (mode === 'timeout') return;
      socket.emit('message', { data: JSON.stringify({ type: 'progress', data: 'internal' }) });
      socket.emit('message', { data: '[start]回答' });
      socket.emit('message', { data: '25' });
      if (mode === 'done') socket.emit('message', { data: '[end]' });
      socket.emit('close');
    };
    const evaluator = createLiteratureEvaluator({ url: 'ws://127.0.0.1/test', timeoutMs: 30, createSocket: () => { queueMicrotask(() => socket.emit('open')); return socket; } });
    const started = await evaluator.startQuestionRun({ question: '请检索芯片封装相关文献。' }, { onText: text => chunks.push(text) });
    const result = await started.completion;
    assert.equal(payload.instruction, '请检索芯片封装相关文献。');
    assert.equal(result.status, mode === 'done' ? 'done' : 'error');
    if (mode === 'done') assert.equal(chunks.join(''), '[start]回答25[end]');
    assert.equal((await evaluator.getRunQuality()).status, 'absent');
  }
});

test('运行 HTTP 校验会话、读写权限、来源、开关、幂等键及参数', async t => {
  let calls = 0;
  const evaluations = { list: async () => ({ items: [], total: 0 }), createRun: async (_, { scope, key }) => { calls++; assert.equal(scope, 'evaluation-user:writer'); assert.equal(key, 'same-key'); return { runId: '11111111-1111-4111-8111-111111111111', serviceKey: 'literature' }; } };
  const authService = { authenticate: async token => { if (!token) throw Object.assign(new Error('请登录'), { status: 401 }); return { id: token, permissions: token === 'reader' ? ['team-services:read'] : ['team-services:read', 'team-services:write'] }; } };
  const server = createApp({ token: 'x'.repeat(32), authService, evaluations, runWriteEnabled: true, publicOrigin: 'http://localhost' });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); t.after(() => server.close());
  const base = `http://127.0.0.1:${server.address().port}/api/evaluation/unified/runs`;
  const post = (token = 'writer', origin = 'http://localhost', key = 'same-key') => fetch(base, { method: 'POST', headers: { cookie: `evaluation_session=${token}`, origin, 'content-type': 'application/json', 'Idempotency-Key': key }, body: JSON.stringify({ serviceKey: 'literature', question: '测试文献问题' }) });
  assert.equal((await fetch(base)).status, 401);
  assert.equal((await post('reader')).status, 403);
  assert.equal((await post('writer', 'http://evil.invalid')).status, 403);
  // 幂等键由运行服务最终校验；HTTP 完整传递主体及键。
  assert.equal((await post()).status, 201); assert.equal(calls, 1);
  assert.equal((await fetch(base + '?page=0', { headers: { cookie: 'evaluation_session=reader' } })).status, 400);
  assert.equal((await fetch(base + '/bad-id', { headers: { cookie: 'evaluation_session=reader' } })).status, 400);
  const disabled = createApp({ token: 'x'.repeat(32), authService, evaluations, publicOrigin: 'http://localhost' });
  await new Promise(resolve => disabled.listen(0, '127.0.0.1', resolve)); t.after(() => disabled.close());
  assert.equal((await fetch(`http://127.0.0.1:${disabled.address().port}/api/evaluation/unified/runs`, { method: 'POST', headers: { cookie: 'evaluation_session=writer', origin: 'http://localhost' } })).status, 503);
});
