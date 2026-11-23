const maxCount = '(?:最多|至多|不超过)([1-9]\\d{0,4})组';
const candidate = '候选(?:成分方案|成分|配方方案|配方|方案)?';
const delivery = new RegExp(`^(?:请)?(?:给出|提供|输出|返回|交付|推荐)${maxCount}${candidate}$`);
const limit = new RegExp(`^${candidate}(?:的)?(?:数|数量|组数)${maxCount}$`);
const normalize = text => text.normalize('NFKC').replace(/\s+/g, '');

// 只使用本轮资料中与最终任务 ID 和交付清单相符的优化结果，不计搜索历史及候选提案。
function readCandidateCount(job, json, url) {
  const result = job.run?.details?.result;
  const taskId = job.run?.details?.autoRetry?.taskId || job.nativeRunId || job.run?.taskId;
  if (job.serviceKey !== 'alpha-rsi' || typeof taskId !== 'string' || !taskId
    || result?.taskid !== taskId || json?.request_id !== taskId || json?.ok !== true || json.operation !== 'optimize') return null;
  if (result.delivery_summary?.independent_cases === true || result.case_results?.length > 0) return null;
  const listed = Array.isArray(result.artifacts) && result.artifacts.some(file => {
    if (typeof file?.url !== 'string' || !file.url) return false;
    try {
      const declared = new URL(file.url, url);
      declared.hash = '';
      return declared.href === url;
    } catch { return false; }
  });
  const rows = json.result?.pareto_front;
  if (!listed || !Array.isArray(rows)) return null;

  const ids = new Set();
  let feasible = 0;
  for (const row of rows) {
    const id = row?.candidate_id;
    if (typeof id !== 'string' || !id.trim() || ids.has(id)) return null;
    ids.add(id);
    const composition = row.composition?.values;
    if (row.feasible === true && row.physical_valid === true && composition && typeof composition === 'object'
      && Object.values(composition).some(amount => Number.isFinite(amount) && amount > 0)) feasible++;
  }
  if (rows.length ? !ids.has(result.priority_candidate_id) : result.priority_candidate_id) return null;
  return { count: rows.length, feasible };
}

function candidateCountChecks(question, rubric, result) {
  if (!result) return [];
  const original = normalize(question);
  const clauses = original.split(/[，,。；;！？!?：:]/);
  const maxima = clauses.map(clause => delivery.exec(clause)).filter(Boolean);
  // 复合数量条件或无法直接回到题面的要求，继续按冻结清单由评委核验。
  if (maxima.length !== 1 || /(?:至少|最少|不少于|不低于|不得少于|起码)(?:给出|提供|输出|返回|交付|推荐)?[\d一二两三四五六七八九十百]+组|[\d一二两三四五六七八九十百]+组(?:起|以上)/.test(original)) return [];
  const maximum = Number(maxima[0][1]);
  const { count, feasible, source, quote } = result;
  return rubric.requirements.flatMap(item => {
    if (item.scope === 'all') return [];
    const constraint = item.kind === 'constraint';
    const match = (constraint ? limit : delivery).exec(normalize(item.requirement));
    if (!match || Number(match[1]) !== maximum) return [];
    const over = count > maximum;
    const status = constraint ? (over ? 'missing' : 'met') : !feasible ? 'missing' : over ? 'partial' : 'met';
    const countNote = `交付 ${count} 组候选，${over ? '超过' : '符合'}最多 ${maximum} 组的数量上限。`;
    const note = constraint ? countNote : `${countNote}其中 ${feasible} 组由服务标记为可行且通过物理校验。`;
    return [{ id: item.id, status, note, source, quote, count, feasible, maximum }];
  });
}

module.exports = { readCandidateCount, candidateCountChecks };
