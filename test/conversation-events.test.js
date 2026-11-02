const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { createConversationEvents } = require('../src/runs/conversation-events');
const { createMissionEvaluator } = require('../src/runs/mission-evaluator');
const { createUnifiedEvaluationService } = require('../src/runs/unified-evaluation.service');
const { createScoringService, packInput } = require('../src/scoring/service');
const flush = () => new Promise(resolve => setImmediate(resolve));

class Socket extends EventEmitter { addEventListener(...args) { this.on(...args); } send(value) { this.sent.push(JSON.parse(value)); } close() {} message(value) { this.emit('message', { data: typeof value === 'string' ? value : JSON.stringify(value) }); } }
function setup() {
  const socket = new Socket(); socket.sent = [];
  const evaluator = createMissionEvaluator({ url: 'ws://127.0.0.1:1234/start', createSocket: () => { queueMicrotask(() => socket.emit('open')); return socket; } });
  return { evaluator, socket };
}

test('团队输出按序号归并、去重，结束帧保留全部增量和最初位置', () => {
  const state = createConversationEvents();
  state.record({ type: 'display.team_output', event_id: 'team', phase: 'start', seq: 0, team: { name: '文献' } }, 4);
  state.record({ type: 'display.team_output', event_id: 'team', phase: 'delta', seq: 2, delta: '乙' }, 9);
  state.record({ type: 'display.team_output', event_id: 'team', phase: 'delta', seq: 1, delta: '甲' }, 9);
  state.record({ type: 'display.team_output', event_id: 'team', phase: 'delta', seq: 2, delta: '乙' });
  state.record({ type: 'display.team_output', event_id: 'team', phase: 'end', seq: 3, status: 'success' });
  const event = state.data.displayEvents[0];
  assert.equal(event.delta, '甲乙'); assert.equal(event.text_offset, 4); assert.equal(event.phase, 'end'); assert.equal(event.status, 'success'); assert.equal(event.team.name, '文献');
});

test('压缩快照之后只追加新序号，最终总结完整content替换预览', () => {
  const state = createConversationEvents();
  state.record({ type: 'display.team_output', event_id: 't', phase: 'delta', seq: 4, compacted_through_seq: 4, delta: '历史' });
  state.record({ type: 'display.team_output', event_id: 't', phase: 'delta', seq: 3, delta: '旧重复' });
  state.record({ type: 'display.team_output', event_id: 't', phase: 'delta', seq: 5, delta: '新增' });
  assert.equal(state.data.displayEvents[0].delta, '历史新增');
  state.record({ type: 'timeline.event', event: { type: 'display.final_answer', event_id: 'f', phase: 'delta', seq: 1, delta: '草稿' } });
  state.record({ type: 'display.final_answer', event_id: 'f', phase: 'end', seq: 2, content: '完整总结' });
  state.record({ type: 'display.final_answer', event_id: 'f', phase: 'delta', seq: 1, delta: '草稿' });
  assert.equal(state.data.displayEvents[1].content, '完整总结'); assert.equal(state.data.displayEvents[1].phase, 'end');
});

test('大内容的结束帧不重复保存增量，迟到增量不覆盖最终正文', () => {
  for (const type of ['display.team_output', 'display.final_answer']) {
    const state = createConversationEvents();
    const content = 'x'.repeat(600 * 1024);
    assert.equal(state.record({ type, event_id: 'large', phase: 'delta', seq: 1, delta: content }), true);
    assert.equal(state.record({ type, event_id: 'large', phase: 'end', seq: 2, content }), true);
    assert.equal(state.record({ type, event_id: 'large', phase: 'delta', seq: 1, delta: content }), true);
    const event = state.data.displayEvents[0];
    assert.equal(event.phase, 'end');
    assert.equal(event.content, content);
    assert.equal(event.delta, undefined);
    assert.equal(state.data.truncated, false);
    assert.match(packInput({ question: '测试', answer: '', run: { details: state.data } }).answer, /x{100}/);
  }
});

test('文件归一化去重、未知业务JSON保留、心跳忽略、超限明确标记', () => {
  const state = createConversationEvents({ baseUrl: 'http://localhost:1234' });
  const frame = { type: 'display.artifact', event_id: 'file', file_metadata: [{ original_filename: '图.png', download_url: '/files/figure.png' }, { name: '危险', url: 'javascript:alert(1)' }, { name: '缺少地址' }] };
  state.record(frame); state.record({ type: 'generated_files', file_metadata: frame.file_metadata });
  state.record({ type: 'business-result', value: 0, valid: false }); state.record({ type: 'heartbeat.ping' });
  assert.equal(state.data.artifacts.length, 1); assert.equal(state.data.artifacts[0].url, 'http://localhost:1234/files/figure.png');
  assert.deepEqual(state.data.protocolFrames.map(item => item.type), ['generated_files', 'business-result']);
  const small = createConversationEvents({ maxBytes: 40 }); assert.equal(small.record({ type: 'result', data: 'x'.repeat(50) }), false); assert.equal(small.data.truncated, true);
});

