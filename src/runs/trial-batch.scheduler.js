const { localTime } = require('./mission-daily.service');
const { randomUUID } = require('node:crypto');

// 凌晨任务归属前一晚，保持与 22:00–次日 22:00 的日报周期一致。
function previousDate(day) {
  const date = new Date(`${day}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() - 1);
  return date.toISOString().slice(0, 10);
}

function createTrialBatchScheduler({ date, daily = false, service, repository, missionRepository, now = () => new Date(), intervalMs = 30000, onError = () => {} } = {}) {
  if ((!date && !daily) || !service || !repository || !missionRepository) throw new Error('试运行调度依赖不完整');
  let timer = null; let ticking = false; let blockedDate = null;
  async function tick() {
    if (ticking) return;
    ticking = true;
    try {
      const time = localTime(now());
      const currentDate = daily ? previousDate(time.date) : date;
      const startMinute = daily ? 2 * 60 : 22 * 60;
      // 每日模式先恢复最早未完成的快照，即使已跨过午夜也不重新出题。
      const pending = daily ? await repository.pending() : null;
      if (pending && pending.date !== currentDate && time.minute >= startMinute) {
        if (time.minute < startMinute + 10) blockedDate = currentDate;
        else if (blockedDate === currentDate) {
          await repository.recordSkipped({ date: currentDate, id: randomUUID(), reason: '上一轮计划尚未准备或派发完成，本轮未启动' });
          blockedDate = null;
        }
      }
      const targetDate = pending?.date || currentDate;
      const plan = pending || await repository.get(targetDate);
      if (plan?.state === 'dispatching') return await service.dispatch(targetDate);
      if (plan?.state === 'generating') { await repository.failExpiredGeneration(plan.id); return; }
      if (plan || (!daily && time.date !== targetDate) || time.minute < startMinute) return;
      if (time.minute >= startMinute + 10) {
        if (daily && blockedDate === targetDate) {
          await repository.recordSkipped({ date: targetDate, id: randomUUID(), reason: '上一轮自动测评尚未结束，本轮未在凌晨 02:00–02:10 内启动' });
          blockedDate = null;
        }
        return;
      }
      // 不与已有 Mission 计划或上一轮六服务任务叠加负载。
      if (await missionRepository.get(targetDate) || await missionRepository.pending() || await missionRepository.hasUnfinishedRuns()
        || (daily && await repository.hasUnfinishedRuns()) || (repository.hasManualBusy && await repository.hasManualBusy())) {
        if (daily) blockedDate = targetDate;
        throw new Error('已有自动测评计划或未完成任务，本轮未启动');
      }
      await service.prepare(targetDate);
      await service.dispatch(targetDate);
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
