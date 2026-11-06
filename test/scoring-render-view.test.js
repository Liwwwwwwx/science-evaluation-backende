const { test } = require('node:test');
const assert = require('node:assert/strict');
const { scoreView } = require('../src/scoring/score-view');
const { checkMarkdown } = require('../src/scoring/markdown');
const { passages, evidence } = require('../src/scoring/evidence');
const { createScoringService } = require('../src/scoring/service');
const { createDirectScoreService } = require('../src/scoring/direct-score');

const client = fn => ({ model:'fixture', isConfigured:()=>true, callJson:fn });

test('协议标记和隐藏内容不进入评分正文；代码、公式和普通 JSON 保留', () => {
  const text = '<<<CONTENT_START:STEP>>>\n<div><strong>结论清楚</strong></div>\n<think>隐藏的思考</think>\n<<<PAPER_START:RAW_LITERATURE>>>文献正文<<<PAPER_END:RAW_LITERATURE>>>\n%Line Break%\n{"type":"heartbeat.ping","timestamp":10}\n```text\n<<<CONTENT_START:EXAMPLE>>>\n<think>代码示例</think>\n```\n`<<<CONTENT_START:LITERAL>>>`\n$\\text{[start]}$\n{"type":"business","data":"保留"}';
  const input = { answer:text, structured:'', process:{messages:[]} };
  const parts = passages(input).filter(p=>p.source==='answer');
  const view = parts.map(p=>p.text).join('');
  assert.ok(view.includes('结论清楚')); assert.ok(view.includes('文献正文'));
  assert.ok(!view.includes('隐藏的思考')); assert.ok(!view.includes('<<<CONTENT_START:STEP>>>')); assert.ok(!view.includes('heartbeat.ping'));
  assert.ok(view.includes('<<<CONTENT_START:EXAMPLE>>>')); assert.ok(view.includes('<<<CONTENT_START:LITERAL>>>')); assert.ok(view.includes('代码示例')); assert.ok(view.includes('\\text{[start]}')); assert.ok(view.includes('"type":"business"'));
  const ref = parts.find(p=>p.text.includes('结论清楚')); assert.ok(ref);
  const quote = evidence([ref.id], input); assert.equal(quote.valid, true); assert.ok(text.includes(quote.text)); assert.equal(quote.text, '结论清楚');
});

test('保留未知或畸形标记，已识别图片标记仅提取元数据', () => {
  const text = '<<<>>>\n<<>>\n<<<UNKNOWN:should remain>>>\n<<<IMAGE_VIEWER:{bad}>>>\n<<<IMAGE_VIEWER:{"url":"https://example.test/a.png","alt":"示意图"}>>>';
  const view = scoreView(text); const visible = view.ranges.map(([a,b])=>text.slice(a,b)).join('');
  assert.match(visible, /<<<UNKNOWN:should remain>>>/); assert.match(visible, /<<<IMAGE_VIEWER:\{bad\}>>>/);
  assert.ok(!visible.includes('<<<>>>')); assert.ok(!visible.includes('<<>>'));
  assert.equal(view.viewers.length, 1); assert.equal(view.viewers[0].data.alt, '示意图'); assert.ok(!visible.includes('example.test'));
});

test('仅过滤带协议身份的进度 JSON；保留业务 JSON 和链接信息', () => {
  const text = '{"type":"retrieval_progress","task_id":"t1","data":{"value":20}}\n{"type":"progress","value":30}\n<a href="https://example.test/paper">引用文献</a>\n<img src="https://example.test/chart.png" alt="图表">';
  const view = scoreView(text); const visible = view.ranges.map(([a,b])=>text.slice(a,b)).join('');
  assert.ok(!visible.includes('retrieval_progress')); assert.ok(visible.includes('"type":"progress"'));
  assert.ok(visible.includes('引用文献')); assert.ok(!visible.includes('<a '));
  assert.ok(view.viewers.some(item=>item.type==='HTML_LINK' && item.data.href==='https://example.test/paper'));
  assert.ok(view.viewers.some(item=>item.type==='HTML_IMAGE' && item.data.alt==='图表'));
});

test('HTML 安全过滤保留未知标签里的可见文字，移除 script 内容', () => {
  const text = '<abbr title="test">可读的缩写</abbr><iframe>回退说明</iframe><script>隐藏脚本</script>';
  const view = scoreView(text); const visible = view.ranges.map(([a,b])=>text.slice(a,b)).join('');
  assert.ok(visible.includes('可读的缩写')); assert.ok(visible.includes('回退说明')); assert.ok(!visible.includes('隐藏脚本'));
});

