const { TeamServiceError } = require('../errors');

const SERVICE_ORDER = ['mission-material', 'literature', 'literature-aircraft', 'alloy', 'synthesis', 'new-material', 'alpha-rsi', 'alpha-combined-rsi'];
const SERVICE_LABELS = {
  'mission-material': 'Mission 主服务',
  literature: '文献检索',
  'literature-aircraft': '航空文献',
  alloy: '合金材料',
  synthesis: '合成制备',
  'new-material': '新材料',
  'alpha-rsi': '材料配比 RSI',
  'alpha-combined-rsi': '配比+制备 RSI',
};
const JUDGES = { deepSeek: 'deepSeekScore', qwen: 'qwenScore' };
const THRESHOLD_POINTS = 5;
const LOW_SCORE_LIMIT = 5;
const FAILURE_LIMIT = 5;
const PAGE_SIZE = 20;
const MAX_PAGE_SIZE = 100;

function dateOnly(value) {
  if (!value) return null;
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  return String(value).slice(0, 10);
}
function planDate(plan) { return dateOnly(plan.calendar_date ?? plan.plan_date); }

function iso(value) {
  return value ? new Date(value).toISOString() : null;
}

function servicePlans(plan) {
  if (plan.source === 'trial' || plan.source === 'manual') {
    const items = plan.items && typeof plan.items === 'object' && !Array.isArray(plan.items) ? plan.items : {};
    const counts = plan.item_counts && typeof plan.item_counts === 'object' ? plan.item_counts : null;
    const config = plan.config_snapshot?.config;
    const expected = key => counts && typeof counts[key] === 'number' ? counts[key] : Array.isArray(items[key]) ? items[key].length : typeof config?.services?.[key] === 'number' ? config.services[key] : (Number(config?.services?.[key]?.aviation) || 0) + (Number(config?.services?.[key]?.synthesis) || 0);
    return SERVICE_ORDER.filter(key => config ? expected(key) > 0 : plan.source !== 'manual' && !['alpha-rsi', 'alpha-combined-rsi'].includes(key) || Object.hasOwn(counts || items, key)).map((key) => ({ key, label: SERVICE_LABELS[key] || key, expected: expected(key) }));
  }
  return [{ key: 'mission-material', label: SERVICE_LABELS['mission-material'], expected: typeof plan.item_count === 'number' ? plan.item_count : Array.isArray(plan.items) ? plan.items.length : 0 }];
}

function totalScore(scores, key) {
  const item = scores?.[JUDGES[key]];
  const value = item?.quality?.total;
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 100 ? value : null;
}

function readyScore(row, key) {
  const item = row.scores?.[JUDGES[key]];
  return item?.status === 'ready' ? totalScore(row.scores, key) : null;
}

function provisionalScore(row, key) {
  const item = row.scores?.[JUDGES[key]];
  return item?.status === 'ready' && (row.answer_truncated === true || item.quality?.source?.truncated === true);
}

function usableScore(row, key) {
  if (provisionalScore(row, key)) return null;
  return readyScore(row, key);
}

function executionOf(row) {
  const runStatus = row.run_status || null;
  const error = String(row.error || '');
  if (runStatus === 'error' || (row.status === 'error' && !runStatus)) return /超时|timeout/i.test(error) ? 'timeout' : 'failed';
  if (runStatus === 'done' || (row.status === 'done' && !runStatus)) return 'completed';
  return 'unfinished';
}

function mapRun(row) {
  return {
    runId: row.id,
    questionId: row.question_id || null,
    datasetVersion: row.dataset_version || null,
    question: String(row.question || ''),
    comparisonGroupId: row.comparison_group_id || null,
    serviceKey: row.service_key,
    status: row.status,
    execution: executionOf(row),
    scores: { deepSeek: usableScore(row, 'deepSeek'), qwen: usableScore(row, 'qwen') },
    displayScores: { deepSeek: readyScore(row, 'deepSeek'), qwen: readyScore(row, 'qwen') },
    provisionalScores: { deepSeek: provisionalScore(row, 'deepSeek'), qwen: provisionalScore(row, 'qwen') },
    error: row.error || null,
    startedAt: iso(row.started_at) || '',
    elapsedMs: row.elapsed_ms != null && row.elapsed_ms !== '' && Number.isFinite(Number(row.elapsed_ms)) ? Number(row.elapsed_ms) : null,
    answerTruncated: row.answer_truncated === true,
    ruleSnapshot: row.rule_snapshot || null,
    rawScores: row.scores || null,
  };
}

