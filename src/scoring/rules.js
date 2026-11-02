const crypto = require('node:crypto');
const { TeamServiceError } = require('../errors');
const DIMENSIONS = { readability: '可读性', professionalism: '专业性', visualAids: '图文辅助' };
const DEFAULT_CONFIG = {
  weights: { readability: 40, professionalism: 40, visualAids: 20 }, passScore: 60, markdownGate: false,
  contentInstructions: '评价结构、专业准确性、证据、单位与适用条件。图表、代码或公式应对任务有帮助；简单问答无需强制配图。不以篇幅或图片数量奖励答案。',
  completionInstructions: '根据题目核验实际交付。计划、准备、工具调用或“已完成”的自述不能替代成果。先检查完整回答和结构化结果；中间进展与最终交付分开判断。缺少文件内容或其他证据时标为无法判断，不臆断成功或失败。',
  experienceInstructions: '结合用户任务判断交付体验。普通研究或文档任务中，无助于用户决策的容器目录、依赖安装和临时目录细节属于无关实现细节；用户明确要求开发、部署或排障时，相关技术说明可以是有效内容。检查是否只描述准备却未交付、是否存在与可用证据冲突的完成声明。引用原文并说明上下文，不能只匹配关键词扣分。最终完成后仍可记录过程体验问题，不能据单条中间消息宣判整次任务失败。',
  efficiencyRules: [{ serviceKey: '*', phaseKey: 'team-discovery', label: '团队查询', warningSeconds: 60, criticalSeconds: 180 }],
};
const hash = value => crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
function invalid(message) { throw new TeamServiceError(400, 'INVALID_RULE', message); }
function text(value, label, max, required = true) {
  if (typeof value !== 'string' || value.trim().length > max || (required && !value.trim())) invalid(`${label}无效`);
  return value.trim();
}
function validateConfig(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalid('规则配置无效');
  const weights = {};
  for (const key of Object.keys(DIMENSIONS)) {
    const n = value.weights?.[key];
    if (!Number.isInteger(n) || n < 0 || n > 100) invalid('权重需为0到100的整数');
    weights[key] = n;
  }
  if (Object.values(weights).reduce((a,b) => a+b, 0) !== 100 || weights.readability + weights.professionalism === 0) invalid('权重之和须为100，且可读性与专业性合计须大于0');
  if (typeof value.passScore !== 'number' || !Number.isFinite(value.passScore) || value.passScore < 0 || value.passScore > 100) invalid('合格线需为0到100的数字');
  if (typeof value.markdownGate !== 'boolean') invalid('Markdown门槛配置无效');
  if (!Array.isArray(value.efficiencyRules) || value.efficiencyRules.length > 20) invalid('最多配置20项阶段阈值');
  const seen = new Set();
  const efficiencyRules = value.efficiencyRules.map(item => {
    if (!item || typeof item.serviceKey !== 'string' || !/^(?:\*|[a-z][a-z0-9-]{0,59})$/.test(item.serviceKey) || typeof item.phaseKey !== 'string' || !/^[a-zA-Z][a-zA-Z0-9_-]{0,79}$/.test(item.phaseKey)) invalid('服务或阶段标识无效');
    const key = `${item.serviceKey}/${item.phaseKey}`; if (seen.has(key)) invalid('同服务同阶段阈值不能重复'); seen.add(key);
    if (!Number.isInteger(item.warningSeconds) || !Number.isInteger(item.criticalSeconds) || item.warningSeconds < 1 || item.criticalSeconds <= item.warningSeconds || item.criticalSeconds > 86400) invalid('阶段阈值需满足：提醒大于0，严重大于提醒且不超过86400秒');
    return { serviceKey: item.serviceKey, phaseKey: item.phaseKey, label: text(item.label, '阶段名称', 80), warningSeconds: item.warningSeconds, criticalSeconds: item.criticalSeconds };
  });
  return { weights, passScore: value.passScore, markdownGate: value.markdownGate,
    contentInstructions: text(value.contentInstructions, '内容评分说明', 6000),
    completionInstructions: text(value.completionInstructions, '任务交付说明', 6000),
    experienceInstructions: text(value.experienceInstructions, '交付体验说明', 6000), efficiencyRules };
}
function snapshotRule(record) {
  const config = validateConfig(record.config);
  return { id: record.id, version: record.version, name: record.name, publishedAt: record.publishedAt || null, hash: hash(config), config };
}
function builtinRule() {
  return snapshotRule({ id: 'builtin-v1', version: 0, name: '默认评分规则', config: structuredClone(DEFAULT_CONFIG) });
}
function ruleDocument(record) {
  const c = record.config;
  return `# ${record.name}\n\n规则版本：${record.id === 'builtin-v1' ? '内置' : `v${record.version}`}\n\n## 内容评分\n\n${Object.entries(DIMENSIONS).map(([k,label]) => `- ${label}：${c.weights[k]}%`).join('\n')}\n\n图文不适用时，对其余适用维度按比例归一化。合格线 ${c.passScore} 分；两家评委独立评分。\n\n${c.contentInstructions}\n\n## 任务交付\n\n${c.completionInstructions}\n\n## 交付体验\n\n${c.experienceInstructions}\n\n## 阶段效率\n\n${c.efficiencyRules.length ? c.efficiencyRules.map(r => `- ${r.label}（${r.serviceKey} / ${r.phaseKey}）：${r.warningSeconds}秒提醒，${r.criticalSeconds}秒严重异常。`).join('\n') : '未设置阶段阈值。'}\n\n仅使用实际采集的阶段证据；缺少阶段时间时无法评估。\n\n## Markdown\n\n原文机检${c.markdownGate ? '纳入合格门槛' : '独立展示，不纳入合格门槛'}。模型评分不等于独立科学核验。\n`;
}
function createRuleService(repository) {
  async function catalog() {
    let data;
    try { data = await repository.catalog(); }
    catch (error) { if (error.code !== '42P01') throw error; return { items: [], active: builtinRule(), stateRevision: 0, storageReady: false, message: '规则存储尚未迁移，当前使用内置规则；请先在授权的数据库完成迁移。' }; }
    if (data.active && data.active.status !== 'published') throw new Error('生效规则状态异常');
    const items = data.active && !data.items.some(r => r.id === data.active.id) ? [...data.items,data.active] : data.items;
    return { ...data, items, active: data.active ? snapshotRule(data.active) : builtinRule(), storageReady: true };
  }
  return {
    catalog,
    async activeSnapshot() {
      try { const record = await repository.active(); return record ? snapshotRule(record) : builtinRule(); }
      catch (error) { if (error.code !== '42P01') throw error; return builtinRule(); }
    },
    async create(input, actor, id) {
      return repository.create({ id, name: text(input.name, '规则名称', 100), changeNote: text(input.changeNote || '', '变更说明', 1000, false), config: validateConfig(input.config) }, actor);
    },
    async change(id, action, input, actor) {
      if (!Number.isInteger(input.revision) || input.revision < 1) invalid('缺少有效版本号，请刷新后重试');
      if (action === 'save') return repository.change(id, action, { revision: input.revision, name: text(input.name, '规则名称', 100), changeNote: text(input.changeNote || '', '变更说明', 1000, false), config: validateConfig(input.config) }, actor);
      if (!['publish','activate','archive'].includes(action)) invalid('规则操作无效');
      if (action === 'activate' && (!Number.isInteger(input.stateRevision) || input.stateRevision < 0)) invalid('缺少当前生效版本号');
      return repository.change(id, action, input, actor);
    },
  };
}
module.exports = { DIMENSIONS, DEFAULT_CONFIG, validateConfig, builtinRule, snapshotRule, ruleDocument, createRuleService, hash };
