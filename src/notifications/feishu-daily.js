const { createFeishuTestNotifier, normalizeFeishuWebhookUrl } = require('./feishu-test');

function createFeishuDailyNotifier({
  officialWebhookUrl = process.env.FEISHU_WEBHOOK_URL,
  testWebhookUrl = process.env.MATERIAL_EVAL_DIGEST_BRIEF_WEBHOOK_URL,
  fetchImpl = globalThis.fetch,
  timeoutMs = 10000,
} = {}) {
  const seen = new Set();
  const destinations = [];
  for (const [channel, value] of [['official', officialWebhookUrl], ['test', testWebhookUrl]]) {
    const url = normalizeFeishuWebhookUrl(value);
    if (url && seen.has(url)) continue;
    if (url) seen.add(url);
    destinations.push({ channel, notifier: createFeishuTestNotifier({ webhookUrl: url || '', fetchImpl, timeoutMs }) });
  }
  return {
    configured: destinations.some(({ notifier }) => notifier.configured),
    async sendText(message) {
      // 分别尝试两个通道；一路失败或超时，不阻断另一路，也不自动重发。
      const deliveries = await Promise.all(destinations.map(async ({ channel, notifier }) => ({
        channel, ...await notifier.sendText(message),
      })));
      if (deliveries.every(delivery => delivery.sent)) return { sent: true, deliveries };
      const failure = deliveries.find(delivery => delivery.reason === 'request-failed') || deliveries.find(delivery => !delivery.sent);
      return { sent: false, reason: failure.reason, deliveries };
    },
  };
}

module.exports = { createFeishuDailyNotifier };
