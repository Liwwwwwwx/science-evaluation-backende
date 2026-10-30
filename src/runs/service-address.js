// 展示/持久化只保留服务入口，不包含认证信息、查询参数或片段。
function publicServiceAddress(value) {
  try {
    const url = new URL(value);
    return ['ws:', 'wss:', 'http:', 'https:'].includes(url.protocol) ? `${url.protocol}//${url.host}${url.pathname}` : null;
  } catch { return null; }
}
module.exports = { publicServiceAddress };