function mapSummaryEntry(entry) {
  const scores = {};
  const makeJudge = index => ({ status: entry[index + 1], model: entry[index + 2], quality: { total: entry[index + 3], source: { truncated: entry[index + 4] } } });
  if (entry[4]) scores.deepSeekScore = makeJudge(4);
  if (entry[9]) scores.qwenScore = makeJudge(9);
  const row = { status: entry[0], run_status: entry[1], error: entry[2] ? 'timeout' : '', answer_truncated: entry[3], scores };
  return { status: row.status, execution: executionOf(row), answerTruncated: row.answer_truncated === true, rawScores: scores };
}

function judgeSummary(runs, key) {
  const states = { ready: 0, provisional: 0, pending: 0, failed: 0, unavailable: 0, absent: 0, invalid: 0 };
  const values = [];
  let model = null;
  for (const run of runs) {
    const item = run.rawScores?.[JUDGES[key]];
    if (!item) { states.absent++; continue; }
    if (item.model && !model) model = item.model;
    if (item.status !== 'ready') {
      if (Object.hasOwn(states, item.status)) states[item.status]++; else states.absent++;
      continue;
    }
    const total = totalScore(run.rawScores, key);
    if (total === null) { states.invalid++; continue; }
    if (run.answerTruncated || item.quality?.source?.truncated === true) { states.provisional++; continue; }
    states.ready++;
    values.push(total);
  }
  const mean = values.length ? Math.round((values.reduce((sum, value) => sum + value, 0) / values.length) * 10) / 10 : null;
  return { mean, count: values.length, ...states, model };
}

function lowestScore(run) {
  const values = [run.scores.deepSeek, run.scores.qwen].filter((value) => value !== null);
  return values.length ? Math.min(...values) : null;
}

function lowestDisplayScore(run) {
  const values = [run.displayScores?.deepSeek, run.displayScores?.qwen].filter((value) => typeof value === 'number');
  return values.length ? Math.min(...values) : null;
}

function publicRun(run) {
  const { rawScores, answerTruncated, ruleSnapshot, ...value } = run;
  return value;
}

function totalsOf(runs, planned) {
  const completed = runs.filter((run) => run.execution === 'completed').length;
  const failed = runs.filter((run) => run.execution === 'failed').length;
  const timeout = runs.filter((run) => run.execution === 'timeout').length;
  return {
    planned,
    total: runs.length,
    completed,
    failed,
    timeout,
    unfinished: runs.length - completed - failed - timeout,
    queued: runs.filter((run) => run.status === 'queued').length,
    running: runs.filter((run) => run.status === 'running').length,
    scoring: runs.filter((run) => run.status === 'scoring').length,
  };
}

function addTotals(items, planned) {
  return items.reduce((sum, item) => ({
    planned,
    total: sum.total + item.total,
    completed: sum.completed + item.completed,
    failed: sum.failed + item.failed,
    timeout: sum.timeout + item.timeout,
    unfinished: sum.unfinished + item.unfinished,
    queued: sum.queued + item.queued,
    running: sum.running + item.running,
    scoring: sum.scoring + item.scoring,
  }), { planned, total: 0, completed: 0, failed: 0, timeout: 0, unfinished: 0, queued: 0, running: 0, scoring: 0 });
}

function batchScores(runs) {
  return { deepSeek: judgeSummary(runs, 'deepSeek'), qwen: judgeSummary(runs, 'qwen') };
}

function normalizedState(plan, totals, planned, hasPaused = false) {
  if (plan.state === 'failed' || plan.state === 'skipped') return 'failed';
  if (plan.state === 'generating') return 'preparing';
  if (plan.state === 'dispatching') return 'dispatching';
  if (plan.state === 'empty') return 'done';
  if (totals.queued + totals.running + totals.scoring > 0) return 'running';
  return hasPaused || totals.total < planned ? 'partial' : 'done';
}

function summaryOf(plan, runs) {
  const services = servicePlans(plan);
  const planned = services.reduce((sum, service) => sum + service.expected, 0);
  const totals = totalsOf(runs, planned);
  return {
    batchId: plan.id,
    date: planDate(plan),
    source: plan.source,
    state: normalizedState(plan, totals, planned, runs.some(run => run.status === 'paused')),
    rawState: plan.state,
    scheme: plan.config_snapshot?.scheme || null,
    error: plan.error || null,
    planned,
    services,
    totals,
    scores: batchScores(runs),
    startedAt: iso(plan.created_at),
    updatedAt: iso(plan.updated_at),
  };
}

