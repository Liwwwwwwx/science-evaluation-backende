const { test } = require('node:test');
const assert = require('node:assert/strict');
const { readRunArtifact, MAX_ARTIFACT_BYTES } = require('../src/runs/artifacts');
const { createApp } = require('../src/app');
function run(url = 'http://127.0.0.1:1115/new-material/tasks/task-1/assets/model.glb') {
  return { nativeRunId: 'task-1', run: { serviceAddress: 'ws://127.0.0.1:1115/new-material/start', details: { artifacts: [{ url }] } } };
}
test('产物只读代理按运行内索引读取，保持GLB字节并禁止重定向', async () => {
  let calls = 0;
  const result = await readRunArtifact(run(), 0, { fetchImpl: async (url, options) => {
    calls++; assert.equal(url.pathname, '/new-material/tasks/task-1/assets/model.glb'); assert.equal(options.redirect, 'error'); assert.ok(options.signal);
    return new Response(new Uint8Array([0x67, 0x6c, 0x54, 0x46, 0]));
  } });
  assert.equal(calls, 1); assert.equal(result.contentType, 'model/gltf-binary'); assert.equal(result.filename, 'model.glb'); assert.deepEqual([...result.body], [103, 108, 84, 70, 0]);
});
test('代理拒绝缺失索引、任意URL、其他任务、凭据、重编码、SVG和未知类型', async () => {
  const never = async () => { throw Error('不应联网'); };
  for (const index of [-1, 1, 0.5, NaN]) await assert.rejects(readRunArtifact(run(), index, { fetchImpl: never }), { status: 404 });
  for (const url of ['http://evil.invalid/a.png', 'http://127.0.0.1:1115/new-material/tasks/other/assets/a.png', 'http://u:p@127.0.0.1:1115/files/a.png', 'http://127.0.0.1:1115/files/%252e.png', 'file:///tmp/a.png', 'http://127.0.0.1:1115/files/%2fetc.png']) await assert.rejects(readRunArtifact(run(url), 0, { fetchImpl: never }), { status: 403 });
  for (const extension of ['svg', 'html', 'js', 'exe']) await assert.rejects(readRunArtifact(run(`http://127.0.0.1:1115/files/a.${extension}`), 0, { fetchImpl: never }), { status: 415 });
});
test('代理允许固定公开产物源，对上游失败与大小超限给出可恢复错误', async () => {
  assert.equal((await readRunArtifact(run('https://www.science42.tech/alpha/materials/modelfiles/a.png'), 0, { fetchImpl: async () => new Response('png') })).contentType, 'image/png');
  for (const fetchImpl of [async () => new Response('', { status: 404 }), async () => { throw Error('redirect'); }]) await assert.rejects(readRunArtifact(run(), 0, { fetchImpl }), { status: 502 });
  await assert.rejects(readRunArtifact(run(), 0, { fetchImpl: async () => new Response('x', { headers: { 'content-length': String(MAX_ARTIFACT_BYTES + 1) } }) }), { status: 413 });
  await assert.rejects(readRunArtifact(run(), 0, { fetchImpl: async () => new Response(new Uint8Array(MAX_ARTIFACT_BYTES + 1)) }), { status: 413 });
});
test('HTTP产物读取保留会话与读权限校验，无产物404，非法ID400', async t => {
  const server = createApp({ token: 'x'.repeat(32), publicOrigin: 'http://localhost', authService: { authenticate: async token => {
    if (!token) throw Object.assign(Error('请登录'), { status: 401 });
    return { id: token, permissions: token === 'reader' ? ['team-services:read'] : [] };
  } }, evaluations: { get: async () => run() } });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); t.after(() => server.close());
  const root = `http://127.0.0.1:${server.address().port}/api/evaluation/unified/runs`;
  const url = `${root}/11111111-1111-4111-8111-111111111111/artifacts/1`;
  assert.equal((await fetch(url)).status, 401);
  assert.equal((await fetch(url, { headers: { cookie: 'evaluation_session=denied' } })).status, 403);
  assert.equal((await fetch(url, { headers: { cookie: 'evaluation_session=reader' } })).status, 404);
  assert.equal((await fetch(`${root}/bad-id/artifacts/0`, { headers: { cookie: 'evaluation_session=reader' } })).status, 400);
  assert.equal((await fetch(url, { method: 'POST', headers: { cookie: 'evaluation_session=reader' } })).status, 405);
});
