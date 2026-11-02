const test = require('node:test');
const assert = require('node:assert/strict');
const { createFeishuTestNotifier } = require('../src/notifications/feishu-test');
const url = 'https://open.feishu.cn/open-apis/bot/v2/hook/fake-for-test';

test('仅向显式配置的测试机器人发送飞书文本并检查业务返回', async () => {
  const calls = [];
  const notifier = createFeishuTestNotifier({ webhookUrl: url, fetchImpl: async (...args) => {
    calls.push(args); return { ok: true, async json() { return { code: 0 }; } };
  } });
  assert.equal(notifier.configured, true);
  assert.deepEqual(await notifier.sendText('测试日报'), { sent: true });
  assert.equal(calls.length, 1); assert.equal(calls[0][0], url);
  assert.deepEqual(JSON.parse(calls[0][1].body), { msg_type: 'text', content: { text: '测试日报' } });
  assert.equal(calls[0][1].redirect, 'error');
});

test('未配置、非法地址及飞书业务失败不会被误报发送成功', async () => {
  let calls = 0;
  const fetchImpl = async () => { calls++; return { ok: true, async json() { return { code: 19021 }; } }; };
  for (const webhookUrl of ['', 'https://example.com/open-apis/bot/v2/hook/fake', `${url}?token=secret`]) {
    const notifier = createFeishuTestNotifier({ webhookUrl, fetchImpl });
    assert.equal(notifier.configured, false);
    assert.deepEqual(await notifier.sendText('测试'), { sent: false, reason: 'not-configured' });
  }
  assert.equal(calls, 0);
  assert.deepEqual(await createFeishuTestNotifier({ webhookUrl: url, fetchImpl }).sendText('测试'), { sent: false, reason: 'service-error' });
  assert.equal(calls, 1);
});

test('网络失败和 HTTP 失败不暴露 webhook，也不自动重试', async () => {
  let calls = 0;
  const notifier = createFeishuTestNotifier({ webhookUrl: url, fetchImpl: async () => { calls++; throw new Error(`failed ${url}`); } });
  assert.deepEqual(await notifier.sendText('测试'), { sent: false, reason: 'request-failed' });
  assert.equal(calls, 1);
  const http = createFeishuTestNotifier({ webhookUrl: url, fetchImpl: async () => ({ ok: false, status: 429 }) });
  assert.deepEqual(await http.sendText('测试'), { sent: false, reason: 'http-error', status: 429 });
});
