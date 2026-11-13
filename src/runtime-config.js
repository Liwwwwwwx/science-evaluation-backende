function automationEnabled(env = process.env) {
  if (env.EVALUATION_AUTOMATION_ENABLED === 'true') return true;
  if (env.EVALUATION_AUTOMATION_ENABLED === 'false') return false;
  return !['development', 'test'].includes(env.NODE_ENV);
}

function timeoutRecoveryEnabled(env = process.env) {
  return env.EVALUATION_RUN_WRITE_ENABLED === 'true' && env.EVALUATION_TIMEOUT_RECOVERY_ENABLED !== 'false';
}

function httpSettings(env = process.env) {
  const publicOrigin = env.EVALUATION_PUBLIC_ORIGIN;
  if (!publicOrigin) throw new Error('EVALUATION_PUBLIC_ORIGIN is required when authentication is enabled');
  const origin = new URL(publicOrigin);
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(origin.hostname);
  const allowHttp = env.EVALUATION_ALLOW_HTTP === 'true';
  if (origin.origin !== publicOrigin || (origin.protocol !== 'https:' && !(origin.protocol === 'http:' && (allowHttp || (env.NODE_ENV !== 'production' && local))))) throw new Error('EVALUATION_PUBLIC_ORIGIN must be HTTPS unless HTTP is explicitly enabled');
  return { publicOrigin, secureCookies: origin.protocol === 'https:' || (env.NODE_ENV === 'production' && !allowHttp) };
}

// Mission 综合题可能远超 15 分钟（文献团队、网页检索、文件生成与图片核验）；默认放宽到 60 分钟。
function missionTimeoutMs(env = process.env) {
  if (env.EVALUATION_MISSION_TIMEOUT_MS == null || env.EVALUATION_MISSION_TIMEOUT_MS === '') return 60 * 60 * 1000;
  const value = Number(env.EVALUATION_MISSION_TIMEOUT_MS);
  if (!Number.isInteger(value) || value < 60 * 1000 || value > 24 * 60 * 60 * 1000) throw new Error('EVALUATION_MISSION_TIMEOUT_MS must be an integer between 60000 and 86400000 milliseconds');
  return value;
}
module.exports = { automationEnabled, timeoutRecoveryEnabled, httpSettings, missionTimeoutMs };
