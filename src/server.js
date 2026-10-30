const { createApp } = require('./app');
const { Pool } = require('pg');
const { createAuthRepository } = require('./auth/repository');
const { createAuthService } = require('./auth/service');
const { createEvalQuestionBankRepository } = require('./question-bank/repository');
const { createQuestionBankService } = require('./question-bank/service');
const host = process.env.EVALUATION_HOST || '127.0.0.1';
const port = Number(process.env.PORT || 7714);
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid PORT');
const databaseUrl = process.env.EVALUATION_DATABASE_URL;
let publicOrigin = process.env.EVALUATION_PUBLIC_ORIGIN;
let authService;
let questionBank;
if (databaseUrl) {
  if (!publicOrigin) throw new Error('EVALUATION_PUBLIC_ORIGIN is required when authentication is enabled');
  const origin = new URL(publicOrigin);
  if (origin.origin !== publicOrigin || (origin.protocol !== 'https:' && !(process.env.NODE_ENV !== 'production' && origin.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(origin.hostname)))) throw new Error('EVALUATION_PUBLIC_ORIGIN must be an HTTPS origin');
  const pool = new Pool({ connectionString: databaseUrl });
  authService = createAuthService(createAuthRepository(pool));
  questionBank = createQuestionBankService(createEvalQuestionBankRepository({ pool }));
}
createApp({ token: process.env.EVALUATION_SERVICE_TOKEN, authService, questionBank, questionBankWriteEnabled: process.env.EVALUATION_QUESTION_BANK_WRITE_ENABLED === 'true', publicOrigin, secureCookies: process.env.NODE_ENV === 'production' || publicOrigin?.startsWith('https:') }).listen(port, host, () => {
  console.log(`Evaluation backend listening on ${host}:${port}`);
});
