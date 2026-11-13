// 对比随机题与批次材料题共用同一套出题方向：配比/配方或工艺优化，而不是机理解释。
const { randomInt } = require('node:crypto');

const OPTIMIZATION_TYPES = Object.freeze([
  '配比优化：给定应用场景、性能门槛和工艺条件，要求提出 2–3 组候选成分或配方并比较排序',
  '工艺优化：给定材料体系与目标性能，要求优化关键工艺参数（温度、时间、路线等）并说明取舍',
  '方案取舍：比较 2–3 组候选成分、配方或工艺方案，给出排序、适用条件与风险',
]);

const OPTIMIZATION_RULES = [
  '题目必须是材料配比/配方或工艺优化任务：给出应用场景、可核验的性能门槛和成分/工艺约束，要求提出或比较 2–3 组候选成分、配方或工艺方案，并排序或说明取舍。',
  '题面必须包含至少一个明确的数值约束（如 wt.%、温度、时间、强度门槛）；适用时说明组分合计 100%。性能门槛必须写成具体数值，不能用“假设门槛/待定上限”代替。',
  '禁止以解释机理、原理或机制作为题目主体；文献综述、实验设计、故障诊断也不能作为主题，只能作为优化任务的辅助条件。',
  '不要编造已有实验结果、具体牌号性能或模型能力；未确定的数据明确标为假设。',
].join('\n');

const OPTIMIZE_WORDS = /(配比|配方|成分|组分|工艺|热处理|优化|候选|排序|比较|方案)/;
const NUMERIC_CONSTRAINT = /(?:\d+(?:\.\d+)?\s*(?:wt\.?\s*%|%|℃|°C|MPa|GPa|h|min|分钟|小时|K)|(?:不低于|不超过|≥|≤|大于|小于)\s*\d)/i;
const EXPLANATION_ASK = /(?:解释|阐述|论述|说明)[^。！？\n]{0,60}(?:机理|机制|原理)/;
const PLACEHOLDER_THRESHOLD = /(?:假设|待定|待确认|待给出)(?:门槛|上限|阈值|数值|指标)/;

function isOptimizationQuestion(question) {
  const text = typeof question === 'string' ? question.trim() : '';
  if (!text) return false;
  if (!OPTIMIZE_WORDS.test(text) || !NUMERIC_CONSTRAINT.test(text)) return false;
  if (PLACEHOLDER_THRESHOLD.test(text)) return false;
  // 允许在优化题里附带解释机理，但题目主体不能是机理解释。
  if (EXPLANATION_ASK.test(text) && !/(候选|配比|配方|优化|排序|比较|方案)/.test(text.slice(0, 60))) return false;
  return true;
}

function optimizationComposition(count) {
  const offset = randomInt(OPTIMIZATION_TYPES.length);
  const slots = Array.from({ length: count }, (_, i) => `第${i + 1}题：${OPTIMIZATION_TYPES[(offset + i) % OPTIMIZATION_TYPES.length]}。必须包含可核验的数值约束，并要求候选方案、比较或排序。`).join('\n');
  return `本批题型安排：${slots}。不要生成只解释机理、原理或机制的题目，也不要把文献综述、实验设计或故障诊断作为主题。`;
}

module.exports = { OPTIMIZATION_TYPES, OPTIMIZATION_RULES, isOptimizationQuestion, optimizationComposition };
