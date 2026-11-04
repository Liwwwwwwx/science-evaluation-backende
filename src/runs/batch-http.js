const { TeamServiceError } = require('../errors');

const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const STATES = new Set(['preparing', 'dispatching', 'running', 'done', 'partial', 'failed']);
const SOURCES = new Set(['all', 'trial', 'mission']);
const EXECUTIONS = new Set(['completed', 'failed', 'timeout', 'unfinished']);
const STATUSES = new Set(['queued', 'running', 'scoring', 'done', 'error', 'paused']);
const SORTS = new Set(['scoreAsc', 'scoreDesc', 'startedAtAsc', 'startedAtDesc']);

function invalid(message) { throw new TeamServiceError(400, 'INVALID_INPUT', message); }
function validDate(value) { return DATE.test(value) && Number.isFinite(Date.parse(`${value}T00:00:00Z`)) && new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) === value; }
function integer(value, fallback, min, max) {
  if (value === null) return fallback;
  if (!/^\d+$/.test(value)) invalid('分页参数无效');
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < min || number > max) invalid('分页参数无效');
  return number;
}

async function handleBatches({ req, res, url, user, batches, reply }) {
  if (!batches) throw new TeamServiceError(503, 'BATCHES_UNAVAILABLE', '批次读取尚未配置');
  if (!user.permissions.includes('team-services:read')) throw new TeamServiceError(403, 'FORBIDDEN', '没有批次查看权限');
  const base = '/api/evaluation/unified/batches';
  if (url.pathname === base) {
    if (req.method !== 'GET') throw new TeamServiceError(405, 'METHOD_NOT_ALLOWED', '请求方式不支持');
    const source = url.searchParams.get('source') || 'all';
    const state = url.searchParams.get('state') || '';
    const from = url.searchParams.get('from') || '';
    const to = url.searchParams.get('to') || '';
    if (!SOURCES.has(source) || (state && !STATES.has(state)) || (from && !validDate(from)) || (to && !validDate(to)) || (from && to && from > to)) invalid('批次筛选参数无效');
    return reply(res, 200, await batches.list({ source, state, from, to, page: integer(url.searchParams.get('page'), 1, 1, 100000), pageSize: integer(url.searchParams.get('pageSize'), 20, 1, 100) }));
  }
  const match = /^\/api\/evaluation\/unified\/batches\/([^/]+)(\/runs|\/comparison)?$/.exec(url.pathname);
  if (!match) throw new TeamServiceError(404, 'NOT_FOUND', 'Not found');
  if (req.method !== 'GET') throw new TeamServiceError(405, 'METHOD_NOT_ALLOWED', '请求方式不支持');
  if (!UUID.test(match[1])) invalid('批次 ID 无效');
  if (!match[2]) return reply(res, 200, await batches.get(match[1]));
  if (match[2] === '/runs') {
    const serviceKey = (url.searchParams.get('serviceKey') || '').trim();
    const status = (url.searchParams.get('status') || '').trim();
    const execution = (url.searchParams.get('execution') || '').trim();
    const sort = url.searchParams.get('sort') || 'scoreAsc';
    if (serviceKey.length > 64 || (status && !STATUSES.has(status)) || (execution && !EXECUTIONS.has(execution)) || !SORTS.has(sort)) invalid('批次运行筛选参数无效');
    return reply(res, 200, await batches.runs(match[1], { serviceKey, status, execution, sort, page: integer(url.searchParams.get('page'), 1, 1, 100000), pageSize: integer(url.searchParams.get('pageSize'), 20, 1, 100) }));
  }
  const against = url.searchParams.get('against') || 'previous';
  if (against !== 'previous' && !UUID.test(against)) invalid('对比批次 ID 无效');
  return reply(res, 200, await batches.comparison(match[1], { against }));
}

module.exports = { handleBatches };
