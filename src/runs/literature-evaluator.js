const { randomUUID } = require('node:crypto');

// 1106 协议来源：旧管理端 material-service-cases.service.js 的 literature-ws。
// 只运行问答，不调用旧管理端的归档、评分、MinIO 或夜检。
function createLiteratureEvaluator({ url, timeoutMs = 180000, createSocket = target => new WebSocket(target) } = {}) {
  const target = new URL(url);
  if (!['ws:', 'wss:'].includes(target.protocol)) throw new Error('文献服务必须配置 WebSocket 地址');
  return {
    scoreMode: 'none',
    async startQuestionRun({ question }, { onText }) {
      const id = `evaluation-literature-${randomUUID()}`;
      const started = Date.now();
      const completion = new Promise(resolve => {
        let socket; let text = ''; let settled = false; let endTimer;
        const finish = error => {
          if (settled) return; settled = true;
          clearTimeout(timer); clearTimeout(endTimer);
          try { socket?.close(); } catch {}
          resolve({ status: error ? 'error' : 'done', error: error || null, taskid: id, elapsedMs: Date.now() - started });
        };
        const timer = setTimeout(() => finish('文献服务执行超时'), timeoutMs);
        try {
          socket = createSocket(target.href);
          socket.addEventListener('open', () => {
            try { socket.send(JSON.stringify({ instruction: question, taskid: id, user_name: 'science-evaluation', file_metadata: [] })); }
            catch { finish('文献服务请求发送失败'); }
          });
          socket.addEventListener('message', event => {
            if (settled) return;
            if (typeof event.data !== 'string') { finish('文献服务返回了不支持的数据帧'); return; }
            const delta = event.data;
            let frame; try { frame = JSON.parse(delta); } catch {}
            if (frame && typeof frame === 'object' && !Array.isArray(frame)) {
              if (['error', 'requirement_review_error'].includes(frame.type)) finish('文献服务返回执行错误');
              if (['user_input_request', 'requirement_review_request'].includes(frame.type)) finish('该服务要求交互确认，当前单题运行尚不支持');
              return;
            }
            if (text.length + delta.length > 1024 * 1024) { finish('文献服务回答超过保存上限'); return; }
            text += delta;
            onText(delta);
            if (text.includes('[end]') && !endTimer) endTimer = setTimeout(() => finish(text.includes('[start]') ? null : '文献服务缺少起始标识'), 300);
          });
          socket.addEventListener('error', () => finish('文献服务连接失败'));
          socket.addEventListener('close', () => finish(text.includes('[start]') && text.includes('[end]') ? null : '文献服务连接中断，未收到完整回答'));
        } catch { finish('文献服务连接失败'); }
      });
      return { run: { id }, completion };
    },
    async getRunQuality() { return { status: 'absent', quality: null, error: null }; },
  };
}
module.exports = { createLiteratureEvaluator };
