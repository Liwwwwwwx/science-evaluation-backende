function normalizeFeishuWebhookUrl(webhookUrl) {
  try {
    const candidate = new URL(String(webhookUrl || '').trim());
    if (candidate.protocol === 'https:' && ['open.feishu.cn', 'open.larksuite.com'].includes(candidate.hostname)
      && candidate.pathname.startsWith('/open-apis/bot/v2/hook/') && !candidate.username && !candidate.password && !candidate.search && !candidate.hash) return candidate.href;
  } catch {}
  return null;
}

// 默认仅接入旧平台的测试机器人；其他通道必须显式传入地址，不做回退。
function createFeishuTestNotifier({ webhookUrl = process.env.MATERIAL_EVAL_DIGEST_BRIEF_WEBHOOK_URL, fetchImpl = globalThis.fetch, timeoutMs = 10000 } = {}) {
  const url = normalizeFeishuWebhookUrl(webhookUrl);
  return {
    configured: Boolean(url),
    async sendText(message) {
      if (!url) return { sent: false, reason: 'not-configured' };
      if (typeof message !== 'string' || !message.trim()) return { sent: false, reason: 'invalid-message' };
      if (typeof fetchImpl !== 'function') return { sent: false, reason: 'fetch-unavailable' };
      try {
        const response = await fetchImpl(url, { method: 'POST', redirect: 'error', signal: AbortSignal.timeout(timeoutMs),
          headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ msg_type: 'text', content: { text: message.trim() } }) });
        if (!response.ok) return { sent: false, reason: 'http-error', status: response.status };
        const data = await response.json();
        return data && (data.code === 0 || data.StatusCode === 0) ? { sent: true } : { sent: false, reason: 'service-error' };
      } catch { return { sent: false, reason: 'request-failed' }; }
    },
  };
}
module.exports = { createFeishuTestNotifier, normalizeFeishuWebhookUrl };
