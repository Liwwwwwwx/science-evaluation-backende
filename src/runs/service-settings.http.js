const { canManageAccounts } = require('../auth/accounts');
const { TeamServiceError } = require('../errors');

async function handleServiceSettings({ req, res, user, serviceSettings, publicOrigin, readBody, reply }) {
  if (!canManageAccounts(user)) throw new TeamServiceError(403, 'FORBIDDEN', '仅 admin 可管理测评服务');
  if (!serviceSettings) throw new TeamServiceError(503, 'SERVICE_SETTINGS_UNAVAILABLE', '服务配置存储尚未启用');
  if (req.method === 'GET') return reply(res, 200, await serviceSettings.list());
  if (req.method !== 'POST') throw new TeamServiceError(405, 'METHOD_NOT_ALLOWED', '请求方式不支持');
  if (req.headers.origin !== publicOrigin || req.headers['sec-fetch-site'] === 'cross-site') throw new TeamServiceError(403, 'INVALID_ORIGIN', '请求来源无效');
  return reply(res, 200, await serviceSettings.save(await readBody(req, 8192), String(user.id)));
}

module.exports = { handleServiceSettings };