test('大团队输出和展示事件完整保留，超大进度帧不占归档预算', () => {
  const state = createConversationEvents();
  const team = 'x'.repeat(409 * 1024);
  assert.equal(state.record({ type: 'display.team_output', event_id: 'large-team', phase: 'end', content: team }), true);
  assert.equal(state.record({ type: 'display.final_answer', event_id: 'large-final', phase: 'end', content: 'y'.repeat(281 * 1024) }), true);
  assert.equal(state.record({ type: 'progress', message: 'z'.repeat(745 * 1024) }), true);
  assert.equal(state.record({ type: 'result', data: { value: 'r'.repeat(300 * 1024) } }), true);
  assert.equal(state.data.displayEvents.length, 2);
  assert.equal(state.data.displayEvents[0].content, team);
  assert.deepEqual(state.data.protocolFrames.map(frame => frame.type), ['result']);
  assert.equal(state.data.truncated, false);
});

test('带阶段的进度帧保留，普通进度帧只留摘要不归档', () => {
  const state = createConversationEvents();
  assert.equal(state.record({ type: 'progress', stage_id: 'S1', input_count: 3, message: '阶段进度' }), true);
  assert.equal(state.record({ type: 'progress', message: '普通进度' }), true);
  assert.equal(state.data.protocolFrames.length, 1);
  assert.equal(state.data.protocolFrames[0].stage_id, 'S1');
  assert.equal(state.data.truncated, false);
});

test('超过1MiB的关键事件明确标记截断，不静默保存', () => {
  const state = createConversationEvents();
  assert.equal(state.record({ type: 'display.team_output', event_id: 'too-large', phase: 'delta', delta: 'x'.repeat(1024 * 1024 + 1) }), false);
  assert.equal(state.data.displayEvents.length, 0);
  assert.equal(state.data.truncated, true);
});

test('正常请求不传路由type和历史；子步骤结束与总结end不会提前完成，尾部文件必须保留', async () => {
  const { evaluator, socket } = setup(); const chunks = []; const states = [];
  const started = await evaluator.startQuestionRun({ question: '本题独立完成材料分析', type: '不得发送', history: ['旧内容'] }, { onText: text => chunks.push(text), onState: state => states.push(state) });
  await flush(); assert.equal(socket.sent[0].has_context, false); assert.equal(socket.sent[0].type, undefined); assert.equal(socket.sent[0].history, undefined); assert.equal(socket.sent[0].idea, '本题独立完成材料分析');
  let completed = false; started.completion.then(() => { completed = true; });
  socket.message('[start]说明'); socket.message({ type: 'display.process.step', event_id: 'step', step_id: 'team_selection', seq: 0, status: 'running', title: '选择团队' });
  socket.message({ type: 'display.team_output', event_id: 'team', phase: 'delta', seq: 1, delta: '团队交付内容' });
  socket.message('[end]'); socket.message({ type: 'step.done' });
  socket.message({ type: 'display.final_answer', event_id: 'final', phase: 'start', seq: 2 });
  socket.message({ type: 'display.final_answer', event_id: 'final', phase: 'delta', seq: 3, delta: '总结预览' });
  socket.message('总结预览');
  socket.message({ type: 'display.final_answer', event_id: 'final', phase: 'end', seq: 4, content: '最终交付总结' });
  await flush(); assert.equal(completed, false);
  socket.message({ type: 'generated_files', file_metadata: [{ name: '尾部文件', url: '/files/final.png' }] });
  socket.emit('close', { code: 1001 });
  const result = await started.completion;
  assert.equal(result.status, 'done'); assert.equal(result.details.artifacts.length, 1); assert.equal(chunks.join(''), '[start]说明[end]');
  assert.equal(states.at(-1).displayEvents.find(event => event.event_id === 'final').content, '最终交付总结');
  assert.equal(states.at(-1).displayEvents.find(event => event.event_id === 'team').delta, '团队交付内容');
});

test('关闭后等待异步末帧解码，异常关闭保留部分团队输出', async () => {
  const { evaluator, socket } = setup();
  const started = await evaluator.startQuestionRun({ question: '验证消息排空测试问题' }, { onText() {} }); await flush();
  let decode; socket.emit('message', { data: { text: () => new Promise(resolve => { decode = resolve; }) } }); await flush();
  socket.emit('close', { code: 1000 }); let finished = false; started.completion.then(() => { finished = true; }); await flush(); assert.equal(finished, false);
  decode(JSON.stringify({ type: 'display.final_answer', event_id: 'f', phase: 'end', seq: 1, content: '最后异步帧' }));
  assert.equal((await started.completion).details.displayEvents[0].content, '最后异步帧');
  const next = setup(); const partial = await next.evaluator.startQuestionRun({ question: '验证异常连接保留内容' }, { onText() {} }); await flush();
  next.socket.message({ type: 'display.team_output', event_id: 't', phase: 'delta', seq: 1, delta: '部分成果' }); next.socket.emit('close', { code: 1006 });
  const result = await partial.completion; assert.equal(result.status, 'error'); assert.equal(result.details.displayEvents[0].delta, '部分成果');
});

