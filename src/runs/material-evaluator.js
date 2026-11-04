const { randomUUID } = require('node:crypto');
const { TeamServiceError } = require('../errors');
const { publicServiceAddress } = require('./service-address');
const { createAutomaticReview } = require('./automatic-review');
const { createProcessRecorder } = require('../scoring/process-review');
const { createConversationEvents } = require('./conversation-events');

// 协议来源：旧管理端 material-service-cases / material-case-evidence；不调用归档或评分。
const MATERIAL_SERVICES = {
  alloy: { label: '合金材料', field: 'idea', timeoutMs: 900000, endSettleMs: 300, snapshot: true },
  synthesis: { label: '合成制备', field: 'idea', timeoutMs: 360000, endSettleMs: 1200, snapshot: false },
  'new-material': { label: '新材料', field: 'instruction', timeoutMs: 900000, endSettleMs: 300, snapshot: true },
};
const MAX_STATE_BYTES = 2 * 1024 * 1024;
const MAX_ANSWER_CHARS = 3 * 1024 * 1024;
function inputError(message) { throw new TeamServiceError(400, 'REVIEW_INPUT_INVALID', message); }

async function readJsonBounded(response) {
  if (!response.ok) throw Error(`HTTP ${response.status}`);
  const reader = response.body.getReader(); const chunks = []; let bytes = 0;
  try {
    while (true) {
      const item = await reader.read(); if (item.done) break;
      bytes += item.value.length; if (bytes > MAX_STATE_BYTES) throw Error('结果快照超过保存上限');
      chunks.push(Buffer.from(item.value));
    }
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } finally { await reader.cancel().catch(() => {}); }
}

function collectArtifacts(value, baseUrl) {
  const items = []; const seen = new Set();
  function visit(node, depth = 0) {
    if (!node || typeof node !== 'object' || depth > 16 || items.length >= 100) return;
    for (const [key, child] of Object.entries(node)) {
      if (typeof child === 'string' && /^(?:url|preview_url|download_url|asset_url|glb_url|image_url)$/.test(key)) {
        try {
          const url = new URL(child, baseUrl);
          if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || seen.has(url.href)) continue;
          seen.add(url.href); items.push({ name: String(node.name || node.filename || node.title || url.pathname.split('/').pop() || '产物').slice(0, 200), url: url.href });
        } catch {}
      } else visit(child, depth + 1);
    }
  }
  visit(value); return items;
}

