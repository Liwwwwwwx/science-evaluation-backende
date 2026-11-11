const { randomUUID } = require('node:crypto');
const { TeamServiceError } = require('../errors');
const { DEFAULT_SCHEME, validateScheme } = require('./batch-scheme');
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;

async function handleBatchSchemes({ req, res, url, user, schemes, manualBatches, runWriteEnabled, nightlyEnabled, publicOrigin, readBody, reply, concurrencyCaps = null }) {
  if (!user.permissions.includes('team-services:read')) throw new TeamServiceError(403, 'FORBIDDEN', '没有方案查看权限');
  if (!schemes) throw new TeamServiceError(503, 'BATCH_SCHEMES_UNAVAILABLE', '测评方案服务不可用');
  const base = '/api/evaluation/unified/batch-schemes';
  if (url.pathname === base && req.method === 'GET') {
    const canWrite = runWriteEnabled && user.permissions.includes('team-services:write');
    const data = await schemes.list({ userId: String(user.id), admin: user.username === 'admin' });
    const nightly = data.nightly !== undefined ? data.nightly : data.storageReady && typeof schemes.nightly === 'function' ? await schemes.nightly() : null;
    return reply(res, 200, { ...data, nightly: nightly ? { id: nightly.id, name: nightly.name, version: nightly.version } : null, nightlyEnabled: typeof nightlyEnabled === 'boolean' ? nightlyEnabled : null, userId: String(user.id), defaultConfig: DEFAULT_SCHEME, canManage: canWrite, canSetNightly: canWrite && user.username === 'admin', canRun: canWrite, concurrencyCaps });
  }
  if (req.method !== 'POST') throw new TeamServiceError(405, 'METHOD_NOT_ALLOWED', '请求方式不支持');
  if (!user.permissions.includes('team-services:write')) throw new TeamServiceError(403, 'FORBIDDEN', '没有测评执行权限');
  if (req.headers.origin !== publicOrigin || req.headers['sec-fetch-site'] === 'cross-site') throw new TeamServiceError(403, 'INVALID_ORIGIN', '请求来源无效');
  if (!runWriteEnabled) throw new TeamServiceError(503, 'EVALUATION_WRITE_DISABLED', '运行写入尚未启用');
  const input = await readBody(req, 16 * 1024);
  if (url.pathname === `${base}/run`) {
    if (!manualBatches) throw new TeamServiceError(503, 'MANUAL_BATCH_UNAVAILABLE', '手动批次服务不可用');
    return reply(res, 202, await manualBatches.create({ config: input.config, schemeId: input.schemeId || null, schemeVersion: input.schemeVersion ?? null, userId: String(user.id), key: req.headers['idempotency-key'] }));
  }
  if (url.pathname !== base) throw new TeamServiceError(404, 'NOT_FOUND', 'Not found');
  if (input.action === 'remove' || input.action === 'setNightly') {
    if (!UUID.test(input.id || '') || !Number.isInteger(input.version) || input.version < 1) throw new TeamServiceError(400, 'BATCH_SCHEME_INVALID', '方案或版本无效');
    if (input.action === 'setNightly') {
      if (user.username !== 'admin') throw new TeamServiceError(403, 'FORBIDDEN', '仅管理员可设置夜间方案');
      return reply(res, 200, { item: await schemes.setNightly({ id: input.id, version: input.version, userId: String(user.id) }) });
    }
    return reply(res, 200, await schemes.remove({ id: input.id, version: input.version, userId: String(user.id) }));
  }
  const name = typeof input.name === 'string' ? input.name.trim() : '';
  const id = input.id || randomUUID();
  if (!name || name.length > 80 || !UUID.test(id) || !Number.isInteger(input.version) || input.version < 0 || typeof input.isNightly !== 'boolean') throw new TeamServiceError(400, 'BATCH_SCHEME_INVALID', '方案名称、版本或夜间状态无效');
  if (input.isNightly && user.username !== 'admin') throw new TeamServiceError(403, 'FORBIDDEN', '仅管理员可设置夜间方案');
  return reply(res, 200, { item: await schemes.save({ id, name, config: validateScheme(input.config), version: input.version, userId: String(user.id), nightly: input.isNightly }) });
}
module.exports = { handleBatchSchemes };
