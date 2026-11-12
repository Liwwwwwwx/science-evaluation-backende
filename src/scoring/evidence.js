const { scoreView } = require('./score-view');
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
    const ranges = source.id === 'answer' ? scoreView(source.text).ranges : [[0, source.text.length]];
    for (const [rangeStart, rangeEnd] of ranges) {
      // 将相邻短行合并为连续原文片段，避免长回答产生海量片段元数据。
      let start = rangeStart;
      while (start < rangeEnd) {
        let end = Math.min(start + 300, rangeEnd);
        // 不把UTF-16代理对拆成两个片段。
        if (end < rangeEnd && /[\uD800-\uDBFF]/.test(source.text[end-1]) && /[\uDC00-\uDFFF]/.test(source.text[end])) end--;
        result.push({id:`${source.id}:${start}`,source:source.id,text:source.text.slice(start,end)});
        start = end;
      }
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
    const imageId = typeof item === 'string' ? item : item && typeof item.ref === 'string' ? item.ref : '';
    if (/^image:\d+$/.test(imageId)) {
      const image = (input.images || []).find(entry => entry.id === imageId);
      if (!image) return { text: '', refs: [], valid: false };
      refs.push({ source: 'image', imageId, label: `图片 ${imageId.slice(6)}（视觉判断未独立核验）` });
      continue;
    }
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
  return { text: refs.map(r => r.quote || r.label).join('\n'), refs, valid: true };
}

function completeScope(input, scope) {
  return !input.truncated && (scope === 'output' || (input.process?.recorded === true && !input.process?.truncated));
}

module.exports = { evidence, completeScope, passages };
