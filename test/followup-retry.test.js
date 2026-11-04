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
