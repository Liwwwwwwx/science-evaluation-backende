const { TeamServiceError } = require('../errors');

const SERVICE_KEYS = ['mission-material', 'literature', 'literature-aircraft', 'alloy', 'synthesis', 'new-material', 'alpha-rsi'];
const DEFAULT_SCHEME = Object.freeze({
  pools: { aviation: 50, synthesis: 50 },
  services: {
    'mission-material': { aviation: 10, synthesis: 10 }, literature: { aviation: 25, synthesis: 25 },
    'literature-aircraft': { aviation: 50, synthesis: 0 }, alloy: { aviation: 50, synthesis: 0 },
    synthesis: { aviation: 0, synthesis: 50 }, 'new-material': { aviation: 0, synthesis: 50 },
    'alpha-rsi': { aviation: 0, synthesis: 50 },
  },
  compareSynthesisAlpha: true,
});

function invalid(message) { throw new TeamServiceError(400, 'BATCH_SCHEME_INVALID', message); }
function count(value) { return Number.isInteger(value) && value >= 0 && value <= 100; }
function validateScheme(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some(key => !['pools', 'services', 'compareSynthesisAlpha'].includes(key))) invalid('方案格式无效');
  const { pools, services, compareSynthesisAlpha } = input;
  if (!pools || typeof pools !== 'object' || Array.isArray(pools) || Object.keys(pools).some(key => !['aviation', 'synthesis'].includes(key)) || !count(pools.aviation) || !count(pools.synthesis) || !pools.aviation && !pools.synthesis) invalid('两类题量应为0至100，且至少生成一道题');
  if (!services || typeof services !== 'object' || Array.isArray(services) || Object.keys(services).some(key => !SERVICE_KEYS.includes(key)) || typeof compareSynthesisAlpha !== 'boolean') invalid('服务或对比组合无效');
  const normalized = {}; let total = 0;
  for (const key of SERVICE_KEYS) {
    const value = services[key];
    if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(k => !['aviation', 'synthesis'].includes(k)) || !count(value.aviation) || !count(value.synthesis) || value.aviation > pools.aviation || value.synthesis > pools.synthesis) invalid('服务题量不能超过对应题池');
    if (key === 'synthesis' && value.aviation) invalid('合成制备仅支持合成题池');
    normalized[key] = { aviation: value.aviation, synthesis: value.synthesis };
    total += value.aviation + value.synthesis;
  }
  if (!total || total > 320) invalid('每批运行次数须为1至320次');
  if (compareSynthesisAlpha && (!normalized.synthesis.synthesis || normalized['alpha-rsi'].aviation || normalized['alpha-rsi'].synthesis !== normalized.synthesis.synthesis)) invalid('同题对比要求合成制备与1110使用相同数量的合成题');
  for (const pool of ['aviation', 'synthesis']) if (pools[pool] && !SERVICE_KEYS.some(key => normalized[key][pool])) invalid('每类生成题目都需至少分配给一个服务');
  return { pools: { aviation: pools.aviation, synthesis: pools.synthesis }, services: normalized, compareSynthesisAlpha };
}
module.exports = { DEFAULT_SCHEME, SERVICE_KEYS, validateScheme };
