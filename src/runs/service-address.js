// 展示/持久化只保留服务入口，不包含认证信息、查询参数或片段。
function publicServiceAddress(value) {
  try {
    const url = new URL(value);
    return ['ws:', 'wss:', 'http:', 'https:'].includes(url.protocol) ? `${url.protocol}//${url.host}${url.pathname}` : null;
  } catch { return null; }
}
function taskDirectoryPath(pathname, serviceKey) {
  if (serviceKey === 'new-material-rsi' && /^\/start\/?$/.test(pathname)) return '/new-material/tasks';
  return `${pathname.replace(/\/start\/?$/, '').replace(/\/$/, '')}/tasks`;
}
module.exports = { publicServiceAddress, taskDirectoryPath };
