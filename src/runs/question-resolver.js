const { TeamServiceError } = require('../errors');
function createRunQuestionResolver(repository) {
  return async input => {
    if (typeof input.question !== 'string') throw new TeamServiceError(400, 'QUESTION_TEXT_INVALID', '请输入有效题面');
    const row = await repository.getQuestion(input.questionId, input.datasetVersion);
    if (!row) throw new TeamServiceError(404, 'QUESTION_NOT_FOUND', '题目不存在');
    const applicable = Array.isArray(row.applicableServices) ? row.applicableServices : [];
    const bound = row.serviceKey ? row.serviceKey === input.serviceKey || applicable.includes(input.serviceKey) : applicable.length === 0 || applicable.includes(input.serviceKey);
    if (row.layer !== 'base' || row.status !== 'active' || row.sourceType !== input.sourceType || !bound) {
      throw new TeamServiceError(409, 'QUESTION_NOT_RUNNABLE', '题目已停用或不适用于当前服务，请重新选择');
    }
    if (row.question.trim() !== input.question.trim()) throw new TeamServiceError(409, 'QUESTION_TEXT_CONFLICT', '题目已变化，请重新选择版本');
    if (row.criteria) throw new TeamServiceError(409, 'QUESTION_RULES_UNSUPPORTED', '该旧题带有专属评分规则，首版运行暂不支持，请选择领域题或不带规则的题目');
    return null;
  };
}
module.exports = { createRunQuestionResolver };
