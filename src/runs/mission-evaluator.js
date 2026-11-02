const { randomUUID, createHash } = require('node:crypto');
const { publicServiceAddress } = require('./service-address');
const { createProcessRecorder } = require('../scoring/process-review');
const { createConversationEvents } = require('./conversation-events');
const { stackConfirmation } = require('./mission-confirmations');

const MAX_ANSWER_CHARS = 3 * 1024 * 1024;
// 接收上限与归档预算分开：下游团队的完整输出可能超过单条归档预算。
const MAX_MESSAGE_BYTES = 8 * 1024 * 1024;
const MAX_RECORD_BYTES = 1024 * 1024;
const MAX_STATE_BYTES = 2 * 1024 * 1024;
const MAX_FRAMES = 100000;
const MAX_CHECKPOINTS = 200;

// Mission 的确认卡可能携带下游 taskid；只能在收到该卡的连接内答复。
function createMissionEvaluator({ url, timeoutMs = 15 * 60 * 1000, createSocket = target => new WebSocket(target) } = {}) {
  const target = new URL(url);
  if (!['ws:', 'wss:'].includes(target.protocol)) throw new Error('Mission 主服务必须配置 WebSocket 地址');
  return {
    serviceAddress: publicServiceAddress(target),
    scoreMode: 'none',
    async startQuestionRun({ question }, { onText, onState = () => {} }) {
      const taskid = `evaluation-mission-material-${randomUUID()}`;
      const started = Date.now();
      const process = createProcessRecorder(started);
      const assetsBase = new URL(target); assetsBase.protocol = target.protocol === 'wss:' ? 'https:' : 'http:';
      const conversation = createConversationEvents({ baseUrl: assetsBase.origin });
      const transport = { state: 'connecting', openedAt: null, closedAt: null, closeCode: null, wasClean: null, lastFrameType: null, lastFrameAt: null, receivedFrames: 0 };
      const details = { process: process.data, progress: [], review: [], result: null, transport, ...conversation.data };
      const processSteps = new Set();
      const seen = new Set();
      const openSummaries = new Set(); const completedSummaries = new Set();
      let socket; let timer; let errorTimer; let settled = false; let text = ''; let messageChain = Promise.resolve(); let frameCount = 0; let stateBytes = 0; let emitTimer; let received = false;
      let resolveCompletion;
      const completion = new Promise(resolve => { resolveCompletion = resolve; });
      const emit = () => { clearTimeout(emitTimer); emitTimer = null; details.truncated ||= conversation.data.truncated; onState(structuredClone(details)); };
      const scheduleEmit = () => { if (!emitTimer) emitTimer = setTimeout(emit, 32); };
      const finish = error => {
        if (settled) return;
        settled = true; clearTimeout(timer); clearTimeout(errorTimer);
        transport.state = error ? 'failed' : 'closed'; transport.finishedAt = new Date().toISOString(); emit();
        try { socket?.close(); } catch {}
        resolveCompletion({ status: error ? 'error' : 'done', error: error || null, taskid, elapsedMs: Date.now() - started, details: structuredClone(details) });
      };
      const keep = value => {
        const size = Buffer.byteLength(JSON.stringify(value));
        if (size > MAX_RECORD_BYTES || stateBytes + size > MAX_STATE_BYTES) { details.truncated = true; return false; }
        stateBytes += size; return true;
      };
      function recordProgress(frame) {
        process.record(frame);
        const body = frame.data && typeof frame.data === 'object' && !Array.isArray(frame.data) ? frame.data : frame;
        const message = [body.message, body.text, body.content, body.title, frame.message, typeof frame.data === 'string' ? frame.data : null].find(value => typeof value === 'string' && value.trim());
        if (message) {
          details.progress.push({ text: message.slice(0, 1000) });
          if (details.progress.length > 50) details.progress.shift();
        }
      }
      function replyToCheckpoint(frame) {
        const childId = frame.type === 'stack_planner_prompt_request' ? frame.request_id : frame.taskid || frame.task_id || taskid;
        if (typeof childId !== 'string' || !childId || childId.length > 200) return finish('Mission 确认请求的任务标识无效');
        if (frame.request_id != null && (!['string', 'number'].includes(typeof frame.request_id) || String(frame.request_id).length > 200)) return finish('Mission 确认请求标识无效');
        if (frame.type === 'display.followup_request' && frame.event_id != null && (typeof frame.event_id !== 'string' || !frame.event_id || frame.event_id.length > 200)) return finish('Mission 追问标识无效');
        const identity = frame.type === 'display.followup_request' && frame.event_id ? frame.event_id : frame.request_id ?? (frame.type === 'equations_request' ? frame.extractType : frame.type === 'temporarily_suspend_request' ? frame.stageid : null);
        const key = `${frame.type}:${childId}:${identity == null ? createHash('sha256').update(JSON.stringify(frame)).digest('hex') : identity}`;
        if (seen.has(key)) return;
        if (seen.size >= MAX_CHECKPOINTS) return finish('Mission 确认次数超过上限');
        seen.add(key);
        const feedback = frame.type === 'user_input_request' && frame.parameters?.reason === 'adaptive_refactor' && frame.message === '本次生成是否符合用户需求';
        const approval = frame.type === 'display.followup_request' && frame.kind === 'approval';
        let decision;
        if (frame.type === 'stack_planner_prompt_request') {
          try { decision = stackConfirmation(frame); } catch (error) { return finish(error.message); }
        }
        const reply = decision ? decision.reply : frame.type === 'equations_request'
          ? { type: 'checkpoint.reply', taskid: childId, approved: true, params: { formulaKey: typeof frame.extractType === 'string' ? frame.extractType : '', selectedFormulas: {} } }
          : frame.type === 'temporarily_suspend_request'
            ? { type: 'checkpoint.reply', taskid: childId, approved: true, params: { action: 'continue' } }
          : frame.type === 'requirement_review_request'
          ? { type: 'checkpoint.reply', schema_version: 1, taskid: childId, ...(frame.request_id == null ? {} : { request_id: frame.request_id }), action: 'continue' }
          : feedback
            ? { type: 'checkpoint.reply', taskid: childId, approved: false, params: { message: '本轮测试到此结束，不追加问题。' } }
            : approval
              ? { type: 'checkpoint.reply', taskid: childId, approved: false, params: { message: '' } }
            : { type: 'checkpoint.reply', taskid: childId, params: { message: '无' }, mission: true, approved: true };
        const summary = decision?.summary || (frame.type === 'equations_request' ? '自动确认公式，未新增人工选择。' : frame.type === 'temporarily_suspend_request' ? '自动确认继续执行。' : null);
        const record = { at: new Date().toISOString(), requestId: frame.request_id ?? null, taskId: childId, action: feedback || approval ? 'stop' : 'continue', source: 'automatic', delivery: 'pending', ...(summary ? { summary } : {}), request: frame, reply };
        if (!keep(record)) return finish('Mission 确认记录超过保存上限');
        details.review.push(record);
        try { socket.send(JSON.stringify(reply)); record.delivery = 'sent'; emit(); if (approval) finish('Mission 审批请求未自动批准'); }
        catch { record.delivery = 'failed'; emit(); finish('Mission 自动答复发送失败'); }
      }
      async function receive(event) {
        if (settled) return;
        if (++frameCount > MAX_FRAMES) return finish('Mission 协议帧超过上限');
        let raw = event && typeof event === 'object' && 'data' in event ? event.data : event;
        if (Buffer.isBuffer(raw)) raw = raw.toString('utf8');
        else if (raw instanceof ArrayBuffer) raw = Buffer.from(raw).toString('utf8');
        else if (raw && typeof raw.text === 'function') raw = await raw.text();
        if (settled) return;
        if (typeof raw !== 'string') return finish('Mission 返回了不支持的数据帧');
        const messageBytes = Buffer.byteLength(raw);
        if (messageBytes > MAX_MESSAGE_BYTES) {
          transport.rejectedFrameBytes = messageBytes; transport.maxFrameBytes = MAX_MESSAGE_BYTES;
          return finish('Mission 数据帧超过接收上限（8 MiB）');
        }
        let frame; try { frame = JSON.parse(raw); } catch {}
        received = true;
        transport.receivedFrames = frameCount; transport.lastFrameAt = new Date().toISOString();
        transport.lastFrameType = frame && typeof frame.type === 'string' ? frame.type.slice(0, 100) : 'text';
        if (frame && typeof frame === 'object' && !Array.isArray(frame)) {
          if (frame.type === 'timeline.event' && frame.event && typeof frame.event === 'object' && !Array.isArray(frame.event)) frame = frame.event;
          transport.lastJsonType = typeof frame.type === 'string' ? frame.type.slice(0, 100) : null;
          transport.lastJsonPhase = typeof frame.phase === 'string' ? frame.phase.slice(0, 40) : null;
          if (['error', 'requirement_review_error'].includes(frame.type)) return finish('Mission 返回执行错误');
          if (['requirement_review_request', 'user_input_request', 'adaptive_refactor', 'display.followup_request', 'stack_planner_prompt_request', 'equations_request', 'temporarily_suspend_request'].includes(frame.type)) {
            conversation.record(frame, text.length);
            return replyToCheckpoint(frame);
          }
          if (typeof frame.type === 'string' && /(?:_request|\.request)$/.test(frame.type)) {
            conversation.record(frame, text.length);
            return finish(`Mission 交互尚未支持：${frame.type.slice(0, 100)}，已保存请求，未自动选择。`);
          }
          if (frame.type === 'text.delta' && typeof frame.delta === 'string' && !openSummaries.size) {
            if (text.length + frame.delta.length > MAX_ANSWER_CHARS) return finish('Mission 回答超过保存上限');
            text += frame.delta; onText(frame.delta);
            return;
          }
          if (['final', 'completed', 'close'].includes(frame.type)) {
            const finalText = [frame.content, frame.text, frame.answer, typeof frame.data === 'string' ? frame.data : frame.data?.content].find(value => typeof value === 'string' && value.trim());
            if (finalText) {
              const visible = text.replace(/^\[start\]/i, '').replace(/\[end\]$/i, '');
              if (finalText.startsWith(visible)) {
                const tail = finalText.slice(visible.length);
                if (text.length + tail.length > MAX_ANSWER_CHARS) return finish('Mission 回答超过保存上限');
                text += tail; if (tail) onText(tail);
              } else conversation.record({ ...frame, type: 'display.final_answer', event_id: frame.event_id || 'legacy-final', phase: 'end', content: finalText }, text.length);
            }
          }
          if (frame.type === 'display.final_answer') {
            // 生命周期独立于归档：归档超限、重复或迟到帧都不能掩盖未结束的总结。
            const identity = typeof frame.event_id === 'string' && frame.event_id ? `id:${frame.event_id}` : 'anonymous';
            const key = createHash('sha256').update(identity).digest('hex');
            if (['end', 'exit'].includes(frame.phase)) { openSummaries.delete(key); completedSummaries.add(key); }
            else if (!completedSummaries.has(key)) openSummaries.add(key);
          }
          if (['progress', 'retrieval_progress', 'retrival_progress', 'stage', 'phase_start', 'phase_end', 'stage_start', 'stage_end'].includes(frame.type)) recordProgress(frame);
          if (frame.type === 'display.process.step') {
            const step = frame.step_id || frame.event_id;
            const phaseKey = frame.phaseKey || frame.phase_key || (frame.source === 'mission_list_teams' ? 'team-discovery' : step);
            if (frame.status === 'running' && !processSteps.has(step)) { processSteps.add(step); process.record({ type: 'phase_start', phaseKey }); }
            if (['success', 'failed', 'skipped', 'warning'].includes(frame.status) && processSteps.has(step)) { processSteps.delete(step); process.record({ type: 'phase_end', phaseKey }); }
            process.record({ type: 'progress', message: [frame.title, frame.detail].filter(value => typeof value === 'string').join('：') });
          }
          if (frame.type === 'result' && keep(frame)) details.result = frame.data || frame;
          // 所有业务 JSON 均保留在结构化通道；不会落进普通正文。
          if (conversation.record(frame, text.length)) {
            if (frame.phase === 'delta') scheduleEmit(); else emit();
          }
          return;
        }
        // dual 模式的裸文本与最终总结增量是同一份内容，统一由总结卡展示。
        if (openSummaries.size) return;
        if (text.length + raw.length > MAX_ANSWER_CHARS) return finish('Mission 回答超过保存上限');
        text += raw; onText(raw);
      }
      try {
        socket = createSocket(target.href);
        socket.addEventListener('open', () => {
          if (settled) return;
          transport.state = 'open'; transport.openedAt = new Date().toISOString();
          try { socket.send(JSON.stringify({ idea: question, taskid, user_name: 'science-evaluation', file_metadata: [], has_context: false })); }
          catch { finish('Mission 请求发送失败'); }
        });
        socket.addEventListener('message', event => { messageChain = messageChain.then(() => receive(event)).catch(() => finish('处理 Mission 消息失败')); });
        socket.addEventListener('close', event => {
          if (settled) return;
          transport.closedAt = new Date().toISOString();
          transport.closeCode = Number.isInteger(event?.code) ? event.code : null;
          transport.wasClean = typeof event?.wasClean === 'boolean' ? event.wasClean : null;
          void messageChain.then(() => {
            const incomplete = openSummaries.size > 0;
            const error = !received ? 'Mission 连接未返回业务输出' : ![1000, 1001].includes(transport.closeCode) ? `Mission 连接中断（关闭码 ${transport.closeCode ?? '未知'}）` : incomplete ? 'Mission 最终总结未收到结束帧' : null;
            finish(error);
          });
        });
        socket.addEventListener('error', () => { if (!settled) { transport.socketError = true; errorTimer = setTimeout(() => { void messageChain.finally(() => finish('Mission WebSocket 连接错误')); }, 50); } });
        timer = setTimeout(() => finish('Mission 执行超时'), timeoutMs);
      } catch { finish('Mission WebSocket 连接失败'); }
      return { run: { id: taskid }, completion };
    },
    async getRunQuality() { return { status: 'absent', quality: null, error: null }; },
  };
}
module.exports = { createMissionEvaluator };
