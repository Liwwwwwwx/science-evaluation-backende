const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { handleRuns } = require('./runs/http');
const { handleBatches } = require('./runs/batch-http');
const { handleBatchSchemes } = require('./runs/batch-scheme.http');
const { handleRules } = require('./scoring/rule-http');
const { handleDailyReports } = require('./daily-reports/http');
const crypto = require('node:crypto');
const { createQuestionBankGenerationService } = require('./question-bank/generation');
const { createStandardsService } = require('./standards/service');
const { createDirectScoreService } = require('./scoring/direct-score');

const PATH = '/api/admin/team-services/evaluations/question-bank/generate';
const MAX_BODY = 8192;
const OPENAPI_SPEC = path.join(__dirname, '..', 'docs', 'openapi.yaml');
// Swagger 静态资源按白名单只读提供；未列出的文件一律 404，避免目录遍历。
const SWAGGER_ASSETS = new Map([
  ['swagger-ui-bundle.js', 'application/javascript; charset=utf-8'],
  ['swagger-ui.css', 'text/css; charset=utf-8'],
  ['favicon-32x32.png', 'image/png'],
  ['favicon-16x16.png', 'image/png'],
]);
const DOCS_HTML = `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Science 测评后端 API</title>
<link rel="icon" href="/docs/assets/favicon-32x32.png">
<link rel="stylesheet" href="/docs/assets/swagger-ui.css">
</head>
<body>
<div id="swagger-ui"></div>
<script src="/docs/assets/swagger-ui-bundle.js"></script>
<script>
  window.ui = SwaggerUIBundle({
    url: '/openapi.yaml',
    dom_id: '#swagger-ui',
    deepLinking: true,
    docExpansion: 'list',
    tryItOutEnabled: false,
    supportedSubmitMethods: ['get'],
  });
</script>
</body>
</html>`;

