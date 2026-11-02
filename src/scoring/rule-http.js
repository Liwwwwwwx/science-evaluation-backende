const { TeamServiceError } = require('../errors');
const { builtinRule, ruleDocument } = require('./rules');
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
async function handleRules({req,res,url,user,rules,writeEnabled,publicOrigin,readBody,reply}) {
  if (!user.permissions.includes('team-services:read')) throw new TeamServiceError(403,'FORBIDDEN','没有规则查看权限');
  if (!rules) throw new TeamServiceError(503,'RULES_UNAVAILABLE','规则服务尚未配置');
  const base = '/api/evaluation/rules';
  if (url.pathname === base && req.method === 'GET') {
    const data = await rules.catalog();
    return reply(res,200,{...data,template:builtinRule(),canWrite:writeEnabled && data.storageReady && user.permissions.includes('team-services:write'),document:ruleDocument(data.active)});
  }
  if (req.method !== 'POST') throw new TeamServiceError(405,'METHOD_NOT_ALLOWED','请求方式不支持');
  if (!user.permissions.includes('team-services:write')) throw new TeamServiceError(403,'FORBIDDEN','没有规则维护权限');
  if (req.headers.origin !== publicOrigin || req.headers['sec-fetch-site'] === 'cross-site') throw new TeamServiceError(403,'INVALID_ORIGIN','请求来源无效');
  if (!writeEnabled) throw new TeamServiceError(503,'RULE_WRITE_DISABLED','规则写入尚未启用');
  const key = req.headers['idempotency-key'];
  if (!UUID.test(key || '')) throw new TeamServiceError(400,'INVALID_INPUT','规则操作需要UUID格式的Idempotency-Key');
  const input = await readBody(req,96*1024);
  const actor = String(user.id);
  if (url.pathname === base) return reply(res,201,{item:await rules.create(input,actor,key)});
  const match = /^\/api\/evaluation\/rules\/([^/]+)\/(save|publish|activate|archive)$/.exec(url.pathname);
  if (!match || !UUID.test(match[1])) throw new TeamServiceError(404,'NOT_FOUND','规则操作不存在');
  return reply(res,200,{item:await rules.change(match[1],match[2],input,actor)});
}
module.exports = { handleRules };
