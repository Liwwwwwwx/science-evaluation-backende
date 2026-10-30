// 评测链路共用的模型调用（OpenAI 兼容，默认 DeepSeek）：
// - callText：普通文本返回；callJson：要求 JSON 输出（response_format=json_object）并解析。
// - 供「每日结论」与「逐条质量解读」共用，避免继续复制 callDeepSeekModel。
// - 未配置 DEEPSEEK_API_KEY 时 isConfigured() 为 false；调用失败抛错，由调用方决定降级方式。


const DEFAULT_BASE_URL = 'https://api.deepseek.com';
const DEFAULT_MODEL = 'deepseek-chat';
const DEFAULT_TIMEOUT_MS = 120000;

function createEvaluationLlmClient(options = {}) {
  const apiKey = options.apiKey !== undefined ? options.apiKey : process.env.DEEPSEEK_API_KEY || '';
  const baseUrl = String(options.baseUrl || process.env.DEEPSEEK_BASE_URL || DEFAULT_BASE_URL).replace(/\/+$/, '');
  const model = options.model || process.env.DEEPSEEK_MODEL || DEFAULT_MODEL;
  const timeoutMs = Number.isInteger(options.timeoutMs) ? options.timeoutMs : DEFAULT_TIMEOUT_MS;
  const fetchImpl = typeof options.fetch === 'function' ? options.fetch : global.fetch;

  function isConfigured() {
    return Boolean(apiKey) && typeof fetchImpl === 'function';
  }

  async function request(prompt, { temperature, json, maxTokens }) {
    if (!isConfigured()) throw new Error('模型未配置（缺少 DEEPSEEK_API_KEY）');
    const response = await fetchImpl(`${baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model,
        messages: [{ role: 'user', content: prompt }],
        temperature,
        ...(Number.isInteger(maxTokens) && maxTokens > 0 ? { max_tokens: maxTokens } : {}),
        ...(json ? { response_format: { type: 'json_object' } } : {}),
      }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!response.ok) throw new Error(`模型请求失败（HTTP ${response.status}）`);
    const data = await response.json();
    if (data && data.choices && data.choices[0] && data.choices[0].finish_reason === 'length') {
      throw new Error('模型输出达到长度上限，结果被截断');
    }
    return (data && data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content) || '';
  }

  return {
    model,
    isConfigured,
    async callText(prompt, { temperature = 0.3 } = {}) {
      return request(prompt, { temperature, json: false });
    },
    async callJson(prompt, { temperature = 0.2, maxTokens } = {}) {
      const content = await request(prompt, { temperature, json: true, maxTokens });
      return JSON.parse(content);
    },
  };
}

module.exports = {
  DEFAULT_MODEL,
  DEFAULT_TIMEOUT_MS,
  createEvaluationLlmClient,
};
