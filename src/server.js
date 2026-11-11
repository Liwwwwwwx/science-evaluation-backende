const { createScoringService } = require('./scoring/service');
const { createRuleService } = require('./scoring/rules');
const { createRuleRepository } = require('./scoring/rule-repository');
const { createApp } = require('./app');
const { Pool } = require('pg');
const { createAuthRepository } = require('./auth/repository');
const { createAuthService } = require('./auth/service');
const { createAccountService, createAccountRepository } = require('./auth/accounts');
const { createEvalQuestionBankRepository } = require('./question-bank/repository');
const { createUnifiedEvaluationService } = require('./runs/unified-evaluation.service');
const { createUnifiedEvaluationRepository } = require('./runs/unified-evaluation.repository');
const { createBatchReadRepository } = require('./runs/batch-read.repository');
const { createBatchReadService } = require('./runs/batch-read.service');
const { createRunQuestionResolver } = require('./runs/question-resolver');
const { createLiteratureEvaluator } = require('./runs/literature-evaluator');
const { createMaterialEvaluator } = require('./runs/material-evaluator');
const { createMissionEvaluator } = require('./runs/mission-evaluator');
const { createAlphaRsiEvaluator } = require('./runs/alpha-rsi-evaluator');
const { createMissionDailyRepository } = require('./runs/mission-daily.repository');
const { createMissionDailyService } = require('./runs/mission-daily.service');
const { createFeishuTestNotifier } = require('./notifications/feishu-test');
const { createFeishuDailyNotifier } = require('./notifications/feishu-daily');
const { createMissionDailyReportRepository } = require('./notifications/mission-daily-report.repository');
const { createMissionDailyReportService } = require('./notifications/mission-daily-report.service');
const { createQuestionBankService } = require('./question-bank/service');
const { createDailyReportRepository } = require('./daily-reports/repository');
const { createDailyReportService } = require('./daily-reports/service');
const { createDailyReportSharing } = require('./daily-reports/sharing');
const { validDate } = require('./daily-reports/summary');
const { createQuestionBankGenerationService } = require('./question-bank/generation');
const { createTrialBatchRepository } = require('./runs/trial-batch.repository');
const { createTrialBatchService, TARGETS } = require('./runs/trial-batch.service');
const { createBatchSchemeRepository } = require('./runs/batch-scheme.repository');
const { createManualBatchRepository } = require('./runs/manual-batch.repository');
const { createManualBatchService } = require('./runs/manual-batch.service');
const { createTrialBatchScheduler } = require('./runs/trial-batch.scheduler');
const { createStandardsRepository } = require('./standards/repository');
const { automationEnabled, httpSettings, missionTimeoutMs } = require('./runtime-config');
const host = process.env.EVALUATION_HOST || '127.0.0.1';
const port = Number(process.env.PORT || 7714);
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid PORT');
const databaseUrl = process.env.EVALUATION_DATABASE_URL;
let publicOrigin = process.env.EVALUATION_PUBLIC_ORIGIN;
let secureCookies = true;
let authService;
let accounts;
let questionBank;
let evaluations;
let batches;
let missionDaily;
let missionDailyReport;
let dailyReports;
let reportSharing;
let rules;
let trialScheduler;
let batchSchemes;
let nightlyEnabled = null;
let manualBatches;
let standardsRepository;
if (databaseUrl) {
  ({ publicOrigin, secureCookies } = httpSettings());
  const pool = new Pool({ connectionString: databaseUrl });
  pool.on('error', () => console.error('数据库空闲连接断开，后续请求将重新连接'));
  rules = createRuleService(createRuleRepository(pool));
  authService = createAuthService(createAuthRepository(pool));
  accounts = createAccountService(createAccountRepository(pool));
  const questionRepository = createEvalQuestionBankRepository({ pool });
  standardsRepository = createStandardsRepository({ pool, questions: questionRepository });
  questionBank = createQuestionBankService(questionRepository);
  const evaluators = {};
  if (process.env.EVALUATION_MISSION_MATERIAL_WS_URL) evaluators['mission-material'] = createMissionEvaluator({ url: process.env.EVALUATION_MISSION_MATERIAL_WS_URL, timeoutMs: missionTimeoutMs() });
  if (process.env.EVALUATION_ALPHA_RSI_WS_URL) evaluators['alpha-rsi'] = createAlphaRsiEvaluator({ url: process.env.EVALUATION_ALPHA_RSI_WS_URL });
  if (process.env.EVALUATION_LITERATURE_WS_URL) evaluators.literature = createLiteratureEvaluator({ url: process.env.EVALUATION_LITERATURE_WS_URL });
  if (process.env.EVALUATION_AIRCRAFT_LITERATURE_WS_URL) evaluators['literature-aircraft'] = createLiteratureEvaluator({ serviceKey: 'literature-aircraft', url: process.env.EVALUATION_AIRCRAFT_LITERATURE_WS_URL });
  for (const [serviceKey, name] of [['alloy', 'EVALUATION_ALLOY_WS_URL'], ['synthesis', 'EVALUATION_SYNTHESIS_WS_URL'], ['new-material', 'EVALUATION_NEW_MATERIAL_WS_URL']]) {
    if (process.env[name]) evaluators[serviceKey] = createMaterialEvaluator({ serviceKey, url: process.env[name] });
  }
  const automation = automationEnabled();
  const trialDate = automation ? process.env.EVALUATION_TRIAL_DATE || '' : '';
  const dailyMultiService = automation && process.env.EVALUATION_DAILY_MULTI_SERVICE_ENABLED === 'true';
  nightlyEnabled = dailyMultiService;
  if (trialDate && !validDate(trialDate)) throw new Error('试运行日期无效');
  const serviceAddresses = Object.fromEntries(Object.keys(TARGETS).map(key => [key, evaluators[key]?.serviceAddress || null]));
  if ((trialDate || dailyMultiService) && process.env.EVALUATION_RUN_WRITE_ENABLED !== 'true') throw new Error('自动测评需要启用运行写入');
  const scoring = createScoringService({ rules });
  evaluations = createUnifiedEvaluationService({ evaluators, scoring, repository: createUnifiedEvaluationRepository({ pgPool: pool }), resolveQuestion: createRunQuestionResolver(questionRepository), maxActive: trialDate || dailyMultiService ? 26 : 25, maxQueued: 350, serviceLimits: { 'literature-aircraft': 1 }, executionTimeoutMs: { 'mission-material': missionTimeoutMs(), default: 60 * 60 * 1000 } });
  batches = createBatchReadService({ repository: createBatchReadRepository({ pgPool: pool }) });
  const plans = createMissionDailyRepository({ pgPool: pool });
  batchSchemes = createBatchSchemeRepository({ pgPool: pool });
  const trialRepository = createTrialBatchRepository({ pgPool: pool });
  const generator = createQuestionBankGenerationService();
  const trialService = createTrialBatchService({ repository: trialRepository, evaluations, scoring, serviceAddresses, generator, schemes: batchSchemes });
  manualBatches = createManualBatchService({ repository: createManualBatchRepository({ pgPool: pool, schemes: batchSchemes }), evaluations, scoring, serviceAddresses, generator, trialService, schemes: batchSchemes, onError: () => console.error('手动组合测评暂不可用，请检查批次状态') });
  missionDaily = createMissionDailyService({ repository: plans, evaluations, scoring,
    serviceAddress: evaluators['mission-material']?.serviceAddress || null,
    enabled: automation && process.env.EVALUATION_MISSION_DAILY_ENABLED === 'true', ready: process.env.EVALUATION_RUN_WRITE_ENABLED === 'true' && !!evaluators['mission-material'], skipDate: day => dailyMultiService || day === trialDate,
    onError: () => console.error('Mission 每日测评调度暂不可用，将自动重试') });
  if (trialDate || dailyMultiService) {
    trialScheduler = createTrialBatchScheduler({ date: trialDate, daily: dailyMultiService, service: trialService, repository: trialRepository, missionRepository: plans,
      onError: () => console.error('自动测评尚未准备或派发完成，请检查服务地址、对比存储及未完成任务') });
  }
  const notifier = createFeishuTestNotifier();
  const dailyReportEnabled = automation && process.env.EVALUATION_DAILY_REPORT_ENABLED === 'true';
  reportSharing = createDailyReportSharing({ publicOrigin });
  dailyReports = createDailyReportService({ repository:createDailyReportRepository(pool, { trialEnabled: 'auto' }), preferred:process.env.EVALUATION_DAILY_REPORT_MODEL || 'deepseek',
    enabled:dailyReportEnabled && process.env.EVALUATION_RUN_WRITE_ENABLED === 'true',
    notifyEnabled:process.env.EVALUATION_DAILY_REPORT_NOTIFY_ENABLED === 'true',notifier:createFeishuDailyNotifier(),sharing:reportSharing,publicOrigin,
    onError:result=>console.error('每日测评报告暂不可用，请查看报告状态', result?.deliveries || '') });
  const reportRepository = createMissionDailyReportRepository({ pgPool: pool });
  missionDailyReport = createMissionDailyReportService({ repository: reportRepository, notifier,
    enabled: automation && !dailyReportEnabled && process.env.EVALUATION_MISSION_DAILY_NOTIFY_ENABLED === 'true' && process.env.EVALUATION_MISSION_DAILY_ENABLED === 'true',
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
createApp({ token: process.env.EVALUATION_SERVICE_TOKEN, authService, accounts, questionBank, evaluations, batches, batchSchemes, manualBatches, rules, dailyReports, reportSharing, standardsRepository, reportWriteEnabled:process.env.EVALUATION_DAILY_REPORT_WRITE_ENABLED === 'true', rulesWriteEnabled: process.env.EVALUATION_RULES_WRITE_ENABLED === 'true', runWriteEnabled: process.env.EVALUATION_RUN_WRITE_ENABLED === 'true', nightlyEnabled, questionBankWriteEnabled: process.env.EVALUATION_QUESTION_BANK_WRITE_ENABLED === 'true', publicOrigin, secureCookies }).listen(port, host, () => {
  console.log(`Evaluation backend listening on ${host}:${port}`);
  if (process.env.EVALUATION_RUN_WRITE_ENABLED === 'true' && process.env.EVALUATION_QUEUE_RECOVERY_ENABLED !== 'false') evaluations?.startQueueRecovery({ onError: () => console.error('测评队列恢复暂不可用，将自动重试') });
  if (process.env.EVALUATION_RUN_WRITE_ENABLED === 'true') evaluations?.startTimeoutRecovery({ onError: () => console.error('超时运行检查暂不可用，将自动重试') });
  if (process.env.EVALUATION_RUN_WRITE_ENABLED === 'true' && process.env.EVALUATION_QUEUE_RECOVERY_ENABLED !== 'false') manualBatches?.start();
  missionDaily?.start();
  trialScheduler?.start();
  missionDailyReport?.start();
  dailyReports?.start();
});
