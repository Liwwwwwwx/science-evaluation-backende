const { test } = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { createMaterialEvaluator, collectArtifacts } = require('../src/runs/material-evaluator');

function socketFor(send) {
  const socket = new EventEmitter(); socket.addEventListener = socket.on;
  socket.send = text => send(JSON.parse(text), socket);
  socket.close = () => socket.emit('close');
  queueMicrotask(() => socket.emit('open')); return socket;
}
const frame = (socket, value) => socket.emit('message', { data: typeof value === 'string' ? value : JSON.stringify(value) });

for (const serviceKey of ['alloy', 'synthesis', 'new-material']) test(`${serviceKey} 请求、控制帧、尾帧、结果和任务快照`, async () => {
  let payload; let fetches = 0; const chunks = []; const states = [];
  const evaluator = createMaterialEvaluator({ serviceKey, url: `ws://127.0.0.1/${serviceKey}/start`, endSettleMs: 15,
    createSocket: () => socketFor((sent, socket) => {
      payload = sent; frame(socket, '[start]回答25'); frame(socket, { type: 'progress', data: { stage: '生成', percent: 50 } });
      frame(socket, { type: 'result', data: { status: 'completed', candidates: [{ id: 'C1' }] } });
      if (serviceKey === 'synthesis') { frame(socket, { contract_version: 1, task: 't' }); frame(socket, { stage_id: 'S1', input_count: 3, output_count: 1 }); }
      frame(socket, '[end]');
      setTimeout(() => frame(socket, { type: 'generated_files', file_metadata: [{ name: '模型.glb', url: '/files/model.glb' }] }), 2);
    }),
    fetchImpl: async url => {
      fetches++; assert.equal(url.pathname, `/${serviceKey}/tasks/${payload.taskid}`);
      return Response.json({ taskid: payload.taskid, ranked_candidates: [{ candidate: { formula_pretty: 'Al2O3' } }] });
    },
  });
  const started = await evaluator.startQuestionRun({ question: '请计算材料候选并比较各项性能。' }, { onText: t => chunks.push(t), onState: s => states.push(s) });
  const result = await started.completion;
  assert.equal(payload[serviceKey === 'new-material' ? 'instruction' : 'idea'], '请计算材料候选并比较各项性能。');
  assert.match(payload.taskid, new RegExp(`^evaluation-${serviceKey}-`));
  assert.equal(result.status, 'done'); assert.equal(chunks.join(''), '[start]回答25[end]');
  assert.equal(result.details.result.candidates.length, 1); assert.equal(result.details.progress.length, serviceKey === 'synthesis' ? 2 : 1);
  assert.equal(result.details.artifacts[0].url, 'http://127.0.0.1/files/model.glb');
  assert.equal(fetches, serviceKey === 'synthesis' ? 0 : 1);
  assert.equal(result.details.snapshot.ok, serviceKey !== 'synthesis');
  assert.ok(states.length >= 3); assert.equal(evaluator.scoreMode, 'none');
});

test('显式人工策略仍校验必填答案及重复/过期答复', async () => {
  const sent = []; let pending;
  const evaluator = createMaterialEvaluator({ serviceKey: 'new-material', url: 'ws://127.0.0.1/new-material/start', autoContinueReview: false, endSettleMs: 0,
    createSocket: () => socketFor((payload, socket) => {
      sent.push(payload);
      if (payload.type === 'checkpoint.reply') { frame(socket, '[start]回答[end]'); return; }
      frame(socket, { type: 'requirement_review_request', request_id: 'r1', data: { title: '确认元素空间', questions: [{ id: 'elements', question: '允许的元素', required: true, answer: '服务建议' }] } });
    }), fetchImpl: async () => Response.json({ candidates: [] }),
  });
  const started = await evaluator.startQuestionRun({ question: '生成指定元素体系候选。' }, { onText() {}, onState: state => { pending = state; } });
  await new Promise(resolve => setImmediate(resolve)); assert.equal(sent.length, 1);
  assert.equal(pending.pendingReview.questions[0].suggestedAnswer, '服务建议');
  assert.throws(() => started.reply({ requestId: 'r1', action: 'apply', answers: [{ id: 'elements', answer: '' }] }), /不能为空/);
  assert.throws(() => started.reply({ requestId: 'r0', action: 'continue' }), /失效/);
  started.reply({ requestId: 'r1', action: 'apply', answers: [{ id: 'elements', answer: '只允许Cs、Pb、Br' }] });
  assert.equal(sent.length, 2); assert.equal(sent[1].data.answers[0].answer, '只允许Cs、Pb、Br');
  assert.throws(() => started.reply({ requestId: 'r1', action: 'apply' }), /失效/);
  const result = await started.completion; assert.equal(result.status, 'done'); assert.equal(result.details.review[1].source, 'user');
});

