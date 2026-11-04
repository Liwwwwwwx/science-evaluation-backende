const { randomUUID } = require('node:crypto');
const { publicServiceAddress } = require('./service-address');
const { createProcessRecorder } = require('../scoring/process-review');
const { collectArtifacts } = require('./material-evaluator');
const { createAlphaRsiSupplement } = require('./alpha-rsi-supplement');

// 协议来源：旧管理端 material-service-cases 的 alpha-rsi-ws runner。
// 1110 用 [start]/[end] 标记正文，user_input_request 表达开工确认与补充条件请求。
const SERVICE_LABEL = 'ALPHA 材料 RSI';
const DEFAULT_TIMEOUT_MS = 15 * 60 * 1000;
const DEFAULT_END_SETTLE_MS = 1500;
const DEFAULT_CLOSE_SETTLE_MS = 500;
const MAX_ANSWER_CHARS = 3 * 1024 * 1024;
const MAX_STATE_BYTES = 2 * 1024 * 1024;
const MAX_FRAMES = 100000;
const MAX_CHECKPOINTS = 4;
const MAX_PROGRESS = 50;
const MAX_RECORDS = 100;
const START_MARK = '[start]';
const END_MARK = '[end]';
const MARKER_RE = /\[start\]|\[end\]/g;

function partialMarkerLength(value) {
  let length = 0;
  for (const marker of [START_MARK, END_MARK]) {
    for (let size = 1; size < marker.length; size += 1) {
      if (value.endsWith(marker.slice(0, size))) length = Math.max(length, size);
    }
  }
  return length;
}

