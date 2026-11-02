const http = require('node:http');
const { handleRuns } = require('./runs/http');
const { handleRules } = require('./scoring/rule-http');
const crypto = require('node:crypto');
const { createQuestionBankGenerationService } = require('./question-bank/generation');

const PATH = '/api/admin/team-services/evaluations/question-bank/generate';
const MAX_BODY = 8192;

function createApp({ token, generator = createQuestionBankGenerationService(), authService, questionBank, evaluations, rules, rulesWriteEnabled = false, runWriteEnabled = false, questionBankWriteEnabled = false, publicOrigin, secureCookies = true } = {}) {
  if (typeof token !== 'string' || Buffer.byteLength(token) < 32) throw new Error('EVALUATION_SERVICE_TOKEN must contain at least 32 bytes');
  if (authService && !publicOrigin) throw new Error('Authentication requires EVALUATION_PUBLIC_ORIGIN');
  const expected = crypto.createHash('sha256').update(token).digest();
  const attempts = new Map();
  function reply(res, status, value) {
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify(value));
  }
  function fail(res, status, code, message) { return reply(res, status, { error: { code, message } }); }
  async function readBody(req, maxBody = MAX_BODY) {
    if (!(req.headers['content-type'] || '').toLowerCase().startsWith('application/json')) throw Object.assign(new Error('Expected JSON'), { status: 415, code: 'INVALID_CONTENT_TYPE' });
    const chunks = []; let size = 0;
    for await (const chunk of req) { size += chunk.length; if (size > maxBody) throw Object.assign(new Error('Request too large'), { status: 413, code: 'REQUEST_TOO_LARGE' }); chunks.push(chunk); }
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
    const url = new URL(req.url, 'http://localhost');
    if (url.pathname === '/api/evaluation/rules' || url.pathname.startsWith('/api/evaluation/rules/')) {
      try {
        if (!authService) return fail(res,503,'AUTH_UNAVAILABLE','登录服务尚未配置');
        const user = await authService.authenticate(session(req));
        return await handleRules({req,res,url,user,rules,writeEnabled:rulesWriteEnabled,publicOrigin,readBody,reply});
      } catch (error) {
        const status = error.code === '42P01' ? 503 : Number.isInteger(error.status) ? error.status : 500;
        return fail(res,status,status === 500 ? 'RULES_FAILED' : error.code || 'REQUEST_FAILED',status === 500 ? '规则服务暂不可用，请稍后重试' : error.code === '42P01' ? '规则存储尚未迁移' : error.message);
      }
    }
    if (url.pathname.startsWith('/api/evaluation/unified/')) {
      try {
        if (!authService) return fail(res, 503, 'AUTH_UNAVAILABLE', '登录服务尚未配置');
        const user = await authService.authenticate(session(req));
        if (req.method === 'GET' && !user.permissions.includes('team-services:read')) return fail(res, 403, 'FORBIDDEN', '没有运行查看权限');
        return await handleRuns({ req, res, url, user, evaluations, runWriteEnabled, publicOrigin, readBody, reply });
      } catch (error) {
        if (res.headersSent) { res.end(); return; }
        const status = Number.isInteger(error.status) && error.status >= 400 && error.status < 600 ? error.status : 500;
        return fail(res, status, status === 500 ? 'EVALUATION_FAILED' : error.code || 'REQUEST_FAILED', status === 500 ? '测评服务暂不可用，请保留幂等键后重试' : error.message);
      }
    }
    if (url.pathname.startsWith('/api/question-bank/')) {
      try {
        if (!authService || !questionBank) return fail(res, 503, 'QUESTION_BANK_UNAVAILABLE', '题库服务尚未配置');
        const action = url.pathname.slice('/api/question-bank/'.length);
        const methods = { access: 'GET', questions: 'GET', import: 'POST', 'random-save': 'POST', generate: 'POST', domain: 'PUT', update: 'PUT', delete: 'DELETE' };
        if (!Object.hasOwn(methods, action) || req.method !== methods[action]) return fail(res, 404, 'NOT_FOUND', 'Not found');
        const user = await authService.authenticate(session(req));
        const write = methods[action] !== 'GET';
        if (action === 'questions' && !user.permissions.includes('team-services:read')) return fail(res, 403, 'FORBIDDEN', '没有题库查看权限');
        if (write && !user.permissions.includes('team-services:write')) return fail(res, 403, 'FORBIDDEN', '没有题库操作权限');
        if (write && (req.headers.origin !== publicOrigin || req.headers['sec-fetch-site'] === 'cross-site')) return fail(res, 403, 'INVALID_ORIGIN', '请求来源无效');
        if (write && action !== 'generate' && !questionBankWriteEnabled) return fail(res, 503, 'QUESTION_BANK_WRITE_DISABLED', '题库写入尚未启用');
        if (action === 'access') return reply(res, 200, { access: { permissions: user.permissions } });
        if (action === 'questions') return reply(res, 200, await questionBank.list(url.searchParams));
        const input = await readBody(req, 256 * 1024);
        if (action === 'generate') return reply(res, 200, await generator.generate(input));
        if (action === 'import') return reply(res, 201, await questionBank.import(input));
        if (action === 'random-save') return reply(res, 200, await questionBank.saveRandom(input));
        if (typeof input.id !== 'string' || !input.id || input.id.length > 200) return fail(res, 400, 'INVALID_INPUT', '题目 ID 无效');
        if (action === 'domain') return reply(res, 200, await questionBank.setDomain(input.id, input));
        return reply(res, 200, action === 'update' ? await questionBank.update(input.id, input) : await questionBank.retire(input.id, input));
      } catch (error) {
        const status = Number.isInteger(error.status) && error.status >= 400 && error.status < 600 ? error.status : 500;
        return fail(res, status, status === 500 ? 'INTERNAL_ERROR' : error.code || 'REQUEST_FAILED', status === 500 ? '题库服务暂不可用' : error.message);
      }
    }
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
