const { test } = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { createApp } = require('../src/app');
const { createLiteratureEvaluator } = require('../src/runs/literature-evaluator');
const { createUnifiedEvaluationService } = require('../src/runs/unified-evaluation.service');

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

test('重新测评接口要求读写权限、同源、写开关并禁止覆盖输入', async t => {
  let calls = 0;
  const id = '11111111-1111-4111-8111-111111111111';
  const evaluations = { async rerun(runId, options) { calls++; assert.equal(runId, id); assert.equal(options.key, 'rerun-key'); return { runId: '22222222-2222-4222-8222-222222222222' }; } };
  const authService = { async authenticate(token) { if (!token) throw Object.assign(Error('登录'), { status: 401 }); return { id: token, permissions: token === 'reader' ? ['team-services:read'] : ['team-services:read','team-services:write'] }; } };
  for (const enabled of [true,false]) {
    const app = createApp({ token: 'a'.repeat(32), authService, evaluations, runWriteEnabled: enabled, publicOrigin: 'http://localhost' });
    await new Promise(resolve => app.listen(0,'127.0.0.1',resolve)); t.after(() => app.close());
    const url = `http://127.0.0.1:${app.address().port}/api/evaluation/unified/runs/${id}/rerun`;
    const post = (cookie='writer',origin='http://localhost',body='{}') => fetch(url,{method:'POST',headers:{cookie:`evaluation_session=${cookie}`,origin,'content-type':'application/json','Idempotency-Key':'rerun-key'},body});
    assert.equal((await post('reader')).status,403);
    assert.equal((await post('writer','http://other.test')).status,403);
    if (enabled) { assert.equal((await post('writer','http://localhost','{"question":"覆盖"}')).status,400); assert.equal((await post()).status,201); }
    else assert.equal((await post()).status,503);
  }
  assert.equal(calls,1);
});

test('航空文献复用 instruction 协议，隔离任务标识并保留部分回答和失败原因', async () => {
  const ids = new Set();
  for (const mode of ['done', 'close', 'timeout', 'error', 'interaction', 'binary', 'oversize']) {
    let payload; const chunks = []; const socket = new Socket();
    socket.send = text => {
      payload = JSON.parse(text);
      socket.emit('message', { data: '[sta' });
      socket.emit('message', { data: 'rt]航空文献正文' });
      socket.emit('message', { data: JSON.stringify({ type: 'progress', text: '内部过程' }) });
      if (mode === 'done') { socket.emit('message', { data: '[en' }); socket.emit('message', { data: 'd]' }); socket.emit('close'); }
      if (mode === 'close') socket.emit('close');
      if (mode === 'error') socket.emit('message', { data: '{"type":"error"}' });
      if (mode === 'interaction') socket.emit('message', { data: '{"type":"user_input_request"}' });
      if (mode === 'binary') socket.emit('message', { data: new Uint8Array([1]) });
      if (mode === 'oversize') socket.emit('message', { data: 'x'.repeat(3 * 1024 * 1024 + 1) });
    };
    const evaluator = createLiteratureEvaluator({ serviceKey: 'literature-aircraft', url: 'ws://127.0.0.1:1108/start', timeoutMs: 30,
      createSocket: target => { assert.equal(target, 'ws://127.0.0.1:1108/start'); queueMicrotask(() => socket.emit('open')); return socket; } });
    const started = await evaluator.startQuestionRun({ question: '请检索高超声速飞行器热防护材料文献。' }, { onText: text => chunks.push(text) });
    const result = await started.completion;
    assert.equal(result.status, mode === 'done' ? 'done' : 'error');
    assert.match(payload.taskid, /^evaluation-literature-aircraft-/); ids.add(payload.taskid);
    assert.equal(payload.instruction, '请检索高超声速飞行器热防护材料文献。');
    assert.deepEqual(payload.file_metadata, []); assert.equal(payload.user_name, 'science-evaluation');
    assert.equal(result.taskid, payload.taskid);
    assert.equal(chunks.join(''), `[start]航空文献正文${mode === 'done' ? '[end]' : ''}`);
    if (!['done', 'interaction'].includes(mode)) assert.match(result.error, /航空文献服务/);
    assert.equal(evaluator.scoreMode, 'none'); assert.equal((await evaluator.getRunQuality()).status, 'absent');
  }
  assert.equal(ids.size, 7);
});

test('服务可用性按各自适配器、写开关和用户权限确定，1108可单独配置', async t => {
  const authService = { authenticate: async token => {
    if (!token) throw Object.assign(Error('请登录'), { status: 401 });
    return { id: token, permissions: token === 'reader' ? ['team-services:read'] : ['team-services:read', 'team-services:write'] };
  } };
  for (const keys of [[], ['mission-material'], ['literature'], ['literature-aircraft'], ['literature', 'literature-aircraft'], ['alloy'], ['synthesis'], ['new-material'], ['mission-material', 'literature', 'literature-aircraft', 'alloy', 'synthesis', 'new-material']]) {
    const evaluator = { startQuestionRun: () => { throw Error('不能触发被测服务'); } };
    const evaluations = createUnifiedEvaluationService({ evaluators: Object.fromEntries(keys.map(key => [key, evaluator])) });
    for (const write of [false, true]) {
      const server = createApp({ token: 'x'.repeat(32), authService, evaluations, runWriteEnabled: write, publicOrigin: 'http://localhost' });
      await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); t.after(() => server.close());
      const url = `http://127.0.0.1:${server.address().port}/api/evaluation/unified/services`;
      assert.equal((await fetch(url)).status, 401);
      for (const user of ['reader', 'writer']) {
        const response = await fetch(url, { headers: { cookie: `evaluation_session=${user}` } });
        assert.equal(response.status, 200);
        const { items } = await response.json();
        assert.deepEqual(items.filter(item => item.enabled).map(item => item.key), write && user === 'writer' ? keys : []);
        assert.ok(items.every(item => item.scoring === 'absent'));
      }
      for (const key of ['mission-material', 'literature', 'literature-aircraft', 'alloy', 'synthesis', 'new-material'].filter(key => !keys.includes(key))) {
        const response = await fetch(url.replace('/services', '/runs'), { method: 'POST',
          headers: { cookie: 'evaluation_session=writer', origin: 'http://localhost', 'content-type': 'application/json', 'Idempotency-Key': 'unconfigured' },
          body: JSON.stringify({ serviceKey: key, question: '请检索航空热防护材料相关文献。' }) });
        assert.equal(response.status, write ? 400 : 503);
      }
    }
  }
});