function createAlphaRsiEvaluator({
  url,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  endSettleMs = DEFAULT_END_SETTLE_MS,
  closeSettleMs = DEFAULT_CLOSE_SETTLE_MS,
  createSocket = (target) => new WebSocket(target),
  generateSupplement = createAlphaRsiSupplement(),
} = {}) {
  const target = new URL(url);
  if (!['ws:', 'wss:'].includes(target.protocol) || target.username || target.password) throw new Error('ALPHA 材料 RSI 必须配置 WebSocket 地址');
  const httpUrl = new URL(target);
  httpUrl.protocol = target.protocol === 'wss:' ? 'https:' : 'http:';

  return {
    serviceAddress: publicServiceAddress(target),
    scoreMode: 'none',
    async startQuestionRun({ question }, { onText = () => {}, onState = () => {} } = {}) {
      const id = `evaluation-alpha-rsi-${randomUUID()}`;
      const startedAt = Date.now();
      const process = createProcessRecorder(startedAt);
      const transport = { state: 'connecting', openedAt: null, closedAt: null, closeCode: null, wasClean: null, lastFrameType: null, lastFrameAt: null, receivedFrames: 0 };
      const details = { process: process.data, progress: [], review: [], result: null, generatedFiles: [], artifacts: [], protocolFrames: [], transport, truncated: false };
      let socket;
      let settled = false;
      let ending = false;
      let raw = '';
      let visibleSentLength = 0;
      let pendingPartial = false;
      let receivedStart = false;
      let receivedEnd = false;
      let replyCount = 0;
      let frameCount = 0;
      let stateBytes = 0;
      let emitTimer = null;
      let endTimer = null;
      let closeTimer = null;
      let resolveCompletion;
      const requests = new Set();
      const supplementAbort = new AbortController();
      let inputPending = false;

      const completion = new Promise((resolve) => { resolveCompletion = resolve; });
      const keep = (value) => {
        const size = Buffer.byteLength(JSON.stringify(value));
        if (stateBytes + size > MAX_STATE_BYTES) { details.truncated = true; return false; }
        stateBytes += size;
        return true;
      };
      const emit = () => {
        clearTimeout(emitTimer);
        emitTimer = null;
        try { onState(structuredClone(details)); } catch {}
      };
      const scheduleEmit = () => { if (!emitTimer) emitTimer = setTimeout(emit, 32); };

      const finish = (error = null) => {
        if (settled || ending) return;
        ending = true;
        supplementAbort.abort();
        if (!error && details.result?.status === 'waiting_for_input') error = '服务返回等待补充信息，但未提供可回复的交互请求，本轮未完成。';
        transport.state = error ? 'failed' : 'closed'; transport.finishedAt = new Date().toISOString(); if (!transport.closedAt) transport.closedAt = transport.finishedAt;
        clearTimeout(timer);
        clearTimeout(endTimer);
        clearTimeout(closeTimer);
        clearTimeout(emitTimer);
        try { socket?.close(); } catch {}
        try {
          const textAssets = [...raw.matchAll(/https?:\/\/[^\s<>()[\]"']+?\.(?:png|jpe?g|gif|webp|svg|pdf|csv)(?:\?[^\s<>()[\]"']*)?/gi)].map((item) => ({ url: item[0] }));
          details.artifacts = collectArtifacts({ result: details.result, generatedFiles: details.generatedFiles, frames: details.protocolFrames, textAssets }, httpUrl);
        } catch {
          details.artifactError = '成果文件整理失败，请查看完整结构化结果';
        }
        emit();
        settled = true;
        resolveCompletion({ status: error ? 'error' : 'done', taskid: id, elapsedMs: Date.now() - startedAt, error, details });
      };

      const timer = setTimeout(() => finish(`${SERVICE_LABEL} 执行超时`), timeoutMs);

      const replyToInputRequest = async (frame) => {
        const requestId = frame.request_id;
        if (!['string', 'number'].includes(typeof requestId) || String(requestId).length > 200) return finish(`${SERVICE_LABEL} 确认请求标识无效`);
        const requestKey = String(requestId);
        if (requests.has(requestKey)) return;
        if (inputPending) return finish(`${SERVICE_LABEL} 同时发出多个确认请求，无法安全答复`);
        if (replyCount >= MAX_CHECKPOINTS) return finish(`${SERVICE_LABEL} 重复要求人工确认，已中止`);
        requests.add(requestKey);
        replyCount += 1;
        const parameters = frame.parameters && typeof frame.parameters === 'object' ? frame.parameters : {};
        const reason = typeof parameters.reason === 'string' ? parameters.reason : '';
        const title = typeof frame.message === 'string' && frame.message.trim() ? frame.message.trim().slice(0, 500) : reason === 'requirements' ? '需求补充请求' : '执行确认';
        const record = { at: new Date().toISOString(), requestId, title, reason, action: reason === 'requirements' ? 'apply' : 'continue', source: 'automatic', delivery: 'pending' };
        if (details.review.length < 20 && keep({ title, reason })) details.review.push(record); else details.truncated = true;
        if (reason === 'requirements') {
          inputPending = true;
          const data = frame.data && typeof frame.data === 'object' ? frame.data : {};
          const questions = Array.isArray(data.questions) ? data.questions.slice(0, 20).map(item => typeof item === 'string' ? item.slice(0, 1000) : JSON.stringify(item).slice(0, 1000)) : [];
          record.questions = questions;
          record.summary = '正在生成补充答复。';
          emit();
          let supplement;
          try { supplement = await generateSupplement({ question, title, questions, signal: supplementAbort.signal }); }
          catch (error) {
            if (settled || ending) return;
            record.delivery = 'not_sent'; record.summary = '自动补充失败，未发送答复。';
            emit();
            return finish(error?.message === '自动补充模型未配置' ? error.message : '自动补充生成失败，未发送答复');
          }
          if (settled || ending) return;
          if (!supplement || typeof supplement.message !== 'string' || !supplement.message.trim() || supplement.message.length > 4000) {
            record.delivery = 'not_sent'; record.summary = '自动补充内容无效，未发送答复。'; emit();
            return finish('自动补充内容无效，未发送答复');
          }
          record.answers = [{ answer: supplement.message.trim() }];
          record.model = supplement.model || null;
          record.summary = '已自动补充条件；假设请结合题目核对。';
          try {
            socket.send(JSON.stringify({ type: 'checkpoint.reply', taskid: id, request_id: requestId, approved: true, params: { message: supplement.message.trim() } }));
            record.delivery = 'sent'; inputPending = false;
            if (details.result?.status === 'waiting_for_input') details.result = null;
          } catch {
            record.delivery = 'failed'; emit();
            return finish(`${SERVICE_LABEL} 补充答复发送失败`);
          }
          emit();
          return;
        }
        if (reason !== 'checkpoint') { record.delivery = 'not_sent'; emit(); return finish(`${SERVICE_LABEL} 未知交互类型，未自动答复`); }
        record.summary = '自动确认继续。';
        try {
          socket.send(JSON.stringify({ type: 'checkpoint.reply', taskid: id, request_id: requestId, approved: true, params: { message: '' } }));
          record.delivery = 'sent';
        } catch {
          record.delivery = 'failed';
          emit();
          return finish(`${SERVICE_LABEL} 确认答复发送失败`);
        }
        emit();
      };

      const recordProtocol = (frame) => {
        if (details.protocolFrames.length >= MAX_RECORDS) { details.truncated = true; return; }
        if (keep(frame)) details.protocolFrames.push(frame); else details.truncated = true;
      };

      const appendText = (delta) => {
        raw += delta;
        if (raw.length > MAX_ANSWER_CHARS) return finish(`${SERVICE_LABEL} 回答超过保存上限`);
        if (delta.includes('[') || pendingPartial) {
          const visible = raw.replace(MARKER_RE, '');
          const held = partialMarkerLength(raw);
          const safeLength = Math.max(0, visible.length - held);
          if (safeLength > visibleSentLength) {
            onText(visible.slice(visibleSentLength, safeLength));
            visibleSentLength = safeLength;
          }
          pendingPartial = held > 0;
        } else {
          onText(delta);
          visibleSentLength += delta.length;
        }
        if (raw.includes(START_MARK)) receivedStart = true;
        if (raw.includes(END_MARK) && !receivedEnd) {
          receivedEnd = true;
          endTimer = setTimeout(() => finish(inputPending ? '服务在自动补充完成前结束，本轮未继续。' : receivedStart ? null : `${SERVICE_LABEL} 缺少起始标识`), endSettleMs);
        }
      };

      const receive = (event) => {
        if (settled || ending) return;
        const data = typeof event?.data === 'string' ? event.data : event?.data?.toString?.();
        if (typeof data !== 'string' || !data) return;
        transport.receivedFrames = frameCount + 1; transport.lastFrameAt = new Date().toISOString(); transport.lastFrameType = data.startsWith('{') ? 'json' : 'text';
        if (++frameCount > MAX_FRAMES) return finish(`${SERVICE_LABEL} 协议帧超过上限`);
        if (Buffer.byteLength(data) > MAX_STATE_BYTES) return finish(`${SERVICE_LABEL} 数据帧超过保存上限`);
        let frame = null;
        try { frame = JSON.parse(data); } catch {}
        if (frame && typeof frame === 'object' && !Array.isArray(frame)) {
          if (frame.type === 'timeline.event' && frame.event && typeof frame.event === 'object' && !Array.isArray(frame.event)) frame = frame.event;
          if (frame.ignore === true || ['heartbeat.ping', 'heartbeat', 'ping', 'pong'].includes(frame.type)) return;
          process.record(frame);
          if (['error', 'requirement_review_error'].includes(frame.type)) return finish(`${SERVICE_LABEL} 返回执行错误`);
          if (frame.type === 'user_input_request') { void replyToInputRequest(frame); return; }
          if (typeof frame.type === 'string' && /(?:_request|\.request)$/.test(frame.type)) {
            recordProtocol(frame);
            return finish(`${SERVICE_LABEL} 交互尚未支持：${frame.type.slice(0, 100)}`);
          }
          if (frame.type === 'generated_files') {
            const files = Array.isArray(frame.file_metadata) ? frame.file_metadata : [];
            for (const item of files) {
              if (details.generatedFiles.length >= MAX_RECORDS) { details.truncated = true; break; }
              if (keep(item)) details.generatedFiles.push(item); else details.truncated = true;
            }
            recordProtocol({ type: 'generated_files', count: files.length });
            scheduleEmit();
            return;
          }
          if (frame.type === 'result') {
            if (keep(frame.data || frame)) details.result = frame.data || frame; else details.truncated = true;
            recordProtocol({ type: 'result' });
            scheduleEmit();
            return;
          }
          if (['progress', 'retrieval_progress', 'stage', 'stage_start', 'stage_end'].includes(frame.type)) {
            const body = frame.data && typeof frame.data === 'object' ? frame.data : frame;
            const message = [body.message, body.text, body.content, body.title, frame.message].find((value) => typeof value === 'string' && value.trim());
            if (message && details.progress.length < MAX_PROGRESS && keep(message)) details.progress.push({ at: new Date().toISOString(), text: message.slice(0, 1000) });
            recordProtocol({ type: frame.type, stage_id: frame.stage_id || body.stage_id || null });
            scheduleEmit();
            return;
          }
          recordProtocol(frame);
          scheduleEmit();
          return;
        }
        appendText(data);
        scheduleEmit();
      };

      try {
        socket = createSocket(target.href);
        socket.addEventListener('open', () => {
          if (settled || ending) return;
          transport.state = 'open'; transport.openedAt = new Date().toISOString();
          try {
            socket.send(JSON.stringify({ idea: question, taskid: id, user_name: 'science-evaluation', file_metadata: [] }));
          } catch { finish(`${SERVICE_LABEL} 请求发送失败`); }
        });
        socket.addEventListener('message', receive);
        socket.addEventListener('error', () => finish(`${SERVICE_LABEL} 连接失败`));
        socket.addEventListener('close', (event) => {
          if (settled || ending) return;
          transport.closedAt = new Date().toISOString();
          transport.closeCode = Number.isInteger(event?.code) ? event.code : null;
          transport.wasClean = typeof event?.wasClean === 'boolean' ? event.wasClean : null;
          if (endTimer) return;
          closeTimer = setTimeout(() => finish(receivedStart && receivedEnd ? null : `${SERVICE_LABEL} 连接中断（关闭码 ${transport.closeCode ?? '未知'}），未收到完整回答`), closeSettleMs);
        });
      } catch { finish(`${SERVICE_LABEL} 连接失败`); }

      return { run: { id }, completion };
    },
    async getRunQuality() { return { status: 'absent', quality: null, error: null }; },
  };
}

module.exports = { createAlphaRsiEvaluator, SERVICE_LABEL };
