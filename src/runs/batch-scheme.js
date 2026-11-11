const { TeamServiceError } = require('../errors');

const SERVICE_KEYS = ['mission-material', 'literature', 'literature-aircraft', 'alloy', 'synthesis', 'new-material', 'alpha-rsi'];
const MAX_CONCURRENCY = 5;
const DEFAULT_SCHEME = Object.freeze({
  pools: { aviation: 50, synthesis: 50 },
  services: {
    'mission-material': { aviation: 10, synthesis: 10 }, literature: { aviation: 25, synthesis: 25 },
    'literature-aircraft': { aviation: 50, synthesis: 0 }, alloy: { aviation: 50, synthesis: 0 },
    synthesis: { aviation: 0, synthesis: 50 }, 'new-material': { aviation: 0, synthesis: 50 },
    'alpha-rsi': { aviation: 50, synthesis: 0 },
  },
  compareAlloyAlpha: true,
  compareSynthesisAlpha: false,
});

function invalid(message) { throw new TeamServiceError(400, 'BATCH_SCHEME_INVALID', message); }
function count(value) { return Number.isInteger(value) && value >= 0 && value <= 100; }
function validateConcurrency(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some(key => !SERVICE_KEYS.includes(key))) invalid('服务并发配置无效');
  const normalized = {};
  for (const key of SERVICE_KEYS) {
    const value = input[key] ?? MAX_CONCURRENCY;
    if (!Number.isInteger(value) || value < 1 || value > MAX_CONCURRENCY) invalid(`服务并发须为1至${MAX_CONCURRENCY}的整数`);
    normalized[key] = value;
  }
  return normalized;
}
function validateScheme(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some(key => !['pools', 'services', 'concurrency', 'compareSynthesisAlpha', 'compareAlloyAlpha'].includes(key))) invalid('方案格式无效');
  const { pools, services } = input;
  const concurrency = input.concurrency === undefined ? undefined : validateConcurrency(input.concurrency);
  if (input.compareSynthesisAlpha !== undefined && typeof input.compareSynthesisAlpha !== 'boolean') invalid('同题对比配置无效');
  if (input.compareAlloyAlpha !== undefined && typeof input.compareAlloyAlpha !== 'boolean') invalid('同题对比配置无效');
  const compareAlloyAlpha = input.compareAlloyAlpha === true;
  const compareSynthesisAlpha = input.compareSynthesisAlpha === true;
  if (compareAlloyAlpha && compareSynthesisAlpha) invalid('不能同时开启两种同题对比');
  if (!pools || typeof pools !== 'object' || Array.isArray(pools) || Object.keys(pools).some(key => !['aviation', 'synthesis'].includes(key)) || !count(pools.aviation) || !count(pools.synthesis) || !pools.aviation && !pools.synthesis) invalid('两类题量应为0至100，且至少生成一道题');
  if (!services || typeof services !== 'object' || Array.isArray(services) || Object.keys(services).some(key => !SERVICE_KEYS.includes(key))) invalid('服务或对比组合无效');
  const normalized = {}; let total = 0;
  for (const key of SERVICE_KEYS) {
    const value = services[key];
    if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(k => !['aviation', 'synthesis'].includes(k)) || !count(value.aviation) || !count(value.synthesis) || value.aviation > pools.aviation || value.synthesis > pools.synthesis) invalid('服务题量不能超过对应题池');
    if (key === 'synthesis' && value.aviation) invalid('合成制备仅支持合成题池');
    normalized[key] = { aviation: value.aviation, synthesis: value.synthesis };
    total += value.aviation + value.synthesis;
  }
  if (!total || total > 320) invalid('每批运行次数须为1至320次');
  if (compareAlloyAlpha) {
    const alloy = normalized.alloy, alpha = normalized['alpha-rsi'];
    if (!alloy.aviation && !alloy.synthesis) invalid('同题对比要求合金材料至少分配一道题');
    if (alpha.aviation !== alloy.aviation || alpha.synthesis !== alloy.synthesis) invalid('同题对比要求1110与合金材料使用相同数量的题目');
  }
  if (compareSynthesisAlpha && (!normalized.synthesis.synthesis || normalized['alpha-rsi'].aviation || normalized['alpha-rsi'].synthesis !== normalized.synthesis.synthesis)) invalid('同题对比要求合成制备与1110使用相同数量的合成题');
  for (const pool of ['aviation', 'synthesis']) if (pools[pool] && !SERVICE_KEYS.some(key => normalized[key][pool])) invalid('每类生成题目都需至少分配给一个服务');
  return { pools: { aviation: pools.aviation, synthesis: pools.synthesis }, services: normalized, compareAlloyAlpha, compareSynthesisAlpha, ...(concurrency === undefined ? {} : { concurrency }) };
}

// 旧配置仍用于历史计划回放；新建批次时可在合金材料有题量的前提下升级为合金对比。
function upgradeComparisonScheme(input) {
  const config = validateScheme(input);
  if (!config.compareSynthesisAlpha) return config;
  if (!config.services.alloy.aviation && !config.services.alloy.synthesis) return config;
  return validateScheme({
    ...config,
    compareSynthesisAlpha: false,
    compareAlloyAlpha: true,
    services: { ...config.services, 'alpha-rsi': { ...config.services.alloy } },
  });
}

module.exports = { DEFAULT_SCHEME, SERVICE_KEYS, MAX_CONCURRENCY, validateConcurrency, validateScheme, upgradeComparisonScheme };
