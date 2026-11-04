const { generateBatchQuestions } = require('./batch-generation');
const { fingerprintOf } = require('./identity');
const { DEFAULT_SCHEME, SERVICE_KEYS, validateScheme } = require('../runs/batch-scheme');

// 两组均围绕材料领域：航空材料可用于航空检索、材料检索和合金团队；
// 新材料合成题可用于新材料、合成制备和材料检索。Mission 各取一部分。
async function generateTrialQuestions({ generator, scheme = DEFAULT_SCHEME } = {}) {
  scheme = validateScheme(scheme);
  const aviation = scheme.pools.aviation ? await generateBatchQuestions({ generator, input: { serviceKey: 'literature-aircraft', topic: '航空航天材料与高温合金：材料成分、制备工艺、结构和性能、失效与可靠性，问题应可用于航空材料文献检索和合金材料研究' }, count: scheme.pools.aviation }) : [];
  const synthesis = scheme.pools.synthesis ? await generateBatchQuestions({ generator, input: { serviceKey: 'synthesis', topic: '新材料合成与制备：前驱体、反应路线、工艺条件、结构与性能，问题应适合合成制备和新材料研究' }, count: scheme.pools.synthesis }) : [];
  const pool = [...aviation, ...synthesis];
  if (new Set(pool.map(item => fingerprintOf(item.question))).size !== pool.length) {
    const error = new Error('不同领域生成的题目存在重复，未创建运行计划');
    error.code = 'TRIAL_QUESTIONS_DUPLICATE';
    throw error;
  }
  const values = items => items.map(item => item.question);
  return Object.fromEntries(SERVICE_KEYS.filter(key => scheme.services[key].aviation + scheme.services[key].synthesis > 0).map(key => [key, values([...aviation.slice(0, scheme.services[key].aviation), ...synthesis.slice(0, scheme.services[key].synthesis)])]));
}
module.exports = { generateTrialQuestions };
