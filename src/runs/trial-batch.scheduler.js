const { localTime } = require('./mission-daily.service');

function createTrialBatchScheduler({ date, service, repository, missionRepository, now = () => new Date(), intervalMs = 30000, onError = () => {} } = {}) {
  if (!date || !service || !repository || !missionRepository) throw new Error('试运行调度依赖不完整');
  let timer = null; let ticking = false;
  async function tick() {
    if (ticking) return;
    ticking = true;
    try {
      const time = localTime(now());
      const plan = await repository.get(date);
      if (plan?.state === 'dispatching') return await service.dispatch(date);
      if (plan?.state === 'generating') { await repository.failExpiredGeneration(plan.id); return; }
      if (plan || time.date !== date || time.minute < 22 * 60 || time.minute >= 22 * 60 + 10) return;
      // 已存在旧计划或旧计划未完成时不叠加同一上游负载。
      if (await missionRepository.get(date) || await missionRepository.pending() || await missionRepository.hasUnfinishedRuns()) throw new Error('已有 Mission 每日计划或未完成任务，试运行未启动');
      await service.prepare(date);
      await service.dispatch(date);
    } finally { ticking = false; }
  }
  function start() {
    if (timer) return;
    const run = () => void tick().catch(onError);
    run(); timer = setInterval(run, intervalMs); timer.unref();
  }
  function stop() { if (timer) clearInterval(timer); timer = null; }
  return { tick, start, stop };
}
module.exports = { createTrialBatchScheduler };
