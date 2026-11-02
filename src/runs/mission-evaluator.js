const { randomUUID, createHash } = require('node:crypto');
const { publicServiceAddress } = require('./service-address');
const { createProcessRecorder } = require('../scoring/process-review');

const MAX_ANSWER_CHARS = 1024 * 1024;
const MAX_FRAME_BYTES = 256 * 1024;
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
      const details = { process: process.data, progress: [], review: [], result: null, truncated: false };
      const seen = new Set();
      let socket; let timer; let settled = false; let text = ''; let messageChain = Promise.resolve(); let frameCount = 0; let stateBytes = 0;
      let resolveCompletion;
      const completion = new Promise(resolve => { resolveCompletion = resolve; });
      const emit = () => onState(structuredClone(details));
      const finish = error => {
        if (settled) return;
        settled = true; clearTimeout(timer);
        try { socket?.close(); } catch {}
        resolveCompletion({ status: error ? 'error' : 'done', error: error || null, taskid, elapsedMs: Date.now() - started, details: structuredClone(details) });
      };
      const keep = value => {
        const size = Buffer.byteLength(JSON.stringify(value));
        if (size > MAX_FRAME_BYTES || stateBytes + size > MAX_STATE_BYTES) { details.truncated = true; return false; }
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
        const childId = frame.taskid || frame.task_id || taskid;
        if (typeof childId !== 'string' || !childId || childId.length > 200) return finish('Mission 确认请求的任务标识无效');
        if (frame.request_id != null && (!['string', 'number'].includes(typeof frame.request_id) || String(frame.request_id).length > 200)) return finish('Mission 确认请求标识无效');
        if (frame.type === 'display.followup_request' && frame.event_id != null && (typeof frame.event_id !== 'string' || !frame.event_id || frame.event_id.length > 200)) return finish('Mission 追问标识无效');
        const identity = frame.type === 'display.followup_request' && frame.event_id ? frame.event_id : frame.request_id;
        const key = `${frame.type}:${childId}:${identity == null ? createHash('sha256').update(JSON.stringify(frame)).digest('hex') : identity}`;
        if (seen.has(key)) return;
        if (seen.size >= MAX_CHECKPOINTS) return finish('Mission 确认次数超过上限');
        seen.add(key);
        const feedback = frame.type === 'user_input_request' && frame.parameters?.reason === 'adaptive_refactor' && frame.message === '本次生成是否符合用户需求';
        const approval = frame.type === 'display.followup_request' && frame.kind === 'approval';
        const reply = frame.type === 'requirement_review_request'
          ? { type: 'checkpoint.reply', schema_version: 1, taskid: childId, ...(frame.request_id == null ? {} : { request_id: frame.request_id }), action: 'continue' }
          : feedback
            ? { type: 'checkpoint.reply', taskid: childId, approved: false, params: { message: '本轮测试到此结束，不追加问题。' } }
            : approval
              ? { type: 'checkpoint.reply', taskid: childId, approved: false, params: { message: '' } }
            : { type: 'checkpoint.reply', taskid: childId, params: { message: '无' }, mission: true, approved: true };
        const record = { at: new Date().toISOString(), requestId: frame.request_id ?? null, taskId: childId, action: feedback || approval ? 'stop' : 'continue', source: 'automatic', delivery: 'pending', request: frame, reply };
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
        if (typeof raw !== 'string') return finish('Mission 返回了不支持的数据帧');
        if (Buffer.byteLength(raw) > MAX_FRAME_BYTES) return finish('Mission 数据帧超过保存上限');
        let frame; try { frame = JSON.parse(raw); } catch {}
        if (frame && typeof frame === 'object' && !Array.isArray(frame)) {
          if (['error', 'requirement_review_error'].includes(frame.type)) return finish('Mission 返回执行错误');
          if (['requirement_review_request', 'user_input_request', 'adaptive_refactor', 'display.followup_request'].includes(frame.type)) return replyToCheckpoint(frame);
          if (['progress', 'retrieval_progress', 'stage', 'phase_start', 'phase_end', 'stage_start', 'stage_end'].includes(frame.type)) {
            if (keep(frame)) { recordProgress(frame); emit(); }
          } else if (frame.type === 'result' && keep(frame)) { details.result = frame.data || frame; emit(); }
          return;
        }
        if (text.length + raw.length > MAX_ANSWER_CHARS) return finish('Mission 回答超过保存上限');
        text += raw; onText(raw);
      }
      try {
        socket = createSocket(target.href);
        socket.addEventListener('open', () => {
          if (settled) return;
          try { socket.send(JSON.stringify({ idea: question, taskid, user_name: 'science-evaluation', file_metadata: [], has_context: false })); }
          catch { finish('Mission 请求发送失败'); }
        });
        socket.addEventListener('message', event => { messageChain = messageChain.then(() => receive(event)).catch(() => finish('处理 Mission 消息失败')); });
        socket.addEventListener('close', event => { void messageChain.then(() => finish(text.includes('[end]') && Number(event?.code) === 1000 ? null : 'Mission 连接中断或未正常结束')); });
        socket.addEventListener('error', () => { void messageChain.finally(() => finish('Mission WebSocket 连接错误')); });
        timer = setTimeout(() => finish('Mission 执行超时'), timeoutMs);
      } catch { finish('Mission WebSocket 连接失败'); }
      return { run: { id: taskid }, completion };
    },
    async getRunQuality() { return { status: 'absent', quality: null, error: null }; },
  };
}
module.exports = { createMissionEvaluator };
