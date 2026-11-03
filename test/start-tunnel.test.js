const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
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
test('开发模式监听已加载的源码，退出时关闭后端进程', { timeout: 15000 }, async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'evaluation-watch-'));
  const scripts = path.join(dir, 'scripts'), src = path.join(dir, 'src');
  await fs.mkdir(scripts); await fs.mkdir(src);
  const start = path.join(scripts, 'start.js'), server = path.join(src, 'server.js'), dependency = path.join(src, 'version.js');
  await fs.copyFile(path.join(__dirname, '../scripts/start.js'), start);
  await fs.writeFile(dependency, "module.exports = 'first';\n");
  await fs.writeFile(server, "console.log('READY:' + require('./version') + ':' + process.pid); setInterval(() => {}, 1000);\n");
  const child = spawn(process.execPath, [start, '--watch'], { cwd: dir, env: { PATH: process.env.PATH || '' }, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '', serverPid;
  child.stdout.on('data', chunk => { output += chunk.toString(); });
  child.stderr.on('data', chunk => { output += chunk.toString(); });
  const waitFor = async (predicate, message) => {
    const deadline = Date.now() + 7000;
    while (!predicate()) {
      if (Date.now() > deadline) throw new Error(message);
      await new Promise(resolve => setTimeout(resolve, 50));
    }
  };
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
    if (serverPid) { try { process.kill(serverPid, 'SIGTERM'); } catch {} }
    await Promise.all([start, server, dependency].map(file => fs.unlink(file).catch(() => {})));
    await fs.rmdir(scripts).catch(() => {}); await fs.rmdir(src).catch(() => {}); await fs.rmdir(dir).catch(() => {});
  });
  await waitFor(() => /READY:first:\d+/.test(output), '开发模式未启动');
  await fs.writeFile(dependency, "module.exports = 'second';\n");
  await waitFor(() => /READY:second:\d+/.test(output), '源码变化未触发重新启动');
  serverPid = Number(output.match(/READY:second:(\d+)/)[1]);
  child.kill('SIGTERM');
  await waitFor(() => child.exitCode !== null || child.signalCode !== null, '启动器未退出');
  await waitFor(() => { try { process.kill(serverPid, 0); return false; } catch { return true; } }, '退出后仍有后端进程');
});