function lowScores(runs) {
  return runs
    .filter((run) => run.execution === 'completed' && lowestScore(run) !== null)
    .sort((left, right) => lowestScore(left) - lowestScore(right))
    .slice(0, LOW_SCORE_LIMIT)
    .map(publicRun);
}

function failures(runs) {
  return runs
    .filter((run) => run.execution === 'failed' || run.execution === 'timeout')
    .sort((left, right) => Date.parse(right.startedAt) - Date.parse(left.startedAt))
    .slice(0, FAILURE_LIMIT)
    .map(publicRun);
}

function serviceDetails(plan, runs) {
  return servicePlans(plan).map((service) => {
    const rows = runs.filter((run) => run.serviceKey === service.key);
    const elapsed = rows.map((run) => run.elapsedMs).filter((value) => typeof value === 'number');
    return {
      serviceKey: service.key,
      label: service.label,
      expected: service.expected,
      totals: totalsOf(rows, service.expected),
      scores: batchScores(rows),
      maxElapsedMs: elapsed.length ? Math.max(...elapsed) : null,
      lowScores: lowScores(rows),
      failures: failures(rows),
    };
  });
}

function detailOf(plan, runs) {
  const services = serviceDetails(plan, runs);
  const planned = services.reduce((sum, service) => sum + service.expected, 0);
  const totals = addTotals(services.map((service) => service.totals), planned);
  return {
    batch: {
      batchId: plan.id,
      date: planDate(plan),
      source: plan.source,
      state: normalizedState(plan, totals, planned, runs.some(run => run.status === 'paused')),
      rawState: plan.state,
      planned,
      services: servicePlans(plan),
      rule: plan.rule_snapshot ? { name: plan.rule_snapshot.name || null, version: plan.rule_snapshot.version || null, hash: plan.rule_snapshot.hash || null } : { name: null, version: null, hash: null },
      scheme: plan.config_snapshot?.scheme || null,
      startedAt: iso(plan.created_at),
      updatedAt: iso(plan.updated_at),
      error: plan.error || null,
    },
    totals,
    scores: batchScores(runs),
    services,
    coverage: {
      planned,
      persisted: totals.total,
      missing: Math.max(0, planned - totals.total),
      note: plan.source === 'manual' ? '仅显示当前账号的手动组合测评。' : '已持久化自动测评；未入库脚本不在统计范围内。',
    },
    links: { dailyReport: plan.source === 'manual' ? null : `/daily-reports/${planDate(plan)}`, comparison: `/batches/${plan.id}/comparison` },
  };
}

function imageInputMode(score) {
  const source = score?.quality?.source;
  const sent = source?.imageCoverage?.sent;
  return (Number.isFinite(sent) ? sent > 0 : source?.imagesInspected === true) ? 'vision' : 'text';
}

function comparableScores(previous, current) {
  if (previous.execution !== 'completed' || current.execution !== 'completed') return [null, null];
  for (const key of Object.keys(JUDGES)) {
    const before = previous.rawScores?.[JUDGES[key]];
    const after = current.rawScores?.[JUDGES[key]];
    if (before?.status !== 'ready' || after?.status !== 'ready') continue;
    if (previous.answerTruncated || current.answerTruncated || before.quality?.source?.truncated === true || after.quality?.source?.truncated === true) continue;
    if (imageInputMode(before) !== imageInputMode(after)) continue;
    if (!before.model || !after.model || before.model !== after.model) continue;
    const beforeScore = totalScore(previous.rawScores, key);
    const afterScore = totalScore(current.rawScores, key);
    if (beforeScore !== null && afterScore !== null) return [beforeScore, afterScore];
  }
  return [null, null];
}

function levelOf(previous, current, before, after) {
  if (previous.execution === 'unfinished' || current.execution === 'unfinished') return null;
  const previousFailed = ['failed', 'timeout'].includes(previous.execution);
  const currentFailed = ['failed', 'timeout'].includes(current.execution);
  if (!previousFailed && currentFailed) return 'new_failure';
  if (previousFailed && current.execution === 'completed') return 'fixed';
  if (before === null || after === null) return null;
  const delta = after - before;
  if (delta <= -THRESHOLD_POINTS) return 'regressed';
  if (delta >= THRESHOLD_POINTS) return 'improved';
  return 'stable';
}