function createMaterialEvaluator({ serviceKey, url, timeoutMs, endSettleMs, autoContinueReview = true, createSocket = target => new WebSocket(target), fetchImpl = fetch, generateAnswers } = {}) {
  const config = Object.hasOwn(MATERIAL_SERVICES, serviceKey) ? MATERIAL_SERVICES[serviceKey] : null; if (!config) throw Error('不支持的材料服务');
  const target = new URL(url); if (!['ws:', 'wss:'].includes(target.protocol) || target.username || target.password) throw Error('材料服务必须配置 WebSocket 地址');
  const httpUrl = new URL(target); httpUrl.protocol = target.protocol === 'wss:' ? 'https:' : 'http:';
  return {
    serviceAddress: publicServiceAddress(target),
    scoreMode: 'none',
    async startQuestionRun({ question }, { onText, onState = () => {} }) {
      const id = `evaluation-${serviceKey}-${randomUUID()}`; const startedAt = Date.now();
      const process = createProcessRecorder(startedAt);
      const conversation = createConversationEvents({ baseUrl: httpUrl.origin });
      const details = { displayEvents: conversation.data.displayEvents, process: process.data, progress: [], result: null, protocolFrames: [], generatedFiles: [], artifacts: [], review: [], pendingReview: null, snapshot: null, truncated: false };
      let socket; let settled = false; let ending = false; let text = ''; let endTimer; let pendingRaw = null; let stateBytes = 0; let displayTimer; let summaryActive = false;
      const reviewAbort = new AbortController();
      const emit = () => { clearTimeout(displayTimer); displayTimer = null; details.truncated ||= conversation.data.truncated; onState(structuredClone(details)); };
      const accept = value => {
        const size = Buffer.byteLength(JSON.stringify(value));
        if (stateBytes + size > MAX_STATE_BYTES) { details.truncated = true; return false; }
        stateBytes += size; return true;
      };
      let resolveCompletion;
      const completion = new Promise(resolve => { resolveCompletion = resolve; });
      const finish = async error => {
        if (settled || ending) return; ending = true;
        if (!error && automaticReview.hasPending()) error = '服务在自动补充完成前结束，本轮未继续。';
        reviewAbort.abort();
        clearTimeout(timer); clearTimeout(endTimer); clearTimeout(displayTimer); emit(); pendingRaw = null; details.pendingReview = null;
        try { socket?.close(); } catch {}
        let completionError = error;
        try {
          if (config.snapshot && !error) {
            const snapshotUrl = new URL(httpUrl); snapshotUrl.pathname = target.pathname.replace(/\/start\/?$/, `/tasks/${encodeURIComponent(id)}`); snapshotUrl.search = '';
            try {
              const data = await readJsonBounded(await fetchImpl(snapshotUrl, { signal: AbortSignal.timeout(15000), redirect: 'error' }));
              if (!data || typeof data !== 'object' || Array.isArray(data) || (data.taskid && data.taskid !== id)) throw Error('任务快照身份不匹配');
              details.snapshot = { ok: true, data }; // 快照完整保留；采集帧另有限额。
            } catch { details.snapshot = { ok: false, error: '任务快照读取失败，已保留流式结果' }; }
          } else if (!config.snapshot) details.snapshot = { ok: false, skipped: true, error: '该服务不提供任务快照接口' };
          const textAssets = [...text.matchAll(/https?:\/\/[^\s<>()[\]"']+?\.(?:png|jpe?g|gif|webp|svg|glb|stl|cif|csv|pdf)(?:\?[^\s<>()[\]"']*)?/gi)].map(item => ({ url: item[0] }));
          const presentation = details.snapshot?.data?.artifacts?.presentation;
          const declaredAssets = serviceKey === 'new-material' && Array.isArray(presentation?.assets) ? presentation.assets.flatMap(asset => {
            if (typeof asset?.path !== 'string') return [];
            const name = asset.path.split('/').pop();
            if (!name || !/\.(?:png|jpe?g|gif|webp|glb|stl|cif)$/i.test(name)) return [];
            let encodedName;
            try { encodedName = encodeURIComponent(name); }
            catch { details.artifactError = '部分成果路径无效，已跳过对应预览链接'; return []; }
            const assetUrl = new URL(httpUrl); assetUrl.pathname = target.pathname.replace(/\/start\/?$/, `/tasks/${encodeURIComponent(id)}/assets/${encodedName}`); assetUrl.search = '';
            return [{ name: asset.name || name, url: assetUrl.href }];
          }) : [];
          details.artifacts = collectArtifacts({ result: details.result, snapshot: details.snapshot, frames: details.protocolFrames, files: details.generatedFiles, displayArtifacts: conversation.data.artifacts, textAssets, declaredAssets }, httpUrl);
        } catch {
          // 服务返回的数据不能让异步收尾拒绝或悬挂，必须保留已有输出并结束当前运行。
          completionError ||= '服务成果整理失败，已保留回答及结构化结果';
          details.artifactError = '成果文件整理失败，请查看完整结构化结果';
        } finally {
          settled = true;
          resolveCompletion({ status: completionError ? 'error' : 'done', taskid: id, elapsedMs: Date.now() - startedAt, error: completionError || null, details });
        }
      };
      const timer = setTimeout(() => void finish(`${config.label}执行超时`), timeoutMs ?? config.timeoutMs);
      const automaticReview = createAutomaticReview({ taskid: id, question, review: details.review, send: frame => socket.send(JSON.stringify(frame)), onRecord: emit, onError: error => void finish(error), isActive: () => !settled && !ending, signal:reviewAbort.signal, ...(generateAnswers ? { generateAnswers } : {}) });
      const reply = input => {
        if (settled || ending || !pendingRaw || String(input.requestId) !== String(pendingRaw.request_id)) throw new TeamServiceError(409, 'REVIEW_NOT_PENDING', '确认请求已处理或已失效，请刷新运行');
        if (!['apply', 'continue', 'stop'].includes(input.action)) inputError('无效的确认操作');
        const questions = details.pendingReview.questions;
        let answers = [];
        if (input.action !== 'stop') {
          if (questions.length && input.action !== 'apply') inputError('请填写确认问题后提交');
          if (!questions.length && input.action !== 'continue') inputError('请确认继续或停止');
          if (questions.length) {
            if (!Array.isArray(input.answers) || input.answers.length !== questions.length) inputError('请逐项填写确认问题');
            answers = questions.map(q => {
              const found = input.answers.filter(item => item && String(item.id) === String(q.id));
              if (found.length !== 1 || typeof found[0].answer !== 'string' || found[0].answer.length > 2000 || (q.required && !found[0].answer.trim())) inputError('必填答案不能为空，且每项不超过2000字符');
              return { id: q.id, answer: found[0].answer.trim() };
            });
          }
        }
        const frame = { type: 'checkpoint.reply', schema_version: 1, taskid: id, request_id: pendingRaw.request_id, action: input.action,
          ...(input.action === 'apply' ? { data: { edits: [], answers } } : {}) };
        // 先消费，防止双击或同步返回帧导致重复发送。
        pendingRaw = null; details.pendingReview = null;
        details.review.push({ at: new Date().toISOString(), requestId: frame.request_id, action: input.action, answers, source: 'user' }); emit();
        try { socket.send(JSON.stringify(frame)); } catch { void finish('确认答复发送失败'); throw new TeamServiceError(502, 'REVIEW_SEND_FAILED', '确认答复发送失败，请读取原运行状态'); }
        if (input.action === 'stop') void finish('用户已停止运行');
      };
      try {
        socket = createSocket(target.href);
        socket.addEventListener('open', () => {
          if (settled || ending) return;
          try { socket.send(JSON.stringify({ [config.field]: question, taskid: id, user_name: 'science-evaluation', ...(config.field === 'instruction' ? { file_metadata: [] } : {}) })); }
          catch { void finish(`${config.label}请求发送失败`); }
        });
        socket.addEventListener('message', event => {
          if (settled || ending) return;
          if (typeof event.data !== 'string') { void finish('服务返回了不支持的数据帧'); return; }
          if (Buffer.byteLength(event.data) > MAX_STATE_BYTES) { void finish('服务数据帧超过保存上限'); return; }
          let frame; try { frame = JSON.parse(event.data); } catch {}
          if (frame && typeof frame === 'object' && !Array.isArray(frame)) {
            if (frame.type === 'timeline.event' && frame.event && typeof frame.event === 'object') frame = frame.event;
            if (frame.ignore === true || ['heartbeat.ping', 'heartbeat', 'ping', 'pong'].includes(frame.type)) return;
            if (['user_input_request', 'display.followup_request'].includes(frame.type)) {
              if (accept(frame)) details.review.push({ at:new Date().toISOString(), action:'requested', source:'service', data:frame.data || {}, request:frame });
              emit(); void finish('服务提出了尚不支持的追问协议，已保留请求，未发送答复'); return;
            }
            if (typeof frame.type === 'string' && frame.type.startsWith('display.')) {
              if (frame.type === 'display.final_answer') summaryActive = ['start', 'delta'].includes(frame.phase);
              if (conversation.record(frame, text.length)) { details.artifacts = [...conversation.data.artifacts]; if (frame.phase === 'delta') { if (!displayTimer) displayTimer = setTimeout(emit, 32); } else emit(); }
              return;
            }
            if (!frame.taskid || frame.taskid === id) process.record(frame);
            if (['error', 'requirement_review_error'].includes(frame.type)) { void finish(frame.type === 'requirement_review_error' && autoContinueReview ? '服务拒绝自动继续，请查看本次确认记录' : `${config.label}返回执行错误`); return; }
            if (frame.type === 'requirement_review_request') {
              if (autoContinueReview) { void automaticReview(frame); return; }
              if (pendingRaw || details.review.length >= 20 || !['string', 'number'].includes(typeof frame.request_id) || String(frame.request_id).length > 200 || !accept(frame)) { void finish('服务确认请求异常或超过上限'); return; }
              const data = frame.data && typeof frame.data === 'object' ? frame.data : {};
              const qs = Array.isArray(data.questions) ? data.questions : [];
              if (qs.length > 20 || qs.some(q => !q || !['string', 'number'].includes(typeof q.id)) || new Set(qs.map(q => String(q.id))).size !== qs.length) { void finish('服务确认问题格式异常'); return; }
              pendingRaw = frame;
              details.pendingReview = { requestId: frame.request_id, title: String(data.title || frame.message || '请确认运行条件').slice(0, 500),
                questions: qs.map(q => ({ id: q.id, question: String(q.question || q.id).slice(0, 2000), required: q.required === true, suggestedAnswer: q.answer == null ? '' : String(q.answer).slice(0, 2000) })), data };
              details.review.push({ at: new Date().toISOString(), requestId: frame.request_id, action: 'requested', data }); emit(); return;
            }
            if (frame.type === 'result' && accept(frame)) details.result = frame.data || frame;
            else if (['progress', 'retrieval_progress'].includes(frame.type)) {
              const body = frame.data ?? frame.content ?? frame;
              const message = typeof body === 'string' ? body : [body.message, body.text, body.title, body.content].find(value => typeof value === 'string') || '';
              const progress = { ...(frame.stage_id ? { stage: frame.stage_id } : {}), text: message.slice(0, 1000) };
              if (!accept(progress)) return;
              details.progress.push(progress); if (details.progress.length > 50) details.progress.shift();
            } else if (frame.type === 'generated_files' && Array.isArray(frame.file_metadata) && accept(frame)) details.generatedFiles.push(...frame.file_metadata.slice(0, 100 - details.generatedFiles.length));
            else if (!frame.type && serviceKey === 'synthesis' && accept(frame)) {
              if (details.protocolFrames.length < 100) details.protocolFrames.push(frame); else details.truncated = true;
              if (frame.stage_id) { details.progress.push({ stage: frame.stage_id, text: frame.title || frame.name || frame.stage_id }); if (details.progress.length > 50) details.progress.shift(); }
            } else { if (!accept(frame)) return; if (details.protocolFrames.length < 100) details.protocolFrames.push(frame); else details.truncated = true; }
            emit(); return;
          }
          if (summaryActive) return;
          if (text.length + event.data.length > MAX_ANSWER_CHARS) { void finish('服务回答超过保存上限'); return; }
          text += event.data; onText(event.data);
          if (text.includes('[end]') && !endTimer) endTimer = setTimeout(() => void finish(text.includes('[start]') ? null : '服务缺少起始标识'), endSettleMs ?? config.endSettleMs);
        });
        socket.addEventListener('error', () => void finish(`${config.label}连接失败`));
        socket.addEventListener('close', () => {
          if (!ending && !settled) {
            clearTimeout(endTimer);
            endTimer = setTimeout(() => void finish(text.includes('[start]') && text.includes('[end]') && !pendingRaw ? null : `${config.label}连接中断，未收到完整回答`), endSettleMs ?? config.endSettleMs);
          }
        });
      } catch { void finish(`${config.label}连接失败`); }
      return { run: { id }, completion, reply, cancel: () => void finish('本次运行已结束') };
    },
    async getRunQuality() { return { status: 'absent', quality: null, error: null }; },
  };
}
module.exports = { createMaterialEvaluator, MATERIAL_SERVICES, collectArtifacts };
