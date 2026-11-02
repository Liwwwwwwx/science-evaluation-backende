const { TeamServiceError } = require('../errors');
const { readRunArtifact } = require('./artifacts');
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
// 单个结构化结果可达数MB；允许一份完整结果写出，慢连接仍受缓冲上限保护。
const MAX_SSE_BUFFER = 8 * 1024 * 1024;
function invalid(message) { throw new TeamServiceError(400, 'INVALID_INPUT', message); }
async function handleRuns({ req, res, url, user, evaluations, runWriteEnabled, publicOrigin, readBody, reply }) {
  const base = '/api/evaluation/unified';
  if (url.pathname === `${base}/services` && req.method === 'GET') {
    const configured = evaluations?.availableServices() || [];
    const writable = runWriteEnabled && user.permissions.includes('team-services:write');
    return reply(res, 200, { items: [
      { key: 'mission-material', label: 'Mission_ScienceMaterial' },
      { key: 'literature', label: '文献检索' },
      { key: 'literature-aircraft', label: '航空文献' },
      { key: 'alloy', label: '合金材料' },
      { key: 'synthesis', label: '合成制备' },
      { key: 'new-material', label: '新材料' },
    ].map(item => ({ ...item, enabled: writable && configured.includes(item.key), scoring: evaluations?.scoringEnabled ? 'independent' : 'absent' })) });
  }
  if (!evaluations) throw new TeamServiceError(503, 'EVALUATION_UNAVAILABLE', '独立运行尚未配置');
  if (url.pathname === `${base}/mission-daily` && req.method === 'GET') {
    if (!evaluations.missionDailyStatus) throw new TeamServiceError(503, 'MISSION_DAILY_UNAVAILABLE', '每日测评状态尚未配置');
    return reply(res, 200, await evaluations.missionDailyStatus());
  }
  if (url.pathname === `${base}/question-scores` && req.method === 'GET') {
    let items; try { items = JSON.parse(url.searchParams.get('items') || '[]'); } catch { invalid('题目版本参数无效'); }
    return reply(res, 200, await evaluations.questionScores(items));
  }
  const artifact = /^\/api\/evaluation\/unified\/runs\/([^/]+)\/artifacts\/(\d{1,3})$/.exec(url.pathname);
  if (artifact) {
    if (req.method !== 'GET') throw new TeamServiceError(405, 'METHOD_NOT_ALLOWED', '请求方式不支持');
    if (!UUID.test(artifact[1])) invalid('运行 ID 无效');
    const result = await readRunArtifact(await evaluations.get(artifact[1]), Number(artifact[2]));
    res.writeHead(200, { 'Content-Type': result.contentType, 'Content-Length': result.body.length, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Content-Security-Policy': "sandbox; default-src 'none'", 'Content-Disposition': `inline; filename*=UTF-8''${encodeURIComponent(result.filename)}` });
    res.end(result.body); return;
  }
  if (url.pathname === `${base}/runs`) {
    if (req.method === 'POST') {
      if (!user.permissions.includes('team-services:write')) throw new TeamServiceError(403, 'FORBIDDEN', '没有测评执行权限');
      if (req.headers.origin !== publicOrigin || req.headers['sec-fetch-site'] === 'cross-site') throw new TeamServiceError(403, 'INVALID_ORIGIN', '请求来源无效');
      if (!runWriteEnabled) throw new TeamServiceError(503, 'EVALUATION_WRITE_DISABLED', '运行写入尚未启用');
      const input = await readBody(req, 16 * 1024);
      const result = await evaluations.createRun(input, { scope: `evaluation-user:${user.id}`, key: req.headers['idempotency-key'] });
      return reply(res, 201, { runId: result.runId, serviceKey: result.serviceKey, reused: result.reused === true });
    }
    if (req.method !== 'GET') throw new TeamServiceError(405, 'METHOD_NOT_ALLOWED', '请求方式不支持');
    const origin = url.searchParams.get('origin');
    const q = (url.searchParams.get('q') || '').trim();
    const domain = (url.searchParams.get('domain') || '').trim();
    const from = (url.searchParams.get('from') || '').trim();
    const to = (url.searchParams.get('to') || '').trim();
    const page = Number(url.searchParams.get('page') || 1); const pageSize = Number(url.searchParams.get('pageSize') || 20);
    const datePattern = /^\d{4}-\d{2}-\d{2}$/;
    const validDate = value => { if (!datePattern.test(value)) return false; const date = new Date(`${value}T00:00:00Z`); return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value; };
    if ((origin && !['manual', 'automation', 'legacy'].includes(origin)) || q.length > 100 || (domain && domain !== 'unclassified' && !/^[a-z0-9-]{1,64}$/.test(domain)) || (from && !validDate(from)) || (to && !validDate(to)) || (from && to && from > to) || !Number.isInteger(page) || page < 1 || page > 100000 || !Number.isInteger(pageSize) || pageSize < 1 || pageSize > 100) invalid('运行列表参数无效');
    const value = await evaluations.list({ origin, page, pageSize, q, domain, from, to });
    const canRescoreBase = !!(user.permissions.includes('team-services:write') && runWriteEnabled && evaluations.scoringEnabled);
    return reply(res, 200, { ...value, items: value.items.map(item => ({ ...item, canRescore: canRescoreBase && ['done', 'error'].includes(item.status) })) });
  }
  const match = /^\/api\/evaluation\/unified\/runs\/([^/]+)(\/events|\/reply|\/score)?$/.exec(url.pathname);
  if (!match) throw new TeamServiceError(404, 'NOT_FOUND', 'Not found');
  if (!UUID.test(match[1])) invalid('运行 ID 无效');
  const scope = user.permissions.includes('team-services:write') ? `evaluation-user:${user.id}` : null;
  if (['/reply', '/score'].includes(match[2]) && req.method === 'POST') {
    if (!scope) throw new TeamServiceError(403, 'FORBIDDEN', '没有测评执行权限');
    if (req.headers.origin !== publicOrigin || req.headers['sec-fetch-site'] === 'cross-site') throw new TeamServiceError(403, 'INVALID_ORIGIN', '请求来源无效');
    if (!runWriteEnabled) throw new TeamServiceError(503, 'EVALUATION_WRITE_DISABLED', '运行写入尚未启用');
    if (match[2] === '/score') {
      const input = await readBody(req, 1024);
      if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).length) invalid('重评使用已保存答案，请发送空对象');
      return reply(res, 202, await evaluations.rescore(match[1], { scope, key: req.headers['idempotency-key'] }));
    }
    return reply(res, 200, await evaluations.reply(match[1], await readBody(req, 16 * 1024), { scope }));
  }
  if (req.method !== 'GET' || ['/reply','/score'].includes(match[2])) throw new TeamServiceError(405, 'METHOD_NOT_ALLOWED', '请求方式不支持');
  if (!match[2]) {
    const value = await evaluations.get(match[1], { scope });
    const scoring = value.run?.scoring;
    const leased = scoring && !scoring.finishedAt && Date.parse(scoring.expiresAt) > Date.now();
    return reply(res, 200, { ...value, canRescore: !!(scope && runWriteEnabled && evaluations.scoringEnabled && ['done','error'].includes(value.run?.status) && !['running','scoring'].includes(value.status) && !leased) });
  }
  // 先读取一次，保证不存在/不可读时返回 JSON 错误而不是半条 SSE。
  await evaluations.get(match[1]);
  let unsubscribe = () => {}; let heartbeat; let closed = false; let ready = false; const pending = [];
  const close = () => { if (closed) return; closed = true; clearInterval(heartbeat); unsubscribe(); if (!res.destroyed) res.end(); };
  const send = (event, data) => {
    if (closed) return;
    if (!ready) { pending.push([event, data]); return; }
    if (res.writableLength > MAX_SSE_BUFFER) { close(); return; }
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    if (event === 'done' || event === 'error') close();
  };
  res.on('close', close);
  const observation = await evaluations.observe(match[1], send, { scope });
  unsubscribe = observation.unsubscribe;
  if (closed) { unsubscribe(); return; }
  res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-store, no-transform', 'X-Accel-Buffering': 'no' });
  res.flushHeaders(); ready = true;
  send('snapshot', { ...observation.snapshot, live: observation.live });
  for (const [event, data] of pending) send(event, data);
  if (!observation.live) { close(); return; }
  if (!closed) heartbeat = setInterval(() => { if (res.writableLength > MAX_SSE_BUFFER) close(); else res.write(': heartbeat\n\n'); }, 15000);
}
module.exports = { handleRuns };
