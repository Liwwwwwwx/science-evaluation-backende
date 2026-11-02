function scoreSummary(runs, key) {
  const values = runs.map(run => run.scores?.[key]).filter(score => score?.status === 'ready' && typeof score.quality?.total === 'number' && Number.isFinite(score.quality.total));
  return values.length ? `${(values.reduce((sum, score) => sum + score.quality.total, 0) / values.length).toFixed(1)} 分（${values.length}/${runs.length} 题）` : `暂无有效评分（0/${runs.length} 题）`;
}
function buildMissionDailyReport(plan, runs) {
  const lines = [`【Mission_ScienceMaterial 每日测评（测试）】`, `日期：${plan.date}（北京时间）`];
  if (plan.state !== 'submitted') {
    lines.push(`状态：${plan.state === 'empty' ? '无可用题目' : '本轮跳过'}`, `原因：${plan.reason || '未提供'}`);
  } else {
    lines.push(`题目：${plan.items.length} 道`, `执行完成：${runs.filter(run => run.status === 'done').length} 道`, `执行失败：${runs.filter(run => run.status === 'error').length} 道`,
      `DeepSeek：${scoreSummary(runs, 'deepSeekScore')}`, `Qwen：${scoreSummary(runs, 'qwenScore')}`);
    if (plan.reason) lines.push(`说明：${plan.reason}`);
  }
  return lines.join('\n');
}
function createMissionDailyReportService({ repository, notifier, enabled = false, ready = false, intervalMs = 30000, onError = () => {} } = {}) {
  if (!repository || !notifier) throw new Error('每日通知依赖计划、存储和测试机器人');
  let timer = null; let ticking = false; let reported = false;
  async function tick() {
    if (!enabled || !ready || !notifier.configured || ticking) return;
    ticking = true;
    try {
      for (const plan of await repository.candidates()) {
        const runs = plan.state === 'submitted' ? await repository.runs(plan.id) : [];
        if (plan.state === 'submitted') {
          const identities = new Set(runs.map(run => `${run.questionId}\0${run.datasetVersion}`));
          if (!Array.isArray(plan.items) || !plan.items.length || runs.length !== plan.items.length || plan.items.some(item => !identities.has(`${item.questionId}\0${item.datasetVersion}`))
            || runs.some(run => !['done', 'error'].includes(run.status) || !run.finishedAt)) continue;
        }
        if (!await repository.claim(plan.id)) continue;
        // 先持久化抢占再发送；网络结果不确定或进程中断时不自动重发。
        const result = await notifier.sendText(buildMissionDailyReport(plan, runs));
        await repository.finish(plan.id, result.sent ? 'sent' : result.reason === 'request-failed' ? 'unknown' : 'failed', result.reason);
      }
    } finally { ticking = false; }
  }
  function start() {
    if (!enabled || !ready || !notifier.configured || timer) return;
    const run = () => { void tick().then(() => { reported = false; }).catch(() => { if (!reported) { reported = true; onError(); } }); };
    run(); timer = setInterval(run, intervalMs); timer.unref();
  }
  function stop() { if (timer) clearInterval(timer); timer = null; }
  return { tick, start, stop, enabled: enabled && ready && notifier.configured };
}
module.exports = { createMissionDailyReportService, buildMissionDailyReport };
