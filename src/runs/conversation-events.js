// 参考 ALPHA-BACKEND 的 display 归并：团队增量按 seq 去重，快照与流使用同一份状态。
const MAX_EVENT_BYTES = 256 * 1024;
const MAX_ESSENTIAL_EVENT_BYTES = 1024 * 1024;
const ESSENTIAL_TYPES = new Set([
  'display.team_output', 'display.final_answer', 'display.artifact',
  'display.followups', 'display.followup_request', 'display.followup_answer',
  'display.recommendations', 'display.supplement', 'result', 'generated_files',
]);
const TRANSIENT_PROGRESS_TYPES = new Set(['progress', 'retrieval_progress', 'retrival_progress']);
const eventLimit = type => ESSENTIAL_TYPES.has(type) ? MAX_ESSENTIAL_EVENT_BYTES : MAX_EVENT_BYTES;

function createConversationEvents({ baseUrl, maxBytes = 4 * 1024 * 1024, maxEvents = 2000 } = {}) {
  const data = { displayEvents: [], protocolFrames: [], artifacts: [], truncated: false };
  const groups = new Map();
  let bytes = 0; let arrival = 0;
  const size = value => Buffer.byteLength(JSON.stringify(value));
  function put(list, index, value, limit = MAX_EVENT_BYTES) {
    const previous = index < 0 ? 0 : size(list[index]);
    const next = size(value);
    if ((index < 0 && list.length >= maxEvents) || next > limit || bytes - previous + next > maxBytes) { data.truncated = true; return false; }
    bytes += next - previous;
    if (index < 0) list.push(value); else list[index] = value;
    return true;
  }
  function files(frame) {
    const values = Array.isArray(frame.file_metadata) ? frame.file_metadata : Array.isArray(frame.files) ? frame.files : [];
    for (const item of values) {
      const file = typeof item === 'string' ? { url: item } : item;
      if (!file || typeof file !== 'object') continue;
      const address = file.download_url || file.url || file.preview_url;
      if (typeof address !== 'string' || !address.trim()) continue;
      let url;
      try { url = new URL(address, baseUrl); } catch { continue; }
      if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) continue;
      if (data.artifacts.some(existing => existing.url === url.href)) continue;
      put(data.artifacts, -1, { ...file, url: url.href, name: file.original_filename || file.name || url.pathname.split('/').pop() || '服务文件' });
    }
  }
  function record(input, offset = 0) {
    let frame = input;
    if (frame.type === 'timeline.event' && frame.event && typeof frame.event === 'object' && !Array.isArray(frame.event)) frame = frame.event;
    if (!frame || typeof frame !== 'object' || Array.isArray(frame)) return false;
    const type = typeof frame.type === 'string' ? frame.type : '';
    if (frame.ignore === true || ['heartbeat.ping', 'heartbeat', 'ping', 'pong'].includes(type)) return false;
    // 进度正文已由 process/progress 摘要保留；完整大帧不进入归档预算。
    if (TRANSIENT_PROGRESS_TYPES.has(type) && !frame.stage_id && !frame.candidates && !frame.recommendations && frame.input_count == null && frame.output_count == null) return true;
    const sequence = Number.isSafeInteger(frame.seq) && frame.seq >= 0 ? frame.seq : null;
    const order = ++arrival;
    const eventId = typeof frame.event_id === 'string' && frame.event_id ? frame.event_id : type === 'display.process.step' && typeof frame.step_id === 'string' ? `step:${frame.step_id}` : `${type}:${order}`;
    const index = data.displayEvents.findIndex(value => value.type === type && (type === 'display.process.step' && frame.step_id ? value.step_id === frame.step_id && value.message_id === frame.message_id : value.event_id === eventId));
    const previous = index < 0 ? null : data.displayEvents[index];
    if (type.startsWith('display.')) {
      const key = `${type}:${eventId}`;
      let merged = { ...previous, ...frame, event_id: eventId, text_offset: previous?.text_offset ?? offset, received_order: previous?.received_order ?? order };
      if (['display.team_output', 'display.final_answer'].includes(type)) {
        const old = groups.get(key) || { prefix: '', watermark: -1, parts: new Map() };
        const next = { ...old, parts: new Map(old.parts) };
        const compacted = Number.isSafeInteger(frame.compacted_through_seq) ? frame.compacted_through_seq : null;
        if (frame.phase === 'delta' && typeof frame.delta === 'string') {
          if (compacted !== null) {
            if (compacted >= next.watermark) { next.prefix = frame.delta; next.watermark = compacted; for (const seq of next.parts.keys()) if (seq <= compacted) next.parts.delete(seq); }
          } else {
            const seq = sequence ?? order;
            if (seq > next.watermark && !next.parts.has(seq)) next.parts.set(seq, frame.delta);
          }
        }
        merged.delta = next.prefix + [...next.parts].sort((a, b) => a[0] - b[0]).map(entry => entry[1]).join('');
        if (previous?.phase === 'end' && frame.phase !== 'end') merged = { ...merged, phase: 'end', content: previous.content, status: previous.status };
        if (previous?.content && frame.phase !== 'end') merged.content = previous.content;
        // 最终正文是权威内容；重复保存累计增量会使合法结束帧超出归档预算。
        if (merged.phase === 'end' && typeof merged.content === 'string') delete merged.delta;
        merged.seq = Math.max(previous?.seq ?? -1, sequence ?? order);
        merged.compacted_through_seq = Math.max(next.watermark, ...next.parts.keys());
        if (!put(data.displayEvents, index, merged, eventLimit(type))) return false;
        groups.set(key, next);
      } else {
        if (previous && sequence !== null && typeof previous.seq === 'number' && sequence <= previous.seq) return false;
        if (!put(data.displayEvents, index, merged, eventLimit(type))) return false;
      }
      if (type === 'display.artifact') files(frame);
      return true;
    }
    if (type === 'generated_files') files(frame);
    if ((type === 'MaterialsPNG' || /stl/i.test(type)) && typeof frame.url === 'string') files({ files: [{ url: frame.url, name: frame.title }] });
    return put(data.protocolFrames, -1, { ...frame, text_offset: offset, received_order: order }, eventLimit(type));
  }
  return { data, record };
}
module.exports = { createConversationEvents };
