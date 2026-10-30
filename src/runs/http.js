const { TeamServiceError } = require('../errors');
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
function invalid(message) { throw new TeamServiceError(400, 'INVALID_INPUT', message); }
async function handleRuns({ req, res, url, user, evaluations, runWriteEnabled, publicOrigin, readBody, reply }) {
  const base = '/api/evaluation/unified';
  if (url.pathname === `${base}/services` && req.method === 'GET') {
    return reply(res, 200, { items: [{ key: 'literature', label: '文献检索', enabled: !!evaluations && runWriteEnabled && user.permissions.includes('team-services:write'), scoring: 'absent' }] });
  }
  if (!evaluations) throw new TeamServiceError(503, 'EVALUATION_UNAVAILABLE', '独立运行尚未配置');
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
    const page = Number(url.searchParams.get('page') || 1); const pageSize = Number(url.searchParams.get('pageSize') || 20);
    if ((origin && !['manual', 'automation', 'legacy'].includes(origin)) || !Number.isInteger(page) || page < 1 || page > 100000 || !Number.isInteger(pageSize) || pageSize < 1 || pageSize > 100) invalid('运行列表参数无效');
    return reply(res, 200, await evaluations.list({ origin, page, pageSize }));
  }
  const match = /^\/api\/evaluation\/unified\/runs\/([^/]+)(\/events)?$/.exec(url.pathname);
  if (!match) throw new TeamServiceError(404, 'NOT_FOUND', 'Not found');
  if (req.method !== 'GET') throw new TeamServiceError(405, 'METHOD_NOT_ALLOWED', '请求方式不支持');
  if (!UUID.test(match[1])) invalid('运行 ID 无效');
  if (!match[2]) return reply(res, 200, await evaluations.get(match[1]));
  // 先读取一次，保证不存在/不可读时返回 JSON 错误而不是半条 SSE。
  await evaluations.get(match[1]);
  let unsubscribe = () => {}; let heartbeat; let closed = false; let ready = false; const pending = [];
  const close = () => { if (closed) return; closed = true; clearInterval(heartbeat); unsubscribe(); if (!res.destroyed) res.end(); };
  const send = (event, data) => {
    if (closed) return;
    if (!ready) { pending.push([event, data]); return; }
    if (res.writableLength > 256 * 1024) { close(); return; }
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    if (event === 'done' || event === 'error') close();
  };
  res.on('close', close);
  const observation = await evaluations.observe(match[1], send);
  unsubscribe = observation.unsubscribe;
  if (closed) { unsubscribe(); return; }
  res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-store, no-transform', 'X-Accel-Buffering': 'no' });
  res.flushHeaders(); ready = true;
  send('snapshot', { ...observation.snapshot, live: observation.live });
  for (const [event, data] of pending) send(event, data);
  if (!observation.live) { close(); return; }
  if (!closed) heartbeat = setInterval(() => { if (res.writableLength > 256 * 1024) close(); else res.write(': heartbeat\n\n'); }, 15000);
}
module.exports = { handleRuns };
