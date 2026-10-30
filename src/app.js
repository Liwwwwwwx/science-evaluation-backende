const http = require('node:http');
const crypto = require('node:crypto');
const { createQuestionBankGenerationService } = require('./question-bank/generation');

const PATH = '/api/admin/team-services/evaluations/question-bank/generate';
const MAX_BODY = 8192;

function createApp({ token, generator = createQuestionBankGenerationService(), authService, publicOrigin, secureCookies = true } = {}) {
  if (typeof token !== 'string' || Buffer.byteLength(token) < 32) throw new Error('EVALUATION_SERVICE_TOKEN must contain at least 32 bytes');
  if (authService && !publicOrigin) throw new Error('Authentication requires EVALUATION_PUBLIC_ORIGIN');
  const expected = crypto.createHash('sha256').update(token).digest();
  const attempts = new Map();
  function reply(res, status, value) {
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify(value));
  }
  function fail(res, status, code, message) { return reply(res, status, { error: { code, message } }); }
  async function readBody(req) {
    if (!(req.headers['content-type'] || '').toLowerCase().startsWith('application/json')) throw Object.assign(new Error('Expected JSON'), { status: 415, code: 'INVALID_CONTENT_TYPE' });
    const chunks = []; let size = 0;
    for await (const chunk of req) { size += chunk.length; if (size > MAX_BODY) throw Object.assign(new Error('Request too large'), { status: 413, code: 'REQUEST_TOO_LARGE' }); chunks.push(chunk); }
    let input;
    try { input = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { throw Object.assign(new Error('Invalid JSON'), { status: 400, code: 'INVALID_JSON' }); }
    if (!input || typeof input !== 'object' || Array.isArray(input)) throw Object.assign(new Error('Invalid JSON'), { status: 400, code: 'INVALID_JSON' });
    return input;
  }
  function session(req) {
    const values = (req.headers.cookie || '').split(';').map(x => x.trim()).filter(x => x.startsWith('evaluation_session='));
    return values.length === 1 ? values[0].slice('evaluation_session='.length) : '';
  }
  function setCookie(res, value, age) {
    res.setHeader('Set-Cookie', `evaluation_session=${value}; Path=/; HttpOnly; SameSite=Lax${secureCookies ? '; Secure' : ''}${age == null ? '' : `; Max-Age=${age}`}`);
  }
  function rateLimit(key, max) {
    const now = Date.now();
    if (attempts.size > 10000) { for (const [k, v] of attempts) if (v.until <= now) attempts.delete(k); }
    if (attempts.size > 20000 && !attempts.has(key)) return false;
    let entry = attempts.get(key);
    if (!entry || entry.until <= now) { entry = { count: 0, until: now + 15 * 60 * 1000 }; attempts.set(key, entry); }
    entry.count++;
    return entry.count <= max;
  }
  return http.createServer(async (req, res) => {
    if (req.method === 'GET' && req.url === '/health') return reply(res, 200, { ok: true, service: 'science-evaluation' });
    if (authService && ['/api/auth/login', '/api/auth/me', '/api/auth/logout', '/api/auth/logout-all'].includes(req.url)) {
      try {
        if (req.method === 'GET' && req.url === '/api/auth/me') return reply(res, 200, { ok: true, user: await authService.authenticate(session(req)) });
        if (req.method !== 'POST' || req.url === '/api/auth/me') return fail(res, 405, 'METHOD_NOT_ALLOWED', 'Method not allowed');
        if (req.headers.origin !== publicOrigin || req.headers['sec-fetch-site'] === 'cross-site') return fail(res, 403, 'INVALID_ORIGIN', '请求来源无效');
        if (req.url === '/api/auth/logout') { await authService.logout(session(req)); setCookie(res, '', 0); return reply(res, 200, { ok: true }); }
        if (req.url === '/api/auth/logout-all') { await authService.logoutAll(session(req)); setCookie(res, '', 0); return reply(res, 200, { ok: true }); }
        const ip = req.socket.remoteAddress || 'unknown';
        if (!rateLimit(`ip:${ip}`, 30)) return fail(res, 429, 'TOO_MANY_ATTEMPTS', '尝试次数过多，请稍后再试');
        const input = await readBody(req);
        const account = typeof input.username === 'string' ? input.username.trim().toLowerCase().slice(0, 100) : '';
        if (!rateLimit(`account:${account}`, 10)) return fail(res, 429, 'TOO_MANY_ATTEMPTS', '尝试次数过多，请稍后再试');
        const result = await authService.login(input);
        setCookie(res, result.token, result.rememberMe ? result.maxAge : null);
        return reply(res, 200, { ok: true, user: result.user });
      } catch (error) {
        const status = Number.isInteger(error.status) && error.status >= 400 && error.status < 600 ? error.status : 500;
        return fail(res, status, status === 500 ? 'INTERNAL_ERROR' : error.code || 'REQUEST_FAILED', status === 500 ? '认证服务暂不可用' : error.message);
      }
    }
    if (req.method !== 'POST' || req.url !== PATH) return fail(res, 404, 'NOT_FOUND', 'Not found');
    const auth = req.headers.authorization || '';
    const candidate = crypto.createHash('sha256').update(auth.startsWith('Bearer ') ? auth.slice(7) : '').digest();
    if (!crypto.timingSafeEqual(candidate, expected)) return fail(res, 401, 'UNAUTHORIZED', 'Unauthorized');
    if (!(req.headers['content-type'] || '').toLowerCase().startsWith('application/json')) return fail(res, 415, 'INVALID_CONTENT_TYPE', 'Expected JSON');
    try {
      const input = await readBody(req);
      const data = await generator.generate(input);
      return reply(res, 200, data);
    } catch (error) {
      const status = Number.isInteger(error.status) && error.status >= 400 && error.status < 600 ? error.status : 500;
      return fail(res, status, status === 500 ? 'INTERNAL_ERROR' : error.code || 'REQUEST_FAILED', status === 500 ? 'Internal server error' : error.message);
    }
  });
}
module.exports = { createApp };
