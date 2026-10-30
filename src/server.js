const { createApp } = require('./app');
const { Pool } = require('pg');
const { createAuthRepository } = require('./auth/repository');
const { createAuthService } = require('./auth/service');
const { createEvalQuestionBankRepository } = require('./question-bank/repository');
const { createUnifiedEvaluationService } = require('./runs/unified-evaluation.service');
const { createUnifiedEvaluationRepository } = require('./runs/unified-evaluation.repository');
const { createRunQuestionResolver } = require('./runs/question-resolver');
const { createLiteratureEvaluator } = require('./runs/literature-evaluator');
const { createQuestionBankService } = require('./question-bank/service');
const host = process.env.EVALUATION_HOST || '127.0.0.1';
const port = Number(process.env.PORT || 7714);
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid PORT');
const databaseUrl = process.env.EVALUATION_DATABASE_URL;
let publicOrigin = process.env.EVALUATION_PUBLIC_ORIGIN;
let authService;
let questionBank;
let evaluations;
if (databaseUrl) {
  if (!publicOrigin) throw new Error('EVALUATION_PUBLIC_ORIGIN is required when authentication is enabled');
  const origin = new URL(publicOrigin);
  if (origin.origin !== publicOrigin || (origin.protocol !== 'https:' && !(process.env.NODE_ENV !== 'production' && origin.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(origin.hostname)))) throw new Error('EVALUATION_PUBLIC_ORIGIN must be an HTTPS origin');
  const pool = new Pool({ connectionString: databaseUrl });
  authService = createAuthService(createAuthRepository(pool));
  const questionRepository = createEvalQuestionBankRepository({ pool });
  questionBank = createQuestionBankService(questionRepository);
  const evaluators = {};
  if (process.env.EVALUATION_LITERATURE_WS_URL) evaluators.literature = createLiteratureEvaluator({ url: process.env.EVALUATION_LITERATURE_WS_URL });
  evaluations = createUnifiedEvaluationService({ evaluators, repository: createUnifiedEvaluationRepository({ pgPool: pool }), resolveQuestion: createRunQuestionResolver(questionRepository) });
}
createApp({ token: process.env.EVALUATION_SERVICE_TOKEN, authService, questionBank, evaluations, runWriteEnabled: process.env.EVALUATION_RUN_WRITE_ENABLED === 'true' && !!process.env.EVALUATION_LITERATURE_WS_URL, questionBankWriteEnabled: process.env.EVALUATION_QUESTION_BANK_WRITE_ENABLED === 'true', publicOrigin, secureCookies: process.env.NODE_ENV === 'production' || publicOrigin?.startsWith('https:') }).listen(port, host, () => {
  console.log(`Evaluation backend listening on ${host}:${port}`);
});