function questionComparisons(currentRuns, previousRuns) {
  const current = new Map();
  const previous = new Map();
  for (const run of currentRuns) if (run.questionId && run.datasetVersion) current.set(`${run.serviceKey}\0${run.questionId}\0${run.datasetVersion}`, run);
  for (const run of previousRuns) if (run.questionId && run.datasetVersion) previous.set(`${run.serviceKey}\0${run.questionId}\0${run.datasetVersion}`, run);
  const questions = [];
  for (const [key, after] of current) {
    const before = previous.get(key);
    if (!before) continue;
    const [beforeScore, afterScore] = comparableScores(before, after);
    const level = levelOf(before, after, beforeScore, afterScore);
    questions.push({
      questionId: after.questionId,
      datasetVersion: after.datasetVersion,
      question: after.question || before.question,
      serviceKey: after.serviceKey,
      before: { score: beforeScore, status: before.execution },
      after: { score: afterScore, status: after.execution },
      delta: beforeScore !== null && afterScore !== null ? afterScore - beforeScore : null,
      level,
    });
  }
  const order = { regressed: 0, new_failure: 1, improved: 2, fixed: 3, stable: 4 };
  questions.sort((left, right) => ((order[left.level] ?? 5) - (order[right.level] ?? 5)) || ((left.delta ?? 0) - (right.delta ?? 0)));
  return questions;
}

function ruleHashes(plan, runs) {
  return [...new Set([
    plan.rule_snapshot?.hash,
    ...runs.map((run) => run.ruleSnapshot?.hash),
  ].filter((value) => typeof value === 'string' && value))].sort();
}

function models(runs) {
  return [...new Set(runs.flatMap((run) => Object.values(JUDGES).map((key) => run.rawScores?.[key]?.model)).filter((value) => typeof value === 'string' && value))].sort();
}

function compatibleImageModes(first, second) {
  return Object.values(JUDGES).every(key => {
    const modes = runs => new Set(runs.map(run => run.rawScores?.[key]).filter(item => item?.status === 'ready').map(imageInputMode));
    const a = modes(first); const b = modes(second);
    return a.size <= 1 && b.size <= 1 && (!a.size || !b.size || [...a][0] === [...b][0]);
  });
}

function comparisonOf(basePlan, previousPlan, baseRuns, previousRuns) {
  const base = { batchId: basePlan.id, date: planDate(basePlan), planned: servicePlans(basePlan).reduce((sum, service) => sum + service.expected, 0) };
  if (!previousPlan) {
    return { base, previous: null, comparable: false, mode: 'none', reason: '没有更早的同来源批次可用于比较。', matchedQuestions: 0, thresholdPoints: THRESHOLD_POINTS, services: [], questions: [] };
  }
  const previous = { batchId: previousPlan.id, date: planDate(previousPlan), planned: servicePlans(previousPlan).reduce((sum, service) => sum + service.expected, 0) };
  if (basePlan.source !== previousPlan.source) {
    return { base, previous, comparable: false, mode: 'none', reason: '不同来源的批次不能直接比较。', matchedQuestions: 0, thresholdPoints: THRESHOLD_POINTS, services: [], questions: [] };
  }
  const baseHashes = ruleHashes(basePlan, baseRuns);
  const previousHashes = ruleHashes(previousPlan, previousRuns);
  const baseModels = models(baseRuns);
  const previousModels = models(previousRuns);
  if (baseHashes.length && previousHashes.length && baseHashes.join('\0') !== previousHashes.join('\0')) {
    return { base, previous, comparable: false, mode: 'none', reason: '两批次的评分规则版本不同，不能直接比较。', matchedQuestions: 0, thresholdPoints: THRESHOLD_POINTS, services: [], questions: [] };
  }
  if (baseModels.length && previousModels.length && baseModels.join('\0') !== previousModels.join('\0')) {
    return { base, previous, comparable: false, mode: 'none', reason: '两批次使用的评分模型不同，不能直接比较。', matchedQuestions: 0, thresholdPoints: THRESHOLD_POINTS, services: [], questions: [] };
  }
  if (!compatibleImageModes(baseRuns, previousRuns)) {
    return { base, previous, comparable: false, mode: 'none', reason: '两批次的图片评分方式不一致，不能直接比较。', matchedQuestions: 0, thresholdPoints: THRESHOLD_POINTS, services: [], questions: [] };
  }
  const questions = questionComparisons(baseRuns, previousRuns);
  const sameRule = baseHashes.length === 1 && previousHashes.length === 1 && baseHashes[0] === previousHashes[0];
  const strict = sameRule && baseModels.length > 0 && previousModels.length > 0 && baseModels.join('\0') === previousModels.join('\0');
  const mode = questions.length && strict ? 'question' : 'aggregate';
  const keys = [...new Set([...servicePlans(basePlan).map((service) => service.key), ...servicePlans(previousPlan).map((service) => service.key)])];
  const services = keys.map((serviceKey) => {
    const after = serviceDetails(basePlan, baseRuns).find((service) => service.serviceKey === serviceKey);
    const before = serviceDetails(previousPlan, previousRuns).find((service) => service.serviceKey === serviceKey);
    const afterFailures = after ? after.totals.failed + after.totals.timeout : 0;
    const beforeFailures = before ? before.totals.failed + before.totals.timeout : 0;
    const matched = mode === 'question' ? questions.filter((question) => question.serviceKey === serviceKey) : [];
    return {
      serviceKey,
      label: SERVICE_LABELS[serviceKey] || serviceKey,
      scoreDelta: {
        deepSeek: strict && after?.scores.deepSeek.model && after.scores.deepSeek.model === before?.scores.deepSeek.model && after.scores.deepSeek.mean != null && before?.scores.deepSeek.mean != null ? Math.round((after.scores.deepSeek.mean - before.scores.deepSeek.mean) * 10) / 10 : null,
        qwen: strict && after?.scores.qwen.model && after.scores.qwen.model === before?.scores.qwen.model && after.scores.qwen.mean != null && before?.scores.qwen.mean != null ? Math.round((after.scores.qwen.mean - before.scores.qwen.mean) * 10) / 10 : null,
      },
      completionDelta: (after?.totals.completed || 0) - (before?.totals.completed || 0),
      failureDelta: afterFailures - beforeFailures,
      newFailureCount: mode === 'question' ? matched.filter((question) => question.level === 'new_failure').length : null,
      fixedCount: mode === 'question' ? matched.filter((question) => question.level === 'fixed').length : null,
    };
  });
  return {
    base,
    previous,
    comparable: true,
    mode,
    reason: mode === 'question' ? null : (!strict ? '评分规则或模型版本无法确认，分数不作比较；仅展示执行汇总。' : '没有同题同版本记录，只比较服务汇总。'),
    matchedQuestions: questions.length,
    thresholdPoints: THRESHOLD_POINTS,
    services,
    questions: mode === 'question' ? questions.filter((question) => question.level !== null) : [],
  };
}

