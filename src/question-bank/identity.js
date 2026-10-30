const crypto = require('node:crypto');

// 题目身份工具：随机题指纹（去重）、固定题/Mission 题的稳定 ID、数据集版本。
// 规范化口径（一期）：NFC、全角转半角、去全部空白、小写；够随机题同题判定用。

function normalizeQuestionText(text) {
  return String(text || '')
    .normalize('NFC')
    .replace(/[\uFF01-\uFF5E]/g, (ch) => String.fromCharCode(ch.charCodeAt(0) - 0xFEE0))
    .replace(/\u3000/g, ' ')
    .replace(/\s+/g, '')
    // 只去句尾标点（生成端常见的「。/./！/？」差异）；句中标点保留——「3.2 ppm」不能变「32 ppm」。
    .replace(/[\u3002\uFF0C\u3001\uFF1B\uFF1A\uFF01\uFF1F.,;:!~\uFF5E]+$/u, '')
    .toLowerCase();
}

function fingerprintOf(text) {
  const normalized = normalizeQuestionText(text);
  if (!normalized) return null;
  return crypto.createHash('sha256').update(normalized, 'utf8').digest('hex').slice(0, 12);
}

function randomQuestionId(serviceKey, fingerprint) {
  return `rnd:${serviceKey}:${fingerprint}`;
}

function fixedQuestionId(serviceKey, caseId) {
  return `${serviceKey}:${caseId}`;
}

function missionQuestionId(caseId) {
  return `mission:${caseId}`;
}

// 固定题数据集版本 = 服务内用例清单的内容哈希：用例一改（题面/期望），版本即升，趋势按版本分段。
function fixedDatasetVersionOf(serviceKey, cases) {
  const material = (Array.isArray(cases) ? cases : [])
    .map((item) => [item.id, item.title, item.question, item.expectation == null ? '' : item.expectation].join('\u0001'))
    .sort()
    .join('\u0002');
  const hash = crypto.createHash('sha256').update(material, 'utf8').digest('hex').slice(0, 12);
  return `fixed-${serviceKey}-${hash}`;
}

// Mission 题数据集版本 = fixture 的内容寻址版本；校验 version 与 sha256 一致，不一致即拒绝导入。
function missionDatasetVersionOf(fixture) {
  const sha256 = String((fixture && fixture.sha256) || '').trim();
  const version = String((fixture && fixture.version) || '').trim();
  if (!sha256 || !version) throw new Error('Mission fixture 缺少 version/sha256，拒绝导入');
  if (!version.includes(sha256.slice(0, 16))) throw new Error('Mission fixture version 与 sha256 不一致，拒绝导入');
  return version;
}

module.exports = {
  normalizeQuestionText,
  fingerprintOf,
  randomQuestionId,
  fixedQuestionId,
  missionQuestionId,
  fixedDatasetVersionOf,
  missionDatasetVersionOf,
};
