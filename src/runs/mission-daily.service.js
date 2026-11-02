const { randomUUID, createHash } = require('node:crypto');

const TIME_ZONE = 'Asia/Shanghai';
const SCOPE = 'evaluation-automation:mission-material';
function localTime(date) {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: TIME_ZONE, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(date);
  const values = Object.fromEntries(parts.map(part => [part.type, part.value]));
  return { date: `${values.year}-${values.month}-${values.day}`, minute: Number(values.hour) * 60 + Number(values.minute) };
}
function dailyKey(day, item) {
  const fingerprint = createHash('sha256').update(JSON.stringify([item.questionId, item.datasetVersion])).digest('hex');
  return `mission-daily:${day}:${fingerprint}`;
}

// 计划与题目快照先落库，再创建可幂等恢复的运行；不使用请求方身份或公开接口。
function createMissionDailyService({ repository, evaluations, scoring, serviceAddress = null, enabled = false, ready = false, now = () => new Date(), intervalMs = 30000, onError = () => {} } = {}) {
  if (!repository || !evaluations) throw new Error('每日测评依赖运行及数据库');
  let timer = null; let ticking = false; let reported = false;
  async function dispatch(plan) {
    if (!serviceAddress || plan.serviceAddress !== serviceAddress) return;
    for (const item of plan.items) {
      await evaluations.createMissionDailyRun({ ...item, batchId: plan.id }, { key: dailyKey(plan.date, item), ruleSnapshot: plan.ruleSnapshot });
    }
    await repository.markSubmitted(plan.id);
  }
  async function tick() {
    if (!enabled || !ready || ticking) return;
    ticking = true;
    try {
      const pending = await repository.pending();
      if (pending) { await dispatch(pending); return; }
      const { date, minute } = localTime(now());
      if (minute < 22 * 60) return;
      if (await repository.get(date)) return;
      // 只在触发窗口创建新计划；错过时记录，不在启动时堆积补跑。
      if (minute >= 22 * 60 + 10) {
        await repository.create({ date, id: randomUUID(), serviceAddress, items: [], ruleSnapshot: null, state: 'skipped', reason: '错过计划时间，未自动补跑' });
        return;
      }
      if (await repository.hasUnfinishedRuns()) {
        await repository.create({ date, id: randomUUID(), serviceAddress, items: [], ruleSnapshot: null, state: 'skipped', reason: '上一轮仍未结束，本轮未叠加运行' });
        return;
      }
      const items = await repository.selectQuestions(date);
      const ruleSnapshot = scoring?.snapshotRule ? await scoring.snapshotRule() : null;
      const plan = await repository.create({ date, id: randomUUID(), serviceAddress, items, ruleSnapshot,
        state: items.length ? 'dispatching' : 'empty', reason: items.length < 10 ? `可用题目 ${items.length} 道，未达到 10 道` : null });
      if (plan.state === 'dispatching') await dispatch(plan);
    } finally { ticking = false; }
  }
  function start() {
    if (!enabled || !ready || timer) return;
    const run = () => { void tick().then(() => { reported = false; }).catch(() => { if (!reported) { reported = true; onError(); } }); };
    run(); timer = setInterval(run, intervalMs); timer.unref();
  }
  function stop() { if (timer) clearInterval(timer); timer = null; }
  async function status() {
    const info = { enabled, ready, time: '22:00', timeZone: TIME_ZONE, targetCount: 10, last: null };
    if (!enabled || !ready) return info;
    const plan = await repository.latest();
    if (!plan) return info;
    const runs = await repository.runs(plan.id);
    const byQuestion = new Map(runs.map(run => [`${run.questionId}\0${run.datasetVersion}`, run]));
    const reason = plan.state === 'dispatching' && plan.serviceAddress !== serviceAddress ? '服务地址已变化，任务暂停并等待核对' : plan.reason;
    return { ...info, last: { date: plan.date, id: plan.id, state: plan.state, reason, count: plan.items.length,
      items: plan.items.map(item => ({ ...item, ...(byQuestion.get(`${item.questionId}\0${item.datasetVersion}`) || { runId: null, status: 'not_dispatched', scores: null }) })) } };
  }
  return { tick, start, stop, status };
}
module.exports = { createMissionDailyService, localTime, dailyKey, SCOPE };
