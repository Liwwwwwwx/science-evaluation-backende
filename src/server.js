const { createApp } = require('./app');
const { Pool } = require('pg');
const { createAuthRepository } = require('./auth/repository');
const { createAuthService } = require('./auth/service');
const host = process.env.EVALUATION_HOST || '127.0.0.1';
const port = Number(process.env.PORT || 7714);
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid PORT');
const databaseUrl = process.env.EVALUATION_DATABASE_URL;
let publicOrigin = process.env.EVALUATION_PUBLIC_ORIGIN;
let authService;
if (databaseUrl) {
  if (!publicOrigin) throw new Error('EVALUATION_PUBLIC_ORIGIN is required when authentication is enabled');
  const origin = new URL(publicOrigin);
  if (origin.origin !== publicOrigin || (origin.protocol !== 'https:' && !(process.env.NODE_ENV !== 'production' && origin.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(origin.hostname)))) throw new Error('EVALUATION_PUBLIC_ORIGIN must be an HTTPS origin');
  authService = createAuthService(createAuthRepository(new Pool({ connectionString: databaseUrl })));
}
createApp({ token: process.env.EVALUATION_SERVICE_TOKEN, authService, publicOrigin, secureCookies: process.env.NODE_ENV === 'production' || publicOrigin?.startsWith('https:') }).listen(port, host, () => {
  console.log(`Evaluation backend listening on ${host}:${port}`);
});
