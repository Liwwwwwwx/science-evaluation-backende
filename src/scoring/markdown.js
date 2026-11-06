const katex = require('katex');
const { scoreView } = require('./score-view');
let parser;
async function getParser() {
  parser ||= Promise.all([import('unified'), import('remark-parse'), import('remark-gfm'), import('remark-math')]).then(([u, p, g, m]) => u.unified().use(p.default).use(g.default).use(m.default));
  return parser;
}
// 仅去掉展示层不显示的协议；原文、位置和实际格式错误均保留。
async function checkMarkdown(source, { truncated = false } = {}) {
  const raw = typeof source === 'string' ? source : ''; const checked = raw.slice(0, 120000);
  const projected = scoreView(checked, { hideHtml: false }); const text = projected.compact;
  const limited = raw.length > checked.length || truncated;
  const tree = (await getParser()).parse(text); const issues = []; const protectedRanges = []; const maths = [];
  function add(id, severity, offset, detail, suggestion) {
    if (issues.length >= 100) return;
    const originalOffset = projected.offsets[offset] ?? checked.length;
    const line = checked.slice(0, originalOffset).split('\n').length;
    const column = originalOffset - checked.lastIndexOf('\n', originalOffset - 1);
    issues.push({ id, severity, line, column, snippet: checked.split('\n')[line - 1]?.slice(0, 180) || '', detail, suggestion });
  }
  function math(value, offset, display) {
    if (!display && /^\d/.test(value) && /\p{Script=Han}/u.test(value) && !value.includes('\\')) return;
    try { katex.renderToString(value, { displayMode: display, throwOnError: true, trust: false, strict: 'ignore' }); }
    catch { add('MATH_INVALID', 'error', offset, '公式无法按 KaTeX 语法渲染。', '检查命令、花括号及数学环境是否配对。'); }
  }
  function walk(node) {
    const start = node.position?.start.offset || 0; const end = node.position?.end.offset || 0;
    if (node.type === 'code' || node.type === 'inlineCode') {
      protectedRanges.push([start, end]);
      if (node.type === 'code') {
        const content = text.slice(start, end); const open = /^ {0,3}(`{3,}|~{3,})/.exec(content);
        if (open && !new RegExp(`\\n {0,3}${open[1][0]}{${open[1].length},}[ \\t]*$`).test(content)) add('FENCE_OPEN', 'warning', start, '代码围栏延伸到文本末尾。CommonMark 允许此写法，但可能吞入后续正文。', '确认内容完整，并显式关闭代码围栏。');
      }
      return;
    }
    if (node.type === 'math' || node.type === 'inlineMath') { maths.push([start, end]); math(node.value, start, node.type === 'math'); if (node.type === 'math' && !/\n[ \t]*\${2,}[ \t]*$/.test(text.slice(start, end))) add('DISPLAY_MATH_OPEN', 'warning', start, '块公式延伸到文本末尾，缺少结束定界符。', '补齐独立成行的 $$。'); }
    if (node.type === 'html') {
      const html = String(node.value || '');
      for (const attribute of html.matchAll(/\b(href|src)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/gi)) {
        const url = (attribute[2] ?? attribute[3] ?? attribute[4]).trim();
        const unsafeData = /^data:/i.test(url) && !(attribute[1].toLowerCase() === 'src' && /^data:image\/(?:png|jpeg|gif|webp|avif);base64,/i.test(url));
        if (/^(?:javascript|vbscript|file):/i.test(url) || unsafeData || /[\u0000-\u001f]/.test(url)) {
          add('URL_UNSAFE', 'error', start, 'HTML 链接使用不支持或不安全的协议。', '使用受支持的链接地址。');
        }
      }
    }
    if (['link', 'image', 'definition'].includes(node.type)) {
      const url = node.url || '';
      if (/^(?:javascript|data|file|vbscript):/i.test(url) || /[\u0000-\u001f]/.test(url)) add('URL_UNSAFE', 'error', start, '链接使用不支持或不安全的协议。', '使用 HTTP/HTTPS 链接。');
      else if (!url || (node.type === 'image' && !/^https?:\/\//i.test(url))) add('URL_UNVERIFIED', 'warning', start, '图片地址为空或为相对路径，可能无法显示。', '提供可访问的完整图片地址；本机检不检查远程可用性。');
    }
    if (node.type === 'table') {
      const cells = node.children[0]?.children.length || 0;
      for (const row of node.children.slice(1)) if (row.children.length > cells) add('TABLE_EXTRA_CELLS', 'warning', row.position.start.offset, '数据行列数超过表头，GFM 会丢弃多出的单元格。', '检查未转义的竖线，补齐表头或转义单元格中的竖线。');
    }
    for (const child of node.children || []) walk(child);
  }
  walk(tree);
  const blocked = offset => protectedRanges.some(([a, b]) => offset >= a && offset < b) || maths.some(([a,b]) => offset >= a && offset < b);
  const escaped = index => { let n = 0; while (index > 0 && text[--index] === '\\') n++; return n % 2 === 1; };
  // 与前端约定一致地识别 \( \)、\[ \]；保留原始位置，并排除代码和文献编号。
  const bracket = /\\([([])/g; let match;
  while ((match = bracket.exec(text))) {
    if (blocked(match.index) || escaped(match.index)) continue;
    const close = match[1] === '(' ? '\\)' : '\\]'; const end = text.indexOf(close, match.index + 2);
    if (end < 0) { add('MATH_OPEN', 'warning', match.index, '数学定界符未闭合。', '补齐对应的数学结束符。'); continue; }
    const body = text.slice(match.index + 2, end);
    if (!(match[1] === '[' && /^\s*\d{1,3}\s*$/.test(body))) math(body, match.index, match[1] === '[');
    bracket.lastIndex = end + 2;
  }
  for (const hit of text.matchAll(/\\begin\{(aligned|alignedat|gathered|matrix|pmatrix|bmatrix|cases|array)\}/g)) {
    if (blocked(hit.index)) continue;
    const endToken = `\\end{${hit[1]}}`; const end = text.indexOf(endToken, hit.index + hit[0].length);
    if (end < 0) add('MATH_ENV_OPEN', 'warning', hit.index, '数学环境没有对应的结束标记。', '补齐对应的 end 环境。');
    else math(text.slice(hit.index, end + endToken.length), hit.index, true);
  }
  for (const hit of text.matchAll(/(?<!\$)\$(?!\$)([^$\n]*[\\_{}^][^$\n]*)$/gm)) {
    if (!blocked(hit.index) && !escaped(hit.index)) add('INLINE_MATH_OPEN', 'warning', hit.index, '疑似行内公式未闭合。', '确认数学内容后补齐 $，普通金额使用转义美元符号。');
  }
  for (const hit of text.matchAll(/\$\$/g)) if (!blocked(hit.index) && !escaped(hit.index)) add('DISPLAY_MATH_OPEN', 'warning', hit.index, '块公式定界符未形成完整数学区间。', '将 $$ 独立成行并成对闭合，避免吞入正文。');
  for (const hit of text.matchAll(/!?\[[^\]\n]+\]\([^\n]*$/gm)) if (!blocked(hit.index) && !hit[0].includes(')')) add('LINK_OPEN', 'warning', hit.index, '疑似链接缺少右括号。', '检查链接括号及地址。');
  return { version: 'markdown-v2', status: !text.trim() ? 'not_evaluable' : issues.some(i => i.severity === 'error') ? 'failed' : limited ? 'not_evaluable' : issues.length ? 'observe' : 'passed', issues, coverage: limited ? 'partial' : 'full', checkedChars: checked.length, sourceChars: raw.length, linksVerified: false };
}
module.exports = { checkMarkdown };
