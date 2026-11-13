const test = require('node:test');
const assert = require('node:assert/strict');
const { automationEnabled, timeoutRecoveryEnabled, httpSettings, missionTimeoutMs } = require('../src/runtime-config');

test('自动化默认只在非开发环境启用，显式开关优先', () => {
  assert.equal(automationEnabled({ NODE_ENV: 'development' }), false);
  assert.equal(automationEnabled({ NODE_ENV: 'test' }), false);
  assert.equal(automationEnabled({}), true);
  assert.equal(automationEnabled({ NODE_ENV: 'production' }), true);
  assert.equal(automationEnabled({ NODE_ENV: 'production', EVALUATION_AUTOMATION_ENABLED: 'false' }), false);
  assert.equal(automationEnabled({ NODE_ENV: 'development', EVALUATION_AUTOMATION_ENABLED: 'true' }), true);
});
test('运行写入开启时默认恢复超时记录，本地可单独关闭', () => {
  assert.equal(timeoutRecoveryEnabled({}), false);
  assert.equal(timeoutRecoveryEnabled({ EVALUATION_RUN_WRITE_ENABLED: 'true' }), true);
  assert.equal(timeoutRecoveryEnabled({ EVALUATION_RUN_WRITE_ENABLED: 'true', EVALUATION_TIMEOUT_RECOVERY_ENABLED: 'false' }), false);
  assert.equal(timeoutRecoveryEnabled({ EVALUATION_RUN_WRITE_ENABLED: 'false', EVALUATION_TIMEOUT_RECOVERY_ENABLED: 'true' }), false);
});
test('生产 HTTP 必须显式开启，HTTPS 始终使用 Secure Cookie', () => {
  const env = { NODE_ENV: 'production', EVALUATION_PUBLIC_ORIGIN: 'http://192.0.2.1:6714' };
  assert.throws(() => httpSettings(env));
  assert.equal(httpSettings({ ...env, EVALUATION_ALLOW_HTTP: 'true' }).secureCookies, false);
  assert.equal(httpSettings({ ...env, EVALUATION_ALLOW_HTTP: 'true', EVALUATION_PUBLIC_ORIGIN: 'https://example.com' }).secureCookies, true);
  for (const url of ['http://user:pass@example.com', 'http://example.com/path', 'ftp://example.com', 'http://example.com/']) assert.throws(() => httpSettings({ ...env, EVALUATION_ALLOW_HTTP: 'true', EVALUATION_PUBLIC_ORIGIN: url }));
  assert.equal(httpSettings({ EVALUATION_PUBLIC_ORIGIN: 'http://localhost:6714' }).secureCookies, false);
});
test('Mission 执行超时默认 60 分钟，仅接受 1 分钟至 24 小时的整数毫秒', () => {
  assert.equal(missionTimeoutMs({}), 60 * 60 * 1000);
  assert.equal(missionTimeoutMs({ EVALUATION_MISSION_TIMEOUT_MS: '' }), 60 * 60 * 1000);
  assert.equal(missionTimeoutMs({ EVALUATION_MISSION_TIMEOUT_MS: '900000' }), 900000);
  assert.equal(missionTimeoutMs({ EVALUATION_MISSION_TIMEOUT_MS: '86400000' }), 86400000);
  for (const value of ['59999', '86400001', '900000.5', 'abc', '-1']) assert.throws(() => missionTimeoutMs({ EVALUATION_MISSION_TIMEOUT_MS: value }), /EVALUATION_MISSION_TIMEOUT_MS/);
});
