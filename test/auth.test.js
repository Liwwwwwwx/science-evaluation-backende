const { test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const argon2 = require('argon2');
const otp = require('otplib');
const { createAuthService, verifyPassword } = require('../src/auth/service');
const { createApp } = require('../src/app');

test('兼容现有 scrypt 和 argon2 密码', async () => {
  const salt = crypto.randomBytes(16).toString('hex');
  const old = `${salt}:${crypto.scryptSync('password1', salt, 64).toString('hex')}`;
  const modern = await argon2.hash('password1');
  for (const stored of [old, modern]) {
    assert.equal(await verifyPassword('password1', stored), true);
    assert.equal(await verifyPassword('wrong', stored), false);
  }
  assert.equal(await verifyPassword('password1', 'bad'), false);
});

test('登录、二次验证、权限撤销、退出以及来源校验', async t => {
  const secret = otp.generateSecret();
  const user = { id: '1', username: 'alice', display_name: 'Alice', password_hash: await argon2.hash('password1'), token_version: 1, two_factor_enabled: true, two_factor_secret: secret };
  let permissions = ['team-services:read'];
  const sessions = new Map();
  const repo = {
    userByName: async name => name === user.username ? user : null,
    permissions: async () => permissions,
    consumeBackupCode: async () => false,
    createSession: async (key, u) => sessions.set(key, u.token_version),
    session: async key => sessions.get(key) === user.token_version ? user : null,
    deleteSession: async key => sessions.delete(key),
    deleteUserSessions: async () => sessions.clear(),
  };
  const server = createApp({ token: 'x'.repeat(32), authService: createAuthService(repo), publicOrigin: 'http://localhost:4000', secureCookies: false });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  const url = `http://127.0.0.1:${server.address().port}`;
  const login = (body, origin = 'http://localhost:4000') => fetch(url + '/api/auth/login', { method: 'POST', headers: { origin, 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const creds = { username: 'Alice', password: 'password1' };
  assert.equal((await login(creds, 'http://evil.example')).status, 403);
  let response = await login(creds);
  assert.equal(response.status, 401);
  assert.equal((await response.json()).error.code, '2FA_REQUIRED');
  response = await login({ ...creds, totpCode: otp.generateSync({ secret }), rememberMe: true });
  assert.equal(response.status, 200);
  assert.match(response.headers.get('set-cookie'), /HttpOnly; SameSite=Lax; Max-Age=2592000/);
  const cookie = response.headers.get('set-cookie').split(';')[0];
  assert.equal((await fetch(url + '/api/auth/me', { headers: { cookie } })).status, 200);
  permissions = [];
  assert.equal((await fetch(url + '/api/auth/me', { headers: { cookie } })).status, 403);
  permissions = ['team-services:read']; user.token_version++;
  assert.equal((await fetch(url + '/api/auth/me', { headers: { cookie } })).status, 401);
  user.token_version--;
  assert.equal((await fetch(url + '/api/auth/logout', { method: 'POST', headers: { cookie, origin: 'http://localhost:4000' } })).status, 200);
  assert.equal((await fetch(url + '/api/auth/me', { headers: { cookie } })).status, 401);
});

test('错误密码受登录频率限制，未登录用户不能退出所有设备', async t => {
  const service = createAuthService({ userByName: async () => null });
  const server = createApp({ token: 'x'.repeat(32), authService: service, publicOrigin: 'http://localhost:4000', secureCookies: false });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  const url = `http://127.0.0.1:${server.address().port}`;
  const headers = { origin: 'http://localhost:4000', 'content-type': 'application/json' };
  assert.equal((await fetch(url + '/api/auth/logout-all', { method: 'POST', headers })).status, 401);
  for (let i = 0; i < 10; i++) assert.equal((await fetch(url + '/api/auth/login', { method: 'POST', headers, body: JSON.stringify({ username: 'alice', password: 'wrong' }) })).status, 401);
  assert.equal((await fetch(url + '/api/auth/login', { method: 'POST', headers, body: JSON.stringify({ username: 'alice', password: 'wrong' }) })).status, 429);
});
