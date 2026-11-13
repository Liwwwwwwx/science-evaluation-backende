const { generateBatchQuestions } = require('./batch-generation');
const { DEFAULT_SCHEME, SERVICE_KEYS, validateScheme } = require('../runs/batch-scheme');

// 批次按服务独立出题；旧服务和对比逻辑仅用于历史方案兼容。
const COMPOSITION_TOPIC = '航空航天材料与高温合金：仅限镍基/钴基高温合金或航空铝合金的成分/配比设计，要求给出 wt.% 具体成分（合计100%）、目标性能数值门槛和2–3组候选配比并排序；不要出工艺优化、热处理、涂层、凝固或机理解释题';
const SERVICE_INPUTS = Object.freeze({
  'mission-material': { generationMode: 'service', serviceKey: 'mission-material' },
  literature: { generationMode: 'service', serviceKey: 'literature' },
  'literature-aircraft': { generationMode: 'service', serviceKey: 'literature-aircraft' },
  'alpha-combined-rsi': { generationMode: 'service', serviceKey: 'alpha-combined-rsi' },
  synthesis: { generationMode: 'service', serviceKey: 'synthesis' },
  'new-material': { generationMode: 'service', serviceKey: 'new-material' },
});

async function generateTrialQuestions({ generator, scheme = DEFAULT_SCHEME } = {}) {
  scheme = validateScheme(scheme);
  const out = {};
  const count = key => scheme.services[key] || 0;
  async function generate(input, total) {
    const items = await generateBatchQuestions({ generator, input, count: total });
    return items.map(item => item.question);
  }

  if (count('alloy')) {
    out.alloy = await generate({ serviceKey: 'alloy', focus: 'composition', topic: COMPOSITION_TOPIC }, count('alloy'));
    if (scheme.compareAlloyAlpha) out['alpha-rsi'] = [...out.alloy];
  }
  if (!out['alpha-rsi'] && count('alpha-rsi')) {
    out['alpha-rsi'] = await generate({ serviceKey: 'alpha-rsi', focus: 'composition', topic: COMPOSITION_TOPIC }, count('alpha-rsi'));
  }
  if (scheme.compareSynthesisAlpha && count('synthesis')) {
    out.synthesis = await generate(SERVICE_INPUTS.synthesis, count('synthesis'));
    out['alpha-rsi'] = [...out.synthesis];
  } else if (count('synthesis')) {
    out.synthesis = await generate(SERVICE_INPUTS.synthesis, count('synthesis'));
  }
  for (const key of ['mission-material', 'literature', 'literature-aircraft', 'new-material', 'alpha-combined-rsi']) {
    if (count(key)) out[key] = await generate(SERVICE_INPUTS[key], count(key));
  }
  return Object.fromEntries(SERVICE_KEYS.filter(key => out[key]).map(key => [key, out[key]]));
}

module.exports = { generateTrialQuestions };
