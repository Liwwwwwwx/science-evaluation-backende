const crypto = require('crypto');
const { TeamServiceError } = require('../errors');
const { createUnifiedEvaluationAdapters } = require('./unified-evaluation-adapters');
const { createRunEvents } = require('./unified-evaluation-events');

const SERVICE_KEYS = ['alpha-rsi', 'alloy', 'literature', 'literature-aircraft', 'synthesis', 'new-material'];
const MAX_ACTIVE = 8;
const MAX_FINISHED = 100;
const MAX_ANSWER_CHARS = 1024 * 1024;
const SCORE_WAIT_MS = 300000;
const SCORE_POLL_MS = 1000;

// 执行和评分分开呈现；旧 status 保留兼容，并不把评分失败视为执行失败。
function statusFields(value) {
  const nativeStatus = value.run && value.run.status;
  const executionStatus = nativeStatus === 'error' || (!nativeStatus && value.status === 'error') ? 'failed'
    : nativeStatus === 'done' ? 'succeeded' : 'running';
  const items = Object.values(value.scores || {}).filter((item) => item && typeof item.status === 'string');
  let scoringStatus = 'pending';
  if (value.scoreError) scoringStatus = 'unknown';
  else if (items.some((item) => item.status === 'pending')) scoringStatus = 'pending';
  else if (items.some((item) => item.status === 'failed')) scoringStatus = 'failed';
  else if (items.some((item) => item.status === 'ready')) scoringStatus = 'ready';
  else if (items.length && items.every((item) => item.status === 'unavailable')) scoringStatus = 'unavailable';
  else if (items.length && items.every((item) => ['absent', 'skipped', 'unavailable'].includes(item.status))) scoringStatus = 'absent';
  else if (items.length) scoringStatus = 'unknown';
  return { ...value, executionStatus, scoringStatus };
}

