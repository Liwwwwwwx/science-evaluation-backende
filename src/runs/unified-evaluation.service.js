const crypto = require('crypto');
const { TeamServiceError } = require('../errors');
const { createUnifiedEvaluationAdapters } = require('./unified-evaluation-adapters');
const { createRunEvents } = require('./unified-evaluation-events');
const { createConcurrency } = require('./concurrency');

const SERVICE_KEYS = ['mission-material', 'alpha-rsi', 'alloy', 'literature', 'literature-aircraft', 'synthesis', 'new-material'];
const MAX_ACTIVE = 25;
const MAX_PER_SERVICE = 5;
const MAX_QUEUED = 300;
const MAX_FINISHED = 100;
const MAX_ANSWER_CHARS = 3 * 1024 * 1024;
const SCORE_WAIT_MS = 300000;
const SCORE_POLL_MS = 1000;

// 执行和评分分开呈现；旧 status 保留兼容，并不把评分失败视为执行失败。
function statusFields(value) {
  const nativeStatus = value.run && value.run.status;
  const executionStatus = value.status === 'queued' ? 'queued' : value.status === 'cancelled' ? 'cancelled'
    : nativeStatus === 'error' || (!nativeStatus && value.status === 'error') ? 'failed'
    : nativeStatus === 'done' ? 'succeeded' : 'running';
  const items = Object.values(value.scores || {}).filter((item) => item && typeof item.status === 'string');
  let scoringStatus = 'pending';
  if (value.scoreError) scoringStatus = 'unknown';
  else if (items.some((item) => item.status === 'pending')) scoringStatus = 'pending';
  else if (items.some((item) => item.status === 'failed') && items.some((item) => item.status === 'ready')) scoringStatus = 'partial';
  else if (items.some((item) => item.status === 'failed')) scoringStatus = 'failed';
  else if (items.some((item) => item.status === 'ready')) scoringStatus = 'ready';
  else if (items.length && items.every((item) => item.status === 'unavailable')) scoringStatus = 'unavailable';
  else if (items.length && items.every((item) => ['absent', 'skipped', 'unavailable'].includes(item.status))) scoringStatus = 'absent';
  else if (items.length) scoringStatus = 'unknown';
  return { ...value, executionStatus, scoringStatus };
}

function recoverScoringSnapshot(value) {
  const attempt = value.run?.scoring;
  if (!attempt || attempt.finishedAt || !(Date.parse(attempt.expiresAt) <= Date.now())) return value;
  const scores = Object.fromEntries(Object.entries(value.scores || {}).map(([key, item]) => [key, item?.status === 'pending' ? { ...item, status: 'failed', quality: null, error: '本轮评分已超时或中断，可仅重新评分' } : item]));
  return { ...value, scores, status: value.run.status === 'error' ? 'error' : 'done', run: { ...value.run, scoring: { ...attempt, expired: true } } };
}