test('连接异常、交互停止、快照失败和超限如实保留状态', async () => {
  for (const mode of ['close', 'timeout', 'error', 'stop', 'snapshot', 'oversize']) {
    const chunks = []; let finishReview;
    const evaluator = createMaterialEvaluator({ serviceKey: 'alloy', url: 'ws://127.0.0.1/alloy/start', autoContinueReview: false, timeoutMs: 30, endSettleMs: 0,
      createSocket: () => socketFor((payload, socket) => {
        if (payload.type === 'checkpoint.reply') return;
        frame(socket, '[start]部分回答');
        if (mode === 'close') socket.close();
        if (mode === 'error') frame(socket, { type: 'error' });
        if (mode === 'oversize') frame(socket, 'x'.repeat(2 * 1024 * 1024 + 1));
        if (mode === 'snapshot') frame(socket, '[end]');
        if (mode === 'stop') frame(socket, { type: 'requirement_review_request', request_id: 1, data: { questions: [] } });
      }), fetchImpl: async () => new Response('not found', { status: 404 }),
    });
    const started = await evaluator.startQuestionRun({ question: '测试材料候选性能。' }, { onText: t => chunks.push(t), onState: s => { finishReview = s.pendingReview; } });
    await new Promise(resolve => setImmediate(resolve));
    if (mode === 'stop') { assert.ok(finishReview); started.reply({ requestId: 1, action: 'stop' }); }
    const result = await started.completion;
    assert.equal(result.status, mode === 'snapshot' ? 'done' : 'error'); assert.ok(chunks.join('').startsWith('[start]部分回答'));
    if (mode === 'snapshot') assert.equal(result.details.snapshot.ok, false);
  }
});

test('产物只接受HTTP链接，拒绝脚本/凭据并解析相对地址', () => {
  const files = collectArtifacts([{ url: 'javascript:alert(1)' }, { url: 'https://user:password@x/a' }, { name: 'a', preview_url: '/files/a.png' }], 'http://127.0.0.1/start');
  assert.deepEqual(files, [{ name: 'a', url: 'http://127.0.0.1/files/a.png' }]);
});


test('非法Unicode成果名不会拒绝收尾，正常资产仍保留并给出提示', async () => {
  const evaluator = createMaterialEvaluator({ serviceKey: 'new-material', url: 'ws://127.0.0.1/new-material/start', endSettleMs: 0,
    createSocket: () => socketFor((_, socket) => frame(socket, '[start]完整回答[end]')),
    fetchImpl: async () => Response.json({ artifacts: { presentation: { assets: [{ path: 'broken\ud800.glb' }, { path: 'valid.glb' }] } } }),
  });
  const { completion } = await evaluator.startQuestionRun({ question: '生成晶体结构并保留完整结果。' }, { onText() {} });
  const result = await completion;
  assert.equal(result.status, 'done'); assert.match(result.details.artifactError, /路径无效/);
  assert.equal(result.details.artifacts.length, 1); assert.match(result.details.artifacts[0].url, /valid\.glb$/);
  assert.equal(result.details.snapshot.ok, true);
});

test('异常成果路径不会挂起统一运行，并保留正文及释放执行容量', { timeout: 1000 }, async () => {
  const { createUnifiedEvaluationService } = require('../src/runs/unified-evaluation.service');
  let calls = 0;
  const evaluator = createMaterialEvaluator({ serviceKey: 'new-material', url: 'ws://127.0.0.1/new-material/start', endSettleMs: 0,
    createSocket: () => socketFor((_, socket) => { calls++; frame(socket, '[start]已有回答[end]'); }),
    fetchImpl: async () => Response.json({ artifacts: { presentation: { assets: [{ path: calls === 1 ? 'broken\ud800.glb' : 'valid.glb' }] } } }),
  });
  const service = createUnifiedEvaluationService({ evaluators: { 'alpha-combined-rsi': evaluator }, maxActive: 1 });
  const first = await service.start({ serviceKey: 'alpha-combined-rsi', question: '异常产物也需要结束并保留已有正文。' });
  const result = await first.nativeCompletion;
  assert.equal(result.status, 'done'); assert.match(result.details.artifactError, /路径无效/);
  await new Promise(resolve => setImmediate(resolve));
  const saved = await service.get(first.runId); assert.equal(saved.status, 'done'); assert.equal(saved.answer, '[start]已有回答[end]');
  const next = await service.start({ serviceKey: 'alpha-combined-rsi', question: '后续运行仍能正常使用执行容量。' });
  const nextResult = await next.nativeCompletion; assert.equal(nextResult.status, 'done'); assert.equal(nextResult.details.artifacts.length, 1);
});
