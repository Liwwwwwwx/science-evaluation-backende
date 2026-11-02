const test = require('node:test');
const assert = require('node:assert/strict');
const { tunnelConfig } = require('../scripts/start');

test('未启用隧道时维持现有启动方式', () => { assert.equal(tunnelConfig({}), null); });
test('隧道仅连接配置的本地端口与独立测评数据库', () => {
  const env = { EVALUATION_DB_TUNNEL_ENABLED: 'true', EVALUATION_DB_TUNNEL_HOST: 'server.example', EVALUATION_DB_TUNNEL_USER: 'worker',
    EVALUATION_DATABASE_URL: 'postgresql://user:pass@127.0.0.1:15433/science_evaluation' };
  assert.deepEqual(tunnelConfig(env), { host: 'server.example', user: 'worker', localPort: 15433, remotePort: 5432, sshPort: 22 });
  for (const changes of [{ EVALUATION_DATABASE_URL: 'postgresql://other:pass@127.0.0.1:15433/science_admin' },
    { EVALUATION_DATABASE_URL: 'postgresql://other:pass@remote:15433/science_evaluation' }, { EVALUATION_DB_TUNNEL_LOCAL_PORT: '99999' }, { EVALUATION_DB_TUNNEL_HOST: '-o' }]) {
    assert.throws(() => tunnelConfig({ ...env, ...changes }));
  }
});