function createUnifiedEvaluationService({ evaluators, repository = null, resolveQuestion = null, scoring = null, scoreWaitMs = SCORE_WAIT_MS, scorePollMs = SCORE_POLL_MS, maxActive = MAX_ACTIVE, maxPerService = MAX_PER_SERVICE, maxQueued = MAX_QUEUED, serviceLimits = {} } = {}) {
  const runs = new Map();
  const adapters = createUnifiedEvaluationAdapters(evaluators);
  const concurrency = createConcurrency({ maxActive, maxPerKey: maxPerService, maxQueued, limitsByKey: serviceLimits });
  const scoreConcurrency = createConcurrency({ maxActive: 4, maxPerKey: 4, maxQueued });
  const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  function send(job, event, data) { job.events.send(event, data); }
  function releaseJob(job) {
    if (job.released || typeof job.release !== 'function') return;
    job.released = true;
    const release = job.release;
    job.release = null;
    release();
  }
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
  async function finish(job, completion, release) {
    let executionFinished = false;
    let executionSlotReleased = false;
    try {
      const result = await completion;
      releaseJob(job);
      executionSlotReleased = true;
      if (job.cancelRequested) return;
      job.run = { ...job.run, details: result.details || job.run?.details || null, status: result.status, verdict: result.verdict == null ? null : result.verdict, checks: result.checks || null, markdownSyntax: result.markdownSyntax || null,
        caseId: result.caseId || null, caseTitle: result.caseTitle || null,
        reportKey: result.reportKey || (result.report && result.report.key) || null,
        evidenceKey: result.evidenceKey || (result.evidence && result.evidence.key) || null,
        taskId: result.taskid || (result.structured && result.structured.taskid) || null,
        answerTruncated: job.answerTruncated, elapsedMs: result.elapsedMs == null ? null : result.elapsedMs, error: result.error || null };
      job.status = result.status === 'error' ? 'error' : 'scoring';
      job.error = result.error || null;
      send(job, 'run', { runId: job.runId, ...job.run });
      if (scoring && job.serviceKey !== 'alpha-rsi') {
        executionFinished = true;
        job.scores = scoring.pending();
        if (job.saveTimer) { clearTimeout(job.saveTimer); job.saveTimer = null; }
        try { await save(job); }
        catch {
          job.scores = Object.fromEntries(Object.entries(job.scores).map(([key, item]) => [key, { ...item, status: 'skipped', error: '完整输出保存失败，暂未评分' }]));
          job.status = result.status === 'error' ? 'error' : 'done';
          job.scoreError = '完整输出保存失败；请恢复原运行后重新评分';
          throw new Error('output persistence failed');
        }
        await runScoring(job);
        return;
      }
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
      if (job.cancelRequested) return;
      if (job.saveTimer) { clearTimeout(job.saveTimer); job.saveTimer = null; }
      if (executionFinished) {
        job.persistenceError = true;
        send(job, 'error', { runId: job.runId, code: 'UNIFIED_EVAL_PERSISTENCE_FAILED', message: '运行已结束，但记录保存失败；请稍后读取原运行，不要重复发起。' });
      } else {
        job.status = 'error'; job.scores = { quality: { status: 'absent' } }; job.error = '测评执行失败'; job.finishedAt = new Date().toISOString();
        await save(job).catch(() => { job.persistenceError = true; });
        send(job, 'error', { runId: job.runId, code: 'UNIFIED_EVAL_FAILED', message: job.error });
      }
    } finally { job.settled = true; job.reply = null; if (!executionSlotReleased) releaseJob(job); prune(); }
  }
  async function start({ serviceKey, question, origin = 'manual', questionId = null, datasetVersion = null, sourceType = null, batchId = null } = {}, internal = null) {
    if (typeof serviceKey !== 'string' || !SERVICE_KEYS.includes(serviceKey) || !evaluators || !evaluators[serviceKey]) throw new TeamServiceError(400, 'UNIFIED_EVAL_SERVICE_INVALID', '不支持该测评服务');
    if (typeof question !== 'string') throw new TeamServiceError(400, 'UNIFIED_EVAL_QUESTION_INVALID', '请输入有效题目');
    // 已验证的固定案例和随机批次保留原服务约束；不能把自定义提问长度限制套到案例上。
    const existingRun = Boolean(internal && typeof internal.execute === 'function');
    const text = question.trim(); const min = existingRun ? 1 : serviceKey === 'alpha-rsi' ? 1 : 8; const max = existingRun ? 10000 : serviceKey === 'synthesis' ? 200 : 500;
    if (text.length < min || text.length > max) throw new TeamServiceError(400, 'UNIFIED_EVAL_QUESTION_INVALID', `题目需为 ${min}–${max} 个字符`);
    const recovered = internal?.recovered || null;
    const idempotency = internal && internal.idempotency;
    if (idempotency) {
      if (!repository || typeof repository.createIdempotent !== 'function' || typeof repository.findIdempotent !== 'function') throw new TeamServiceError(503, 'UNIFIED_EVAL_IDEMPOTENCY_UNAVAILABLE', '运行去重存储不可用');
      const existing = await repository.findIdempotent(idempotency.scope, idempotency.key);
      if (existing) {
        if (existing.hash !== idempotency.hash) throw new TeamServiceError(409, 'UNIFIED_EVAL_IDEMPOTENCY_CONFLICT', '幂等键已用于不同请求');
        return { runId: existing.runId, serviceKey, reused: true };
      }
    }
    // 支持评分规则模块注入发布版快照；恢复时只使用创建时保存的版本。
    const ruleSnapshot = recovered ? null : internal && Object.hasOwn(internal, 'ruleSnapshot') ? internal.ruleSnapshot : scoring?.snapshotRule && serviceKey !== 'alpha-rsi' ? await scoring.snapshotRule() : null;
    if (!['manual', 'automation', 'legacy'].includes(origin)) throw new TeamServiceError(400, 'UNIFIED_EVAL_ORIGIN_INVALID', '无效的运行来源');
    for (const value of [questionId, datasetVersion, sourceType, batchId]) if (value != null && (typeof value !== 'string' || value.length > 200)) throw new TeamServiceError(400, 'UNIFIED_EVAL_METADATA_INVALID', '运行来源信息无效');
    let reservation;
    try { reservation = concurrency.reserve(serviceKey); }
    catch (error) {
      if (error.code === 'CONCURRENCY_QUEUE_FULL') throw new TeamServiceError(429, 'UNIFIED_EVAL_BUSY', '测评等待队列已满，请稍后重试');
      throw error;
    }
    const initialRun = { ...(evaluators[serviceKey]?.serviceAddress ? { serviceAddress: evaluators[serviceKey].serviceAddress, serviceAddressSource: 'run' } : {}),
      ...(ruleSnapshot ? { ruleSnapshot } : {}),
      ...(internal?.rerun ? { previousRunId: internal.rerun.runId } : {}),
      ...(idempotency ? { queuePayload: { version: 1, caseDef: internal.caseDef || null, scoreMode: internal.scoreMode || null } } : {}) };
    const job = { runId: recovered?.runId || crypto.randomUUID(), nativeRunId: null, serviceKey, origin, question: text, questionId, datasetVersion, questionSourceType: sourceType, batchId, status: 'queued', answer: '', answerTruncated: false, run: recovered ? recovered.run : Object.keys(initialRun).length ? initialRun : null, scores: internal && internal.scoreMode === 'none' ? { quality: { status: 'absent', quality: null, error: null } } : null, scoreError: null, error: null, startedAt: recovered?.startedAt || new Date().toISOString(), finishedAt: null, settled: false, events: createRunEvents(), writeChain: Promise.resolve(), saveTimer: null, scoreMode: internal && internal.scoreMode, ownerScope: recovered?.ownerScope || internal?.idempotency?.scope, reply: null, reservation };
    const onText = (delta) => {
      if (job.cancelRequested || typeof delta !== 'string') return;
      const remaining = Math.max(0, MAX_ANSWER_CHARS - job.answer.length);
      job.answer += delta.slice(0, remaining);
      if (delta.length > remaining) job.answerTruncated = true;
      scheduleSave(job);
      // 订阅建立前的短暂缓冲也受恢复正文的大小限制。
      const outgoing = job.events.subscribed ? delta : delta.slice(0, remaining);
      if (outgoing) send(job, 'text', { runId: job.runId, delta: outgoing });
    };
    const onState = details => {
      if (job.cancelRequested) return;
      job.run = { ...job.run, details }; scheduleSave(job);
      send(job, 'state', { runId: job.runId, run: job.run });
    };
    try {
      if (idempotency) {
        const claim = internal?.rerun
          ? await repository.createRerun(snapshot(job), idempotency.scope, idempotency.key, idempotency.hash, internal.rerun.runId, internal.rerun.requestHash)
          : await repository.createIdempotent(snapshot(job), idempotency.scope, idempotency.key, idempotency.hash);
        if (!claim.created) {
          if (!claim.matches) throw new TeamServiceError(409, 'UNIFIED_EVAL_IDEMPOTENCY_CONFLICT', '幂等键已用于不同请求');
          if (!reservation.cancel()) (await reservation.ready)();
          return { runId: claim.runId, serviceKey, reused: true };
        }
        if (internal?.rerun) runs.delete(internal.rerun.runId);
      } else if (repository && !recovered) await repository.create(snapshot(job));
    } catch (error) {
      if (!reservation.cancel()) (await reservation.ready)();
      throw error;
    }
    // 扫描器可能在创建记录提交后、原请求注册到内存前发现同一条记录。
    if (runs.has(job.runId)) {
      if (!reservation.cancel()) (await reservation.ready)();
      return { runId: job.runId, serviceKey, reused: true };
    }
    runs.set(job.runId, job);
    async function launch() {
      const release = await reservation.ready;
      job.reservation = null;
      if (!release && job.cancelRequested) return { runId: job.runId, serviceKey, reused: true };
      if (!release) throw new Error('运行预约已取消');
      try {
        job.release = release;
        if (job.cancelRequested) { releaseJob(job); job.settled = true; return { runId: job.runId, serviceKey, reused: true }; }
        // 原子抢占后才允许向外发送；重启或其他进程只能争抢仍为 queued 的记录。
        if (repository?.claimQueued) {
          let claimed;
          try { claimed = await repository.claimQueued(snapshot(job)); }
          catch {
            release(); if (runs.get(job.runId) === job) runs.delete(job.runId); job.settled = true;
            send(job, 'error', { runId: job.runId, code: 'UNIFIED_EVAL_CLAIM_UNKNOWN', message: '派发状态暂无法确认，请重新读取原运行，勿重复发起。' });
            return { runId: job.runId, serviceKey, reused: true };
          }
          if (!claimed) {
            release(); if (runs.get(job.runId) === job) runs.delete(job.runId); job.settled = true;
            send(job, 'error', { runId: job.runId, code: 'UNIFIED_EVAL_CLAIM_CHANGED', message: '运行已由其他进程处理，请重新读取原运行。' });
            return { runId: job.runId, serviceKey, reused: true };
          }
        } else {
          job.status = 'running';
          await save(job);
        }
        if (job.cancelRequested) { releaseJob(job); job.settled = true; return { runId: job.runId, serviceKey, reused: true }; }
        job.status = 'running';
        send(job, 'execution', { runId: job.runId, status: 'running', executionStatus: 'running' });
        const body = { ...(internal && internal.legacyBody ? internal.legacyBody : {}), question: text, questionId, datasetVersion, sourceType };
        const started = existingRun
          ? { run: { id: internal.nativeRunId }, completion: Promise.resolve().then(() => internal.execute(onText)) }
          : internal && internal.caseDef
            ? await adapters[serviceKey].startCase(internal.caseDef, onText)
            : await adapters[serviceKey].start(body, onText, onState);
        if (!started || !started.run || (!existingRun && !started.run.id) || !started.completion || typeof started.completion.then !== 'function') throw new Error('invalid evaluator response');
        job.nativeRunId = started.run.id || null; job.reply = started.reply || null;
        void save(job).catch(() => { job.persistenceError = true; });
        void finish(job, started.completion, release);
        return { runId: job.runId, serviceKey, nativeSnapshot: started.run, nativeCompletion: started.completion, subscribe: (listener) => job.events.subscribe(listener) };
      } catch (error) {
        release();
        if (job.saveTimer) clearTimeout(job.saveTimer);
        job.status = 'error'; job.error = '启动或记录保存失败'; job.finishedAt = new Date().toISOString(); job.settled = true;
        if (repository) await save(job).catch(() => { job.persistenceError = true; });
        send(job, 'error', { runId: job.runId, code: 'UNIFIED_EVAL_FAILED', message: job.error });
        prune();
        throw error;
      }
    }
    const launched = launch();
    // 手动创建返回队列记录；自动化和旧调用仍等待原生运行实际启动。
    if ((idempotency && reservation.queued) || recovered || internal?.rerun) { void launched.catch(() => {}); return { runId: job.runId, serviceKey }; }
    return launched;
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
    return start(safe, { idempotency: { scope, key, hash }, caseDef, scoreMode: evaluators && evaluators[safe.serviceKey]?.scoreMode });
  }
  async function rerun(runId, { scope, key } = {}) {
    if (!scope || typeof key !== 'string' || !/^[\x21-\x7e]{1,128}$/.test(key)) throw new TeamServiceError(400, 'UNIFIED_EVAL_IDEMPOTENCY_INVALID', '需要有效的 Idempotency-Key');
    if (!repository?.createRerun) throw new TeamServiceError(503, 'RERUN_UNAVAILABLE', '重新测评存储尚未配置');
    const hash = crypto.createHash('sha256').update(JSON.stringify(['rerun', runId])).digest('hex');
    const requestHash = crypto.createHash('sha256').update(JSON.stringify([scope,key])).digest('hex');
    const existing = await repository.findIdempotent(scope, key);
    if (existing) {
      if (existing.hash !== hash) throw new TeamServiceError(409, 'UNIFIED_EVAL_IDEMPOTENCY_CONFLICT', '幂等键已用于不同请求');
      return { runId: existing.runId, reused: true };
    }
    const local = runs.get(runId);
    if (local && !local.settled) throw new TeamServiceError(409, 'RUN_NOT_RERUNNABLE', '此运行仍在执行或评分，请稍后重试');
    if (local?.writeChain) await local.writeChain;
    const current = await repository.get(runId);
    if (!current) throw new TeamServiceError(404, 'NOT_FOUND', '原运行不存在');
    if (current.run?.outputClearedAt) {
      if (current.run.rerunRequestHash === requestHash && current.run.replacementRunId) return { runId: current.run.replacementRunId, reused: true };
      throw new TeamServiceError(409, 'RUN_ALREADY_RERUN', '此记录的输出已清除，请查看新一轮运行');
    }
    const recoveredCurrent = recoverScoringSnapshot(current);
    if (current.origin !== 'manual' || current.batchId || !['done','error'].includes(recoveredCurrent.status) || !['done','error'].includes(current.run?.status)) throw new TeamServiceError(409, 'RUN_NOT_RERUNNABLE', '仅可重新测评已结束的人工运行');
    const evaluator = evaluators?.[current.serviceKey];
    if (!evaluator || current.serviceKey === 'alpha-rsi') throw new TeamServiceError(409, 'RERUN_SERVICE_UNAVAILABLE', '原测评服务暂不可用');
    if (!current.run?.serviceAddress || current.run.serviceAddress !== evaluator.serviceAddress) throw new TeamServiceError(409, 'RERUN_SERVICE_CHANGED', '原服务地址已变化，请新建测评并核对服务');
    const safe = { serviceKey: current.serviceKey, question: current.question, origin: 'manual', questionId: current.questionId, datasetVersion: current.datasetVersion, sourceType: current.questionSourceType, batchId: null };
    let caseDef = null;
    if (safe.questionId || safe.datasetVersion || safe.sourceType) {
      if (!resolveQuestion) throw new TeamServiceError(503, 'QUESTION_SOURCE_INVALID', '题目版本校验尚未配置');
      caseDef = await resolveQuestion(safe);
    }
    return start(safe, { idempotency: { scope,key,hash }, caseDef, ruleSnapshot: current.run.ruleSnapshot || null, scoreMode: evaluator.scoreMode, rerun: { runId,requestHash } });
  }
  async function createMissionDailyRun(input, { key, ruleSnapshot } = {}) {
    if (!input || typeof input.batchId !== 'string' || !input.batchId || typeof key !== 'string' || !/^[\x21-\x7e]{1,128}$/.test(key)) throw new TeamServiceError(400, 'MISSION_DAILY_INVALID', '每日测评任务参数无效');
    const safe = { serviceKey: 'mission-material', question: input.question, origin: 'automation', questionId: input.questionId,
      datasetVersion: input.datasetVersion, sourceType: input.sourceType, batchId: input.batchId };
    const hash = crypto.createHash('sha256').update(JSON.stringify(safe)).digest('hex');
    return start(safe, { idempotency: { scope: 'evaluation-automation:mission-material', key, hash }, caseDef: null, scoreMode: evaluators?.['mission-material']?.scoreMode, ruleSnapshot });
  }
  async function createBatchRun(input, { key, ruleSnapshot } = {}) {
    if (!input || typeof input.batchId !== 'string' || !input.batchId || typeof key !== 'string' || !/^[\x21-\x7e]{1,128}$/.test(key)) throw new TeamServiceError(400, 'BATCH_RUN_INVALID', '批次测评任务参数无效');
    const safe = { serviceKey: input.serviceKey, question: input.question, origin: 'automation', questionId: input.questionId || null,
      datasetVersion: input.datasetVersion || null, sourceType: input.sourceType || null, batchId: input.batchId };
    const hash = crypto.createHash('sha256').update(JSON.stringify(safe)).digest('hex');
    return start(safe, { idempotency: { scope: 'evaluation-automation:batch', key, hash }, caseDef: null, scoreMode: evaluators?.[safe.serviceKey]?.scoreMode, ruleSnapshot });
  }
  let recoveryTimer = null;
  let recoveryRunning = false;
  async function recoverQueued() {
    if (recoveryRunning || !repository?.listRecoverableQueued || !repository?.claimQueued) return;
    recoveryRunning = true;
    try {
      const keys = SERVICE_KEYS.filter(key => !!evaluators?.[key]);
      if (!keys.length) return;
      const addresses = Object.fromEntries(keys.map(key => [key, evaluators[key].serviceAddress || null]));
      const queued = await repository.listRecoverableQueued(keys, maxQueued + maxActive, addresses);
      for (const row of queued) {
        if (runs.has(row.runId)) continue;
        const payload = row.run?.queuePayload;
        if (!payload || payload.version !== 1 || (payload.caseDef != null && (typeof payload.caseDef !== 'object' || Array.isArray(payload.caseDef)))) continue;
        try {
          await start({ serviceKey: row.serviceKey, question: row.question, origin: row.origin, questionId: row.questionId,
            datasetVersion: row.datasetVersion, sourceType: row.questionSourceType, batchId: row.batchId },
          { recovered: row, caseDef: payload.caseDef, scoreMode: payload.scoreMode });
        } catch (error) {
          if (error?.code === 'UNIFIED_EVAL_BUSY') break;
          // 无法恢复的记录继续保留，不能自动重发或覆盖原记录。
        }
      }
    } finally { recoveryRunning = false; }
  }
  function startQueueRecovery({ intervalMs = 5000, onError = () => {} } = {}) {
    if (recoveryTimer) return;
    let reported = false;
    const tick = () => { void recoverQueued().then(() => { reported = false; }).catch(() => { if (!reported) { reported = true; onError(); } }); };
    tick();
    recoveryTimer = setInterval(tick, intervalMs);
    recoveryTimer.unref();
  }
  function stopQueueRecovery() { if (recoveryTimer) clearInterval(recoveryTimer); recoveryTimer = null; }
  async function observe(runId, listener, { scope } = {}) {
    const job = runs.get(runId);
    if (!job) return { snapshot: await get(runId, { scope }), live: false, unsubscribe: () => {} };
    const current = { ...snapshot(job), canEnd: !!scope && job.ownerScope === scope && !job.settled && ['queued', 'running'].includes(job.status), canReply: !!scope && job.ownerScope === scope && !job.settled && typeof job.reply === 'function' };
    if (job.settled) return { snapshot: await get(runId, { scope }), live: false, unsubscribe: () => {} };
    const unsubscribe = job.events.subscribe((event, data) => listener(event, event === 'state' ? { ...data, canReply: current.canReply } : data), { discardPending: true });
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
  async function get(runId, { scope } = {}) {
    const job = runs.get(runId);
    // 已完成评分必须先完成持久化，再让调用方据此发起重评或从其他进程读取。
    if (job?.run?.scoring?.finishedAt && job.scoringWrite) await job.scoringWrite.catch(() => {});
    if (repository && job?.settled) {
      const saved = await repository.get(runId);
      if (saved && (saved.run?.outputClearedAt || !job.persistenceError)) return statusFields({ ...recoverScoringSnapshot(saved), canReply: false, recoveryState: 'snapshot_only' });
    }
    if (!job) {
      const saved = repository ? await repository.get(runId) : null;
      if (!saved) return getJob(runId);
      // 非本进程的运行只返回已保存快照，不推断远端任务是否仍在运行。
      // 旧记录不猜测原调用地址；可展示当前配置，并明确标注来源，不回写旧数据。
      const configuredAddress = evaluators?.[saved.serviceKey]?.serviceAddress;
      const run = saved.run?.serviceAddress || !configuredAddress ? saved.run : { ...saved.run, serviceAddress: configuredAddress, serviceAddressSource: 'configuration' };
      return statusFields({ ...recoverScoringSnapshot({ ...saved, run }), recoveryState: 'snapshot_only', canReply: false });
    }
    if (job.persistenceError) {
      try {
        if (scoring && job.run?.scoring?.attemptId && repository?.updateScoring) {
          const updated = await repository.updateScoring(job.runId, job.run.scoring.attemptId, { scoring: job.run.scoring, markdownSyntax: job.run.markdownSyntax, scores: job.scores, status: job.status });
          if (!updated) throw new Error('评分轮次已变化');
        } else await save(job);
        job.persistenceError = false;
      } catch { /* 返回当前内存快照及保存失败状态。 */ }
    }
    if (!scoring && job.settled && (job.scoreError || hasPending(job.scores))) {
      await updateScores(job);
      if (!job.scoreError && !hasPending(job.scores) && job.status === 'scoring') job.status = 'done';
      await save(job);
    }
    return { ...snapshot(job), canEnd: !!scope && job.ownerScope === scope && !job.settled && ['queued', 'running'].includes(job.status), canReply: !!scope && job.ownerScope === scope && !job.settled && typeof job.reply === 'function' };
  }
  async function end(runId, { scope } = {}) {
    const job = runs.get(runId);
    if (!job) throw new TeamServiceError(409, 'END_UNAVAILABLE', '当前进程无法结束此运行，请查看保存的记录');
    if (!scope || job.ownerScope !== scope) throw new TeamServiceError(403, 'FORBIDDEN', '只能结束本人发起的运行');
    if (job.status === 'scoring') throw new TeamServiceError(409, 'END_UNAVAILABLE', '评分已经启动，无法结束本次测评');
    if (job.settled) return { ok: true, runId, status: job.status };
    job.cancelRequested = true;
    job.reservation?.cancel();
    job.status = 'cancelled';
    job.error = '用户结束了本次测评';
    job.scoreError = '用户结束了本次测评，未继续评分';
    job.finishedAt = new Date().toISOString();
    job.reply = null;
    if (job.saveTimer) { clearTimeout(job.saveTimer); job.saveTimer = null; }
    send(job, 'error', { runId, code: 'UNIFIED_EVAL_ENDED', message: '测评已结束' });
    try { await save(job); } catch { job.persistenceError = true; }
    job.settled = true;
    releaseJob(job);
    prune();
    return { ok: true, runId, status: 'cancelled' };
  }
  async function reply(runId, input, { scope } = {}) {
    const job = runs.get(runId);
    if (!job || job.settled || typeof job.reply !== 'function') throw new TeamServiceError(409, 'REVIEW_UNAVAILABLE', '当前进程无法答复此运行，请查看保存的记录');
    if (!scope || job.ownerScope !== scope) throw new TeamServiceError(403, 'FORBIDDEN', '只能答复本人发起的运行');
    job.reply(input);
    await save(job);
    return { ok: true, runId };
  }
  function withRecoveryState(item) {
    if (!['queued', 'running', 'scoring'].includes(item.status)) return item;
    const job = runs.get(item.runId);
    return !job || job.settled ? { ...item, recoveryState: 'snapshot_only' } : item;
  }
  async function list(query = {}) {
    if (!repository) throw new TeamServiceError(503, 'UNIFIED_EVAL_STORAGE_UNAVAILABLE', '统一运行记录尚未配置');
    const result = await repository.list(query);
    return { ...result, items: result.items.map(withRecoveryState) };
  }
  async function listHistory(userId) {
    if (!repository?.listHistory) throw new TeamServiceError(503, 'HISTORY_UNAVAILABLE', '对话历史存储尚未配置');
    try { return { items: (await repository.listHistory(userId)).map(withRecoveryState), storageReady: true }; }
    catch (error) {
      if (error.code !== '42P01') throw error;
      const fallback = await repository.list({ origin: 'manual', page: 1, pageSize: 50 });
      return { items: fallback.items.map(withRecoveryState), storageReady: false };
    }
  }
  async function updateHistory(userId, runId, action, title) {
    if (!repository?.updateHistory) throw new TeamServiceError(503, 'HISTORY_UNAVAILABLE', '对话历史存储尚未配置');
    try { if (!await repository.updateHistory(userId, runId, action, title)) throw new TeamServiceError(404, 'NOT_FOUND', '对话不存在或已移除'); }
    catch (error) { if (error.code === '42P01') throw new TeamServiceError(503, 'HISTORY_STORAGE_UNAVAILABLE', '对话管理存储尚未迁移'); throw error; }
    return { ok: true };
  }

  async function runScoring(job, options = null, reservedRelease = null) {
    let release = reservedRelease;
    if (!release) {
      try { release = await scoreConcurrency.acquire('scoring'); }
      catch {
        job.scoreError = '评分等待队列已满，可稍后重评'; job.status = job.run.status === 'error' ? 'error' : 'done';
        await save(job).catch(() => { job.persistenceError = true; });
        send(job, 'done', { runId: job.runId, status: job.status, executionStatus: statusFields(job).executionStatus, scoringStatus: 'unknown' });
        return;
      }
    }
    try {
      if (job.saveTimer) { clearTimeout(job.saveTimer); job.saveTimer = null; }
      // 评分错误不改变原服务执行状态；先保存 pending，再逐模型保存最终结果。
      const input = structuredClone(snapshot(job));
      job.scores = scoring.pending(); job.scoreError = null;
      const publish = async value => {
        job.run = { ...job.run, scoring: value.scoring, markdownSyntax: value.markdownSyntax };
        job.scores = value.scores;
        const finished = Boolean(value.scoring.finishedAt);
        job.status = job.run.status === 'error' ? 'error' : finished ? 'done' : 'scoring';
        if (finished && !job.finishedAt) job.finishedAt = new Date().toISOString();
        const persist = async () => {
          if (options) {
            const saved = await repository.updateScoring(job.runId, options.attemptId, { scoring: value.scoring, markdownSyntax: value.markdownSyntax, scores: value.scores, status: job.status });
            if (!saved) throw new Error('评分租约已被替换');
          } else await save(job);
        };
        job.scoringWrite = persist();
        try {
          await job.scoringWrite;
          job.persistenceError = false;
        } catch { job.persistenceError = true; }
        finally { job.scoringWrite = null; }
        send(job, 'run', { runId: job.runId, ...job.run });
        send(job, 'score', { runId: job.runId, scores: job.scores, scoreError: null, scoringStatus: statusFields(job).scoringStatus });
      };
      try { await scoring.score(input, publish, options || undefined); }
      catch {
        job.scores = Object.fromEntries(Object.entries(job.scores || {}).map(([key, value]) => [key, value.status === 'pending' ? { ...value, status: 'failed', error: '评分处理失败，请稍后重评' } : value]));
        job.status = job.run.status === 'error' ? 'error' : 'done'; job.scoreError = '评分处理失败，请稍后重评';
        try {
          if (options) {
            const updated = await repository.updateScoring(job.runId, options.attemptId, { scoring: { ...job.run.scoring, finishedAt: new Date().toISOString() }, markdownSyntax: job.run.markdownSyntax, scores: job.scores, status: job.status });
            if (!updated) throw new Error('评分轮次已变化');
          } else await save(job);
        } catch { job.persistenceError = true; }
      }
      const { executionStatus, scoringStatus } = statusFields(job);
      send(job, 'done', { runId: job.runId, status: job.status, executionStatus, scoringStatus });
    } finally { release(); }
  }
  async function rescore(runId, { scope, key } = {}) {
    if (!scoring || !repository?.claimScoring) throw new TeamServiceError(503, 'SCORING_UNAVAILABLE', '评分尚未配置');
    if (!scope || typeof key !== 'string' || !/^[\x21-\x7e]{1,128}$/.test(key)) throw new TeamServiceError(400, 'IDEMPOTENCY_INVALID', '需要有效的 Idempotency-Key');
    const current = await repository.get(runId);
    if (!current) throw new TeamServiceError(404, 'NOT_FOUND', '运行不存在');
    if (current.run?.outputClearedAt) throw new TeamServiceError(409, 'RUN_OUTPUT_CLEARED', '此运行的输出已清除，请查看新一轮运行');
    if (current.serviceKey === 'alpha-rsi') throw new TeamServiceError(400, 'SCORING_UNSUPPORTED', '旧服务暂不支持此评分方案');
    const requestHash = crypto.createHash('sha256').update(JSON.stringify([scope, key])).digest('hex');
    const previous = current.run?.scoring && typeof current.run.scoring === 'object' && !Array.isArray(current.run.scoring) ? current.run.scoring : null;
    const history = Array.isArray(previous?.history) ? previous.history : [];
    const reused = [previous, ...history].find(v => v?.requestHash === requestHash);
    if (reused) return { runId, attemptId: reused.attemptId, reused: true };
    if ((runs.get(runId) && !runs.get(runId).settled) || current.status === 'running' || (previous && !previous.finishedAt && Date.parse(previous.expiresAt) > Date.now())) throw new TeamServiceError(409, 'SCORING_BUSY', '此运行仍在执行或评分，请稍后重试');
    if (!['done', 'error'].includes(current.run?.status)) throw new TeamServiceError(409, 'RUN_INCOMPLETE', '此快照缺少最终执行结果，不能完整评分');
    if (history.length >= 19) throw new TeamServiceError(409, 'SCORING_HISTORY_LIMIT', '单次运行最多保留20轮评分，请创建新的测评运行');
    let reservation;
    try { reservation = scoreConcurrency.reserve('scoring'); }
    catch { throw new TeamServiceError(429, 'SCORING_BUSY', '评分繁忙，请稍后重试'); }
    if (reservation.queued) { reservation.cancel(); throw new TeamServiceError(429, 'SCORING_BUSY', '评分繁忙，请稍后重试'); }
    const release = await reservation.ready;
    const attemptId = crypto.randomUUID();
    const nextHistory = previous ? [...history, { ...previous, history: undefined, scores: recoverScoringSnapshot(current).scores, markdownSyntax: current.run?.markdownSyntax }] : [];
    const options = { attemptId, requestHash, history: nextHistory };
    const initialScoring = { ...options, version: scoring.version, startedAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 240000).toISOString(), finishedAt: null, rubric: previous?.rubric || null };
    let claimed;
    try { claimed = await repository.claimScoring(runId, previous?.attemptId || null, initialScoring, scoring.pending()); }
    catch (error) { release(); throw error; }
    if (!claimed) { release(); throw new TeamServiceError(409, 'SCORING_CONFLICT', '运行评分已更新，请刷新后重试'); }
    const job = { ...current, run: { ...current.run, scoring: initialScoring }, scores: scoring.pending(), status: current.run.status === 'error' ? 'error' : 'scoring', settled: false, events: createRunEvents(), writeChain: Promise.resolve(), saveTimer: null, reply: null };
    runs.set(runId, job);
    void runScoring(job, options, release).finally(() => { job.settled = true; prune(); });
    return { runId, attemptId, reused: false };
  }
  async function questionScores(items) {
    if (!repository?.questionScores) throw new TeamServiceError(503, 'SCORING_STORAGE_UNAVAILABLE', '评分记录尚未配置');
    if (!Array.isArray(items) || items.length > 50 || items.some(v => !v || typeof v.id !== 'string' || !v.id || v.id.length > 200 || typeof v.datasetVersion !== 'string' || !v.datasetVersion || v.datasetVersion.length > 200)) throw new TeamServiceError(400, 'INVALID_INPUT', '题目版本参数无效');
    return { items: await repository.questionScores(items) };
  }

  function availableServices() { return SERVICE_KEYS.filter(key => !!evaluators?.[key]); }
  return { start, createRun, rerun, createMissionDailyRun, createBatchRun, observe, get, list, listHistory, updateHistory, reply, end, rescore, questionScores, recoverQueued, startQueueRecovery, stopQueueRecovery, scoringEnabled: !!scoring, availableServices, runAutomation, beginAutomation, startLegacy };
}
module.exports = { createUnifiedEvaluationService, SERVICE_KEYS };
