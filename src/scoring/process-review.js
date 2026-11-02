// 使用接收时刻记录显式阶段边界，不从“正在查询”等自然语言反推计时。
function createProcessRecorder(startedAt = Date.now()) {
  const data = { events: [], messages: [], truncated: false };
  function record(frame) {
    if (!frame || typeof frame !== 'object') return;
    const body = frame.data && typeof frame.data === 'object' ? frame.data : frame;
    const phaseKey = body.phaseKey || body.phase_key || body.stage_id || frame.phaseKey || frame.phase_key || frame.stage_id;
    const status = body.status || frame.status;
    const kind = ['phase_start','stage_start'].includes(frame.type) || ['started','start'].includes(status) ? 'start'
      : ['phase_end','stage_end'].includes(frame.type) || ['completed','finished','done','end'].includes(status) ? 'end'
      : ['running','in_progress'].includes(status) ? 'running' : null;
    const atMs = Math.max(0, Date.now() - startedAt);
    if (typeof phaseKey === 'string' && /^[a-zA-Z0-9_-]{1,80}$/.test(phaseKey) && kind) {
      if (data.events.length < 200) data.events.push({ id: `E${data.events.length+1}`, phaseKey, kind, atMs }); else data.truncated = true;
    }
    if (['progress','retrieval_progress','stage','phase_start','phase_end','stage_start','stage_end'].includes(frame.type)) {
      const message = [body.message,body.text,body.content,body.title,frame.message,typeof frame.data === 'string' ? frame.data : null].find(v => typeof v === 'string' && v.trim());
      if (message) {
        if (data.messages.length < 50) data.messages.push({ id: `P${data.messages.length+1}`, atMs, text: message.slice(0,1000) }); else data.truncated = true;
        if (message.length > 1000) data.truncated = true;
      }
    }
  }
  return { data, record };
}
function efficiencyReview(run, serviceKey, config) {
  const elapsedMs = typeof run?.elapsedMs === 'number' && Number.isFinite(run.elapsedMs) && run.elapsedMs >= 0 ? run.elapsedMs : null;
  const process = run?.details?.process;
  const events = Array.isArray(process?.events) ? process.events : [];
  const applicable = config.efficiencyRules.filter(r => r.serviceKey === '*' || r.serviceKey === serviceKey);
  const selected = new Map();
  for (const r of applicable) if (!selected.has(r.phaseKey) || r.serviceKey === serviceKey) selected.set(r.phaseKey,r);
  const rows = [];
  for (const rule of selected.values()) {
    let start = null; let lastRunning = null; let observed = false; let ambiguous = false;
    for (const e of events) {
      if (e.phaseKey !== rule.phaseKey || typeof e.atMs !== 'number' || !Number.isFinite(e.atMs) || e.atMs < 0 || (elapsedMs !== null && e.atMs > elapsedMs)) continue;
      if (e.kind === 'start' && start === null) { start = e; lastRunning = null; }
      else if (e.kind === 'start' && start) ambiguous = true;
      else if (e.kind === 'running' && start && e.atMs >= start.atMs) lastRunning = e;
      else if (e.kind === 'end' && start && e.atMs >= start.atMs) {
        rows.push(ambiguous ? { ...rule,status:'not_evaluable',durationMs:null,evidence:[start.id,e.id],note:'同一阶段有重叠的开始事件，无法可靠匹配本次计时。' } : row(rule,e.atMs-start.atMs,[start,e],false)); observed = true; start = null; lastRunning = null; ambiguous = false;
      }
    }
    if (start && lastRunning && !ambiguous) { rows.push(row(rule,lastRunning.atMs-start.atMs,[start,lastRunning],true)); observed = true; }
    if (!observed) rows.push({ ...rule,status:'not_evaluable',durationMs:null,evidence:[],note:'未采集到可核验的阶段起止时间，无法评估。' });
  }
  const status = rows.some(r => r.status === 'critical') ? 'critical' : rows.some(r => r.status === 'warning') ? 'warning'
    : rows.length && rows.every(r => r.status === 'passed') && !process?.truncated ? 'passed' : 'not_evaluable';
  return { status,elapsedMs,rows,coverage: process?.truncated ? 'partial' : 'recorded',note:'总耗时仅作参考；阶段阈值只用于对应服务和明确阶段，不能代替答案质量。' };
}
function row(rule,durationMs,evidence,open) {
  const status = durationMs >= rule.criticalSeconds*1000 ? 'critical' : durationMs >= rule.warningSeconds*1000 ? 'warning' : open ? 'not_evaluable' : 'passed';
  return { ...rule,status,durationMs,evidence:evidence.map(e=>e.id),observations:evidence.map(e=>({id:e.id,kind:e.kind,atMs:e.atMs})),open,note:open ? '根据开始事件和后续明确的运行中事件得到已持续时间；缺少结束事件，不能确认总阶段耗时。' : '根据平台接收的明确阶段起止事件计时。' };
}
module.exports = { createProcessRecorder, efficiencyReview };