function createApp({ token, generator = createQuestionBankGenerationService(), standards = createStandardsService(), directScore = createDirectScoreService(), standardsRepository, authService, accounts, questionBank, evaluations, batches, batchSchemes, manualBatches, rules, dailyReports, reportWriteEnabled = false, rulesWriteEnabled = false, runWriteEnabled = false, questionBankWriteEnabled = false, publicOrigin, secureCookies = true } = {}) {
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
  function sendStatic(res, status, type, body) {
    res.writeHead(status, { 'Content-Type': type, 'Cache-Control': 'no-store' });
    res.end(body);
  }
  const swaggerAssetCache = new Map();
  function readSwaggerAsset(name) {
    if (!swaggerAssetCache.has(name)) swaggerAssetCache.set(name, fs.readFileSync(require.resolve(`swagger-ui-dist/${name}`)));
    return swaggerAssetCache.get(name);
  }
  return http.createServer(async (req, res) => {
    if (req.method === 'GET' && req.url === '/health') return reply(res, 200, { ok: true, service: 'science-evaluation' });
    // 接口文档预览是纯静态页面，不涉及数据与凭据，与 /health 一样免登录。
    if (req.method === 'GET' && (req.url === '/docs' || req.url === '/openapi.yaml' || req.url.startsWith('/docs/assets/'))) {
      try {
        if (req.url === '/docs') return sendStatic(res, 200, 'text/html; charset=utf-8', DOCS_HTML);
        if (req.url === '/openapi.yaml') return sendStatic(res, 200, 'text/yaml; charset=utf-8', fs.readFileSync(OPENAPI_SPEC));
        const name = decodeURIComponent(req.url.slice('/docs/assets/'.length));
        const type = SWAGGER_ASSETS.get(name);
        if (!type) return fail(res, 404, 'NOT_FOUND', 'Not found');
        return sendStatic(res, 200, type, readSwaggerAsset(name));
      } catch {
        return fail(res, 500, 'DOCS_UNAVAILABLE', '接口文档暂不可用');
      }
    }
    const url = new URL(req.url, 'http://localhost');
    const accountPath = /^\/api\/evaluation\/accounts\/([^/]+)(\/reset-password)?$/.exec(url.pathname);
    if (url.pathname === '/api/evaluation/accounts' || accountPath) {
      try {
        const allowed = accountPath ? (accountPath[2] ? ['POST'] : ['PATCH', 'DELETE']) : ['GET', 'POST'];
        if (!allowed.includes(req.method)) return fail(res, 405, 'METHOD_NOT_ALLOWED', '请求方式不支持');
        if (!authService || !accounts) return fail(res, 503, 'ACCOUNTS_UNAVAILABLE', '账号管理暂不可用');
        const user = await authService.authenticate(session(req));
        if (req.method === 'GET') return reply(res, 200, await accounts.list(user, { ...(url.searchParams.has('page') ? { page: url.searchParams.get('page') } : {}), ...(url.searchParams.has('pageSize') ? { pageSize: url.searchParams.get('pageSize') } : {}), ...(url.searchParams.has('search') ? { search: url.searchParams.get('search') } : {}) }));
        if (req.headers.origin !== publicOrigin || req.headers['sec-fetch-site'] === 'cross-site') return fail(res, 403, 'INVALID_ORIGIN', '请求来源无效');
        if (!rateLimit(`account-write:${user.id}`, 30)) return fail(res, 429, 'TOO_MANY_ATTEMPTS', '账号操作请求过多，请稍后再试');
        if (!accountPath) return reply(res, 201, await accounts.create(user, await readBody(req, 4096)));
        let id;
        try { id = decodeURIComponent(accountPath[1]); } catch { return fail(res, 400, 'INVALID_ACCOUNT_ID', '用户标识无效'); }
        if (accountPath[2]) return reply(res, 200, await accounts.resetPassword(user, id, await readBody(req, 4096)));
        if (req.method === 'PATCH') return reply(res, 200, await accounts.update(user, id, await readBody(req, 4096)));
        return reply(res, 200, await accounts.remove(user, id));
      } catch (error) {
        const status = Number.isInteger(error.status) && error.status >= 400 && error.status < 600 ? error.status : 500;
        return fail(res, status, status === 500 ? 'ACCOUNTS_FAILED' : error.code || 'REQUEST_FAILED', status === 500 ? '账号管理暂不可用，请稍后重试' : error.message);
      }
    }
    if (url.pathname === '/api/evaluation/direct-score') {
      try {
        if (req.method !== 'POST') return fail(res, 405, 'METHOD_NOT_ALLOWED', '请求方式不支持');
        if (!directScore) return fail(res, 503, 'DIRECT_SCORE_UNAVAILABLE', '直接评分尚未配置');
        // 与标准生成一致的双模式鉴权：受信服务端用 Bearer 服务令牌直连；浏览器走登录会话与同源校验，不得使用令牌。
        const bearer = req.headers.authorization || '';
        const candidate = crypto.createHash('sha256').update(bearer.startsWith('Bearer ') ? bearer.slice(7) : '').digest();
        const viaToken = crypto.timingSafeEqual(candidate, expected);
        let user = null;
        if (!viaToken) {
          if (!authService) return fail(res, 503, 'AUTH_UNAVAILABLE', '登录服务尚未配置');
          user = await authService.authenticate(session(req));
          if (!user.permissions.includes('team-services:write')) return fail(res, 403, 'FORBIDDEN', '没有评分权限');
          if (req.headers.origin !== publicOrigin || req.headers['sec-fetch-site'] === 'cross-site') return fail(res, 403, 'INVALID_ORIGIN', '请求来源无效');
        }
        const input = await readBody(req, 384 * 1024);
        let standard;
        if (input.standard?.type === 'text') standard = input.standard.text;
        else if (input.standard?.type === 'saved') {
          if (user && !user.permissions.includes('team-services:read')) return fail(res, 403, 'FORBIDDEN', '没有题库查看权限');
          if (!standardsRepository || !questionBank) return fail(res, 503, 'STANDARDS_UNAVAILABLE', '标准存储尚未配置');
          const { questionId, datasetVersion, id } = input.standard;
          if (typeof id !== 'string' || !/^[a-f\d]{8}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{12}$/i.test(id)) return fail(res, 400, 'INVALID_STANDARD', '请选择有效的评分标准');
          const question = await questionBank.get(questionId, datasetVersion);
          if (question.status !== 'active' || typeof input.question !== 'string' || question.question.trim() !== input.question.trim()) return fail(res, 409, 'QUESTION_CHANGED', '题目已变化或停用，请重新选择');
          const saved = await standardsRepository.list(questionId, datasetVersion);
          const selected = saved.items.find(item => item.id === id && item.question.trim() === question.question.trim());
          if (!selected) return fail(res, 404, 'STANDARD_NOT_FOUND', '该题目版本下没有找到所选标准');
          standard = JSON.stringify(selected.content);
        } else return fail(res, 400, 'INVALID_STANDARD', '请选择或输入评分标准');
        const caller = viaToken ? 'service-token' : `user:${user.id}`;
        if (!rateLimit(`direct-score:${caller}`, 20)) return fail(res, 429, 'DIRECT_SCORE_RATE_LIMITED', '直接评分次数过多，请 15 分钟后再试');
        return reply(res, 200, await directScore.score({ question: input.question, answer: input.answer, standard }));
      } catch (error) {
        if (error.code === '42P01') return fail(res, 503, 'STANDARDS_STORAGE_UNAVAILABLE', '标准存储尚未迁移');
        const status = Number.isInteger(error.status) && error.status >= 400 && error.status < 600 ? error.status : 500;
        return fail(res, status, status === 500 ? 'DIRECT_SCORE_FAILED' : error.code || 'REQUEST_FAILED', status === 500 ? '直接评分暂不可用，请稍后重试' : error.message);
      }
    }
    if (url.pathname === '/api/evaluation/question-standards' || /^\/api\/evaluation\/question-standards\/[^/]+\/confirm$/.test(url.pathname)) {
      try {
        if (!authService || !standardsRepository) return fail(res,503,'STANDARDS_UNAVAILABLE','标准存储尚未配置');
        const user=await authService.authenticate(session(req));
        if (req.method==='GET' && url.pathname.endsWith('question-standards')) {
          if (!user.permissions.includes('team-services:read')) return fail(res,403,'FORBIDDEN','没有题库查看权限');
          return reply(res,200,await standardsRepository.list(url.searchParams.get('questionId'),url.searchParams.get('datasetVersion')));
        }
        if (req.method!=='POST') return fail(res,405,'METHOD_NOT_ALLOWED','请求方式不支持');
        if (!user.permissions.includes('team-services:write')) return fail(res,403,'FORBIDDEN','没有标准管理权限');
        if (req.headers.origin!==publicOrigin || req.headers['sec-fetch-site']==='cross-site') return fail(res,403,'INVALID_ORIGIN','请求来源无效');
        if (!questionBankWriteEnabled) return fail(res,503,'STANDARDS_WRITE_DISABLED','标准保存尚未启用');
        const input=await readBody(req,128*1024);
        const match=/^\/api\/evaluation\/question-standards\/([^/]+)\/confirm$/.exec(url.pathname);
        return reply(res,200,match ? await standardsRepository.confirm(match[1],user.id) : await standardsRepository.save(input,user.id));
      } catch(error) {
        if (error.code==='42P01') return fail(res,503,'STANDARDS_STORAGE_UNAVAILABLE','标准存储尚未迁移');
        const code=Number.isInteger(error.status) ? error.status : 500;
        return fail(res,code,code===500?'STANDARDS_FAILED':error.code || 'REQUEST_FAILED',code===500?'标准存储暂不可用':error.message);
      }
    }
    if (url.pathname === '/api/evaluation/standards') {
      try {
        if (req.method !== 'POST') return fail(res, 405, 'METHOD_NOT_ALLOWED', '请求方式不支持');
        const auth = req.headers.authorization || '';
        const candidate = crypto.createHash('sha256').update(auth.startsWith('Bearer ') ? auth.slice(7) : '').digest();
        if (!crypto.timingSafeEqual(candidate, expected)) {
          if (!authService) return fail(res, 503, 'AUTH_UNAVAILABLE', '登录服务尚未配置');
          const user = await authService.authenticate(session(req));
          if (!user.permissions.includes('team-services:write')) return fail(res, 403, 'FORBIDDEN', '没有生成标准的权限');
          if (req.headers.origin !== publicOrigin || req.headers['sec-fetch-site'] === 'cross-site') return fail(res, 403, 'INVALID_ORIGIN', '请求来源无效');
        }
        return reply(res, 200, await standards.generate(await readBody(req, 32 * 1024)));
      } catch (error) {
        const status = Number.isInteger(error.status) && error.status >= 400 && error.status < 600 ? error.status : 500;
        return fail(res, status, status === 500 ? 'STANDARDS_FAILED' : error.code || 'REQUEST_FAILED', status === 500 ? '标准生成服务暂不可用' : error.message);
      }
    }
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
        if (url.pathname === '/api/evaluation/unified/batch-schemes' || url.pathname.startsWith('/api/evaluation/unified/batch-schemes/')) return await handleBatchSchemes({ req, res, url, user, schemes: batchSchemes, manualBatches, runWriteEnabled, publicOrigin, readBody, reply });
        if (url.pathname === '/api/evaluation/unified/batches' || url.pathname.startsWith('/api/evaluation/unified/batches/')) return await handleBatches({ req, res, url, user, batches, reply });
        if (url.pathname.startsWith('/api/evaluation/unified/daily-reports')) return await handleDailyReports({req,res,url,user,reports:dailyReports,writeEnabled:reportWriteEnabled,publicOrigin,readBody,reply});
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
        const methods = { access: 'GET', questions: 'GET', question: 'GET', import: 'POST', 'random-save': 'POST', generate: 'POST', domain: 'PUT', update: 'PUT', delete: 'DELETE' };
        if (!Object.hasOwn(methods, action) || req.method !== methods[action]) return fail(res, 404, 'NOT_FOUND', 'Not found');
        const user = await authService.authenticate(session(req));
        const write = methods[action] !== 'GET';
        if (['questions', 'question'].includes(action) && !user.permissions.includes('team-services:read')) return fail(res, 403, 'FORBIDDEN', '没有题库查看权限');
        if (write && !user.permissions.includes('team-services:write')) return fail(res, 403, 'FORBIDDEN', '没有题库操作权限');
        if (write && (req.headers.origin !== publicOrigin || req.headers['sec-fetch-site'] === 'cross-site')) return fail(res, 403, 'INVALID_ORIGIN', '请求来源无效');
        if (write && action !== 'generate' && !questionBankWriteEnabled) return fail(res, 503, 'QUESTION_BANK_WRITE_DISABLED', '题库写入尚未启用');
        if (action === 'access') return reply(res, 200, { access: { permissions: user.permissions } });
        if (action === 'questions') return reply(res, 200, await questionBank.list(url.searchParams));
        if (action === 'question') return reply(res, 200, { question: await questionBank.get(url.searchParams.get('id'), url.searchParams.get('datasetVersion')) });
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
