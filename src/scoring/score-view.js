// Build a scoring-only view. Offsets always refer to the original source;
// hidden protocol markup never changes the stored answer or its evidence.
const FLOW = /^\[(?:start|end|done|completed|content_start|content_end)\]/i;
const BLOCK = /^(?:<<<(?:(?:CONTENT|PAPER)_(?:START|END)(?::[^>\n]+)?|(?:START|END)(?::[^>\n]+)?)>>>|<<<\s*>>>|<<>>)/i;
const VIEWER = /^<<<(STL_VIEWER|GLB_VIEWER|GENERATED_FILES_VIEWER|IMAGE_VIEWER):([\s\S]*?)>>>/i;
const PLACEHOLDER = /^【XXX\s*(?:开始|结束|完成|已完成)\s*[:：][^】\n]*】/i;
const CONTROL_TYPES = new Set(['progress','retrieval_progress','retrival_progress','route_progress','stage','phase_start','phase_end','stage_start','stage_end','requirement_review_request','user_input_request','checkpoint.request','adaptive_refactor']);
function closeUnescaped(text, token, from, escapedAt) { let end = text.indexOf(token, from); while (end >= 0 && escapedAt(end)) end = text.indexOf(token, end + token.length); return end; }
function heartbeat(value) {
  try {
    const event = JSON.parse(value);
    if (!event || typeof event !== 'object' || Array.isArray(event)) return false;
    const keys = event.type === 'heartbeat.ping' ? ['type', 'timestamp'] : ['type', 'ignore', 'task_id', 'elapsed_seconds'];
    return (event.type === 'heartbeat.ping' ? typeof event.timestamp === 'number' : event.type === 'heart_beat' && (event.ignore === undefined || event.ignore === true) && (typeof event.task_id === 'string' || typeof event.elapsed_seconds === 'number')) && Object.keys(event).every(key => keys.includes(key));
  } catch { return false; }
}
function jsonObjectAt(text, start) {
  let depth = 0; let quoted = false; let slash = false;
  for (let i = start; i < Math.min(text.length, start + 16000); i++) {
    const ch = text[i];
    if (quoted) { if (slash) slash = false; else if (ch === '\\') slash = true; else if (ch === '"') quoted = false; continue; }
    if (ch === '"') quoted = true;
    else if (ch === '{') depth++;
    else if (ch === '}' && --depth === 0) {
      try { return { value:JSON.parse(text.slice(start, i + 1)), end:i + 1 }; } catch { return null; }
    }
  }
  return null;
}
function scoreView(source, { hideHtml = true } = {}) {
  const text = typeof source === 'string' ? source : '';
  const hidden = new Uint8Array(text.length); const breakAt = new Set(); const viewers = [];
  const escapeFlags = new Uint8Array(text.length); let slashes = 0;
  for (let n = 0; n < text.length; n++) { escapeFlags[n] = slashes % 2; slashes = text[n] === '\\' ? slashes + 1 : 0; }
  const escapedAt = index => escapeFlags[index] === 1;
  const hide = (start, end) => { for (let n = start; n < end; n++) if (text[n] !== '\n' && text[n] !== '\r') hidden[n] = 1; };
  let i = 0;
  while (i < text.length) {
    const rest = text.slice(i); const lineStart = i === 0 || text[i - 1] === '\n';
    if (lineStart) {
      const fence = /^ {0,3}(`{3,}|~{3,})[^\n]*(?:\n|$)/.exec(rest);
      if (fence) {
        const end = new RegExp(`(?:^|\\n) {0,3}${fence[1][0]}{${fence[1].length},}[ \\t]*(?=\\n|$)`).exec(rest.slice(fence[0].length));
        i += end ? fence[0].length + end.index + end[0].length : rest.length; continue;
      }
      if (/^(?: {4}|\t)/.test(rest)) { const end = text.indexOf('\n', i); i = end < 0 ? text.length : end + 1; continue; }
    }
    if (text[i] === '`' && !escapedAt(i)) {
      const ticks = /^`+/.exec(rest)[0]; let end = text.indexOf(ticks, i + ticks.length);
      while (end >= 0 && (text[end - 1] === '`' || text[end + ticks.length] === '`')) end = text.indexOf(ticks, end + ticks.length);
      if (end >= 0) { i = end + ticks.length; continue; }
    }
    if ('[<$\\{【%'.includes(text[i]) && !escapedAt(i)) {
      const open = rest.startsWith('\\(') ? '\\(' : rest.startsWith('\\[') ? '\\[' : rest.startsWith('$$') ? '$$' : rest.startsWith('$') ? '$' : null;
      if (open) {
        const close = open === '\\(' ? '\\)' : open === '\\[' ? '\\]' : open;
        const end = closeUnescaped(text, close, i + open.length, escapedAt);
        const body = end < 0 ? '' : text.slice(i + open.length, end);
        if (end >= 0 && body.trim() && (!['$', '\\('].includes(open) || !body.includes('\n'))) { i = end + close.length; continue; }
      }
      const env = /^\\begin\{(aligned|alignedat|gathered|matrix|pmatrix|bmatrix|cases|array)\}/.exec(rest);
      if (env) { const endToken = `\\end{${env[1]}}`; const end = text.indexOf(endToken, i + env[0].length); if (end >= 0) { i = end + endToken.length; continue; } }
      if (rest.startsWith('<think>')) { const end = text.indexOf('</think>', i + 7); const next = end < 0 ? text.length : end + 8; hide(i, next); i = next; continue; }
      const flow = FLOW.exec(rest);
      if (flow && !['(', '['].includes(text[i + flow[0].length])) { hide(i, i + flow[0].length); i += flow[0].length; continue; }
      const viewer = VIEWER.exec(rest);
      if (viewer) {
        try { const data = JSON.parse(viewer[2]); if (data && typeof data === 'object' && !Array.isArray(data)) viewers.push({ type: viewer[1].toUpperCase(), data }); }
        catch { /* Preserve unrecognised or malformed payload as visible text. */ i += 3; continue; }
        hide(i, i + viewer[0].length); breakAt.add(i); i += viewer[0].length; continue;
      }
      const marker = BLOCK.exec(rest) || PLACEHOLDER.exec(rest);
      if (marker) { hide(i, i + marker[0].length); breakAt.add(i); i += marker[0].length; continue; }
      const pulse = /^\{[^{}\n]*"type"\s*:\s*"(?:heartbeat\.ping|heart_beat)"[^{}\n]*\}/.exec(rest);
      if (pulse && heartbeat(pulse[0])) { hide(i, i + pulse[0].length); i += pulse[0].length; continue; }
      if (text[i] === '{' && /"type"\s*:\s*"(?:progress|retrieval_progress|retrival_progress|route_progress|stage|phase_start|phase_end|stage_start|stage_end|requirement_review_request|user_input_request|checkpoint\.request|adaptive_refactor|MaterialsPNG|generated_files|STL)"/.test(rest.slice(0, 512))) {
        const parsed = jsonObjectAt(text, i); const data = parsed?.value;
        if (data && typeof data === 'object' && !Array.isArray(data)) {
          const isControl = CONTROL_TYPES.has(data.type) && ['taskid','task_id','stageid','request_id','seq'].some(key => Object.hasOwn(data, key));
          const isViewer = (data.type === 'MaterialsPNG' && typeof data.url === 'string') || (data.type === 'generated_files' && Array.isArray(data.file_metadata)) || (data.type === 'STL' && typeof data.url === 'string');
          if (isControl || isViewer) { if (isViewer) viewers.push({ type:data.type, data }); hide(i, parsed.end); breakAt.add(i); i = parsed.end; continue; }
        }
      }
      if (rest.startsWith('%Line Break%')) { hide(i, i + 12); breakAt.add(i); i += 12; continue; }
      // 前端默认安全策略移除 script 内容；不把隐藏脚本送入评分或机检。
      const suppressed = /^<(script)\b[^>]*>/i.exec(rest);
      if (suppressed) { const endRe = new RegExp(`</${suppressed[1]}\\s*>`, 'i'); const end = endRe.exec(rest.slice(suppressed[0].length)); const next = end ? i + suppressed[0].length + end.index + end[0].length : text.length; hide(i, next); i = next; continue; }
      if (hideHtml) {
        const tag = /^<\/?([a-z][a-z0-9-]*)(?:\s[^>]*?)?\s*\/?>/i.exec(rest);
        if (tag) {
          const type = tag[1].toLowerCase();
          if ((type === 'a' || type === 'img') && !/^<\//.test(tag[0])) {
            const attrs = {}; const attrRe = /\b(href|src|alt|title)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/gi; let attr;
            while ((attr = attrRe.exec(tag[0]))) attrs[attr[1].toLowerCase()] = attr[2] ?? attr[3] ?? attr[4];
            if ((type === 'a' && attrs.href) || (type === 'img' && attrs.src)) viewers.push({ type:type === 'a' ? 'HTML_LINK' : 'HTML_IMAGE', data:attrs });
          }
          hide(i, i + tag[0].length); i += tag[0].length; continue;
        }
      }
    }
    i++;
  }
  const ranges = []; const offsets = []; let start = -1; let view = ''; let compact = '';
  for (let n = 0; n < text.length; n++) {
    if (hidden[n]) {
      if (start >= 0) { ranges.push([start, n]); start = -1; }
      view += breakAt.has(n) ? '\n' : ' ';
      if (breakAt.has(n)) { compact += '\n'; offsets.push(n); }
    } else { if (start < 0) start = n; view += text[n]; compact += text[n]; offsets.push(n); }
  }
  if (start >= 0) ranges.push([start, text.length]);
  return { text: view, compact, offsets, ranges, viewers };
}
module.exports = { scoreView };
