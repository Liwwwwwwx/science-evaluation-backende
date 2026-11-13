const { test } = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { withWaitingRetry } = require('../src/runs/followup-retry');
const { createMissionEvaluator } = require('../src/runs/mission-evaluator');
const { createLiteratureEvaluator } = require('../src/runs/literature-evaluator');
const { createMaterialEvaluator } = require('../src/runs/material-evaluator');
const { createFollowupAnswers } = require('../src/runs/followup-answers');

for (const key of ['mission-material', 'literature', 'literature-aircraft', 'alloy', 'synthesis', 'new-material']) test(`${key}等待结果正常结束后最多补充重发一次`, async () => {
  const sockets = []; const sent = []; let answer = ''; let resets = 0;
  const createSocket = () => {
    const socket = new EventEmitter(); socket.addEventListener = socket.on; socket.close = () => {};
    const index = sockets.push(socket);
    socket.send = value => {
      const frame = JSON.parse(value); sent.push(frame);
      queueMicrotask(() => {
        socket.emit('message', {data:JSON.stringify({type:'result',data:index === 1 ? {status:'waiting_for_input',user_conclusion:'请补充条件'} : {status:'completed'}})});
        socket.emit('message', {data:index === 1 ? '[start]首轮等待[end]' : '[start]补充后结果[end]'});
        socket.emit('close', {code:1000,wasClean:true});
      });
    };
    queueMicrotask(() => socket.emit('open')); return socket;
  };
  const opts = {url:'ws://example.test/start',serviceKey:key,timeoutMs:1000,endSettleMs:1,createSocket,fetchImpl:async () => Response.json({})};
  const base = key === 'mission-material' ? createMissionEvaluator(opts) : key.startsWith('literature') ? createLiteratureEvaluator(opts) : createMaterialEvaluator(opts);
  const evaluator = withWaitingRetry(base, { generateSupplement:async () => ({message:'假设测试温度为室温。',model:'test-model'}) });
  const started = await evaluator.startQuestionRun({question:'请比较两种材料的性能。'}, {onText:delta => {answer += delta;},onTextReset:() => {answer='';resets++;}});
  const result = await started.completion;
  assert.equal(result.status,'done'); assert.equal(sockets.length,2); assert.equal(resets,1);
  assert.notEqual(sent[0].taskid,sent[1].taskid); assert.match(sent[1].idea || sent[1].instruction,/假设测试温度/);
  assert.match(answer,/补充后结果/); assert.doesNotMatch(answer,/首轮等待/); assert.equal(result.details.autoRetry.state,'completed');
});

test('逐项补充校验问题编号，首个模型不合规则使用备用模型', async () => {
  const client = createFollowupAnswers({clients:{
    deepSeekScore:{isConfigured:()=>true,callJson:async()=>({answers:[{id:'wrong',answer:'无效'}]})},
    qwenScore:{model:'备用模型',isConfigured:()=>true,callJson:async()=>({answers:[{id:'q1',answer:'假设为室温。'}]})},
  }});
  assert.deepEqual(await client({question:'比较材料',title:'条件',questions:[{id:'q1',question:'温度？'}]}),{answers:[{id:'q1',answer:'假设为室温。'}],model:'备用模型'});
});

test('包装器保留人工答复并转发到当前活动的重试任务', async () => {
  let resolveFirst; let resolveSecond; let startedSecond;
  const secondStarted = new Promise(resolve => { startedSecond = resolve; });
  const calls = [];
  const single = { startQuestionRun: async () => {
    const index = calls.length + 1; calls.push([]);
    const completion = new Promise(resolve => { if (index === 1) resolveFirst = resolve; else resolveSecond = resolve; });
    return { run: { id: `task-${index}` }, completion, reply: input => calls[index - 1].push(input) };
  } };
  const started = await withWaitingRetry(single, { generateSupplement: async () => ({ message: '室温' }) }).startQuestionRun({ question: '测试' }, { onState: details => { if (details.autoRetry?.state === 'running') startedSecond(); } });
  started.reply({ requestId: 'first' });
  resolveFirst({ status: 'done', details: { result: { status: 'waiting_for_input', message: '请补充温度' } } });
  await secondStarted;
  started.reply({ requestId: 'second' });
  resolveSecond({ status: 'done', details: { result: { status: 'completed' } } });
  await started.completion;
  assert.deepEqual(calls, [[{ requestId: 'first' }], [{ requestId: 'second' }]]);
});

test('服务输入校验失败时不生成自动补充或重发', async () => {
  let starts = 0; let supplements = 0;
  const single = { startQuestionRun: async () => {
    starts += 1;
    return { run: { id: 'task-input-error' }, completion: Promise.resolve({ status: 'done', details: { result: {
      status: 'waiting_for_input', user_conclusion: '当前任务无法回答。',
      requirement_interpretation: { input_error: { code: 'invalid_input', message: 'heat_treatment must use explicit solution/precipitation stage fields; otherwise supply native process_history' }, questions_to_confirm: [] },
    } } }) };
  } };
  const wrapped = withWaitingRetry(single, { generateSupplement: async () => { supplements += 1; return { message: '假设测试温度为室温。' }; } });
  const started = await wrapped.startQuestionRun({ question: '测试题面' });
  const result = await started.completion;
  assert.equal(starts, 1);
  assert.equal(supplements, 0);
  assert.equal(result.status, 'error');
  assert.match(result.error, /该服务不支持修改问题后继续回答/);
  assert.match(result.error, /heat_treatment/);
  assert.equal(result.details.autoRetry.state, 'unsupported');
  assert.equal(result.details.autoRetry.message, null);
});

test('等待结论明确为失败且无具体追问时不生成自动补充', async () => {
  let starts = 0; let supplements = 0;
  const single = { startQuestionRun: async () => {
    starts += 1;
    return { run: { id: 'task-service-failed' }, completion: Promise.resolve({ status: 'done', details: { result: {
      status: 'waiting_for_input',
      user_conclusion: '当前任务无法回答。\n\nheat_treatment must use explicit solution/precipitation stage fields; otherwise supply native process_history',
      sampling: { generated: 0, feasible: 0 },
    } } }) };
  } };
  const wrapped = withWaitingRetry(single, { generateSupplement: async () => { supplements += 1; return { message: '假设测试温度为室温。' }; } });
  const started = await wrapped.startQuestionRun({ question: '测试题面' });
  const result = await started.completion;
  assert.equal(starts, 1);
  assert.equal(supplements, 0);
  assert.equal(result.status, 'error');
  assert.match(result.error, /该服务不支持修改问题后继续回答/);
  assert.match(result.error, /heat_treatment/);
  assert.equal(result.details.autoRetry.state, 'unsupported');
  assert.equal(result.details.autoRetry.message, null);
});
