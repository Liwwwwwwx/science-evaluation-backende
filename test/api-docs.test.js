const test = require('node:test');
const assert = require('node:assert/strict');
const { createApp } = require('../src/app');

const token = 'test-service-token-0123456789012345';

test('接口文档页面加载 Swagger UI 并提供 OpenAPI 规范', async (t) => {
  const server = createApp({ token });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}`;
  const page = await fetch(`${base}/docs`);
  assert.equal(page.status, 200);
  assert.match(page.headers.get('content-type'), /text\/html/);
  const html = await page.text();
  assert.match(html, /swagger-ui-bundle\.js/);
  assert.match(html, /\/openapi\.yaml/);
  const spec = await fetch(`${base}/openapi.yaml`);
  assert.equal(spec.status, 200);
  assert.match(spec.headers.get('content-type'), /text\/yaml/);
  assert.match(await spec.text(), /^openapi: 3\.0\.3/);
  const asset = await fetch(`${base}/docs/assets/swagger-ui-bundle.js`);
  assert.equal(asset.status, 200);
  assert.match(asset.headers.get('content-type'), /application\/javascript/);
  assert.ok((await asset.arrayBuffer()).byteLength > 10000);
});

test('Swagger 静态资源仅白名单可读', async (t) => {
  const server = createApp({ token });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}`;
  assert.equal((await fetch(`${base}/docs/assets/unknown.js`)).status, 404);
  // URL 编码的路径穿越同样无法命中白名单。
  assert.equal((await fetch(`${base}/docs/assets/%2e%2e/package.json`)).status, 404);
  assert.equal((await fetch(`${base}/docs/assets/`)).status, 404);
  assert.equal((await fetch(`${base}/docs`, { method: 'POST' })).status, 404);
  assert.equal((await fetch(`${base}/openapi.yaml`, { method: 'POST' })).status, 404);
});
