const { once } = require('node:events');
const { Worker } = require('node:worker_threads');
const { readRunArtifact, artifactOriginAllowed } = require('../runs/artifacts');
const { readCandidateCount } = require('./candidate-count');

const SUPPORTED = new Set(['pdf', 'csv', 'tsv', 'json', 'jsonl', 'md', 'markdown', 'txt', 'log', 'cif']);
const MAX_FILES = 6;
const MAX_FILE_BYTES = 3 * 1024 * 1024;
const MAX_FILE_CHARS = 16000;
const MAX_TOTAL_CHARS = 48000;
const MAX_PDF_PAGES = 20;
const decoder = new TextDecoder('utf-8', { fatal: true });

function limitText(text, maxChars) {
  const end = /[\uD800-\uDBFF]/.test(text[maxChars - 1]) ? maxChars - 1 : maxChars;
  return text.length <= maxChars ? text : text.slice(0, end);
}

async function pdfText(body, signal) {
  if (!body.subarray(0, 1024).includes(Buffer.from('%PDF-'))) throw Error('PDF 文件头无效');
  const timeout = AbortSignal.timeout(5000);
  const stop = signal ? AbortSignal.any([signal, timeout]) : timeout;
  stop.throwIfAborted();
  const worker = new Worker(require.resolve('./pdf-text-worker'), {
    workerData: { body, maxPages: MAX_PDF_PAGES, maxChars: MAX_FILE_CHARS + 1 },
    env: {},
    resourceLimits: { maxOldGenerationSizeMb: 96, maxYoungGenerationSizeMb: 16 },
  });
  try {
    const [result] = await once(worker, 'message', { signal: stop });
    return result;
  } finally {
    await worker.terminate();
  }
}

async function readScoringAttachments(job, { maxChars = MAX_TOTAL_CHARS, signal, readArtifact = readRunArtifact, redact } = {}) {
  const records = job.run?.details?.artifacts;
  const seen = new Set();
  const candidates = (Array.isArray(records) ? records : []).flatMap((file, index) => {
    let url;
    try { url = new URL(file?.url); } catch { return []; }
    url.hash = '';
    const filename = url.pathname.split('/').pop();
    const type = filename?.split('.').pop()?.toLowerCase();
    if (!SUPPORTED.has(type) || seen.has(url.href)) return [];
    seen.add(url.href);
    return [{ index, id: `attachment:${index + 1}`, filename: redact(filename).slice(0, 200), type, url: url.href, allowed: artifactOriginAllowed(job, url.href) }];
  });
  if (!candidates.length) return { attachments: [], attachmentCoverage: null };

  let budget = Math.max(0, Math.min(maxChars, MAX_TOTAL_CHARS));
  // 来源不合规的记录不占下载名额，仍保留覆盖状态以便排查。
  const readable = new Set(budget ? candidates.filter(file => file.allowed).slice(0, MAX_FILES).map(file => file.id) : []);
  const results = await Promise.all(candidates.map(async ({ index, id, filename, type, url, allowed }) => {
    const file = { id, filename, type };
    if (!allowed) return { ...file, state: 'blocked' };
    if (!readable.has(id)) return { ...file, state: 'limited' };
    try {
      const { body } = await readArtifact(job, index, { signal, maxBytes: MAX_FILE_BYTES });
      let result;
      if (type === 'pdf') result = await pdfText(body, signal);
      else {
        const raw = decoder.decode(body);
        if (raw.includes('\0') || /^\s*(?:<!doctype html\b|<html\b)/i.test(raw)) return { ...file, state: 'unreadable' };
        // JSON 保留数据和层级，同时沿用结构化输出的字段脱敏。
        if (type === 'json') {
          const json = JSON.parse(raw);
          result = { text: JSON.stringify(redact(json)), partial: false, candidateCount: readCandidateCount(job, json, url) };
        } else result = { text: raw, partial: false };
      }
      if (!result.text.trim()) return { ...file, state: 'unreadable' };
      return { ...file, ...result, text: redact(result.text) };
    } catch (error) {
      return { ...file, state: error.code === 'ARTIFACT_TOO_LARGE' ? 'limited' : 'unreadable' };
    }
  }));

  const attachments = [];
  const counts = [];
  const quote = '"pareto_front":[';
  const files = results.map(({ text: raw, partial, candidateCount, ...file }) => {
    if (!raw) return file;
    if (!budget) return { ...file, state: 'limited' };
    const text = limitText(raw, Math.min(budget, MAX_FILE_CHARS));
    if (!text.trim()) return { ...file, state: 'limited' };
    budget -= text.length;
    attachments.push({ id: file.id, text });
    if (candidateCount && text.includes(quote)) counts.push({ ...candidateCount, source: file.id, quote });
    return { ...file, state: partial || text.length < raw.length ? 'partial' : 'included' };
  });
  return { attachments, attachmentCoverage: { files }, ...(counts.length === 1 ? { candidateCount: counts[0] } : {}) };
}

module.exports = { readScoringAttachments };
