const { randomUUID, createHash } = require('node:crypto');
const { generateTrialQuestions } = require('../question-bank/trial-questions');
const { DEFAULT_SCHEME, INACTIVE_SERVICE_KEYS, validateScheme, upgradeComparisonScheme } = require('./batch-scheme');
const LEGACY_TARGETS = Object.freeze({ 'mission-material': 20, literature: 50, 'literature-aircraft': 50, alloy: 50, synthesis: 50, 'new-material': 50 });
const TARGETS = Object.freeze({ ...LEGACY_TARGETS, 'alpha-rsi': 50 });

function createTrialBatchService({ repository, evaluations, generator, scoring, serviceAddresses, schemes = null } = {}) {
  if (!repository || !evaluations || !generator || !serviceAddresses) throw new Error('试运行依赖不完整');
  async function prepare(date) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !Number.isFinite(Date.parse(date)) || new Date(date).toISOString().slice(0, 10) !== date) throw new Error('试运行日期无效');
    const id = randomUUID();
    const ruleSnapshot = scoring?.snapshotRule ? await scoring.snapshotRule() : null;
    const selected = schemes ? await schemes.nightly() : null;
    const config = selected ? upgradeComparisonScheme(selected.config, { allowEmpty: true }) : validateScheme(DEFAULT_SCHEME);
    const configSnapshot = { config, scheme: selected ? { id: selected.id, name: selected.name, version: selected.version } : null };
    if (!await repository.create({ date, id, serviceAddresses, ruleSnapshot, configSnapshot })) return repository.get(date);
    try {
      const selectedKeys = Object.keys(config.services).filter(key => config.services[key] > 0);
      if (!selectedKeys.length) throw Object.assign(new Error('夜间方案没有可测服务，请调整配置'), { code: 'TRIAL_SERVICES_MISSING' });
      if (selectedKeys.some(key => !serviceAddresses[key])) throw Object.assign(new Error('自动测评服务配置不完整'), { code: 'TRIAL_SERVICES_MISSING' });
      if ((config.compareAlloyAlpha || config.compareSynthesisAlpha) && !await evaluations.comparisonStorageReady()) throw Object.assign(new Error('对比存储尚未迁移，不能创建自动对比计划'), { code: 'TRIAL_COMPARISON_UNAVAILABLE' });
      const items = await generateTrialQuestions({ generator, scheme: config });
      if (!await repository.ready(id, items)) throw new Error('试运行计划状态已变化');
    } catch (error) {
      // 只持久化受控错误，避免把模型或配置中的敏感信息写入数据库。
      await repository.fail(id, ['BATCH_QUESTIONS_INSUFFICIENT', 'TRIAL_SERVICES_MISSING', 'TRIAL_COMPARISON_UNAVAILABLE'].includes(error.code) ? error.message : '随机题生成或计划保存失败');
      throw error;
    }
    return repository.get(date);
  }
  async function dispatch(date) {
    const plan = await repository.get(date);
    if (!plan || plan.state !== 'dispatching') return plan;
    await dispatchPlan(plan, repository);
    return repository.get(date);
  }
  async function dispatchPlan(plan, targetRepository) {
    const config = plan.configSnapshot ? validateScheme(plan.configSnapshot.config || plan.configSnapshot) : null;
    const alloyPaired = config ? config.compareAlloyAlpha : false;
    const synthesisPaired = config ? config.compareSynthesisAlpha : !!plan.items && Object.hasOwn(plan.items, 'alpha-rsi');
    const paired = alloyPaired || synthesisPaired;
    const targets = config ? Object.fromEntries(Object.entries(config.services).map(([key, value]) => [key, value]).filter(([, count]) => count > 0)) : paired ? TARGETS : LEGACY_TARGETS;
    if (paired || Object.keys(targets).some(key => INACTIVE_SERVICE_KEYS.includes(key))) throw new Error('旧批次包含已停用的服务或对比，已暂停派发；历史记录保留');
    if (!plan.items || Object.keys(plan.items).length !== Object.keys(targets).length || Object.entries(targets).some(([key, count]) => !Array.isArray(plan.items[key]) || plan.items[key].length !== count || plan.items[key].some(question => typeof question !== 'string' || question.trim().length < 8 || question.length > (key === 'synthesis' ? 200 : 500)))) throw new Error('试运行题目快照无效');
    if (alloyPaired && (plan.items.alloy.length !== plan.items['alpha-rsi'].length || plan.items.alloy.some((question, index) => question !== plan.items['alpha-rsi'][index]))) throw new Error('对比题目快照不一致');
    if (synthesisPaired && (plan.items.synthesis.length !== plan.items['alpha-rsi'].length || plan.items.synthesis.some((question, index) => question !== plan.items['alpha-rsi'][index]))) throw new Error('对比题目快照不一致');
    if (Object.keys(targets).some(key => !serviceAddresses[key] || plan.serviceAddresses?.[key] !== serviceAddresses[key])) throw new Error('服务地址已变化，试运行暂停');
    if (paired && !await evaluations.comparisonStorageReady()) throw new Error('对比存储尚未迁移，试运行暂停');
    let failed = false;
    for (const [serviceKey, questions] of Object.entries(plan.items)) {
      for (const [index, question] of questions.entries()) {
        try {
          const comparisonGroupId = paired && ((alloyPaired && (serviceKey === 'alloy' || serviceKey === 'alpha-rsi')) || (synthesisPaired && (serviceKey === 'synthesis' || serviceKey === 'alpha-rsi')))
            ? createHash('sha256').update(JSON.stringify(['trial-comparison', plan.id, index])).digest('hex') : null;
          await evaluations.createBatchRun({ serviceKey, question, batchId: plan.id, sourceType: 'random', ...(config?.concurrency ? { concurrencyLimits: config.concurrency } : {}), ...(plan.ownerUserId ? { ownerUserId: plan.ownerUserId } : {}), ...(comparisonGroupId ? { comparisonGroupId } : {}) }, { key: `${plan.id}:${serviceKey}:${index}`, ruleSnapshot: plan.ruleSnapshot });
        } catch { failed = true; }
      }
    }
    // 错误可能是存储响应未知，保留原计划和幂等键；下一次只恢复原批次。
    if (failed) throw new Error('部分试运行派发状态未知，将按原幂等键恢复');
    await targetRepository.submitted(plan.id);
  }
  return { prepare, dispatch, dispatchPlan };
}
module.exports = { createTrialBatchService, TARGETS, LEGACY_TARGETS };
