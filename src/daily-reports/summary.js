const { createHash } = require('node:crypto');
const { DOMAINS } = require('../question-bank/domains');
const SERVICES = { 'mission-material':'Mission 主服务', literature:'文献检索', 'literature-aircraft':'航空文献', alloy:'合金材料', synthesis:'合成制备', 'new-material':'新材料', 'alpha-rsi':'1110' };
const JUDGES = { deepSeekScore:'DeepSeek', qwenScore:'千问' };
function validDate(value) { return typeof value === 'string' && /^20\d{2}-\d{2}-\d{2}$/.test(value) && Number.isFinite(Date.parse(value)) && new Date(value).toISOString().slice(0,10) === value; }
function nightDate(now) { return new Date(now.getTime() + 8*3600000 - 22*3600000).toISOString().slice(0,10); }
function deadline(day) { return new Date(Date.parse(`${day}T22:00:00+08:00`) + 8*3600000); }
function pending(run) { return !['done','error'].includes(run.status) || !run.finishedAt || Object.values(run.scores || {}).some(score => score?.status === 'pending'); }
function execution(run) { return run.run?.status === 'error' || run.status === 'error' && !run.run?.status ? /超时|timeout/i.test(run.error || run.run?.error || '') ? 'timeout' : 'failed' : run.run?.status === 'done' || run.status === 'done' && !run.run?.status ? 'completed' : 'unfinished'; }
function scoreGroups(runs, key) {
  const groups = new Map(); const states = { ready:0, provisional:0, pending:0, failed:0, unavailable:0, absent:0, invalid:0 };
  for (const run of runs) {
    const item = run.scores?.[key];
    if (!item) { states.absent++; continue; }
    if (item.status !== 'ready') { states[Object.hasOwn(states,item.status) ? item.status : 'absent']++; continue; }
    const value = item.quality?.total;
    if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 100) { states.invalid++; continue; }
    if (run.answerTruncated || item.quality?.source?.truncated) { states.provisional++; continue; }
    states.ready++;
    const rule = run.ruleSnapshot || run.run?.ruleSnapshot || run.run?.scoring?.ruleSnapshot;
    // Unknown historical rules are not assumed comparable to any other run.
    const signature = `${rule?.hash || `unknown:${run.runId}`}|${item.model || 'unknown'}`;
    if (!groups.has(signature)) groups.set(signature,{ rule:rule?.name || '未记录规则', ruleHash:rule?.hash || null, model:item.model || null, count:0, sum:0, taskCompleted:0 });
    const group = groups.get(signature); group.count++; group.sum+=value;
    if (item.quality?.taskCompletion?.status === 'completed') group.taskCompleted++;
  }
  return { states, groups:[...groups.values()].map(({sum,...group})=>({...group,mean:Math.round(sum/group.count*10)/10})) };
}
function metrics(runs) {
  const counts = { total:runs.length, completed:0, failed:0, timeout:0, unfinished:0 };
  const elapsed=[];
  for (const run of runs) { counts[execution(run)]++; if (typeof run.run?.elapsedMs==='number' && Number.isFinite(run.run.elapsedMs) && run.run.elapsedMs>=0) elapsed.push(run.run.elapsedMs); }
  return { ...counts, maxElapsedMs:elapsed.length?Math.max(...elapsed):null, scores:Object.fromEntries(Object.keys(JUDGES).map(key=>[key,scoreGroups(runs,key)])) };
}
function snapshotOf(day, source, now = new Date()) {
  const runs=source.runs;
  const trialItems=source.trialPlan?.items && typeof source.trialPlan.items==='object' ? source.trialPlan.items : {};
  const services=[...new Set([...Object.keys(SERVICES),...runs.map(run=>run.serviceKey)])].map(serviceKey=>{
    const rows=runs.filter(run=>run.serviceKey===serviceKey);
    return { serviceKey,label:SERVICES[serviceKey]||serviceKey,expected:Array.isArray(trialItems[serviceKey]) ? trialItems[serviceKey].length : serviceKey==='mission-material' && source.plan ? source.plan.items.length:null,...metrics(rows) };
  }).filter(item=>item.total || item.expected !== null);
  const domains=[...new Set(runs.map(run=>run.domainKey||'unclassified'))].map(key=>({key,label:DOMAINS[key]||'未分类',...metrics(runs.filter(run=>(run.domainKey||'unclassified')===key))}));
  const latest=Math.max(0,...runs.map(run=>Date.parse(run.updatedAt)||0),Date.parse(source.plan?.updatedAt)||0,Date.parse(source.trialPlan?.updatedAt)||0);
  const missionIds=new Set(runs.filter(run=>run.batchId===source.plan?.id).map(run=>`${run.questionId}\0${run.datasetVersion}`));
  const missionMissing=source.plan?.state==='submitted' ? source.plan.items.filter(item=>!missionIds.has(`${item.questionId}\0${item.datasetVersion}`)).length:0;
  const trialMissing=source.trialPlan?.state==='submitted' ? Object.entries(trialItems).reduce((sum,[key,items])=>sum+Math.max(0,items.length-runs.filter(run=>run.batchId===source.trialPlan.id&&run.serviceKey===key).length),0):0;
  const missing=missionMissing+trialMissing;
  const inProgress=runs.some(pending) || source.plan?.state==='dispatching' || ['generating','dispatching'].includes(source.trialPlan?.state) || missing>0;
  const sourceHash=createHash('sha256').update(JSON.stringify({day,plan:source.plan,trialPlan:source.trialPlan,runs})).digest('hex');
  return { date:day,sourceHash,generatedAt:now.toISOString(),...metrics(runs),services,domains,missingPlanned:missing,planState:source.trialPlan?.state||source.plan?.state||null,planReason:source.trialPlan?.error||source.plan?.reason||null,inProgress,deadlineReached:now>=deadline(day),lastSourceUpdate:latest,coverage:'已持久化自动测评；未入库的脚本运行不在统计范围内。' };
}
function analysisCases(runs, budget=55000) {
  const selected=[];
  // Round-robin services prevents one service consuming the whole evidence budget.
  const groups=[...new Set(runs.map(r=>r.serviceKey))].map(key=>runs.filter(r=>r.serviceKey===key).sort((a,b)=>rank(a)-rank(b)));
  function rank(run) { const values=Object.values(run.scores||{}).filter(s=>s?.status==='ready' && typeof s.quality?.total==='number').map(s=>s.quality.total); return execution(run)!=='completed'?-100:values.length?Math.min(...values):101; }
  for(let i=0;groups.some(group=>group[i]);i++) for(const group of groups) {
    const run=group[i];if(!run)continue;
    const item={runId:run.runId,serviceKey:run.serviceKey,domain:DOMAINS[run.domainKey]||'未分类',execution:execution(run),question:String(run.question||'').slice(0,240),answerExcerpt:String(run.answer||'').slice(0,400),error:String(run.error||'').slice(0,120),judges:Object.fromEntries(Object.keys(JUDGES).map(key=>{const score=run.scores?.[key];return[key,{status:score?.status||'absent',comment:String(score?.quality?.comment||'').slice(0,180),gaps:(score?.quality?.gaps||[]).filter(x=>typeof x==='string').slice(0,2).map(x=>x.slice(0,100))}]}))};
    const size=JSON.stringify(item).length;if(size>budget)continue;budget-=size;selected.push(item);
  }
  return selected;
}
function cleanAnalysis(value, cases) {
  const ids=new Set(cases.map(item=>item.runId));
  const text=value=>typeof value==='string' && value.trim() && value.length<=2000 ? value.trim():null;
  if(!value || !text(value.overview))throw new Error('INVALID_REPORT');
  const result={overview:text(value.overview)};
  for(const key of ['issues','highlights','recommendations']) {
    if(!Array.isArray(value[key]) || value[key].length>8)throw new Error('INVALID_REPORT');
    result[key]=value[key].map(item=>{
      if(!text(item.text)||!Array.isArray(item.runIds)||!item.runIds.length||item.runIds.length>10||item.runIds.some(id=>!ids.has(id)))throw new Error('INVALID_REPORT_REFERENCE');
      return{text:text(item.text),runIds:[...new Set(item.runIds)]};
    });
  }
  return result;
}
const escape = value=>String(value??'').replace(/[\\`*_{}\[\]<>#|]/g,'\\$&').replace(/[\r\n]+/g,' ');
function markdownOf(snapshot, {analysis=null,analysisState='unavailable',provider=null,model=null,caseCount=0,publicOrigin=''}={}) {
  const lines=[`# ${snapshot.date} 每日测评总结`,'',`统计周期：北京时间 ${snapshot.date} 22:00 起的夜间测评。`,snapshot.coverage,'',`已记录 ${snapshot.total} 次；执行完成 ${snapshot.completed} 次，失败 ${snapshot.failed} 次，超时 ${snapshot.timeout} 次，未完成 ${snapshot.unfinished} 次。`];
  if(snapshot.missingPlanned)lines.push(`已知计划中仍缺少 ${snapshot.missingPlanned} 条运行记录。`);
  if(snapshot.planReason)lines.push(`计划说明：${escape(snapshot.planReason)}`);
  if(snapshot.inProgress)lines.push('部分任务或评分尚未结束，本报告是截止生成时的快照。');
  lines.push('','## 各服务运行情况','','| 服务 | 已记录 | 完成 | 失败 | 超时 | 未完成 | 最长执行耗时 |','| --- | ---: | ---: | ---: | ---: | ---: | ---: |');
  for(const item of snapshot.services)lines.push(`| ${escape(item.label)} | ${item.total} | ${item.completed} | ${item.failed} | ${item.timeout} | ${item.unfinished} | ${item.maxElapsedMs===null?'未记录':`${(item.maxElapsedMs/1000).toFixed(1)} 秒`} |`);
  lines.push('','## 独立评分','','不同规则或模型版本分组统计；截断输入的参考分单独计数，不计入均分。');
  for(const item of snapshot.services)for(const [key,label]of Object.entries(JUDGES)){
    const score=item.scores[key];lines.push('',`### ${escape(item.label)} · ${label}`,'');
    if(!score.groups.length)lines.push('暂无可计算均分的有效完整评分。');
    for(const group of score.groups)lines.push(`- ${escape(group.rule)} / ${escape(group.model||'未记录模型')}：${group.mean} / 100，${group.count} 条评分；任务完成 ${group.taskCompleted} 条（模型判断）。`);
    lines.push(`- 评分中 ${score.states.pending}，评分失败 ${score.states.failed}，未配置 ${score.states.unavailable}，缺失 ${score.states.absent}，无效 ${score.states.invalid}，参考分 ${score.states.provisional}。`);
  }
  lines.push('','## 领域覆盖','',...snapshot.domains.map(item=>`- ${escape(item.label)}：${item.total} 次，完成 ${item.completed} 次。`),'','## 智能总结','');
  if(analysis){
    lines.push(`由 ${escape(provider)} / ${escape(model)} 汇总，阅读 ${caseCount}/${snapshot.total} 条案例摘要。`,'',escape(analysis.overview));
    for(const [key,label]of [['issues','主要问题'],['highlights','重点案例'],['recommendations','改进建议']]){
      lines.push('',`### ${label}`,'');
      if(!analysis[key].length)lines.push('没有形成有案例支持的结论。');
      for(const item of analysis[key])lines.push(`- ${escape(item.text)} ${item.runIds.map(id=>`[案例 ${escape(id.slice(0,8))}](${publicOrigin}/runs/${encodeURIComponent(id)})`).join('、')}`);
    }
  }else lines.push(snapshot.total===0?'本轮没有已记录案例，仅展示计划状态。':analysisState==='failed'?'模型汇总失败，已保留完整统计，可仅重试总结。':'未配置可用的汇总模型，已保留统计。');
  lines.push('','模型结论仅是对已有记录的归纳，不代表独立科学验证。各服务题目分布不同，不据均分直接排列优劣。','');
  return lines.join('\n');
}
module.exports={SERVICES,JUDGES,validDate,nightDate,deadline,pending,execution,snapshotOf,analysisCases,cleanAnalysis,markdownOf};
