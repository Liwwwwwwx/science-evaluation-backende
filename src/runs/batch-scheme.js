const { TeamServiceError } = require('../errors');

// 旧服务键仍用于读取历史快照；新批次只执行当前服务。
const SERVICE_KEYS = ['mission-material', 'literature', 'literature-aircraft', 'alloy', 'synthesis', 'new-material', 'alpha-rsi', 'alpha-combined-rsi'];
const INACTIVE_SERVICE_KEYS = ['alloy', 'synthesis', 'new-material'];
const MAX_CONCURRENCY = 5;
// 新方案只按服务分配题数；旧方案的航空/合成两池在读取时合并为服务题数。
const DEFAULT_SCHEME = Object.freeze({
  services: {
    'mission-material': 20, literature: 50, 'literature-aircraft': 50, alloy: 0,
    synthesis: 0, 'new-material': 0, 'alpha-rsi': 50, 'alpha-combined-rsi': 50,
  },
  compareAlloyAlpha: false,
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

function legacyCounts(input) {
  if (!input || typeof input !== 'object' || !input.services || typeof input.services !== 'object') return null;
  const values = Object.values(input.services);
  return input.pools != null || values.some(value => value && typeof value === 'object');
}

function normalizeLegacy(input) {
  if (!legacyCounts(input)) return input;
  const { pools, ...rest } = input;
  const services = {};
  for (const key of SERVICE_KEYS) {
    const value = input.services[key];
    services[key] = value && typeof value === 'object'
      ? (Number(value.aviation) || 0) + (Number(value.synthesis) || 0)
      : value;
  }
  return { ...rest, services };
}

function validateScheme(input) {
  const source = normalizeLegacy(input);
  if (!source || typeof source !== 'object' || Array.isArray(source) || Object.keys(source).some(key => !['services', 'concurrency', 'compareSynthesisAlpha', 'compareAlloyAlpha'].includes(key))) invalid('方案格式无效');
  const { services } = source;
  const concurrency = source.concurrency === undefined ? undefined : validateConcurrency(source.concurrency);
  if (source.compareSynthesisAlpha !== undefined && typeof source.compareSynthesisAlpha !== 'boolean') invalid('同题对比配置无效');
  if (source.compareAlloyAlpha !== undefined && typeof source.compareAlloyAlpha !== 'boolean') invalid('同题对比配置无效');
  const compareAlloyAlpha = source.compareAlloyAlpha === true;
  const compareSynthesisAlpha = source.compareSynthesisAlpha === true;
  if (compareAlloyAlpha && compareSynthesisAlpha) invalid('不能同时开启两种同题对比');
  if (!services || typeof services !== 'object' || Array.isArray(services) || Object.keys(services).some(key => !SERVICE_KEYS.includes(key))) invalid('服务或对比组合无效');
  const normalized = {}; let total = 0;
  for (const key of SERVICE_KEYS) {
    const value = services[key] ?? 0;
    if (!count(value)) invalid('服务题量须为0至100的整数');
    normalized[key] = value; total += value;
  }
  if (!total || total > 320) invalid('每批运行次数须为1至320次');
  if (compareAlloyAlpha) {
    if (!normalized.alloy) invalid('同题对比要求合金材料至少分配一道题');
    if (normalized['alpha-rsi'] !== normalized.alloy) invalid('同题对比要求1110与合金材料使用相同数量的题目');
  }
  if (compareSynthesisAlpha && (!normalized.synthesis || normalized['alpha-rsi'] !== normalized.synthesis)) invalid('同题对比要求合成制备与1110使用相同数量的题目');
  return { services: normalized, compareAlloyAlpha, compareSynthesisAlpha, ...(concurrency === undefined ? {} : { concurrency }) };
}

// 只投影新批次使用的配置，不修改数据库中的旧配置或已生成的批次快照。
function upgradeComparisonScheme(input, { allowEmpty = false } = {}) {
  const config = validateScheme(input);
  const services = { ...config.services };
  for (const key of INACTIVE_SERVICE_KEYS) services[key] = 0;
  const concurrency = config.concurrency && { ...config.concurrency };
  if (concurrency) for (const key of INACTIVE_SERVICE_KEYS) concurrency[key] = MAX_CONCURRENCY;
  const current = {
    ...config,
    services,
    compareSynthesisAlpha: false,
    compareAlloyAlpha: false,
    ...(concurrency ? { concurrency } : {}),
  };
  if (allowEmpty && !Object.values(services).some(Boolean)) return current;
  return validateScheme(current);
}

module.exports = { DEFAULT_SCHEME, SERVICE_KEYS, INACTIVE_SERVICE_KEYS, MAX_CONCURRENCY, validateConcurrency, validateScheme, upgradeComparisonScheme };
