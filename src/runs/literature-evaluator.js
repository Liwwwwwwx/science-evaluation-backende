const { randomUUID } = require('node:crypto');
const { publicServiceAddress } = require('./service-address');
const { createAutomaticReview } = require('./automatic-review');
const { createProcessRecorder } = require('../scoring/process-review');
const { createConversationEvents } = require('./conversation-events');

const MAX_ANSWER_CHARS = 3 * 1024 * 1024;

// 1106/1108 协议来源：旧管理端 material-service-cases.service.js 的文献运行器。
// 只运行问答，不调用旧管理端的归档、评分、MinIO 或夜检。
function createLiteratureEvaluator({ url, serviceKey = 'literature', timeoutMs, createSocket = target => new WebSocket(target), generateAnswers } = {}) {
  if (!['literature', 'literature-aircraft'].includes(serviceKey)) throw new Error('不支持的文献服务');
  const label = serviceKey === 'literature-aircraft' ? '航空文献服务' : '文献服务';
  timeoutMs ??= serviceKey === 'literature-aircraft' ? 240000 : 360000;
  const target = new URL(url);
  if (!['ws:', 'wss:'].includes(target.protocol)) throw new Error(`${label}必须配置 WebSocket 地址`);
  return {
    serviceAddress: publicServiceAddress(target),
    scoreMode: 'none',
    async startQuestionRun({ question }, { onText, onState = () => {} }) {
      const id = `evaluation-${serviceKey}-${randomUUID()}`;
      const started = Date.now();
      const process = createProcessRecorder(started);
      const review = []; let result = null;
      const httpUrl = new URL(target); httpUrl.protocol = target.protocol === 'wss:' ? 'https:' : 'http:';
      const conversation = createConversationEvents({ baseUrl: httpUrl.origin });
      let cancel = () => {};
      const completion = new Promise(resolve => {
        let socket; let text = ''; let settled = false; let endTimer; let emitTimer; let summaryActive = false;
        const reviewAbort = new AbortController();
        const emit = () => { clearTimeout(emitTimer); emitTimer = null; onState({ process: structuredClone(process.data), review: structuredClone(review), result: structuredClone(result), pendingReview: null, ...structuredClone(conversation.data) }); };
        const finish = error => {
          if (settled) return;
          if (!error && automaticReview.hasPending()) error = '服务在自动补充完成前结束，本轮未继续。';
          settled = true; reviewAbort.abort();
          clearTimeout(timer); clearTimeout(endTimer); clearTimeout(emitTimer); emit();
          try { socket?.close(); } catch {}
          resolve({ status: error ? 'error' : 'done', error: error || null, taskid: id, elapsedMs: Date.now() - started, details: { process: process.data, review, result, pendingReview: null, ...structuredClone(conversation.data) } });
        };
        const timer = setTimeout(() => finish(`${label}执行超时`), timeoutMs);
        cancel = () => finish('本次运行已结束');
        const automaticReview = createAutomaticReview({ taskid: id, question, review, send: frame => socket.send(JSON.stringify(frame)), onRecord: emit, onError: finish, isActive: () => !settled, signal:reviewAbort.signal, ...(generateAnswers ? { generateAnswers } : {}) });
        try {
          socket = createSocket(target.href);
          socket.addEventListener('open', () => {
            try { socket.send(JSON.stringify({ instruction: question, taskid: id, user_name: 'science-evaluation', file_metadata: [] })); }
            catch { finish(`${label}请求发送失败`); }
          });
          socket.addEventListener('message', event => {
            if (settled) return;
            if (typeof event.data !== 'string') { finish(`${label}返回了不支持的数据帧`); return; }
            const delta = event.data;
            let frame; try { frame = JSON.parse(delta); } catch {}
            if (frame && typeof frame === 'object' && !Array.isArray(frame)) {
              if (frame.type === 'timeline.event' && frame.event && typeof frame.event === 'object') frame = frame.event;
              process.record(frame);
              if (['user_input_request', 'display.followup_request'].includes(frame.type)) { review.push({ at:new Date().toISOString(), action:'requested', source:'service', data:frame.data || {}, request:frame }); emit(); finish('服务提出了尚不支持的追问协议，已保留请求，未发送答复'); return; }
              if (frame.type === 'display.final_answer') summaryActive = ['start', 'delta'].includes(frame.phase);
              if (frame.type === 'result') { result = frame.data || frame; emit(); }
              if (conversation.record(frame, text.length)) { if (frame.phase === 'delta') { if (!emitTimer) emitTimer = setTimeout(emit, 32); } else emit(); }
              if (['error', 'requirement_review_error'].includes(frame.type)) finish(frame.type === 'requirement_review_error' ? '服务拒绝自动继续，请查看本次确认记录' : `${label}返回执行错误`);
              if (frame.type === 'requirement_review_request') void automaticReview(frame);
              return;
            }
            if (summaryActive) return;
            if (text.length + delta.length > MAX_ANSWER_CHARS) { finish(`${label}回答超过保存上限`); return; }
            text += delta;
            onText(delta);
            if (text.includes('[end]') && !endTimer) endTimer = setTimeout(() => finish(text.includes('[start]') ? null : `${label}缺少起始标识`), 300);
          });
          socket.addEventListener('error', () => finish(`${label}连接失败`));
          socket.addEventListener('close', () => finish(text.includes('[start]') && text.includes('[end]') ? null : `${label}连接中断，未收到完整回答`));
        } catch { finish(`${label}连接失败`); }
      });
      return { run: { id }, completion, cancel };
    },
    async getRunQuality() { return { status: 'absent', quality: null, error: null }; },
  };
}
module.exports = { createLiteratureEvaluator };