test('评分必须等待正常结束和完整输出保存，收到全部团队、总结、成果，自动只触发一次', async () => {
  const { evaluator, socket } = setup(); let releaseSave; let scoreCalls = 0; let scored; const rows = new Map();
  const repository = { async create(value) { rows.set(value.runId, structuredClone(value)); }, async save(value) { if (value.run?.status === 'done' && !releaseSave) await new Promise(resolve => { releaseSave = resolve; }); rows.set(value.runId, structuredClone(value)); }, async get(id) { return rows.get(id); } };
  const scoring = { pending: () => ({ deepSeekScore: { status: 'pending' } }), async score(value, publish) { scoreCalls++; scored = value; assert.equal(rows.get(value.runId).run.details.artifacts.length, 1); await publish({ scoring: { finishedAt: new Date().toISOString() }, scores: { deepSeekScore: { status: 'ready' } }, markdownSyntax: {} }); } };
  const service = createUnifiedEvaluationService({ repository, evaluators: { 'mission-material': evaluator }, scoring });
  await service.start({ serviceKey: 'mission-material', question: '验证完整输出评分时序' }); await flush();
  socket.message({ type: 'display.team_output', event_id: 't', phase: 'delta', seq: 1, delta: '团队结果' }); socket.message('[end]');
  await flush(); assert.equal(scoreCalls, 0);
  socket.message({ type: 'display.final_answer', event_id: 'f', phase: 'end', seq: 2, content: '最后总结' });
  socket.message({ type: 'generated_files', file_metadata: [{ name: '图', url: '/files/end.png' }] }); socket.emit('close', { code: 1000 });
  for (let i = 0; i < 10 && !releaseSave; i++) await flush(); assert.equal(scoreCalls, 0); assert.ok(releaseSave);
  releaseSave(); for (let i = 0; i < 10 && !scored; i++) await flush(); assert.equal(scoreCalls, 1);
  assert.match(packInput(scored).answer, /团队结果/); assert.match(packInput(scored).answer, /最后总结/); assert.equal(scored.run.details.artifacts.length, 1);
  socket.emit('close', { code: 1000 }); await flush(); assert.equal(scoreCalls, 1);
});

test('没有普通正文但有团队/总结仍可评分，Markdown问题定位到各自原文', async () => {
  const prompts = [];
  const client = { model: 'fixture', isConfigured: () => true, async callJson(prompt) { prompts.push(prompt); if (prompt.includes('仅根据题目')) return { requirements: [{ requirement: '解释材料结论', critical: true }], visualAidsApplicable: false, visualAidsReason: '无需图片' }; throw Error('只验证输入，不伪造评分'); } };
  const value = { question: '解释材料结论', answer: '', run: { status: 'done', details: { displayEvents: [{ type: 'display.team_output', event_id: 't', phase: 'end', delta: '团队实际成果' }, { type: 'display.final_answer', event_id: 'f', phase: 'end', content: '结论\n[文献](https://example.com' }] } } };
  const result = await createScoringService({ clients: { deepSeekScore: client } }).score(value);
  assert.ok(prompts.length > 1); assert.match(prompts[1], /团队实际成果/); assert.match(prompts[1], /结论/);
  assert.equal(result.markdownSyntax.status, 'observe'); assert.ok(result.markdownSyntax.issues.some(issue => issue.source === 'f' && issue.line === 2));
});


test('兼容JSON正文增量与旧final完整正文，不重复显示已有前缀', async () => {
  const { evaluator, socket } = setup(); const chunks = [];
  const started = await evaluator.startQuestionRun({ question: '验证旧版最终回答兼容' }, { onText: value => chunks.push(value) }); await flush();
  socket.message({ type: 'text.delta', delta: '已有正文' }); socket.message({ type: 'final', content: '已有正文，最后补充。' });
  socket.emit('close', { code: 1000 });
  assert.equal((await started.completion).status, 'done'); assert.equal(chunks.join(''), '已有正文，最后补充。');
});

test('完整输出保存失败时不调用评委，保留运行和可恢复的失败原因', async () => {
  let scores = 0; let nativeComplete;
  const evaluator = { async startQuestionRun(_, { onText }) { onText('已经返回的完整输出'); return { run: { id: 'test-native' }, completion: new Promise(resolve => { nativeComplete = resolve; }) }; } };
  const repository = { async create() {}, async save(value) { if (value.run?.status === 'done') throw Error('临时存储失败'); }, async get() { return null; } };
  const service = createUnifiedEvaluationService({ repository, evaluators: { 'mission-material': evaluator }, scoring: { pending: () => ({ deepSeekScore: { status: 'pending' } }), async score() { scores++; } } });
  const job = await service.start({ serviceKey: 'mission-material', question: '验证保存失败评分保护' }); nativeComplete({ status: 'done', details: {} });
  await flush(); await flush(); const saved = await service.get(job.runId);
  assert.equal(scores, 0); assert.equal(saved.persistenceError, true); assert.equal(saved.status, 'done'); assert.equal(saved.scores.deepSeekScore.status, 'skipped'); assert.match(saved.scoreError, /保存失败/);
});
