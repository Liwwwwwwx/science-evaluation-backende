const { createHmac, timingSafeEqual } = require('node:crypto');
const { validDate } = require('./summary');

const SHARE_SECONDS = 30 * 24 * 60 * 60;

function createDailyReportSharing({ secret = process.env.EVALUATION_REPORT_SHARE_SECRET || '', publicOrigin = '', now = Date.now } = {}) {
  if (secret && (typeof secret !== 'string' || Buffer.byteLength(secret) < 32)) throw new Error('日报分享签名密钥至少需要32字节');
  const configured = Boolean(secret && publicOrigin);
  const signatureOf = (day, expires) => createHmac('sha256', secret).update(`daily-report:v1\n${day}\n${expires}`).digest('hex');
  return {
    configured,
    create(day) {
      if (!configured || !validDate(day)) return null;
      const expires = String(Math.floor(now() / 1000) + SHARE_SECONDS);
      const url = new URL(`/shared/daily-reports/${day}`, publicOrigin);
      url.searchParams.set('expires', expires);
      url.searchParams.set('signature', signatureOf(day, expires));
      return { url: url.href, expiresAt: new Date(Number(expires) * 1000).toISOString() };
    },
    verify(day, expires, signature) {
      if (!configured || !validDate(day) || typeof expires !== 'string' || !/^\d{10,11}$/.test(expires)
        || typeof signature !== 'string' || !/^[a-f0-9]{64}$/.test(signature) || Number(expires) <= Math.floor(now() / 1000)) return null;
      if (!timingSafeEqual(Buffer.from(signature, 'hex'), Buffer.from(signatureOf(day, expires), 'hex'))) return null;
      return new Date(Number(expires) * 1000).toISOString();
    },
  };
}

module.exports = { createDailyReportSharing };
