const { createScoringService } = require('./scoring/service');
const { createRuleService } = require('./scoring/rules');
const { createRuleRepository } = require('./scoring/rule-repository');
const { createApp } = require('./app');
const { Pool } = require('pg');
const { createAuthRepository } = require('./auth/repository');
const { createAuthService } = require('./auth/service');
const { createEvalQuestionBankRepository } = require('./question-bank/repository');
const { createUnifiedEvaluationService } = require('./runs/unified-evaluation.service');
const { createUnifiedEvaluationRepository } = require('./runs/unified-evaluation.repository');
const { createRunQuestionResolver } = require('./runs/question-resolver');
const { createLiteratureEvaluator } = require('./runs/literature-evaluator');
const { createMaterialEvaluator } = require('./runs/material-evaluator');
const { createMissionEvaluator } = require('./runs/mission-evaluator');
const { createMissionDailyRepository } = require('./runs/mission-daily.repository');
const { createMissionDailyService } = require('./runs/mission-daily.service');
const { createQuestionBankService } = require('./question-bank/service');
const host = process.env.EVALUATION_HOST || '127.0.0.1';
const port = Number(process.env.PORT || 7714);
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid PORT');
const databaseUrl = process.env.EVALUATION_DATABASE_URL;
let publicOrigin = process.env.EVALUATION_PUBLIC_ORIGIN;
let authService;
let questionBank;
let evaluations;
let missionDaily;
let rules;
if (databaseUrl) {
  if (!publicOrigin) throw new Error('EVALUATION_PUBLIC_ORIGIN is required when authentication is enabled');
  const origin = new URL(publicOrigin);
  if (origin.origin !== publicOrigin || (origin.protocol !== 'https:' && !(process.env.NODE_ENV !== 'production' && origin.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(origin.hostname)))) throw new Error('EVALUATION_PUBLIC_ORIGIN must be an HTTPS origin');
  const pool = new Pool({ connectionString: databaseUrl });
  rules = createRuleService(createRuleRepository(pool));
  authService = createAuthService(createAuthRepository(pool));
  const questionRepository = createEvalQuestionBankRepository({ pool });
  questionBank = createQuestionBankService(questionRepository);
  const evaluators = {};
  if (process.env.EVALUATION_MISSION_MATERIAL_WS_URL) evaluators['mission-material'] = createMissionEvaluator({ url: process.env.EVALUATION_MISSION_MATERIAL_WS_URL });
  if (process.env.EVALUATION_LITERATURE_WS_URL) evaluators.literature = createLiteratureEvaluator({ url: process.env.EVALUATION_LITERATURE_WS_URL });
  if (process.env.EVALUATION_AIRCRAFT_LITERATURE_WS_URL) evaluators['literature-aircraft'] = createLiteratureEvaluator({ serviceKey: 'literature-aircraft', url: process.env.EVALUATION_AIRCRAFT_LITERATURE_WS_URL });
  for (const [serviceKey, name] of [['alloy', 'EVALUATION_ALLOY_WS_URL'], ['synthesis', 'EVALUATION_SYNTHESIS_WS_URL'], ['new-material', 'EVALUATION_NEW_MATERIAL_WS_URL']]) {
    if (process.env[name]) evaluators[serviceKey] = createMaterialEvaluator({ serviceKey, url: process.env[name] });
  }
  const scoring = createScoringService({ rules });
  evaluations = createUnifiedEvaluationService({ evaluators, scoring, repository: createUnifiedEvaluationRepository({ pgPool: pool }), resolveQuestion: createRunQuestionResolver(questionRepository) });
  missionDaily = createMissionDailyService({ repository: createMissionDailyRepository({ pgPool: pool }), evaluations, scoring,
    serviceAddress: evaluators['mission-material']?.serviceAddress || null,
    enabled: process.env.EVALUATION_MISSION_DAILY_ENABLED === 'true', ready: process.env.EVALUATION_RUN_WRITE_ENABLED === 'true' && !!evaluators['mission-material'],
    onError: () => console.error('Mission 每日测评调度暂不可用，将自动重试') });
  evaluations.missionDailyStatus = () => missionDaily.status();
}
createApp({ token: process.env.EVALUATION_SERVICE_TOKEN, authService, questionBank, evaluations, rules, rulesWriteEnabled: process.env.EVALUATION_RULES_WRITE_ENABLED === 'true', runWriteEnabled: process.env.EVALUATION_RUN_WRITE_ENABLED === 'true', questionBankWriteEnabled: process.env.EVALUATION_QUESTION_BANK_WRITE_ENABLED === 'true', publicOrigin, secureCookies: process.env.NODE_ENV === 'production' || publicOrigin?.startsWith('https:') }).listen(port, host, () => {
  console.log(`Evaluation backend listening on ${host}:${port}`);
  if (process.env.EVALUATION_RUN_WRITE_ENABLED === 'true') evaluations?.startQueueRecovery({ onError: () => console.error('测评队列恢复暂不可用，将自动重试') });
  missionDaily?.start();
});
