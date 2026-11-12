const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createScoringService, packInput } = require('../src/scoring/service');
const { evidence, passages } = require('../src/scoring/evidence');

const rubric = { requirements: [{ requirement: '核验末尾结论', critical: true }], visualAidsApplicable: false, visualAidsReason: '无需图表' };

test('长 Mission 正文、团队输出与结构化结果的末尾进入两位评委输入，并可引用原文', async () => {
  const answer = '答'.repeat(75000) + '正文末尾';
  const teamOutput = '团队输出'.repeat(6000) + '团队末尾';
  const tail = '快照末尾证据'.repeat(30);
  const job = { serviceKey: 'mission-material', question: '核验完整任务结果的末尾结论', answer, run: { status: 'done', details: {
    displayEvents: [{ type: 'display.team_output', phase: 'end', event_id: 'team-1', team: { name: '材料团队' }, content: teamOutput }],
    result: { report: '结'.repeat(120000) + '结果末尾' }, snapshot: { ok: true, data: { report: '数'.repeat(80000) + tail } },
  } } };
  const prompts = [];
  const clients = Object.fromEntries(['deepSeekScore', 'qwenScore'].map(key => [key, { model: key, isConfigured: () => true, callJson: async prompt => {
    if (prompt.startsWith('仅根据题目')) return rubric;
    const input = JSON.parse(prompt.slice(prompt.indexOf('待评数据：') + '待评数据：'.length));
    prompts.push(input);
    const answerText = input.passages.filter(part => part.source === 'answer').map(part => part.text).join('');
    const structuredText = input.passages.filter(part => part.source === 'structured').map(part => part.text).join('');
    assert.ok(answerText.includes('正文末尾'));
    assert.ok(answerText.includes('团队末尾'));
    assert.ok(structuredText.includes('结果末尾'));
    assert.ok(structuredText.includes(tail));
    const last = input.passages.find(part => part.source === 'structured' && part.text.includes('快照末尾证据'));
    assert.ok(last);
    return { dimensions: Object.fromEntries(['readability', 'professionalism', 'visualAids'].map(name => [name, { score: name === 'visualAids' ? null : 80, note: '依据完整结果' }])),
      requirements: [{ id: 'R1', status: 'met', evidence: [last.id], note: '已核验末尾' }], comment: '已读取完整输入', suggestions: ['继续保留证据'] };
  } }]));
  const result = await createScoringService({ clients }).score(job);
  assert.equal(prompts.length, 2);
  assert.equal(result.scoring.inputVersion, 'vision-v1');
  for (const key of ['deepSeekScore', 'qwenScore']) {
    const score = result.scores[key];
    assert.equal(score.status, 'ready');
    assert.equal(score.quality.source.truncated, false);
    assert.ok(score.quality.source.answerChars > 60000);
    assert.ok(score.quality.source.structuredChars > 30000);
    assert.match(score.quality.taskCompletion.requirements[0].evidence, /快照末尾证据/);
  }
});

test('正文和合计预算边界、原记录截断及 Unicode 截断均保留不完整标记', () => {
  const exact = packInput({ answer: '答'.repeat(300000), run: { details: { result: { text: '结'.repeat(1000) } } } });
  assert.equal(exact.truncated, false);
  const overAnswer = packInput({ answer: '答'.repeat(299999) + '🧪末尾' });
  assert.equal(overAnswer.answer.length, 299999);
  assert.equal(overAnswer.truncated, true);
  const overTotal = packInput({ answer: '答'.repeat(200000), run: { details: { result: { text: '结'.repeat(400000) + '结构化尾部' } } } });
  assert.equal(overTotal.answer.length + overTotal.structured.length, 600000);
  assert.equal(overTotal.truncated, true);
  assert.ok(!overTotal.structured.includes('结构化尾部'));
  assert.equal(packInput({ answer: '正文', answerTruncated: true }).truncated, true);
  assert.equal(packInput({ answer: '正文', run: { details: { truncated: true } } }).truncated, true);
});

test('敏感内容脱敏引起长度变化时不误报截断', () => {
  const value = 'token=abcdefghijklmnopqrstuvwxyz0123456789';
  const input = packInput({ answer: `前文 ${value} 后文` });
  assert.equal(input.truncated, false);
  assert.ok(!input.answer.includes(value));
  assert.ok(input.answer.includes('后文'));
});

test('大量短行保持原文与证据偏移，不让片段数量随行数膨胀', () => {
  const answer = '内容\n'.repeat(40000) + '末尾证据';
  const input = { answer, structured: '', process: { messages: [] } };
  const parts = passages(input).filter(part => part.source === 'answer');
  assert.equal(parts.map(part => part.text).join(''), answer);
  assert.ok(parts.length <= Math.ceil(answer.length / 299));
  const last = parts.at(-1);
  assert.match(evidence([last.id], input).text, /末尾证据/);
});
