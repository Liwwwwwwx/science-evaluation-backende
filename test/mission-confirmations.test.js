const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { stackConfirmation } = require('../src/runs/mission-confirmations');
const { createMissionEvaluator } = require('../src/runs/mission-evaluator');
const { packInput } = require('../src/scoring/service');
const flush = () => new Promise(resolve => setImmediate(resolve));
class Socket extends EventEmitter {
  sent = [];
  addEventListener(...args) { this.on(...args); }
  send(data) { this.sent.push(JSON.parse(data)); }
  close() {}
  message(frame) { this.emit('message', { data: JSON.stringify(frame) }); }
}
async function fixture() {
  const socket = new Socket();
  const evaluator = createMissionEvaluator({ url: 'ws://127.0.0.1:1234/start', createSocket: () => { queueMicrotask(() => socket.emit('open')); return socket; } });
  const job = await evaluator.startQuestionRun({ question: '测试方案确认与协议收尾' }, { onText() {} });
  await flush(); return { socket, job };
}
const scheme = { id: 'one-plus-one', label: '1+1', cycle_size: 2, allowed_total_layers: [2, 4, 6], fixed_io_layers: 1, io_mode: 'independent', total_layers_semantics: 'cycle_layers_excluding_fixed_io' };

test('真实帧对应的linear模式忽略周期候选，回传request_id与confirm及默认键合方式', async () => {
  const { socket, job } = await fixture();
  const frame = { type: 'stack_planner_prompt_request', request_id: 'child-stack', taskid: 'root-id', stacking: { stack_mode: 'linear', total_layers: 3 }, scheme_options: [scheme], advanced_parameters: { parameters: [{ key: 'bonding_type', control: 'select', value: 'microbump', options: [{ value: 'microbump' }] }] } };
  socket.message(frame); socket.message({ ...frame, seq: 2 }); await flush();
  assert.equal(socket.sent.length, 2);
  assert.deepEqual(socket.sent[1], { type: 'checkpoint.reply', taskid: 'child-stack', approved: true, params: { confirm: true, overrides: { bonding_type: 'microbump' } } });
  socket.emit('close', { code: 1000 }); const result = await job.completion;
  assert.equal(result.details.review.length, 1); assert.match(result.details.review[0].summary, /线性堆叠/); assert.equal(result.details.review[0].delivery, 'sent');
});

test('周期模式沿用推荐方案与合法层数，不把固定IO计入选择层数', () => {
  const response = stackConfirmation({ request_id: 'cycle', stacking: { stack_mode: 'periodic', total_layers: 6 }, recommended_scheme_id: scheme.id, recommended_config: { total_layers: 4 }, scheme_options: [scheme] });
  assert.deepEqual(response.reply.params, { scheme_id: scheme.id, total_layers: 4 }); assert.match(response.summary, /周期芯片 4 层/);
  const fallback = stackConfirmation({ request_id: 'cycle', stacking: { stack_mode: 'cycle' }, recommended_scheme_id: 'not-found', scheme_options: [scheme] });
  assert.equal(fallback.reply.params.total_layers, 6);
});

test('旧版空模式使用服务明确默认linear，保留锁定的三层，不误选最大周期', () => {
  const response = stackConfirmation({ request_id: 'legacy', stacking: { stack_mode: null, total_layers: 3, total_layers_editable: false }, options: { defaults: { stack_mode: 'linear' } }, scheme_options: [scheme] });
  assert.deepEqual(response.reply.params, { confirm: true });
  assert.throws(() => stackConfirmation({ request_id: 'missing', stacking: { stack_mode: null }, scheme_options: [scheme] }), /堆叠模式/);
});

test('不合法周期、缺失路由标识及不合法高级默认值明确拒绝', () => {
  assert.throws(() => stackConfirmation({ request_id: '', stacking: { stack_mode: 'linear' } }), /请求标识/);
  assert.throws(() => stackConfirmation({ request_id: 'x', scheme_options: [{ ...scheme, allowed_total_layers: [3] }] }), /周期层数/);
  assert.throws(() => stackConfirmation({ request_id: 'x', stacking: { stack_mode: 'linear' }, advanced_parameters: { fields: [{ key: 'bonding_type', control: 'select', value: 'unknown', options: [{ value: 'microbump' }] }] } }), /默认选项/);
  assert.throws(() => stackConfirmation({ request_id: 'x', stacking: { stack_mode: 'linear', total_layers: 13 }, advanced_parameters: { fields: [{ key: 'detail_level', control: 'select', value: 'full_detail', options: [{ value: 'full_detail' }] }] } }), /细节超出层数/);
});

