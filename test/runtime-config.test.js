const test = require('node:test');
const assert = require('node:assert/strict');
const { httpSettings } = require('../src/runtime-config');
test('生产 HTTP 必须显式开启，HTTPS 始终使用 Secure Cookie', () => {
  const env = { NODE_ENV: 'production', EVALUATION_PUBLIC_ORIGIN: 'http://192.0.2.1:6714' };
  assert.throws(() => httpSettings(env));
  assert.equal(httpSettings({ ...env, EVALUATION_ALLOW_HTTP: 'true' }).secureCookies, false);
  assert.equal(httpSettings({ ...env, EVALUATION_ALLOW_HTTP: 'true', EVALUATION_PUBLIC_ORIGIN: 'https://example.com' }).secureCookies, true);
  for (const url of ['http://user:pass@example.com', 'http://example.com/path', 'ftp://example.com', 'http://example.com/']) assert.throws(() => httpSettings({ ...env, EVALUATION_ALLOW_HTTP: 'true', EVALUATION_PUBLIC_ORIGIN: url }));
  assert.equal(httpSettings({ EVALUATION_PUBLIC_ORIGIN: 'http://localhost:6714' }).secureCookies, false);
});
