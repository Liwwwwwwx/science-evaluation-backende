// 人民币 / 百万 token。单价和估价一起存档，调整价格只影响新调用。
function loadRates(raw) {
  if (!raw) return {};
  const rates = JSON.parse(raw);
  if (!rates || Array.isArray(rates) || typeof rates !== 'object') throw new Error('评委模型价格配置无效');
  for (const rate of Object.values(rates)) {
    if (!rate || ![rate.input, rate.output, rate.cached ?? rate.input].every(n => typeof n === 'number' && Number.isFinite(n) && n >= 0)) {
      throw new Error('评委模型价格需为非负数');
    }
  }
  return rates;
}

function lookupRate(host, model, configuredModel, input, overrides, at) {
  const configured = overrides[host + '/' + model] ?? overrides[host + '/' + configuredModel];
  if (configured) return { input: configured.input, cached: configured.cached ?? configured.input, output: configured.output, basis: 'configured' };
  if (host === 'dashscope.aliyuncs.com' && /^qwen3\.7-flash(?:-2026-07-15)?$/.test(model)) {
    const tier = input <= 32768 ? [0.2, 0.04, 0.8] : input <= 262144 ? [0.6, 0.12, 2.4] : [1.2, 0.24, 4.8];
    return { input: tier[0], cached: tier[1], output: tier[2], basis: 'qwen-beijing-2026-11-20' };
  }
  if (host === 'api.deepseek.com') {
    // 北京时间的周一至周五高峰窗口；节假日及账户优惠以实际账单为准。
    const local = new Date(at.getTime() + 8 * 3600000);
    const hour = local.getUTCHours(), weekday = local.getUTCDay();
    const peak = weekday >= 1 && weekday <= 5 && ((hour >= 9 && hour < 12) || (hour >= 14 && hour < 18));
    const period = peak ? 'peak' : 'off-peak';
    if (/^(deepseek-flash|deepseek-v4-flash(?:-vision-exp)?|deepseek-v4\.1-flash(?:-1017)?|deepseek-chat)$/i.test(model)) {
      return { input: peak ? 2 : 1, cached: peak ? 0.04 : 0.02, output: peak ? 8 : 4, basis: 'deepseek-flash-' + period + '-2026-11-20' };
    }
    if (model === 'deepseek-v4-pro') {
      return { input: peak ? 9 : 4.5, cached: peak ? 0.3 : 0.15, output: peak ? 27 : 13.5, basis: 'deepseek-pro-' + period + '-2026-11-20' };
    }
  }
  return null;
}

function count(value) { return Number.isSafeInteger(value) && value >= 0 ? value : null; }

function measure(usage, host, model, requestedModel, rates, at) {
  const input = count(usage?.prompt_tokens);
  const output = count(usage?.completion_tokens);
  const cached = count(usage?.prompt_cache_hit_tokens ?? usage?.prompt_tokens_details?.cached_tokens);
  const total = count(usage?.total_tokens) ?? (input !== null && output !== null ? input + output : null);
  const rate = input === null ? null : lookupRate(host, model, requestedModel, input, rates, at);
  const cost = rate && output !== null && (cached ?? 0) <= input
    ? (((input - (cached ?? 0)) * rate.input + (cached ?? 0) * rate.cached + output * rate.output) / 1e6).toFixed(10)
    : null;
  return { input, output, cached: cached !== null && input !== null && cached <= input ? cached : null, total, rate, cost };
}

module.exports = { loadRates, measure };
