const { createHash, randomUUID } = require('node:crypto');
const { TeamServiceError } = require('../errors');
const { localTime } = require('./mission-daily.service');
const { validateScheme, upgradeComparisonScheme } = require('./batch-scheme');
const { generateTrialQuestions } = require('../question-bank/trial-questions');

function createManualBatchService({ repository, evaluations, generator, scoring, serviceAddresses, trialService, schemes, onError = () => {} } = {}) {
  const active = new Set(); let timer = null; let ticking = false;
  async function process(id, generate = false) {
    if (active.has(id)) return;
    active.add(id);
    try {
      let plan = await repository.get(id);
      if (!plan) return;
      if (plan.state === 'generating' && generate) {
        try {
          const items = await generateTrialQuestions({ generator, scheme: plan.configSnapshot.config || plan.configSnapshot });
          if (!await repository.ready(id, items)) throw new Error('批次状态已变化');
          plan = await repository.get(id);
        } catch (error) {
          await repository.fail(id, error.code === 'BATCH_QUESTIONS_INSUFFICIENT' ? error.message : '题目生成或计划保存失败');
          throw error;
        }
      }
      if (plan.state === 'dispatching') await trialService.dispatchPlan(plan, repository);
    } finally { active.delete(id); }
  }
  async function create({ config, userId, key, schemeId = null, schemeVersion = null }) {
    if (typeof userId !== 'string' || !userId || typeof key !== 'string' || !/^[\x21-\x7e]{1,128}$/.test(key)) throw new TeamServiceError(400, 'BATCH_IDEMPOTENCY_INVALID', '需要有效的幂等键');
    const requested = validateScheme(config);
    const existing = await repository.find(userId, key);
    if (existing) {
      const previous = existing.configSnapshot;
      const oldConfig = JSON.stringify(validateScheme(previous.config || previous));
      let sameConfig = oldConfig === JSON.stringify(requested);
      if (!sameConfig) {
        try { sameConfig = oldConfig === JSON.stringify(upgradeComparisonScheme(requested)); } catch { /* 原请求可能只包含停用服务。 */ }
      }
      if (!sameConfig || (previous.scheme?.id || null) !== schemeId || (previous.scheme?.version ?? null) !== schemeVersion) throw new TeamServiceError(409, 'BATCH_IDEMPOTENCY_CONFLICT', '幂等键已用于不同方案');
      return { batchId: existing.id, state: existing.state, reused: true };
    }
    const scheme = upgradeComparisonScheme(requested);
    if (!await repository.ownershipReady()) throw new TeamServiceError(503, 'RUN_OWNERSHIP_NOT_MIGRATED', '个人运行归属存储尚未迁移');
    let source = null;
    if (schemeId != null) {
      const catalog = await schemes.list({ userId });
      const selected = catalog.items.find(item => item.id === schemeId);
      if (!catalog.storageReady) throw new TeamServiceError(503, 'BATCH_SCHEMES_NOT_MIGRATED', '批次配置管理尚未迁移');
      const selectedConfig = selected ? upgradeComparisonScheme(selected.config) : null;
      if (!selected || selected.version !== schemeVersion || JSON.stringify(selectedConfig) !== JSON.stringify(scheme)) throw new TeamServiceError(409, 'BATCH_SCHEME_CONFLICT', '所选方案已变化，请刷新后重试');
      source = { id: selected.id, name: selected.name, version: selected.version };
    }
    const keys = Object.keys(scheme.services).filter(service => scheme.services[service] > 0);
    if (scheme.rsiManufacturingCount && !keys.includes('alpha-combined-rsi')) keys.push('alpha-combined-rsi');
    if (keys.some(service => !serviceAddresses[service])) throw new TeamServiceError(503, 'BATCH_SERVICES_UNAVAILABLE', '所选服务尚未配置');
    if ((scheme.compareAlloyAlpha || scheme.compareSynthesisAlpha) && !await evaluations.comparisonStorageReady()) throw new TeamServiceError(503, 'COMPARISON_STORAGE_NOT_MIGRATED', '对比存储尚未迁移');
    const snapshot = { config: scheme, scheme: source, rsiQuestionLayout: 'shared-v1' };
    const requestHash = createHash('sha256').update(JSON.stringify(snapshot)).digest('hex');
    const ruleSnapshot = scoring?.snapshotRule ? await scoring.snapshotRule() : null;
    const result = await repository.create({ id: randomUUID(), date: localTime(new Date()).date, userId, requestKey: key, requestHash, configSnapshot: snapshot, serviceAddresses, ruleSnapshot });
    if (!result.reused) void process(result.plan.id, true).catch(onError);
    return { batchId: result.plan.id, state: result.plan.state, reused: result.reused };
  }
  async function tick() {
    if (ticking) return;
    ticking = true;
    try {
      const plan = await repository.pending();
      if (!plan || active.has(plan.id)) return;
      if (plan.state === 'generating') await repository.failExpired(plan.id);
      else await process(plan.id);
    } finally { ticking = false; }
  }
  function start() { if (!timer) { timer = setInterval(() => void tick().catch(onError), 30000); timer.unref(); void tick().catch(onError); } }
  function stop() { if (timer) clearInterval(timer); timer = null; }
  return { create, tick, start, stop };
}
module.exports = { createManualBatchService };
