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
const { createFeishuTestNotifier } = require('./notifications/feishu-test');
const { createMissionDailyReportRepository } = require('./notifications/mission-daily-report.repository');
const { createMissionDailyReportService } = require('./notifications/mission-daily-report.service');
const { createQuestionBankService } = require('./question-bank/service');
const { createDailyReportRepository } = require('./daily-reports/repository');
const { createDailyReportService } = require('./daily-reports/service');
const { validDate } = require('./daily-reports/summary');
const { createQuestionBankGenerationService } = require('./question-bank/generation');
const { createTrialBatchRepository } = require('./runs/trial-batch.repository');
const { createTrialBatchService, TARGETS } = require('./runs/trial-batch.service');
const { createTrialBatchScheduler } = require('./runs/trial-batch.scheduler');
const { httpSettings } = require('./runtime-config');
const host = process.env.EVALUATION_HOST || '127.0.0.1';
const port = Number(process.env.PORT || 7714);
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid PORT');
const databaseUrl = process.env.EVALUATION_DATABASE_URL;
let publicOrigin = process.env.EVALUATION_PUBLIC_ORIGIN;
let secureCookies = true;
let authService;
let questionBank;
let evaluations;
let missionDaily;
let missionDailyReport;
let dailyReports;
let rules;
let trialScheduler;
if (databaseUrl) {
  ({ publicOrigin, secureCookies } = httpSettings());
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
  const trialDate = process.env.EVALUATION_TRIAL_DATE || '';
  if (trialDate && !validDate(trialDate)) throw new Error('试运行日期无效');
  const serviceAddresses = Object.fromEntries(Object.keys(TARGETS).map(key => [key, evaluators[key]?.serviceAddress || null]));
  if (trialDate && (process.env.EVALUATION_RUN_WRITE_ENABLED !== 'true' || Object.values(serviceAddresses).some(value => !value))) throw new Error('试运行需要启用运行写入和全部六个服务');
  const scoring = createScoringService({ rules });
  evaluations = createUnifiedEvaluationService({ evaluators, scoring, repository: createUnifiedEvaluationRepository({ pgPool: pool }), resolveQuestion: createRunQuestionResolver(questionRepository), maxActive: trialDate ? 26 : 25, serviceLimits: trialDate ? { 'literature-aircraft': 1 } : {} });
  const plans = createMissionDailyRepository({ pgPool: pool });
  missionDaily = createMissionDailyService({ repository: plans, evaluations, scoring,
    serviceAddress: evaluators['mission-material']?.serviceAddress || null,
    enabled: process.env.EVALUATION_MISSION_DAILY_ENABLED === 'true', ready: process.env.EVALUATION_RUN_WRITE_ENABLED === 'true' && !!evaluators['mission-material'], skipDate: day => day === trialDate,
    onError: () => console.error('Mission 每日测评调度暂不可用，将自动重试') });
  if (trialDate) {
    const repository = createTrialBatchRepository({ pgPool: pool });
    const service = createTrialBatchService({ repository, evaluations, scoring, serviceAddresses, generator: createQuestionBankGenerationService() });
    trialScheduler = createTrialBatchScheduler({ date: trialDate, service, repository, missionRepository: plans,
      onError: () => console.error('单日试运行尚未准备或派发完成，请检查试运行计划') });
  }
  const notifier = createFeishuTestNotifier();
  const dailyReportEnabled = process.env.EVALUATION_DAILY_REPORT_ENABLED === 'true';
  dailyReports = createDailyReportService({ repository:createDailyReportRepository(pool, { trialEnabled: 'auto' }), preferred:process.env.EVALUATION_DAILY_REPORT_MODEL || 'deepseek',
    enabled:dailyReportEnabled && process.env.EVALUATION_RUN_WRITE_ENABLED === 'true',
    notifyEnabled:process.env.EVALUATION_DAILY_REPORT_NOTIFY_ENABLED === 'true',notifier,publicOrigin,
    onError:()=>console.error('每日测评报告暂不可用，请查看报告状态') });
  const reportRepository = createMissionDailyReportRepository({ pgPool: pool });
  missionDailyReport = createMissionDailyReportService({ repository: reportRepository, notifier,
    enabled: !dailyReportEnabled && process.env.EVALUATION_MISSION_DAILY_NOTIFY_ENABLED === 'true' && process.env.EVALUATION_MISSION_DAILY_ENABLED === 'true',
    ready: process.env.EVALUATION_RUN_WRITE_ENABLED === 'true' && !!evaluators['mission-material'],
    onError: () => console.error('Mission 每日测试通知暂不可用') });
  evaluations.missionDailyStatus = async () => {
    const info = await missionDaily.status();
    const notification = { enabled: missionDailyReport.enabled, configured: notifier.configured, last: null };
    if (notification.enabled && info.last?.id) {
      try { notification.last = await reportRepository.status(info.last.id); }
      catch { notification.last = { state: 'unavailable', reason: '通知存储暂不可用' }; }
    }
    return { ...info, notification };
  };
}
createApp({ token: process.env.EVALUATION_SERVICE_TOKEN, authService, questionBank, evaluations, rules, dailyReports, reportWriteEnabled:process.env.EVALUATION_DAILY_REPORT_WRITE_ENABLED === 'true', rulesWriteEnabled: process.env.EVALUATION_RULES_WRITE_ENABLED === 'true', runWriteEnabled: process.env.EVALUATION_RUN_WRITE_ENABLED === 'true', questionBankWriteEnabled: process.env.EVALUATION_QUESTION_BANK_WRITE_ENABLED === 'true', publicOrigin, secureCookies }).listen(port, host, () => {
  console.log(`Evaluation backend listening on ${host}:${port}`);
  if (process.env.EVALUATION_RUN_WRITE_ENABLED === 'true') evaluations?.startQueueRecovery({ onError: () => console.error('测评队列恢复暂不可用，将自动重试') });
  missionDaily?.start();
  trialScheduler?.start();
  missionDailyReport?.start();
  dailyReports?.start();
});
