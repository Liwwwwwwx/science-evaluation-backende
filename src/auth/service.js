const crypto = require('node:crypto');
const { promisify } = require('node:util');
const argon2 = require('argon2');
const { verifySync } = require('otplib');
const scrypt = promisify(crypto.scrypt);
const hash = value => crypto.createHash('sha256').update(value).digest('hex');
const READ = 'team-services:read';
const WRITE = 'team-services:write';
const allowed = permissions => permissions.includes(READ) || permissions.includes(WRITE);
const failure = (status, code, message) => Object.assign(new Error(message), { status, code });

async function verifyPassword(password, stored) {
  if (typeof stored !== 'string') return false;
  if (stored.startsWith('$argon2')) {
    try { return await argon2.verify(stored, password); } catch { return false; }
  }
  const match = /^([a-f0-9]{32}):([a-f0-9]{128})$/i.exec(stored);
  if (!match) return false;
  const digest = await scrypt(password, match[1], 64);
  return crypto.timingSafeEqual(digest, Buffer.from(match[2], 'hex'));
}
function publicUser(user, permissions) {
  return { id: user.id, username: user.username, name: user.display_name, permissions };
}
function createAuthService(repo) {
  return {
    async login(input) {
      if (!input || typeof input.username !== 'string' || !input.username.trim() || input.username.length > 100 || typeof input.password !== 'string' || !input.password || input.password.length > 100) throw failure(400, 'INVALID_INPUT', '请输入有效的用户名和密码');
      const user = await repo.userByName(input.username.trim().toLowerCase());
      if (!user || !(await verifyPassword(input.password, user.password_hash))) throw failure(401, 'INVALID_CREDENTIALS', '用户名或密码错误');
      const permissions = await repo.permissions(user.id);
      if (!allowed(permissions)) throw failure(403, 'FORBIDDEN', '没有测评平台访问权限');
      if (user.two_factor_enabled) {
        const code = typeof input.totpCode === 'string' ? input.totpCode.trim() : '';
        if (!code) throw failure(401, '2FA_REQUIRED', '请输入双因素验证码');
        let valid = false;
        try { valid = verifySync({ token: code, secret: user.two_factor_secret }).valid === true; } catch {}
        if (!valid) valid = await repo.consumeBackupCode(user.id, hash(code));
        if (!valid) throw failure(401, 'INVALID_2FA_CODE', '双因素验证码错误');
      }
      const token = crypto.randomBytes(32).toString('base64url');
      const maxAge = input.rememberMe === true ? 30 * 86400 : 12 * 3600;
      await repo.createSession(hash(token), user, new Date(Date.now() + maxAge * 1000));
      return { token, maxAge, rememberMe: input.rememberMe === true, user: publicUser(user, permissions) };
    },
    async authenticate(token) {
      if (!token || !/^[A-Za-z0-9_-]{43}$/.test(token)) throw failure(401, 'UNAUTHORIZED', '请先登录');
      const user = await repo.session(hash(token));
      if (!user) throw failure(401, 'UNAUTHORIZED', '登录已失效');
      const permissions = await repo.permissions(user.id);
      if (!allowed(permissions)) throw failure(403, 'FORBIDDEN', '没有测评平台访问权限');
      return publicUser(user, permissions);
    },
    async logout(token) { if (token && /^[A-Za-z0-9_-]{43}$/.test(token)) await repo.deleteSession(hash(token)); },
    async logoutAll(token) { const user = await this.authenticate(token); await repo.deleteUserSessions(user.id); },
  };
}
module.exports = { createAuthService, verifyPassword };
