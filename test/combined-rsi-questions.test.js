const test = require('node:test');
const assert = require('node:assert/strict');
const { createQuestionBankGenerationService } = require('../src/question-bank/generation');
const { generateBatchQuestions } = require('../src/question-bank/batch-generation');

const specifications = {
  IN625: { bounds: { Ni: [60, 67], Cr: [20, 23], Mo: [8, 10], Nb: [3, 4] }, cast: true, objective: '最大化900℃屈服强度', route: 'LPBF_heat_treatment' },
  CuCrZr: { bounds: { Cr: [0.6, 1.2], Zr: [0.05, 0.15] }, balance: true, objective: '同时提高25℃屈服强度与电导率', route: 'LPBF_solution_aging' },
  IN718: { bounds: { Ni: [50, 55], Cr: [17, 21], Fe: [16, 21], Nb: [4.8, 5.5], Mo: [2.8, 3.3], Ti: [0.65, 1.15], Al: [0.2, 0.8] }, cast: true, objective: '最大化800℃屈服强度', route: 'LPBF_HIP_heat_treatment' },
  'GRCop-84': { bounds: { Cr: [5.5, 7], Nb: [5, 6.5] }, balance: true, objective: '最大化500℃屈服强度', route: 'LPBF_HIP_heat_treatment' },
};

test('四种材料的随机区间保持在示例范围内且可满足总和100%', async () => {
  const generator = createQuestionBankGenerationService({ llm: { isConfigured: () => false } });
  for (const [material, spec] of Object.entries(specifications)) {
    const result = await generator.generate({ generationMode: 'service', serviceKey: 'alpha-combined-rsi', questionKind: 'manufacturing', topic: material, count: 10 });
    assert.equal(new Set(result.items.map(item => item.question)).size, 10);
    for (const { question } of result.items) {
      assert.ok(question.includes(material));
      assert.ok(question.includes('wt.%') && question.includes('总和100%'));
      assert.ok(question.includes('最多20组候选'));
      assert.ok(question.includes(spec.objective));
      assert.ok(question.includes(spec.route));
      assert.equal(question.includes('铸态为性能预测条件'), !!spec.cast);
      assert.equal(question.includes('Cu余量'), !!spec.balance);
      let sumMin = 0; let sumMax = 0;
      for (const [element, [allowedMin, allowedMax]] of Object.entries(spec.bounds)) {
        const match = question.match(new RegExp(`(?:：|、)${element} (\\d+(?:\\.\\d+)?)–(\\d+(?:\\.\\d+)?)`));
        assert.ok(match, `${material} 缺少 ${element} 的成分范围`);
        const min = Number(match[1]); const max = Number(match[2]);
        assert.ok(min >= allowedMin && max <= allowedMax && min < max, `${material} ${element} 范围超出示例`);
        sumMin += min; sumMax += max;
      }
      assert.ok(sumMin <= 100);
      assert.ok(spec.balance ? sumMax < 100 : sumMax >= 100, `${material} 无法组成 100%`);
    }
  }
});

test('批量随机出题能够生成 100 道不重复的配比+制备题', async () => {
  const generator = createQuestionBankGenerationService({ llm: { isConfigured: () => false } });
  const items = await generateBatchQuestions({ generator, input: { generationMode: 'service', serviceKey: 'alpha-combined-rsi', questionKind: 'manufacturing' }, count: 100 });
  assert.equal(items.length, 100);
  assert.equal(new Set(items.map(item => item.question)).size, 100);
  for (const material of Object.keys(specifications)) assert.ok(items.some(item => item.question.includes(material)));
});

test('共同配比题不含制备要求，两个 RSI 均支持同一出题格式', async () => {
  const generator = createQuestionBankGenerationService({ llm: { isConfigured: () => false } });
  for (const serviceKey of ['alpha-rsi', 'alpha-combined-rsi']) {
    const result = await generator.generate({ generationMode: 'service', serviceKey, questionKind: 'composition', count: 4 });
    assert.equal(result.items.length, 4);
    assert.ok(result.items.every(item => item.serviceKey === serviceKey && item.question.includes('总和100%') && !item.question.includes('LPBF_')));
  }
  await assert.rejects(generator.generate({ generationMode: 'service', serviceKey: 'alpha-rsi', questionKind: 'manufacturing', count: 1 }), { code: 'QUESTION_GENERATION_INVALID' });
});