test('公式和暂停分别采用XIMUALPHA的自动确认形状，不编造公式', async () => {
  const { socket, job } = await fixture();
  socket.message({ type: 'equations_request', taskid: 'equations-child', extractType: 'thermal', message: '确认公式' });
  socket.message({ type: 'equations_request', taskid: 'equations-child', extractType: 'thermal', message: '确认公式', seq: 2 });
  socket.message({ type: 'temporarily_suspend_request', taskid: 'suspend-child', stageid: 's1' }); await flush();
  assert.deepEqual(socket.sent[1], { type: 'checkpoint.reply', taskid: 'equations-child', approved: true, params: { formulaKey: 'thermal', selectedFormulas: {} } });
  assert.deepEqual(socket.sent[2], { type: 'checkpoint.reply', taskid: 'suspend-child', approved: true, params: { action: 'continue' } });
  assert.equal(socket.sent.length, 3);
  socket.emit('close', { code: 1000 }); assert.equal((await job.completion).details.review.length, 2);
});

test('未知交互立即说明缺项，保留原请求，不静默等待超时或默认批准', async () => {
  const { socket, job } = await fixture(); socket.message({ type: 'future_choice_request', request_id: 'future' });
  const result = await job.completion; assert.equal(result.status, 'error'); assert.match(result.error, /交互尚未支持：future_choice_request/);
  assert.equal(socket.sent.length, 1); assert.equal(result.details.protocolFrames[0].request_id, 'future');
});

test('关闭码和最后事件保留；异常关闭及缺少总结end不能触发成功', async () => {
  const { socket, job } = await fixture(); socket.message({ type: 'display.final_answer', event_id: 'f', phase: 'delta', delta: '部分总结', seq: 1 });
  socket.emit('close', { code: 1006, wasClean: false }); const result = await job.completion;
  assert.equal(result.status, 'error'); assert.match(result.error, /1006/); assert.equal(result.details.transport.closeCode, 1006); assert.equal(result.details.transport.wasClean, false); assert.equal(result.details.transport.lastJsonType, 'display.final_answer'); assert.equal(result.details.displayEvents[0].delta, '部分总结');
  const next = await fixture(); next.socket.message({ type: 'display.final_answer', phase: 'start', event_id: 'final' }); next.socket.emit('close', { code: 1000, wasClean: true });
  assert.match((await next.job.completion).error, /未收到结束帧/);
});

test('明确的团队查询source映射至评分阶段，不根据自然语言猜测耗时', async () => {
  const { socket, job } = await fixture();
  socket.message({ type: 'display.process.step', step_id: 'list', source: 'mission_list_teams', status: 'running', title: '开始查询' });
  socket.message({ type: 'display.process.step', step_id: 'list', source: 'mission_list_teams', status: 'success', title: '查询结束' });
  socket.emit('close', { code: 1000 });
  const result = await job.completion;
  assert.deepEqual(result.details.process.events.map(e => [e.kind, e.phaseKey]), [['start', 'team-discovery'], ['end', 'team-discovery']]);
});

test('评分输入保留成果和实际决定，去除重复结果与大量未选候选而不丢未知业务数据', () => {
  const result = { conclusion: '成果'.repeat(6000) };
  const details = { result, displayEvents: [], protocolFrames: [{ type: 'result', data: result }, { type: 'stack_planner_prompt_request', options: '候选'.repeat(20000) }, { type: 'retrival_progress', message: '进度'.repeat(1000) }, { type: 'future-result', value: 42 }], review: [{ source: 'automatic', delivery: 'sent', action: 'continue', request: { type: 'stack_planner_prompt_request' }, reply: { params: { confirm: true } } }] };
  const input = packInput({ answer: '完整回答', run: { details } }); const structured = JSON.parse(input.structured);
  assert.equal(input.truncated, false); assert.deepEqual(structured.result, result); assert.deepEqual(structured.protocolFrames, [{ type: 'future-result', value: 42 }]); assert.equal(structured.decisions[0].reply.params.confirm, true);
});