function createUnifiedEvaluationService({ evaluators, repository = null, resolveQuestion = null, scoreWaitMs = SCORE_WAIT_MS, scorePollMs = SCORE_POLL_MS, maxActive = MAX_ACTIVE } = {}) {
  const runs = new Map();
  const adapters = createUnifiedEvaluationAdapters(evaluators);
  let active = 0;
  const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  function send(job, event, data) { job.events.send(event, data); }
  function prune() {
    const finished = [...runs.values()].filter((job) => job.settled);
    while (finished.length > MAX_FINISHED) runs.delete(finished.shift().runId);
  }
  function getJob(runId) {
    const job = runs.get(runId);
    if (!job) throw new TeamServiceError(404, 'UNIFIED_EVAL_RUN_NOT_FOUND', '运行不存在或恢复记录已过期');
    return job;
  }
  function snapshot(job) {
    return statusFields({ runId: job.runId, nativeRunId: job.nativeRunId, serviceKey: job.serviceKey, origin: job.origin, question: job.question, questionId: job.questionId, datasetVersion: job.datasetVersion, questionSourceType: job.questionSourceType, batchId: job.batchId, status: job.status, answer: job.answer, answerTruncated: job.answerTruncated, run: job.run, scores: job.scores, scoreError: job.scoreError, persistenceError: job.persistenceError === true, error: job.error, startedAt: job.startedAt, finishedAt: job.finishedAt });
  }
  async function save(job) {
    if (!repository) return;
    // 同一运行按顺序写入，避免较早的异步写入覆盖最终状态。
    const value = snapshot(job);
    job.writeChain = job.writeChain.catch(() => {}).then(() => repository.save(value));
    return job.writeChain;
  }
  function scheduleSave(job) {
    if (!repository || job.saveTimer) return;
    job.saveTimer = setTimeout(() => {
      job.saveTimer = null;
      void save(job).catch(() => { job.persistenceError = true; });
    }, 1000);
  }
  async function readScores(job) {
    if (job.scoreMode === 'none') return { quality: { status: 'absent', quality: null, error: null } };
    return adapters[job.serviceKey].readScores(job.nativeRunId);
  }
  function hasPending(scores) {
    return Object.values(scores || {}).some((item) => item && item.status === 'pending');
  }
  async function updateScores(job) {
    try { job.scores = await readScores(job); job.scoreError = null; }
    catch { job.scoreError = '无法读取评分状态，可稍后查询'; }
    return job.scores;
  }
  async function finish(job, completion) {
    let executionFinished = false;
    let executionSlotReleased = false;
    try {
      const result = await completion;
      active -= 1;
      executionSlotReleased = true;
      job.run = { status: result.status, verdict: result.verdict == null ? null : result.verdict, checks: result.checks || null, markdownSyntax: result.markdownSyntax || null,
        caseId: result.caseId || null, caseTitle: result.caseTitle || null,
        reportKey: result.reportKey || (result.report && result.report.key) || null,
        evidenceKey: result.evidenceKey || (result.evidence && result.evidence.key) || null,
        taskId: result.taskid || (result.structured && result.structured.taskid) || null,
        answerTruncated: job.answerTruncated, elapsedMs: result.elapsedMs == null ? null : result.elapsedMs, error: result.error || null };
      job.status = result.status === 'error' ? 'error' : 'scoring';
      job.error = result.error || null;
      send(job, 'run', { runId: job.runId, ...job.run });
      const deadline = Date.now() + scoreWaitMs;
      let previous = null;
      do {
        const scores = await updateScores(job);
        const serialized = JSON.stringify({ scores, scoreError: job.scoreError });
        if (serialized !== previous) { send(job, 'score', { runId: job.runId, scores, scoreError: job.scoreError, scoringStatus: statusFields(job).scoringStatus }); previous = serialized; }
        if ((!job.scoreError && !hasPending(scores)) || Date.now() >= deadline) break;
        await wait(Math.min(scorePollMs, Math.max(0, deadline - Date.now())));
      } while (true);
      if (job.status !== 'error') job.status = job.scoreError || hasPending(job.scores) ? 'scoring' : 'done';
      job.finishedAt = new Date().toISOString();
      executionFinished = true;
      if (job.saveTimer) { clearTimeout(job.saveTimer); job.saveTimer = null; }
      await save(job);
      job.persistenceError = false;
      send(job, 'done', { runId: job.runId, status: job.status, executionStatus: statusFields(job).executionStatus, scoringStatus: statusFields(job).scoringStatus });
    } catch {
      if (job.saveTimer) { clearTimeout(job.saveTimer); job.saveTimer = null; }
      if (executionFinished) {
        job.persistenceError = true;
        send(job, 'error', { runId: job.runId, code: 'UNIFIED_EVAL_PERSISTENCE_FAILED', message: '运行已结束，但记录保存失败；请稍后读取原运行，不要重复发起。' });
      } else {
        job.status = 'error'; job.error = '测评执行失败'; job.finishedAt = new Date().toISOString();
        await save(job).catch(() => { job.persistenceError = true; });
        send(job, 'error', { runId: job.runId, code: 'UNIFIED_EVAL_FAILED', message: job.error });
      }
    } finally { job.settled = true; if (!executionSlotReleased) active -= 1; prune(); }
  }
  async function start({ serviceKey, question, origin = 'manual', questionId = null, datasetVersion = null, sourceType = null, batchId = null } = {}, internal = null) {
    if (typeof serviceKey !== 'string' || !SERVICE_KEYS.includes(serviceKey) || !evaluators || !evaluators[serviceKey]) throw new TeamServiceError(400, 'UNIFIED_EVAL_SERVICE_INVALID', '不支持该测评服务');
    if (typeof question !== 'string') throw new TeamServiceError(400, 'UNIFIED_EVAL_QUESTION_INVALID', '请输入有效题目');
    // 已验证的固定案例和随机批次保留原服务约束；不能把自定义提问长度限制套到案例上。
    const existingRun = Boolean(internal && typeof internal.execute === 'function');
    const text = question.trim(); const min = existingRun ? 1 : serviceKey === 'alpha-rsi' ? 1 : 8; const max = existingRun ? 10000 : serviceKey === 'synthesis' ? 200 : 500;
    if (text.length < min || text.length > max) throw new TeamServiceError(400, 'UNIFIED_EVAL_QUESTION_INVALID', `题目需为 ${min}–${max} 个字符`);
    const idempotency = internal && internal.idempotency;
    if (idempotency) {
      if (!repository || typeof repository.createIdempotent !== 'function' || typeof repository.findIdempotent !== 'function') throw new TeamServiceError(503, 'UNIFIED_EVAL_IDEMPOTENCY_UNAVAILABLE', '运行去重存储不可用');
      const existing = await repository.findIdempotent(idempotency.scope, idempotency.key);
      if (existing) {
        if (existing.hash !== idempotency.hash) throw new TeamServiceError(409, 'UNIFIED_EVAL_IDEMPOTENCY_CONFLICT', '幂等键已用于不同请求');
        return { runId: existing.runId, serviceKey, reused: true };
      }
    }
    if (active >= maxActive) throw new TeamServiceError(429, 'UNIFIED_EVAL_BUSY', '测评并发已达上限，请稍后重试');
    if (!['manual', 'automation', 'legacy'].includes(origin)) throw new TeamServiceError(400, 'UNIFIED_EVAL_ORIGIN_INVALID', '无效的运行来源');
    for (const value of [questionId, datasetVersion, sourceType, batchId]) if (value != null && (typeof value !== 'string' || value.length > 200)) throw new TeamServiceError(400, 'UNIFIED_EVAL_METADATA_INVALID', '运行来源信息无效');
    active += 1;
    const job = { runId: crypto.randomUUID(), nativeRunId: null, serviceKey, origin, question: text, questionId, datasetVersion, questionSourceType: sourceType, batchId, status: 'running', answer: '', answerTruncated: false, run: null, scores: null, scoreError: null, error: null, startedAt: new Date().toISOString(), finishedAt: null, settled: false, events: createRunEvents(), writeChain: Promise.resolve(), saveTimer: null, scoreMode: internal && internal.scoreMode };
    const onText = (delta) => {
      if (typeof delta !== 'string') return;
      const remaining = Math.max(0, MAX_ANSWER_CHARS - job.answer.length);
      job.answer += delta.slice(0, remaining);
      if (delta.length > remaining) job.answerTruncated = true;
      scheduleSave(job);
      // 订阅建立前的短暂缓冲也受恢复正文的大小限制。
      const outgoing = job.events.subscribed ? delta : delta.slice(0, remaining);
      if (outgoing) send(job, 'text', { runId: job.runId, delta: outgoing });
    };
    try {
      if (idempotency) {
        const claim = await repository.createIdempotent(snapshot(job), idempotency.scope, idempotency.key, idempotency.hash);
        if (!claim.created) {
          if (!claim.matches) throw new TeamServiceError(409, 'UNIFIED_EVAL_IDEMPOTENCY_CONFLICT', '幂等键已用于不同请求');
          active -= 1;
          return { runId: claim.runId, serviceKey, reused: true };
        }
      } else if (repository) await repository.create(snapshot(job));
      const body = { ...(internal && internal.legacyBody ? internal.legacyBody : {}), question: text, questionId, datasetVersion, sourceType };
      const started = existingRun
        ? { run: { id: internal.nativeRunId }, completion: Promise.resolve().then(() => internal.execute(onText)) }
        : internal && internal.caseDef
          ? await adapters[serviceKey].startCase(internal.caseDef, onText)
          : await adapters[serviceKey].start(body, onText);
      if (!started || !started.run || (!existingRun && !started.run.id) || !started.completion || typeof started.completion.then !== 'function') throw new Error('invalid evaluator response');
      job.nativeRunId = started.run.id || null; runs.set(job.runId, job);
      void save(job).catch(() => { job.persistenceError = true; });
      void finish(job, started.completion);
      return { runId: job.runId, serviceKey, nativeSnapshot: started.run, nativeCompletion: started.completion, subscribe: (listener) => job.events.subscribe(listener) };
    } catch (error) {
      active -= 1;
      if (job.saveTimer) clearTimeout(job.saveTimer);
      if (repository) { job.status = 'error'; job.error = '启动或记录保存失败'; job.finishedAt = new Date().toISOString(); await save(job).catch(() => {}); }
      throw error;
    }
  }
  async function createRun(input, { scope, key } = {}) {
    if (typeof scope !== 'string' || !scope || typeof key !== 'string' || !/^[\x21-\x7e]{1,128}$/.test(key)) throw new TeamServiceError(400, 'UNIFIED_EVAL_IDEMPOTENCY_INVALID', '需要有效的 Idempotency-Key');
    const safe = { serviceKey: input.serviceKey, question: input.question, origin: 'manual', questionId: input.questionId || null, datasetVersion: input.datasetVersion || null, sourceType: input.sourceType || null };
    const hash = crypto.createHash('sha256').update(JSON.stringify(safe)).digest('hex');
    // 已创建的同键请求必须先恢复原运行，即使题目后来停用或修改。
    if (repository && typeof repository.findIdempotent === 'function') {
      const existing = await repository.findIdempotent(scope, key);
      if (existing) {
        if (existing.hash !== hash) throw new TeamServiceError(409, 'UNIFIED_EVAL_IDEMPOTENCY_CONFLICT', '幂等键已用于不同请求');
        return { runId: existing.runId, serviceKey: safe.serviceKey, reused: true };
      }
    }
    let caseDef = null;
    if (safe.questionId || safe.datasetVersion || safe.sourceType) {
      if (!['fixed', 'random'].includes(safe.sourceType) || !safe.questionId || !safe.datasetVersion || !resolveQuestion) throw new TeamServiceError(400, 'QUESTION_SOURCE_INVALID', '请选择有效的题目和版本');
      caseDef = await resolveQuestion(safe);
    }
    return start(safe, { idempotency: { scope, key, hash }, caseDef });
  }
  async function observe(runId, listener) {
    const job = runs.get(runId);
    if (!job) return { snapshot: await get(runId), live: false, unsubscribe: () => {} };
    const current = snapshot(job);
    if (job.settled) return { snapshot: current, live: false, unsubscribe: () => {} };
    const unsubscribe = job.events.subscribe(listener, { discardPending: true });
    return { snapshot: current, live: true, unsubscribe };
  }
  async function beginAutomation(serviceKey, nativeRun, execute, { scoreMode, waitForCapacity = false } = {}) {
    let started;
    // 批次并发超过统一执行容量时等待，不跳题，也不重复启动底层运行。
    const deadline = Date.now() + 15 * 60 * 1000;
    while (!started) {
      try {
        started = await start({ serviceKey, question: nativeRun.question, origin: 'automation',
          questionId: nativeRun.questionId || null, datasetVersion: nativeRun.questionDatasetVersion || null,
          sourceType: nativeRun.questionSourceType || null, batchId: nativeRun.batchId || null },
        { nativeRunId: nativeRun.id, execute, scoreMode });
      } catch (error) {
        if (!error || error.code !== 'UNIFIED_EVAL_BUSY' || !waitForCapacity || Date.now() >= deadline) throw error;
        await wait(1000);
      }
    }
    started.subscribe(() => {});
    return started;
  }
  async function runAutomation(serviceKey, nativeRun, execute, options) {
    const started = await beginAutomation(serviceKey, nativeRun, execute, { ...options, waitForCapacity: true });
    return started.nativeCompletion;
  }
  async function startLegacy(serviceKey, body = {}) {
    const question = serviceKey === 'alpha-rsi' ? body.question : String(body.question || '');
    const started = await start({ serviceKey, question, questionId: body.questionId || null,
      datasetVersion: body.datasetVersion || null, sourceType: body.sourceType || null, origin: 'legacy' }, { legacyBody: body });
    started.subscribe(() => {});
    return started.nativeSnapshot;
  }
  async function get(runId) {
    const job = runs.get(runId);
    if (!job) {
      const saved = repository ? await repository.get(runId) : null;
      if (!saved) return getJob(runId);
      if (saved.status === 'scoring' && saved.nativeRunId && evaluators && evaluators[saved.serviceKey] && typeof repository.refreshScores === 'function') {
        try {
          const scores = await readScores(saved);
          const status = hasPending(scores) ? 'scoring' : 'done';
          const updated = await repository.refreshScores(runId, scores, null, status);
          if (updated) return statusFields({ ...updated, recoveryState: 'snapshot_only' });
          const current = await repository.get(runId);
          if (current) return statusFields({ ...current, recoveryState: 'snapshot_only' });
        } catch { /* 保留已存快照，评分读取失败不伪装成评分失败。 */ }
      }
      // 非本进程的运行只返回已保存快照，不推断远端任务是否仍在运行。
      return statusFields({ ...saved, recoveryState: 'snapshot_only' });
    }
    if (job.persistenceError) {
      try { await save(job); job.persistenceError = false; } catch { /* 返回当前内存快照及保存失败状态。 */ }
    }
    if (job.settled && (job.scoreError || hasPending(job.scores))) {
      await updateScores(job);
      if (!job.scoreError && !hasPending(job.scores) && job.status === 'scoring') job.status = 'done';
      await save(job);
    }
    return snapshot(job);
  }
  async function list(query = {}) { if (!repository) throw new TeamServiceError(503, 'UNIFIED_EVAL_STORAGE_UNAVAILABLE', '统一运行记录尚未配置'); return repository.list(query); }
  return { start, createRun, observe, get, list, runAutomation, beginAutomation, startLegacy };
}
module.exports = { createUnifiedEvaluationService, SERVICE_KEYS };
