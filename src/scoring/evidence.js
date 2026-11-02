// 只接纳可在指定来源中逐字找到的引用；格式修正不能拼接或补造原文。
function sources(input, scope = 'output') {
  const entries = [
    { id: 'answer', text: input.answer || '', kind: 'output' },
    { id: 'structured', text: input.structured || '', kind: 'output' },
    ...(input.process?.messages || []).map(m => ({ id: m.id, text: m.text || '', kind: 'process' })),
  ];
  return entries.filter(e => typeof e.id === 'string' && typeof e.text === 'string' && (scope === 'all' || e.kind === scope));
}

function passages(input, scope = 'all') {
  const result = [];
  for (const source of sources(input,scope)) {
    let offset = 0;
    for (const line of source.text.match(/[^\n]*\n|[^\n]+$/g) || []) {
      let start = 0;
      while (start < line.length) {
        let end = Math.min(start+300,line.length);
        // 不把UTF-16代理对拆成两个片段。
        if (end < line.length && /[\uD800-\uDBFF]/.test(line[end-1]) && /[\uDC00-\uDFFF]/.test(line[end])) end--;
        result.push({id:`${source.id}:${offset+start}`,source:source.id,text:line.slice(start,end)});
        start = end;
      }
      offset += line.length;
    }
  }
  return result;
}

function evidence(value, input, scope = 'output') {
  const available = sources(input, scope);
  const knownPassages = new Map(passages(input,scope).map(p=>[p.id,p]));
  const items = Array.isArray(value) ? value : [value];
  if (!items.length || items.length > 5) return { text: '', refs: [], valid: false };
  const refs = [];
  for (let item of items) {
    let source;
    let quote;
    const ref = typeof item === 'string' ? knownPassages.get(item) : item && typeof item.ref === 'string' ? knownPassages.get(item.ref) : null;
    if (ref) { source=ref.source; quote=ref.text; }
    else if (typeof item === 'string') {
      quote = item.trim();
      // 兼容旧评委的单个字段包装；只有去掉包装后仍逐字匹配才接受。
      if (!available.some(s => s.text.includes(quote))) {
        const wrapped = /^(answer|structured|P\d+):\s*(['"“])([\s\S]*)(['"”])$/.exec(quote);
        if (wrapped && ((wrapped[2] === '“' && wrapped[4] === '”') || wrapped[2] === wrapped[4])) {
          source = wrapped[1]; quote = wrapped[3];
        }
      }
    } else if (item && typeof item === 'object') {
      source = item.source; quote = item.quote;
      if (typeof source !== 'string') return { text: '', refs: [], valid: false };
    }
    if (typeof quote !== 'string' || quote.trim().length < 3 || quote.length > 500) return { text: '', refs: [], valid: false };
    const found = available.find(s => (!source || s.id === source) && s.text.includes(quote));
    if (!found) return { text: '', refs: [], valid: false };
    refs.push({ source: found.id, quote });
  }
  return { text: refs.map(r => r.quote).join('\n'), refs, valid: true };
}

function completeScope(input, scope) {
  return !input.truncated && (scope === 'output' || (input.process?.recorded === true && !input.process?.truncated));
}

module.exports = { evidence, completeScope, passages };
