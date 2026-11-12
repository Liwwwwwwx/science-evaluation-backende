const { readRunArtifact } = require('../runs/artifacts');
const { scoreView } = require('./score-view');

const MAX_IMAGES = 6;
const MAX_IMAGE_BYTES = 4 * 1024 * 1024;
const MAX_TOTAL_BYTES = 12 * 1024 * 1024;
const MAX_CANDIDATES = 100;
const IMAGE_EXT = /\.(?:png|jpe?g|gif|webp|bmp|avif|svg)$/i;

function imageMime(bytes) {
  if (bytes.length >= 8 && bytes.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex'))) return 'image/png';
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg';
  if (bytes.length >= 6 && ['GIF87a', 'GIF89a'].includes(bytes.subarray(0, 6).toString('ascii'))) return 'image/gif';
  if (bytes.length >= 12 && bytes.subarray(0, 4).toString('ascii') === 'RIFF' && bytes.subarray(8, 12).toString('ascii') === 'WEBP') return 'image/webp';
  return null;
}

function markdownImages(text, add) {
  let fence = '';
  for (const line of text.split('\n')) {
    const marker = /^ {0,3}(`{3,}|~{3,})/.exec(line);
    if (fence) {
      if (marker && marker[1][0] === fence[0] && marker[1].length >= fence.length && !line.slice(marker[0].length).trim()) fence = '';
      continue;
    }
    if (marker) { fence = marker[1]; continue; }
    if (/^(?: {4}|\t)/.test(line)) continue;
    const visible = line.replace(/(`+)[^`]*\1/g, '');
    for (const match of visible.matchAll(/!\[[^\]\n]{0,500}\]\(\s*(?:<([^>\n]+)>|([^\s)]+))/g)) add(match[1] || match[2]);
  }
}

function discoverRunImages(job) {
  const details = job.run?.details || {};
  let base;
  try { base = new URL(job.run?.serviceAddress); if (base.protocol === 'ws:') base.protocol = 'http:'; if (base.protocol === 'wss:') base.protocol = 'https:'; } catch { base = undefined; }
  const found = []; const seen = new Set(); let overflow = false;
  function add(value) {
    if (typeof value !== 'string' || !value.trim()) return;
    if (/^data:image\//i.test(value.trim())) {
      const data = value.trim();
      if (seen.has(data)) return;
      seen.add(data);
      if (found.length >= MAX_CANDIDATES) { overflow = true; return; }
      found.push({ id: `image:${found.length + 1}`, inline: data.length <= Math.ceil(MAX_IMAGE_BYTES * 4 / 3) + 100 ? data : null });
      return;
    }
    const raw = value.trim();
    let url;
    if (raw.length <= 8192) try { url = new URL(raw, base); } catch {}
    const address = url && ['http:', 'https:'].includes(url.protocol) ? url.href : null;
    // 识别到图片但地址无效时仍计入覆盖范围，不能误报“未发现图片”。
    const key = address || raw;
    if (seen.has(key)) return;
    seen.add(key);
    if (found.length >= MAX_CANDIDATES) { overflow = true; return; }
    found.push({ id: `image:${found.length + 1}`, ...(address ? { url: address } : {}) });
  }
  for (const file of Array.isArray(details.artifacts) ? details.artifacts : []) {
    if (!file || typeof file !== 'object') continue;
    const url = typeof file.url === 'string' ? file.url : '';
    let path = ''; try { path = new URL(url, base).pathname; } catch {}
    if (IMAGE_EXT.test(path) || IMAGE_EXT.test(String(file.name || '')) || /^image\//i.test(String(file.mime_type || file.contentType || ''))) add(url);
  }
  const display = Array.isArray(details.displayEvents) ? details.displayEvents : [];
  const texts = [String(job.answer || ''), ...display.filter(event => ['display.team_output', 'display.final_answer'].includes(event.type)).map(event => {
    const value = event.phase === 'end' && typeof event.content === 'string' ? event.content : event.delta;
    return typeof value === 'string' ? value : '';
  })];
  for (const text of texts) {
    const view = scoreView(text);
    markdownImages(view.compact, add);
    for (const viewer of view.viewers) {
      if (!['HTML_IMAGE', 'IMAGE_VIEWER', 'MaterialsPNG'].includes(viewer.type)) continue;
      const value = viewer.data?.src || viewer.data?.url || viewer.data?.image_url;
      add(value);
    }
  }
  return { candidates: found, overflow };
}

async function readRunImages(job, discovery, { readArtifact = readRunArtifact, signal } = {}) {
  const candidates = discovery.candidates.slice(0, MAX_IMAGES);
  // 临时替换产物索引，仍由现有代理核验运行来源、任务路径、重定向和文件类型。
  const run = { ...job, run: { ...job.run, details: { ...job.run?.details, artifacts: candidates.map(item => ({ url: item.url || '' })) } } };
  const loaded = await Promise.all(candidates.map(async (item, index) => {
    try {
      if (!item.url) {
        const match = /^data:image\/(?:png|jpeg|gif|webp);base64,([A-Za-z0-9+/]+={0,2})$/i.exec(item.inline || '');
        if (!match) return null;
        const bytes = Buffer.from(match[1], 'base64');
        if (bytes.length > MAX_IMAGE_BYTES || bytes.toString('base64').replace(/=+$/, '') !== match[1].replace(/=+$/, '')) return null;
        const mime = imageMime(bytes);
        return mime ? { id: item.id, bytes, mime } : null;
      }
      const file = await readArtifact(run, index, { maxBytes: MAX_IMAGE_BYTES, signal });
      const mime = imageMime(file.body);
      if (!mime || file.body.length > MAX_IMAGE_BYTES) return null;
      return { id: item.id, bytes: file.body, mime };
    } catch { return null; }
  }));
  const images = []; let total = 0;
  for (const item of loaded) {
    if (!item || total + item.bytes.length > MAX_TOTAL_BYTES) continue;
    total += item.bytes.length;
    images.push({ id: item.id, dataUrl: `data:${item.mime};base64,${item.bytes.toString('base64')}` });
  }
  return images;
}

module.exports = { discoverRunImages, readRunImages, imageMime, MAX_IMAGES, MAX_IMAGE_BYTES, MAX_TOTAL_BYTES };
