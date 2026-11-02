function automationEnabled(env = process.env) {
  if (env.EVALUATION_AUTOMATION_ENABLED === 'true') return true;
  if (env.EVALUATION_AUTOMATION_ENABLED === 'false') return false;
  return !['development', 'test'].includes(env.NODE_ENV);
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
module.exports = { automationEnabled, httpSettings };
