const net = require('node:net');
const path = require('node:path');
const { spawn } = require('node:child_process');

function port(value, fallback) {
  const number = Number(value || fallback);
  if (!Number.isInteger(number) || number < 1 || number > 65535) throw new Error('数据库隧道端口无效');
  return number;
}
function tunnelConfig(env) {
  if (env.EVALUATION_DB_TUNNEL_ENABLED !== 'true') return null;
  const host = String(env.EVALUATION_DB_TUNNEL_HOST || '').trim();
  const user = String(env.EVALUATION_DB_TUNNEL_USER || '').trim();
  if (!host || !user || host.startsWith('-') || user.startsWith('-')) throw new Error('数据库隧道服务器或用户未配置');
  const localPort = port(env.EVALUATION_DB_TUNNEL_LOCAL_PORT, 15433);
  let db;
  try { db = new URL(env.EVALUATION_DATABASE_URL); } catch { throw new Error('数据库连接未配置'); }
  if (!['127.0.0.1', 'localhost'].includes(db.hostname) || Number(db.port) !== localPort || db.pathname !== '/science_evaluation') throw new Error('数据库连接与本地隧道不匹配');
  return { host, user, localPort, remotePort: port(env.EVALUATION_DB_TUNNEL_REMOTE_PORT, 5432), sshPort: port(env.EVALUATION_DB_TUNNEL_SSH_PORT, 22) };
}
function isOpen(portNumber) {
  return new Promise(resolve => {
    const socket = net.connect({ host: '127.0.0.1', port: portNumber });
    const done = value => { socket.destroy(); resolve(value); };
    socket.setTimeout(500); socket.once('connect', () => done(true)); socket.once('error', () => done(false)); socket.once('timeout', () => done(false));
  });
}
async function main() {
  const config = tunnelConfig(process.env);
  let ssh = null; let backend = null; let stopping = false;
  const stop = () => { if (stopping) return; stopping = true; backend?.kill('SIGTERM'); ssh?.kill('SIGTERM'); };
  process.once('SIGINT', stop); process.once('SIGTERM', stop);
  if (config) {
    if (await isOpen(config.localPort)) throw new Error('数据库隧道本地端口已被占用，未复用未知连接');
    ssh = spawn('ssh', ['-N', '-L', `127.0.0.1:${config.localPort}:127.0.0.1:${config.remotePort}`, '-l', config.user, '-p', String(config.sshPort),
      '-o', 'BatchMode=yes', '-o', 'ExitOnForwardFailure=yes', '-o', 'ServerAliveInterval=30', '-o', 'ServerAliveCountMax=3', config.host], { stdio: 'inherit' });
    ssh.once('error', () => { console.error('数据库隧道启动失败'); stop(); process.exitCode = 1; });
    ssh.once('exit', () => { if (!stopping) { console.error('数据库隧道已断开'); stop(); process.exitCode = 1; } });
    let ready = false;
    for (let i = 0; i < 40 && !stopping; i++) {
      if (await isOpen(config.localPort)) { ready = true; break; }
      await new Promise(resolve => setTimeout(resolve, 200));
    }
    if (!ready || stopping) { stop(); throw new Error('数据库隧道未就绪'); }
  }
  const watch = process.argv.includes('--watch');
  const args = [...(watch ? ['--watch', '--watch-preserve-output'] : []), path.join(__dirname, '../src/server.js')];
  backend = spawn(process.execPath, args, { stdio: 'inherit', env: process.env });
  backend.once('error', () => { console.error('评测后端启动失败'); stop(); process.exitCode = 1; });
  backend.once('exit', code => { if (!stopping && code) process.exitCode = code; stop(); });
}
if (require.main === module) main().catch(error => { console.error(error.message); process.exitCode = 1; });
module.exports = { tunnelConfig };
