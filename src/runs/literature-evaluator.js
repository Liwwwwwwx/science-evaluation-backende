const { randomUUID } = require('node:crypto');
const { publicServiceAddress } = require('./service-address');
const { createAutomaticReview } = require('./automatic-review');
const { createProcessRecorder } = require('../scoring/process-review');

// 1106/1108 协议来源：旧管理端 material-service-cases.service.js 的文献运行器。
// 只运行问答，不调用旧管理端的归档、评分、MinIO 或夜检。
function createLiteratureEvaluator({ url, serviceKey = 'literature', timeoutMs, createSocket = target => new WebSocket(target) } = {}) {
  if (!['literature', 'literature-aircraft'].includes(serviceKey)) throw new Error('不支持的文献服务');
  const label = serviceKey === 'literature-aircraft' ? '航空文献服务' : '文献服务';
  timeoutMs ??= serviceKey === 'literature-aircraft' ? 240000 : 180000;
  const target = new URL(url);
  if (!['ws:', 'wss:'].includes(target.protocol)) throw new Error(`${label}必须配置 WebSocket 地址`);
  return {
    serviceAddress: publicServiceAddress(target),
    scoreMode: 'none',
    async startQuestionRun({ question }, { onText, onState = () => {} }) {
      const id = `evaluation-${serviceKey}-${randomUUID()}`;
      const started = Date.now();
      const process = createProcessRecorder(started);
      const review = [];
      const completion = new Promise(resolve => {
        let socket; let text = ''; let settled = false; let endTimer;
        const finish = error => {
          if (settled) return; settled = true;
          clearTimeout(timer); clearTimeout(endTimer);
          try { socket?.close(); } catch {}
          resolve({ status: error ? 'error' : 'done', error: error || null, taskid: id, elapsedMs: Date.now() - started, details: { process: process.data, review, pendingReview: null } });
        };
        const timer = setTimeout(() => finish(`${label}执行超时`), timeoutMs);
        const automaticReview = createAutomaticReview({ taskid: id, review, send: frame => socket.send(JSON.stringify(frame)), onRecord: () => onState({ review: structuredClone(review), pendingReview: null }), onError: finish });
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
              process.record(frame);
              if (['error', 'requirement_review_error'].includes(frame.type)) finish(frame.type === 'requirement_review_error' ? '服务拒绝自动继续，请查看本次确认记录' : `${label}返回执行错误`);
              if (frame.type === 'requirement_review_request') automaticReview(frame);
              if (frame.type === 'user_input_request') finish('该服务要求另一种交互协议，当前单题运行尚不支持');
              return;
            }
            if (text.length + delta.length > 1024 * 1024) { finish(`${label}回答超过保存上限`); return; }
            text += delta;
            onText(delta);
            if (text.includes('[end]') && !endTimer) endTimer = setTimeout(() => finish(text.includes('[start]') ? null : `${label}缺少起始标识`), 300);
          });
          socket.addEventListener('error', () => finish(`${label}连接失败`));
          socket.addEventListener('close', () => finish(text.includes('[start]') && text.includes('[end]') ? null : `${label}连接中断，未收到完整回答`));
        } catch { finish(`${label}连接失败`); }
      });
      return { run: { id }, completion };
    },
    async getRunQuality() { return { status: 'absent', quality: null, error: null }; },
  };
}
module.exports = { createLiteratureEvaluator };
