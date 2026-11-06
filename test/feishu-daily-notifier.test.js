const test = require('node:test');
const assert = require('node:assert/strict');
const { createFeishuDailyNotifier } = require('../src/notifications/feishu-daily');

const officialWebhookUrl = 'https://open.feishu.cn/open-apis/bot/v2/hook/fake-official';
const testWebhookUrl = 'https://open.feishu.cn/open-apis/bot/v2/hook/fake-test';
const ok = () => ({ ok: true, json: async () => ({ code: 0 }) });

test('同一日报并行发送两个机器人，不等待正式通道返回才发送测试通道', async () => {
  const calls = [];
  let release;
  const officialResponse = new Promise(resolve => { release = resolve; });
  const notifier = createFeishuDailyNotifier({ officialWebhookUrl, testWebhookUrl, fetchImpl: async (url, options) => {
    calls.push({ url, options });
    return url === officialWebhookUrl ? officialResponse : ok();
  } });
  const sending = notifier.sendText(' 每日测评总结 ');
  assert.equal(notifier.configured, true);
  assert.deepEqual(calls.map(call => call.url), [officialWebhookUrl, testWebhookUrl]);
  release(ok());
  assert.deepEqual(await sending, { sent: true, deliveries: [{ channel: 'official', sent: true }, { channel: 'test', sent: true }] });
  for (const { options } of calls) {
    assert.deepEqual(JSON.parse(options.body), { msg_type: 'text', content: { text: '每日测评总结' } });
    assert.equal(options.redirect, 'error');
    assert.ok(options.signal instanceof AbortSignal);
  }
});

test('任一路业务、HTTP 或网络失败都尝试另一机器人，结果不泄露地址', async t => {
  for (const channel of ['official', 'test']) {
    for (const reason of ['service-error', 'http-error', 'request-failed']) {
      await t.test(`${channel}: ${reason}`, async () => {
        const calls = [];
        const notifier = createFeishuDailyNotifier({ officialWebhookUrl, testWebhookUrl, fetchImpl: async url => {
          calls.push(url);
          if (url === (channel === 'official' ? officialWebhookUrl : testWebhookUrl)) {
            if (reason === 'request-failed') throw new Error(`private ${url}`);
            if (reason === 'http-error') return { ok: false, status: 429 };
            return { ok: true, json: async () => ({ code: 19021 }) };
          }
          return ok();
        } });
        const result = await notifier.sendText('日报');
        assert.equal(calls.length, 2);
        assert.equal(result.sent, false);
        assert.equal(result.reason, reason);
        assert.equal(result.deliveries.find(delivery => delivery.channel !== channel).sent, true);
        assert.doesNotMatch(JSON.stringify(result), /https:|fake-official|fake-test|private/);
      });
    }
  }
});

test('任一机器人网络结果未知时总体保持未知，不被另一通道确定的失败覆盖', async () => {
  const notifier = createFeishuDailyNotifier({ officialWebhookUrl, testWebhookUrl, fetchImpl: async url => {
    if (url === testWebhookUrl) throw new Error('timeout');
    return { ok: false, status: 503 };
  } });
  assert.equal((await notifier.sendText('日报')).reason, 'request-failed');
});

test('正式与测试地址相同时只发一次，兼容空格及主机名大小写', async () => {
  let calls = 0;
  const notifier = createFeishuDailyNotifier({ officialWebhookUrl, testWebhookUrl: `  ${officialWebhookUrl.replace('open.feishu.cn', 'OPEN.FEISHU.CN')}  `,
    fetchImpl: async () => { calls++; return ok(); } });
  assert.equal((await notifier.sendText('日报')).sent, true);
  assert.equal(calls, 1);
});

test('缺少或无效的地址不回退、不误报双发送成功，仍发送已配置的另一路', async () => {
  for (const missing of ['', 'https://example.com/open-apis/bot/v2/hook/private']) {
    for (const channel of ['official', 'test']) {
      const calls = [];
      const notifier = createFeishuDailyNotifier({
        officialWebhookUrl: channel === 'official' ? missing : officialWebhookUrl,
        testWebhookUrl: channel === 'test' ? missing : testWebhookUrl,
        fetchImpl: async url => { calls.push(url); return ok(); },
      });
      assert.equal(notifier.configured, true);
      const result = await notifier.sendText('日报');
      assert.equal(result.sent, false);
      assert.equal(result.reason, 'not-configured');
      assert.deepEqual(calls, [channel === 'official' ? testWebhookUrl : officialWebhookUrl]);
    }
  }
  const notifier = createFeishuDailyNotifier({ officialWebhookUrl: '', testWebhookUrl: '', fetchImpl: async () => assert.fail('不应发送') });
  assert.equal(notifier.configured, false);
  assert.equal((await notifier.sendText('日报')).reason, 'not-configured');
});
