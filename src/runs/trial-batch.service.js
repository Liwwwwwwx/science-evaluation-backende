const { randomUUID } = require('node:crypto');
const { generateTrialQuestions } = require('../question-bank/trial-questions');
const TARGETS = Object.freeze({ 'mission-material': 20, literature: 50, 'literature-aircraft': 50, alloy: 50, synthesis: 50, 'new-material': 50 });

function createTrialBatchService({ repository, evaluations, generator, scoring, serviceAddresses } = {}) {
  if (!repository || !evaluations || !generator || !serviceAddresses) throw new Error('试运行依赖不完整');
  async function prepare(date) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !Number.isFinite(Date.parse(date)) || new Date(date).toISOString().slice(0, 10) !== date) throw new Error('试运行日期无效');
    if (Object.keys(TARGETS).some(key => !serviceAddresses[key])) throw new Error('试运行服务配置不完整');
    const id = randomUUID();
    const ruleSnapshot = scoring?.snapshotRule ? await scoring.snapshotRule() : null;
    if (!await repository.create({ date, id, serviceAddresses, ruleSnapshot })) return repository.get(date);
    try {
      const items = await generateTrialQuestions({ generator });
      if (!await repository.ready(id, items)) throw new Error('试运行计划状态已变化');
    } catch (error) {
      // 只持久化受控错误，避免把模型或配置中的敏感信息写入数据库。
      await repository.fail(id, error.code === 'BATCH_QUESTIONS_INSUFFICIENT' ? error.message : '随机题生成或计划保存失败');
      throw error;
    }
    return repository.get(date);
  }
  async function dispatch(date) {
    const plan = await repository.get(date);
    if (!plan || plan.state !== 'dispatching') return plan;
    if (!plan.items || Object.keys(plan.items).length !== Object.keys(TARGETS).length || Object.entries(TARGETS).some(([key, count]) => !Array.isArray(plan.items[key]) || plan.items[key].length !== count || plan.items[key].some(question => typeof question !== 'string' || question.trim().length < 8 || question.length > (key === 'synthesis' ? 200 : 500)))) throw new Error('试运行题目快照无效');
    if (Object.keys(TARGETS).some(key => !serviceAddresses[key] || plan.serviceAddresses[key] !== serviceAddresses[key])) throw new Error('服务地址已变化，试运行暂停');
    let failed = false;
    for (const [serviceKey, questions] of Object.entries(plan.items)) {
      for (const [index, question] of questions.entries()) {
        try {
          await evaluations.createBatchRun({ serviceKey, question, batchId: plan.id, sourceType: 'random' }, { key: `${plan.id}:${serviceKey}:${index}`, ruleSnapshot: plan.ruleSnapshot });
        } catch { failed = true; }
      }
    }
    // 错误可能是存储响应未知，保留原计划和幂等键；下一次只恢复原批次。
    if (failed) throw new Error('部分试运行派发状态未知，将按原幂等键恢复');
    await repository.submitted(plan.id);
    return repository.get(date);
  }
  return { prepare, dispatch };
}
module.exports = { createTrialBatchService, TARGETS };