test('安全 HTML、隐藏脚本及 HTML 代码示例不误报，非法公式仍可发现', async () => {
  const good = '<<<CONTENT_START:X>>>\n<div><strong>结论清楚</strong><table><tr><td>数值</td></tr></table></div>\n```html\n<p>代码示例</p>\n```\n<<<CONTENT_END:X>>>';
  const passed = await checkMarkdown(good); assert.equal(passed.status, 'passed', JSON.stringify(passed));
  const bad = await checkMarkdown('<<<CONTENT_START:X>>>\n<script>unsafe</script>\n公式 $\\notARealCommand{x}$\n<<<CONTENT_END:X>>>');
  assert.equal(bad.status, 'failed'); assert.ok(!bad.issues.some(i=>i.id.startsWith('HTML_')));
  const math = bad.issues.find(i=>i.id==='MATH_INVALID'); assert.ok(math); assert.equal(math.line, 3); assert.match(math.snippet, /notARealCommand/);
  const unsafe = await checkMarkdown('<a href="javascript:alert(1)">链接</a>'); assert.ok(unsafe.issues.some(i=>i.id==='URL_UNSAFE'));
  const filtered = await checkMarkdown('正文<script>const s=\'<a href="javascript:alert(1)">x</a>\'</script>');
  assert.equal(filtered.status, 'passed'); assert.ok(!filtered.issues.some(i=>i.id==='URL_UNSAFE'));
});

test('自动评分模型只接收可见正文，证据回溯原文，产物只作为元数据', async () => {
  const answer = '<<<CONTENT_START:STEP>>>\n<div><strong>材料甲导热更好</strong></div>\n<think>不要给评委看的思考</think>\n<<<IMAGE_VIEWER:{"url":"https://example.test/a.png","alt":"示意图"}>>>\n<<<CONTENT_END:STEP>>>';
  let seen; const model = client(async prompt => {
    if (prompt.includes('仅根据题目')) return {requirements:[{requirement:'比较导热',critical:true}],visualAidsApplicable:false,visualAidsReason:'不要求图表'};
    seen = prompt; const input = JSON.parse(prompt.split('待评数据：')[1]);
    const part = input.passages.find(p=>p.source==='answer' && p.text.includes('材料甲导热更好'));
    assert.ok(part); assert.ok(input.passages.filter(p=>p.source==='answer').every(p=>!p.text.includes('<<<') && !p.text.includes('<div>') && !p.text.includes('不要给评委看')));
    assert.match(JSON.stringify(input.passages), /inlineViewers/);
    return { dimensions:{readability:{score:95,note:'结构清楚',evidence:[part.id]},professionalism:{score:90,note:'说明明确',evidence:[part.id]},visualAids:{score:null,note:'不适用'}},requirements:[{id:'R1',status:'met',evidence:[part.id],note:'已比较'}],comment:'内容清楚',suggestions:['可补充条件'] };
  });
  const result = await createScoringService({clients:{deepSeekScore:model}}).score({question:'比较两种材料的导热性能',answer,run:{status:'done'}});
  assert.equal(result.scores.deepSeekScore.status, 'ready'); assert.equal(result.markdownSyntax.status, 'passed');
  assert.equal(result.scores.deepSeekScore.quality.taskCompletion.requirements[0].evidence, '材料甲导热更好');
  assert.ok(answer.includes(result.scores.deepSeekScore.quality.taskCompletion.requirements[0].evidence));
  assert.ok(!seen.includes('不要给评委看的思考'));
});

test('直接评分保持原文证据，过滤协议标记及隐藏思考', async () => {
  const answer = '<<<CONTENT_START:X>>>\n<div>材料甲导热更好</div>\n<think>隐藏内容</think>\n<<<CONTENT_END:X>>>';
  let prompt; const model = client(async value => { prompt=value; return {score:90,summary:'已比较',criteria:[{criterion:'比较导热性能',status:'met',reason:'已给出结论',evidence:['A1']}],suggestions:['补充条件']}; });
  const result = await createDirectScoreService({clients:{deepSeekScore:model}}).score({question:'比较两种材料的导热性能',standard:'比较导热性能',answer});
  assert.equal(result.scores.deepSeekScore.status, 'ready'); assert.equal(result.scores.deepSeekScore.criteria[0].evidence, '材料甲导热更好');
  assert.ok(!prompt.includes('隐藏内容')); assert.ok(!prompt.includes('<<<CONTENT_START:X>>>')); assert.ok(answer.includes(result.scores.deepSeekScore.criteria[0].evidence));
});
