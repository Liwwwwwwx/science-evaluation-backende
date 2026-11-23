const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createScoringService, redact } = require('../src/scoring/service');
const { readScoringAttachments } = require('../src/scoring/attachments');
const { readRunArtifact } = require('../src/runs/artifacts');
const { CHECKS } = require('../src/scoring/delivery-review');
const { builtinRule } = require('../src/scoring/rules');

function pdfWithText(text) {
  const stream = `BT /F1 12 Tf 20 90 Td (${text}) Tj ET`;
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Count 1 /Kids [3 0 R] >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 400 120] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`,
  ];
  let file = '%PDF-1.4\n';
  const offsets = objects.map((object, index) => {
    const offset = file.length;
    file += `${index + 1} 0 obj\n${object}\nendobj\n`;
    return offset;
  });
  return Buffer.from(file + `xref\n0 6\n0000000000 65535 f \n${offsets.map(offset => `${String(offset).padStart(10, '0')} 00000 n \n`).join('')}trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${file.length}\n%%EOF\n`);
}

const base = 'http://rsi.test';
const job = files => ({
  serviceKey: 'alpha-rsi', nativeRunId: 'task-1', question: '给出最多20组候选组成。',
  answer: '候选组成见已交付的数据表。',
  run: { status: 'done', serviceAddress: 'ws://rsi.test/alloy/start', ruleSnapshot: builtinRule(), details: { artifacts: files.map(url => ({ url })) } },
});

test('产物读取提取 PDF、CSV 和 JSON，保留覆盖差异及来源限制', async () => {
  const value = job([
    base + '/alloy/tasks/task-1/assets/candidates.csv', base + '/files/report.pdf', base + '/files/data.json',
    base + '/files/long.md', base + '/files/expired.txt', 'http://external.test/report.txt',
    base + '/alloy/tasks/other/assets/private.json', base + '/files/candidates.xlsx',
  ]);
  const requested = [];
  const readArtifact = (run, index, options) => readRunArtifact(run, index, { ...options, fetchImpl: async (url, config) => {
    assert.equal(config.redirect, 'error');
    requested.push(url.pathname);
    if (url.pathname.endsWith('candidates.csv')) return new Response('material,value\nC01,227.87');
    if (url.pathname.endsWith('report.pdf')) return new Response(pdfWithText('Measured yield 227.87 MPa'));
    if (url.pathname.endsWith('data.json')) return new Response(JSON.stringify({ value: 10, password: 'dummy-sensitive-value' }));
    if (url.pathname.endsWith('long.md')) return new Response('材料表格\n'.repeat(4000));
    return new Response('expired', { status: 404 });
  } });
  const { attachments, attachmentCoverage } = await readScoringAttachments(value, { readArtifact, redact });
  assert.deepEqual(attachmentCoverage.files.map(file => file.state), ['included', 'included', 'included', 'partial', 'unreadable', 'blocked', 'blocked']);
  assert.deepEqual(requested, ['/alloy/tasks/task-1/assets/candidates.csv', '/files/report.pdf', '/files/data.json', '/files/long.md', '/files/expired.txt']);
  assert.match(attachments[0].text, /C01,227\.87/);
  assert.match(attachments[1].text, /Measured yield 227\.87 MPa/);
  assert.match(attachments[2].text, /已隐藏/);
  assert.doesNotMatch(JSON.stringify(attachments), /dummy-sensitive-value/);
  assert.equal(attachments[3].text.length, 16000);
});

test('评委可引用实际附件片段，可选图片被拒时保留正文和附件判定', async () => {
  const value = job([base + '/files/candidates.csv', 'http://external.test/chart.png']);
  const client = {
    model: 'mock', supportsImages: false, isConfigured: () => true,
    async callJson(prompt) {
      if (prompt.startsWith('仅根据题目')) {
        return { requirements: [{ requirement: '给出最多20组候选组成', critical: true }], visualAidsApplicable: false, visualAidsReason: '数据表足够', requiresImages: false };
      }
      assert.match(prompt, /最多N组.*上限/);
      assert.match(prompt, /"id":"attachment:1:0","source":"attachment:1","text":"material,Cr,Nb,Cu/);
      assert.match(prompt, /"blocked":1/);
      return {
        dimensions: { readability: { score: 80, note: '清楚' }, professionalism: { score: 80, note: '清楚' } },
        requirements: [{ id: 'R1', status: 'met', evidence: ['attachment:1:0'], note: '收到实际数据' }],
        comment: '检查了附件', suggestions: ['补充实验条件'],
        deliveryReview: { status: 'delivered', note: '已有数据', evidence: ['attachment:1:0'] },
        experienceChecks: Object.keys(CHECKS).map(id => ({ id, status: 'passed', note: '已核对' })),
      };
    },
  };
  const score = createScoringService({
    clients: { deepSeekScore: client },
    attachmentReader: (run, options) => readScoringAttachments(run, { ...options, readArtifact: async () => ({ body: Buffer.from('material,Cr,Nb,Cu\nC01,6.5,5.8,87.7') }) }),
  });
  const quality = (await score.score(value)).scores.deepSeekScore.quality;
  assert.equal(quality.source.truncated, false);
  assert.deepEqual(quality.source.imageCoverage, { found: 1, sent: 0, overflow: false, blocked: 1 });
  assert.equal(quality.source.attachmentCoverage.files[0].state, 'included');
  assert.equal(quality.taskCompletion.requirements[0].evidenceRefs[0].source, 'attachment:1');
  assert.match(quality.taskCompletion.requirements[0].evidenceRefs[0].quote, /C01,6\.5,5\.8,87\.7/);
  assert.equal(quality.qualification.status, 'qualified');
  value.answerTruncated = true;
  const incomplete = (await score.score(value)).scores.deepSeekScore.quality;
  assert.equal(incomplete.source.outputTruncated, true);
  assert.equal(incomplete.qualification.status, 'unclear');
});
