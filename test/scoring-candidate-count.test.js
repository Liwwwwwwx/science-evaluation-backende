const { test } = require('node:test');
const assert = require('node:assert/strict');
const { candidateCountChecks, readCandidateCount } = require('../src/scoring/candidate-count');
const { readScoringAttachments } = require('../src/scoring/attachments');
const { createScoringService } = require('../src/scoring/service');
const { builtinRule } = require('../src/scoring/rules');
const { CHECKS } = require('../src/scoring/delivery-review');

const question = '按指定温度优化合金成分，给出最多 20 组候选。';
const url = 'http://rsi.test/alloy/tasks/task-1/assets/result.json';
const rubric = {
  requirements: [
    { id: 'R1', requirement: '给出最多20组候选成分方案', critical: true },
    { id: 'R2', requirement: '使用指定温度进行优化', critical: true },
    { id: 'R3', requirement: '候选组数不超过20组', kind: 'constraint', critical: false },
  ],
  visualAidsApplicable: false, visualAidsReason: '不依赖图像', requiresImages: false,
};
const candidate = (i, valid = true) => ({ candidate_id: `c-${i}`, feasible: valid, physical_valid: true, composition: { values: { Cu: 100 } } });
const report = rows => ({ ok: true, operation: 'optimize', request_id: 'task-1', result: { pareto_front: rows, history: Array.from({ length: 21 }, (_, i) => candidate(i)) } });
function job(priorityId = 'c-1') {
  return { question, answer: '按指定温度进行优化。', serviceKey: 'alpha-rsi', nativeRunId: 'task-1',
    run: { status: 'done', ruleSnapshot: builtinRule(), serviceAddress: 'ws://rsi.test/alloy/start', details: {
      artifacts: [{ url }], result: { taskid: 'task-1', artifacts: [{ url }], priority_candidate_id: priorityId },
    } } };
}

test('只统计本次交付的最终候选，有效一组可满足上限，同时识别超限、空结果和不可行候选', () => {
  for (const [rows, priority, expected] of [
    [[candidate(1)], 'c-1', ['met', 'met']],
    [Array.from({ length: 21 }, (_, i) => candidate(i + 1)), 'c-1', ['partial', 'missing']],
    [[], '', ['missing', 'met']],
    [[candidate(1, false)], 'c-1', ['missing', 'met']],
  ]) {
    const counts = readCandidateCount(job(priority), report(rows), url);
    assert.equal(counts.count, rows.length);
    const checks = candidateCountChecks(question, rubric, { ...counts, source: 'attachment:1', quote: '"pareto_front":[' });
    assert.deepEqual(checks.map(check => check.status), expected);
    assert.deepEqual(checks.map(check => check.id), ['R1', 'R3']);
  }
});

test('来源、任务、结果或数量条件有歧义时沿用评委判断', () => {
  assert.equal(readCandidateCount(job(), report([candidate(2)]), url), null);
  assert.equal(readCandidateCount(job(), report([candidate(1), candidate(1)]), url), null);
  assert.equal(readCandidateCount(job(), { ...report([candidate(1)]), request_id: 'other' }, url), null);
  assert.equal(readCandidateCount(job(), report([candidate(1)]), url.replace('result', 'other')), null);
  const multiple = job();
  multiple.run.details.result.case_results = [{}];
  assert.equal(readCandidateCount(multiple, report([candidate(1)]), url), null);
  const counts = { count: 1, feasible: 1, source: 'attachment:1', quote: '"pareto_front":[' };
  assert.deepEqual(candidateCountChecks('给出最多20组候选，至少提供五组候选。', rubric, counts), []);
  assert.deepEqual(candidateCountChecks('给出最多10组候选。', rubric, counts), []);
});

test('候选数量核验覆盖模型误判，其他交付项仍能影响合格', async () => {
  for (const status of ['met', 'partial']) {
    const client = { model: 'fixture', isConfigured: () => true, async callJson(prompt) {
      if (prompt.startsWith('仅根据题目')) return rubric;
      assert.match(prompt, /"candidateCountChecks":\[\{"id":"R1","status":"met"/);
      return {
        dimensions: { readability: { score: 80, note: '清楚' }, professionalism: { score: 80, note: '清楚' } },
        requirements: [
          { id: 'R1', status: 'partial', note: '只有1组候选', evidence: ['attachment:1:0'] },
          { id: 'R2', status, note: '温度说明', evidence: ['answer:0'] },
          { id: 'R3', status: 'met', note: '符合上限', evidence: ['attachment:1:0'] },
        ],
        deliveryReview: { status: 'partial', note: '交付偏少', evidence: ['attachment:1:0'] },
        experienceChecks: Object.keys(CHECKS).map(id => ({ id, status: 'passed', note: '已核对' })),
        comment: '交付说明', suggestions: ['核对单位'],
      };
    } };
    const service = createScoringService({ clients: { deepSeekScore: client }, attachmentReader: (value, options) =>
      readScoringAttachments(value, { ...options, readArtifact: async () => ({ body: Buffer.from(JSON.stringify(report([candidate(1)]))) }) }) });
    const scored = await service.score(job());
    const quality = scored.scores.deepSeekScore.quality;
    const [quantity, temperature, limit] = quality.taskCompletion.requirements;
    assert.equal(quantity.status, 'met');
    assert.equal(quantity.verification.method, 'candidate_count');
    assert.equal(quantity.evidenceRefs[0].source, 'attachment:1');
    assert.equal(limit.status, 'met');
    assert.equal(temperature.status, status);
    assert.equal(quality.deliveryReview.status, status === 'met' ? 'delivered' : 'partial');
    assert.equal(quality.qualification.status, status === 'met' ? 'qualified' : 'not_qualified');
  }
});
