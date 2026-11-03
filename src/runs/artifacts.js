const { TeamServiceError } = require('../errors');
const MAX_ARTIFACT_BYTES = 32 * 1024 * 1024;
const CONTENT_TYPES = { avif: 'image/avif', bmp: 'image/bmp', png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', glb: 'model/gltf-binary', gltf: 'model/gltf+json', stl: 'model/stl', pdf: 'application/pdf', csv: 'text/csv; charset=utf-8', tsv: 'text/tab-separated-values; charset=utf-8', json: 'application/json', md: 'text/plain; charset=utf-8', markdown: 'text/plain; charset=utf-8', log: 'text/plain; charset=utf-8', jsonl: 'text/plain; charset=utf-8', py: 'text/plain; charset=utf-8', js: 'text/plain; charset=utf-8', html: 'text/plain; charset=utf-8', jsx: 'text/plain; charset=utf-8', ts: 'text/plain; charset=utf-8', tsx: 'text/plain; charset=utf-8', css: 'text/plain; charset=utf-8', scss: 'text/plain; charset=utf-8', xml: 'text/plain; charset=utf-8', yaml: 'text/plain; charset=utf-8', yml: 'text/plain; charset=utf-8', sh: 'text/plain; charset=utf-8', sql: 'text/plain; charset=utf-8', toml: 'text/plain; charset=utf-8', ini: 'text/plain; charset=utf-8', txt: 'text/plain; charset=utf-8', cif: 'text/plain; charset=utf-8', zip: 'application/zip' };
function fail(status, code, message) { throw new TeamServiceError(status, code, message); }

async function readRunArtifact(run, index, { fetchImpl = fetch } = {}) {
  const files = run.run?.details?.artifacts;
  if (!Number.isInteger(index) || index < 0 || !Array.isArray(files) || !files[index]) fail(404, 'ARTIFACT_NOT_FOUND', '产物不存在');
  const file = files[index]; let url; let service;
  try {
    url = new URL(file.url); service = new URL(run.run.serviceAddress);
    if (service.protocol === 'ws:') service.protocol = 'http:';
    if (service.protocol === 'wss:') service.protocol = 'https:';
  } catch { fail(403, 'ARTIFACT_ORIGIN_INVALID', '无法核验产物来源，请使用原始文件地址'); }
  const taskid = run.nativeRunId || run.run.taskId;
  const entry = service.pathname.replace(/\/start\/?$/, '').replace(/\/$/, '');
  const serviceAsset = url.origin === service.origin && ((typeof taskid === 'string' && url.pathname.startsWith(`${entry}/tasks/${encodeURIComponent(taskid)}/assets/`)) || url.pathname.startsWith('/files/'));
  const publicAsset = url.origin === 'https://www.science42.tech' && url.pathname.startsWith('/alpha/materials/modelfiles/');
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || /%(?:2f|5c|00|25)/i.test(url.pathname) || (!serviceAsset && !publicAsset)) fail(403, 'ARTIFACT_ORIGIN_INVALID', '产物来源不在当前运行允许范围，请使用原始文件地址');
  const filename = url.pathname.split('/').pop() || 'artifact';
  const extension = filename.split('.').pop().toLowerCase(); const contentType = CONTENT_TYPES[extension];
  if (!contentType) fail(415, 'ARTIFACT_TYPE_UNSUPPORTED', '此文件类型请从原始地址下载');
  try {
    const response = await fetchImpl(url, { redirect: 'error', signal: AbortSignal.timeout(15000) });
    if (!response.ok) fail(502, 'ARTIFACT_UPSTREAM_FAILED', '产物读取失败，文件可能已过期');
    if (Number(response.headers.get('content-length')) > MAX_ARTIFACT_BYTES) { await response.body?.cancel(); fail(413, 'ARTIFACT_TOO_LARGE', '产物超过32MiB预览上限，请使用原始地址'); }
    const reader = response.body.getReader(); const chunks = []; let length = 0;
    try {
      while (true) {
        const part = await reader.read(); if (part.done) break;
        length += part.value.length; if (length > MAX_ARTIFACT_BYTES) fail(413, 'ARTIFACT_TOO_LARGE', '产物超过32MiB预览上限，请使用原始地址');
        chunks.push(Buffer.from(part.value));
      }
    } finally { await reader.cancel().catch(() => {}); }
    return { body: Buffer.concat(chunks), contentType, filename };
  } catch (error) {
    if (error instanceof TeamServiceError) throw error;
    fail(502, 'ARTIFACT_UPSTREAM_FAILED', '产物读取失败，请重试或使用原始地址');
  }
}
module.exports = { readRunArtifact, MAX_ARTIFACT_BYTES };
