const { randomUUID } = require('node:crypto');
const { TeamServiceError } = require('../errors');
const { fingerprintOf, fixedDatasetVersionOf, fixedQuestionId, randomQuestionId } = require('./identity');
const cases = require('./builtin-cases.json');
const { DOMAINS } = require('./domains');

const services = new Set(['mission-material', 'alpha-rsi', 'alloy', 'literature', 'literature-aircraft', 'synthesis', 'new-material']);
function fail(status, code, message) { throw new TeamServiceError(status, code, message); }
function validateQuestion(value, serviceKey) {
  const max = serviceKey === 'synthesis' ? 200 : 500;
  if (typeof value !== 'string' || value.trim().length < 8 || value.trim().length > max) fail(400, 'FIXED_CASE_QUESTION_INVALID', `题面需为 8-${max} 字符`);
  return value.trim();
}
function version(input) {
  if (!input || typeof input.datasetVersion !== 'string' || !input.datasetVersion.trim() || input.datasetVersion.length > 100) fail(400, 'FIXED_CASE_DATASET_VERSION_REQUIRED', '缺少有效的数据集版本');
  return input.datasetVersion.trim();
}
function createQuestionBankService(repo) {
  return {
    async get(id, datasetVersion) {
      if (typeof id !== 'string' || !id || id.length > 200) fail(400, 'INVALID_QUESTION_ID', '题目 ID 无效');
      if (typeof datasetVersion !== 'string' || !datasetVersion || datasetVersion.length > 100) fail(400, 'INVALID_DATASET_VERSION', '数据集版本无效');
      const question = await repo.getQuestion(id, datasetVersion);
      if (!question) fail(404, 'QUESTION_NOT_FOUND', '题目不存在');
      return question;
    },
    async list(query) {
      const serviceKey = query.get('service') || null;
      const sourceType = query.get('source') || null;
      const domainKey = query.get('domain') || null;
      const runnableFor = query.get('runnableFor') || null;
      const status = query.get('status') || 'active';
      const search = (query.get('search') || '').trim();
      const limit = Number(query.get('limit') || 20); const offset = Number(query.get('offset') || 0);
      if ((runnableFor && !services.has(runnableFor)) || (domainKey && domainKey !== 'unclassified' && !Object.hasOwn(DOMAINS, domainKey)) || (serviceKey && !services.has(serviceKey)) || (sourceType && !['fixed', 'random'].includes(sourceType)) || status !== 'active' || search.length > 500 || !Number.isInteger(limit) || limit < 1 || limit > 100 || !Number.isInteger(offset) || offset < 0 || offset > 1000000) fail(400, 'INVALID_QUERY', '题库查询参数无效');
      if (!sourceType || sourceType === 'fixed') {
        const relevant = cases.filter(c => !serviceKey || c.serviceKey === serviceKey);
        const baselines = relevant.map(c => ({ serviceKey: c.serviceKey, caseId: c.id, questionId: fixedQuestionId(c.serviceKey, c.id), datasetVersion: fixedDatasetVersionOf(c.serviceKey, cases.filter(x => x.serviceKey === c.serviceKey)) }));
        if ((await repo.findMissingFixedCaseBaselines(baselines)).length) fail(503, 'FIXED_CASE_BASELINE_MISSING', '内置固定案例基线尚未登记');
      }
      return repo.listQuestionsPaged({ serviceKey, domainKey, runnableFor, sourceType, status, search: search || null, limit, offset });
    },
    async import(input) {
      if (!input || !Array.isArray(input.items) || input.items.length < 1 || input.items.length > 100) fail(400, 'FIXED_CASE_ITEMS_INVALID', 'items 需为 1-100 条');
      const seen = new Set();
      const items = input.items.map((item, i) => {
        if (item && item.domainKey && (!Object.hasOwn(DOMAINS, item.domainKey) || item.serviceKey)) fail(400, 'QUESTION_DOMAIN_INVALID', `第 ${i + 1} 条领域无效或同时指定了服务`);
        if (item && Object.hasOwn(DOMAINS, item.domainKey)) {
          const question = validateQuestion(item.question); const fingerprint = fingerprintOf(question); const key = `${item.domainKey}:${fingerprint}`;
          if (seen.has(key)) fail(409, 'FIXED_CASE_DUPLICATE', `第 ${i + 1} 条固定案例重复`);
          seen.add(key);
          return { id: `fixed-upload:domain:${randomUUID()}`, domainKey: item.domainKey, serviceKey: null, question, fingerprint, datasetVersion: 'fixed-upload-v1' };
        }
        if (!item || typeof item.serviceKey !== 'string' || !services.has(item.serviceKey.trim())) fail(400, 'FIXED_CASE_SERVICE_INVALID', `第 ${i + 1} 条领域或服务无效`);
        const serviceKey = item.serviceKey.trim(); const question = validateQuestion(item.question, serviceKey); const fingerprint = fingerprintOf(question); const key = `${serviceKey}:${fingerprint}`;
        if (seen.has(key) || cases.some(c => c.serviceKey === serviceKey && fingerprintOf(c.question) === fingerprint)) fail(409, 'FIXED_CASE_DUPLICATE', `第 ${i + 1} 条固定案例重复`);
        seen.add(key);
        return { id: `fixed-upload:${serviceKey}:${fingerprint}`, layer: 'base', sourceType: 'fixed', serviceKey, question, fingerprint, datasetVersion: 'fixed-upload-v1' };
      });
      return { items: await repo.insertFixedQuestionsAtomic(items) };
    },
    async saveRandom(input) {
      if (!input || !Array.isArray(input.items) || input.items.length < 1 || input.items.length > 10) fail(400, 'RANDOM_QUESTION_ITEMS_INVALID', '一次可保存 1-10 道随机题');
      const seen = new Set();
      const items = input.items.map((item, i) => {
        if (item && item.domainKey && (!Object.hasOwn(DOMAINS, item.domainKey) || item.serviceKey)) fail(400, 'QUESTION_DOMAIN_INVALID', `第 ${i + 1} 条领域无效或同时指定了服务`);
        if (item && Object.hasOwn(DOMAINS, item.domainKey)) {
          const question = validateQuestion(item.question); const fingerprint = fingerprintOf(question); const key = `${item.domainKey}:${fingerprint}`;
          if (!fingerprint || seen.has(key)) fail(409, 'RANDOM_QUESTION_DUPLICATE', `第 ${i + 1} 条随机题与本批题目重复`);
          seen.add(key);
          return { id: `rnd:domain:${randomUUID()}`, domainKey: item.domainKey, serviceKey: null, question, fingerprint, datasetVersion: 'gen-v1' };
        }
        if (!item || typeof item.serviceKey !== 'string' || !services.has(item.serviceKey.trim())) fail(400, 'RANDOM_QUESTION_SERVICE_INVALID', `第 ${i + 1} 条领域或服务无效`);
        const serviceKey = item.serviceKey.trim(); const question = validateQuestion(item.question, serviceKey); const fingerprint = fingerprintOf(question); const key = `${serviceKey}:${fingerprint}`;
        if (!fingerprint || seen.has(key)) fail(409, 'RANDOM_QUESTION_DUPLICATE', `第 ${i + 1} 条随机题与本批题目重复`);
        seen.add(key);
        return { id: randomQuestionId(serviceKey, fingerprint), serviceKey, question, fingerprint, datasetVersion: 'gen-v1' };
      });
      return repo.insertRandomQuestionsAtomic(items);
    },
    async setDomain(id, input) {
      const datasetVersion = version(input);
      if (!input || !Object.hasOwn(DOMAINS, input.domainKey)) fail(400, 'QUESTION_DOMAIN_INVALID', '请选择有效领域');
      return { question: await repo.setQuestionDomain(id, datasetVersion, input.domainKey) };
    },
    async update(id, input) {
      const datasetVersion = version(input); const current = await repo.getQuestion(id, datasetVersion);
      if (!current) fail(404, 'QUESTION_NOT_FOUND', '题目不存在');
      if (current.layer !== 'base' || !['fixed', 'random'].includes(current.sourceType)) fail(400, 'FIXED_CASE_NOT_EDITABLE', '只有固定题和随机题可以编辑');
      if (current.status !== 'active') fail(409, 'FIXED_CASE_VERSION_CONFLICT', '题目版本已停用，请刷新后重试');
      const question = validateQuestion(input.question, current.serviceKey); const fingerprint = fingerprintOf(question);
      const builtin = cases.find(c => `${c.serviceKey}:${c.id}` === id);
      const questionRow = builtin ? await repo.updateBuiltinFixedQuestionVersion({ caseDef: { ...builtin, fingerprint: fingerprintOf(builtin.question) }, datasetVersion, question, fingerprint }) : await repo.updateFixedQuestionVersion({ id, datasetVersion, question, fingerprint, sourceType: current.sourceType });
      return { question: questionRow };
    },
    async retire(id, input) {
      const datasetVersion = version(input); const current = await repo.getQuestion(id, datasetVersion);
      if (!current) fail(404, 'QUESTION_NOT_FOUND', '题目不存在');
      const builtin = cases.find(c => `${c.serviceKey}:${c.id}` === id);
      const question = builtin ? await repo.retireBuiltinFixedQuestion({ caseDef: { ...builtin, fingerprint: fingerprintOf(builtin.question) }, datasetVersion, reason: 'manual delete' }) : await repo.retireFixedQuestion({ id, datasetVersion, sourceType: current.sourceType, reason: 'manual delete' });
      return { question };
    },
  };
}
module.exports = { createQuestionBankService };
