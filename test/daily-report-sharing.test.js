const test = require('node:test');
const assert = require('node:assert/strict');
const { createDailyReportSharing } = require('../src/daily-reports/sharing');
const { createApp } = require('../src/app');

const secret = 'isolated-report-sharing-test-key-123456';
const publicOrigin = 'https://evaluation.example';
const day = '2026-11-05';
const initial = Date.parse('2026-11-06T10:00:00Z');

test('分享链接仅授权指定日期，有效30天，篡改、到期、关闭或更换密钥后不可用', () => {
  let current = initial;
  const sharing = createDailyReportSharing({ secret, publicOrigin, now: () => current });
  const link = sharing.create(day), url = new URL(link.url);
  const expires = url.searchParams.get('expires'), signature = url.searchParams.get('signature');
  assert.equal(url.pathname, `/shared/daily-reports/${day}`);
  assert.equal(Date.parse(link.expiresAt) - initial, 30 * 86400000);
  assert.equal(sharing.verify(day, expires, signature), link.expiresAt);
  assert.equal(sharing.verify('2026-11-04', expires, signature), null);
  assert.equal(sharing.verify(day, String(Number(expires) + 1), signature), null);
  assert.equal(sharing.verify(day, expires, '0'.repeat(64)), null);
  assert.equal(sharing.verify(day, expires, signature + 'x'), null);
  assert.equal(sharing.verify(day, null, signature), null);
  assert.equal(sharing.create('2026-02-30'), null);
  assert.equal(createDailyReportSharing({ secret: secret + 'rotated', publicOrigin }).verify(day, expires, signature), null);
  const disabled = createDailyReportSharing({ secret: '', publicOrigin });
  assert.equal(disabled.create(day), null);
  assert.equal(disabled.verify(day, expires, signature), null);
  assert.throws(() => createDailyReportSharing({ secret: 'short', publicOrigin }), /32/);
  current = Date.parse(link.expiresAt) - 1;
  assert.equal(sharing.verify(day, expires, signature), link.expiresAt);
  current++;
  assert.equal(sharing.verify(day, expires, signature), null);
});

test('匿名分享只读取正文，拒绝列表、篡改、写操作并保留原鉴权', async t => {
  let authCalls = 0, reads = 0, report = { status: 'ready', markdown: '# 日报\n\n公开正文', updatedAt: '2026-11-06T10:00:00Z', snapshot: { secret: 'hidden-snapshot' }, analysis: { internal: true } };
  const sharing = createDailyReportSharing({ secret, publicOrigin, now: () => initial });
  const reports = { async get(date) { reads++; assert.equal(date, day); return report; } };
  const authService = { async authenticate(session) { authCalls++; if (!session) throw Object.assign(Error('请登录'), { status: 401, code: 'UNAUTHORIZED' }); return { permissions: session === 'reader' ? ['team-services:read'] : [] }; } };
  const server = createApp({ token: 'service-token-for-isolated-test-only-123', authService, publicOrigin, dailyReports: reports, reportSharing: sharing });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  const origin = `http://127.0.0.1:${server.address().port}`;
  const link = new URL(sharing.create(day).url);
  const path = `/api/public/daily-reports/${day}${link.search}`;
  const response = await fetch(origin + path);
  assert.equal(response.status, 200);
  assert.deepEqual(Object.keys(await response.json()).sort(), ['date', 'expiresAt', 'markdown', 'updatedAt']);
  assert.equal(authCalls, 0);
  assert.equal(reads, 1);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.equal(response.headers.get('referrer-policy'), 'no-referrer');
  assert.match(response.headers.get('x-robots-tag'), /noindex/);
  assert.equal(response.headers.get('x-content-type-options'), 'nosniff');

  for (const invalid of ['/api/public/daily-reports', `/api/public/daily-reports/${day}`, path.replace(day, '2026-11-04'), path + '&expires=9999999999', path + '&signature=' + '0'.repeat(64), path + '&action=generate', `/api/public/daily-reports/${day}/generate${link.search}`]) {
    assert.equal((await fetch(origin + invalid)).status, 404, invalid);
  }
  for (const method of ['POST', 'PUT', 'DELETE', 'HEAD']) assert.equal((await fetch(origin + path, { method })).status, 405);
  assert.equal(reads, 1);
  const privatePath = `/api/evaluation/unified/daily-reports/${day}`;
  assert.equal((await fetch(origin + privatePath + link.search)).status, 401);
  assert.equal((await fetch(origin + privatePath, { headers: { cookie: 'evaluation_session=denied' } })).status, 403);
  const privateReport = await (await fetch(origin + privatePath, { headers: { cookie: 'evaluation_session=reader' } })).json();
  assert.equal(privateReport.share.url, link.href);

  report = { ...report, status: 'generating' };
  const updating = await fetch(origin + path);
  assert.equal(updating.status, 409);
  assert.doesNotMatch(await updating.text(), /公开正文|hidden-snapshot/);
  report = { ...report, status: 'failed' };
  const interrupted = await fetch(origin + path);
  assert.equal(interrupted.status, 503);
  assert.doesNotMatch(await interrupted.text(), /公开正文|hidden-snapshot/);
  report = null;
  assert.equal((await fetch(origin + path)).status, 404);
  for (const status of [500, 404]) {
    reports.get = async () => { throw Object.assign(Error('private database diagnostic'), { status }); };
    const failed = await fetch(origin + path);
    assert.equal(failed.status, 503);
    assert.doesNotMatch(await failed.text(), /private database/);
  }
});

test('分享未启用时，即使提供旧签名也不读取数据库', async t => {
  const url = new URL(createDailyReportSharing({ secret, publicOrigin, now: () => initial }).create(day).url);
  const server = createApp({ token: 'service-token-for-isolated-test-only-123', dailyReports: { get: async () => assert.fail('禁止读取') } });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  assert.equal((await fetch(`http://127.0.0.1:${server.address().port}/api/public/daily-reports/${day}${url.search}`)).status, 404);
});
