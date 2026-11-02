const { evidence } = require('./evidence');
const CHECKS = {
  irrelevant_details: '无关实现细节', preparation_only: '准备说明替代交付',
  unsupported_completion: '缺乏依据的完成声明', repeated_preparation: '重复准备且未推进',
};
function deliveryPrompt(policy) {
  if (!policy) return '';
  return `\n本轮规则版本：${policy.name} / ${policy.id} / ${policy.version}，权重：${JSON.stringify(policy.config.weights)}。效率仅由机检判断，不能凭模型直觉判耗时异常，也不能把耗时重复扣入专业性。任务标准：${policy.config.completionInstructions}\n内容标准：${policy.config.contentInstructions}\n交付体验标准：${policy.config.experienceInstructions}\n交付与体验字段必须放在同一个顶层JSON对象中，不能追加第二个JSON。每个体验检查恰好一次。过程progress中的说明与最终回答分开评价，只有准备消息不能算交付。用户要求开发、部署或排障时，相关技术内容可以通过，不能只匹配关键词。缺少过程记录时，对整体过程的判断须标明局限；不得臆造用户看见的内容或重复次数。交付判断结合冻结要求和实际成果，不把图片或附件元信息当作已经检查其内容。`;
}
function normalizeDelivery(value,input) {
  const short = text => typeof text === 'string' ? text.slice(0,1200) : '';
  const raw = value.deliveryReview;
  if (!['delivered','partial','not_delivered','unclear'].includes(raw?.status) || !short(raw.note)) throw Error('交付判断结构无效');
  const quote = evidence(raw.evidence,input,'all');
  const deliveryReview = { status: raw.status === 'unclear' || quote.valid ? raw.status : 'unclear',evidence:quote.text,evidenceRefs:quote.refs,note:short(raw.note), ...(!quote.valid && raw.status !== 'unclear' ? {evidenceIssue:true}: {}) };
  if (input.truncated && deliveryReview.status !== 'unclear') deliveryReview.status = 'unclear';
  const checks = Object.entries(CHECKS).map(([id,label]) => {
    const entries = Array.isArray(value.experienceChecks) ? value.experienceChecks.filter(v => v?.id === id) : [];
    if (entries.length !== 1 || !['passed','issue','unclear'].includes(entries[0].status) || !short(entries[0].note)) throw Error('交付体验结构无效');
    const item = entries[0]; const quote = evidence(item.evidence,input,'all');
    let status = item.status === 'issue' && !quote.valid ? 'unclear' : item.status;
    if (status === 'passed' && (input.truncated || input.process?.truncated || (id === 'repeated_preparation' && !input.process?.messages?.length))) status = 'unclear';
    return {id,label,status,evidence:quote.text,evidenceRefs:quote.refs,note:short(item.note),...(!quote.valid && item.status === 'issue' ? {evidenceIssue:true}: {})};
  });
  return { deliveryReview,experienceReview:{status:checks.some(c => c.status === 'issue') ? 'issue' : checks.some(c => c.status === 'unclear') ? 'unclear' : 'passed',checks,
    coverage:input.process?.messages?.length ? 'answer_and_recorded_process' : 'answer_only'} };
}
module.exports = { CHECKS,deliveryPrompt,normalizeDelivery };