function createBatchReadService({ repository } = {}) {
  if (!repository) throw new Error('批次读取仓储未配置');

  async function list({ source = 'all', state = '', from = '', to = '', schemeId = '', page = 1, pageSize = PAGE_SIZE, userId = null } = {}) {
    const items = [];
    const chunkSize = 100;
    async function summarize(plans) {
      const byBatch = new Map();
      if (repository.summariesByBatchIds) {
        const groups = await repository.summariesByBatchIds(plans.map(plan => plan.id), userId);
        for (const group of groups) byBatch.set(group.batch_id, group.entries.map(mapSummaryEntry));
      } else {
        const runs = await repository.runsByBatchIds(plans.map(plan => plan.id), userId);
        for (const run of runs) {
          if (!byBatch.has(run.batch_id)) byBatch.set(run.batch_id, []);
          byBatch.get(run.batch_id).push(mapRun(run));
        }
      }
      return plans.map(plan => summaryOf(plan, byBatch.get(plan.id) || []));
    }
    if (!state && repository.pagePlans) {
      const requested = Math.max(Number(page) || 1, 1);
      let result = await repository.pagePlans({ source, from, to, schemeId, limit: pageSize, offset: (requested - 1) * pageSize, userId });
      if (!result.storageReady) return { items: [], total: 0, page: 1, pageSize, storageReady: false };
      const safePage = Math.min(requested, Math.max(1, Math.ceil(result.total / pageSize)));
      if (safePage !== requested) result = await repository.pagePlans({ source, from, to, schemeId, limit: pageSize, offset: (safePage - 1) * pageSize, userId });
      return { items: await summarize(result.items), total: result.total, page: safePage, pageSize, storageReady: true, ...(schemeId ? { schemeFilterApplied: true } : {}) };
    }
    for (let offset = 0; ; offset += chunkSize) {
      const result = repository.pagePlans ? await repository.pagePlans({ source, from, to, schemeId, limit: chunkSize, offset, userId }) : await repository.plans({ source, from, to, limit: chunkSize, offset, userId });
      if (!result.storageReady) return { items: [], total: 0, page: 1, pageSize, storageReady: false };
      const plans = schemeId ? result.items.filter(plan => plan.config_snapshot?.scheme?.id === schemeId) : result.items;
      items.push(...(await summarize(plans)).filter((item) => !state || item.state === state));
      if (result.items.length < chunkSize) break;
    }
    const safePage = Math.min(Math.max(Number(page) || 1, 1), Math.max(1, Math.ceil(items.length / pageSize)));
    return { items: items.slice((safePage - 1) * pageSize, safePage * pageSize), total: items.length, page: safePage, pageSize, storageReady: true, ...(schemeId ? { schemeFilterApplied: true } : {}) };
  }

  async function get(id, userId = null) {
    const found = await repository.plan(id, userId);
    if (!found.storageReady) throw new TeamServiceError(503, 'BATCH_STORAGE_UNAVAILABLE', '批次存储尚未迁移');
    if (!found.plan) throw new TeamServiceError(404, 'BATCH_NOT_FOUND', '批次不存在');
    const runs = (await repository.runsByBatchIds([String(id)], userId)).map(mapRun);
    return detailOf(found.plan, runs);
  }

  async function runs(id, { serviceKey = '', status = '', execution = '', sort = 'scoreAsc', page = 1, pageSize = PAGE_SIZE, userId = null } = {}) {
    const found = await repository.plan(id, userId);
    if (!found.storageReady) throw new TeamServiceError(503, 'BATCH_STORAGE_UNAVAILABLE', '批次存储尚未迁移');
    if (!found.plan) throw new TeamServiceError(404, 'BATCH_NOT_FOUND', '批次不存在');
    const allowed = servicePlans(found.plan).map((service) => service.key);
    if (serviceKey && !allowed.includes(serviceKey)) throw new TeamServiceError(400, 'BATCH_SERVICE_INVALID', '服务筛选无效');
    let items = (await repository.runsByBatchIds([String(id)], userId)).map(mapRun);
    if (serviceKey) items = items.filter((run) => run.serviceKey === serviceKey);
    if (status) items = items.filter((run) => run.status === status);
    if (execution) items = items.filter((run) => run.execution === execution);
    items.sort((left, right) => {
      if (sort === 'startedAtAsc') return Date.parse(left.startedAt) - Date.parse(right.startedAt);
      if (sort === 'startedAtDesc') return Date.parse(right.startedAt) - Date.parse(left.startedAt);
      const leftScore = lowestDisplayScore(left);
      const rightScore = lowestDisplayScore(right);
      if (leftScore === null && rightScore === null) return Date.parse(right.startedAt) - Date.parse(left.startedAt);
      if (leftScore === null) return 1;
      if (rightScore === null) return -1;
      return sort === 'scoreDesc' ? rightScore - leftScore : leftScore - rightScore;
    });
    const safePage = Math.min(Math.max(Number(page) || 1, 1), Math.max(1, Math.ceil(items.length / pageSize)));
    return { batchId: String(id), items: items.slice((safePage - 1) * pageSize, safePage * pageSize).map(publicRun), total: items.length, page: safePage, pageSize };
  }

  async function comparison(id, { against = 'previous', userId = null } = {}) {
    const found = await repository.plan(id, userId);
    if (!found.storageReady) throw new TeamServiceError(503, 'BATCH_STORAGE_UNAVAILABLE', '批次存储尚未迁移');
    if (!found.plan) throw new TeamServiceError(404, 'BATCH_NOT_FOUND', '批次不存在');
    const baseRuns = (await repository.runsByBatchIds([String(id)], userId)).map(mapRun);
    let previousPlan = null;
    if (against && against !== 'previous') {
      const target = await repository.plan(against, userId);
      if (!target.storageReady) throw new TeamServiceError(503, 'BATCH_STORAGE_UNAVAILABLE', '批次存储尚未迁移');
      if (!target.plan) throw new TeamServiceError(404, 'BATCH_NOT_FOUND', '对比批次不存在');
      previousPlan = target.plan;
    } else {
      previousPlan = await repository.previousPlan(found.plan.source, found.plan.calendar_date ?? found.plan.plan_date, userId);
    }
    const previousRuns = previousPlan ? (await repository.runsByBatchIds([String(previousPlan.id)], userId)).map(mapRun) : [];
    return comparisonOf(found.plan, previousPlan, baseRuns, previousRuns);
  }

  return { list, get, runs, comparison };
}

module.exports = { createBatchReadService, SERVICE_LABELS, SERVICE_ORDER };
