const { test } = require('node:test');
const assert = require('node:assert/strict');
const { discoverRunImages, readRunImages, MAX_IMAGES, MAX_IMAGE_BYTES } = require('../src/scoring/images');
const { readRunArtifact } = require('../src/runs/artifacts');
const { createJudgeClient, createScoringClients } = require('../src/scoring/clients');
const { createScoringService } = require('../src/scoring/service');
const { evidence } = require('../src/scoring/evidence');

const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRFEAAAAASUVORK5CYII=', 'base64');
const dataUrl = `data:image/png;base64,${png.toString('base64')}`;
const job = () => ({ serviceKey: 'new-material', nativeRunId: 'task-1', question: '识别图中的结果', answer: '结果已经提供。', run: { status: 'done', serviceAddress: 'ws://127.0.0.1:1115/new-material/start', details: { artifacts: [{ url: 'http://127.0.0.1:1115/files/figure.png' }] } } });

test('发现运行产物、可见 Markdown 和团队输出图片，去重且跳过隐藏内容和代码示例', () => {
  const value = job();
  value.answer += '\n![图](http://127.0.0.1:1115/files/figure.png)\n<think>![隐藏](http://evil.test/hidden.png)</think>\n```md\n![示例](http://evil.test/code.png)\n```\n`![代码](http://evil.test/inline.png)`';
  value.run.details.displayEvents = [{ type: 'display.team_output', phase: 'end', content: '![团队图](/files/team.jpg)' }];
  const result = discoverRunImages(value);
  assert.deepEqual(result.candidates.map(item => item.id), ['image:1', 'image:2']);
  assert.ok(result.candidates[1].url.endsWith('/files/team.jpg'));
});

test('图片读取复用产物来源限制，拒绝任意地址、伪图片和超限内容', async () => {
  const value = job();
  value.run.details.artifacts.push({ url: 'http://evil.invalid/secret.png' }, { url: 'http://127.0.0.1:1115/files/fake.png' }, { url: 'http://127.0.0.1:1115/files/large.png' });
  const seen = [];
  const readArtifact = (run, index, options) => readRunArtifact(run, index, { ...options, fetchImpl: async (url, request) => {
    seen.push(url.pathname); assert.equal(request.redirect, 'error');
    if (url.pathname.endsWith('fake.png')) return new Response('<html>不是图片</html>');
    if (url.pathname.endsWith('large.png')) return new Response('x', { headers: { 'content-length': String(MAX_IMAGE_BYTES + 1) } });
    return new Response(png);
  } });
  const discovery = discoverRunImages(value);
  const images = await readRunImages(value, discovery, { readArtifact });
  assert.deepEqual(images.map(item => item.id), ['image:1']);
  assert.equal(images[0].dataUrl, dataUrl);
  assert.deepEqual(seen, ['/files/figure.png', '/files/fake.png', '/files/large.png']);
});

test('每轮最多读取六张图片，超出的候选不会被算成已发送', async () => {
  const value = job(); value.run.details.artifacts = Array.from({ length: 8 }, (_, i) => ({ url: `http://127.0.0.1:1115/files/${i}.png` }));
  const discovery = discoverRunImages(value); let reads = 0;
  const images = await readRunImages(value, discovery, { readArtifact: async () => { reads++; return { body: png }; } });
  assert.equal(discovery.candidates.length, 8); assert.equal(reads, MAX_IMAGES); assert.equal(images.length, MAX_IMAGES);
});

test('内嵌图片直接校验内容，不联网；无效图片仍计入未覆盖数量', async () => {
  const value = job(); value.run.details.artifacts = [];
  value.answer = `<img src="${dataUrl}">\n![无效](data:image/png;base64,SGVsbG8=)`;
  const discovery = discoverRunImages(value);
  const images = await readRunImages(value, discovery, { readArtifact: async () => { throw Error('内嵌图片不应联网'); } });
  assert.equal(discovery.candidates.length, 2);
  assert.equal(images.length, 1); assert.equal(images[0].dataUrl, dataUrl);
});

test('正文中的非运行来源图片不发起读取，只记为外部引用', async () => {
  const value = job(); value.run.details.artifacts = [];
  value.answer = '![图](file:///tmp/example.png)\n<img src="http://36.103.236.211:1106/api/v1/images/a/x.jpg">';
  const discovery = discoverRunImages(value);
  const images = await readRunImages(value, discovery, { readArtifact: async () => { throw Error('外部图片不应联网'); } });
  assert.equal(discovery.candidates.length, 0);
  assert.equal(discovery.external, 2);
  assert.equal(images.length, 0);
});

test('视觉客户端以图片内容块发送数据，并尊重明确的模型能力开关', async () => {
  let body;
  const client = createJudgeClient({ apiKey: 'test-only', baseUrl: 'https://model.test', model: 'vision-test', supportsImages: true, fetch: async (_, options) => {
    body = JSON.parse(options.body); return new Response(JSON.stringify({ choices: [{ finish_reason: 'stop', message: { content: '{"ok":true}' } }] }));
  } });
  assert.deepEqual(await client.callJson('判断图片', { images: [{ id: 'image:1', dataUrl }] }), { ok: true });
  assert.deepEqual(body.messages[1].content[2], { type: 'image_url', image_url: { url: dataUrl } });
  assert.ok(!JSON.stringify(body).includes('test-only'));
  const defaults = createScoringClients({ EVALUATION_QWEN_API_KEY: 'x', EVALUATION_DEEPSEEK_API_KEY: 'x' });
  assert.equal(defaults.qwenScore.supportsImages, true); assert.equal(defaults.deepSeekScore.supportsImages, true);
  assert.equal(createScoringClients({ EVALUATION_QWEN_MODEL: 'text-only', EVALUATION_QWEN_VISION_ENABLED: 'false' }).qwenScore.supportsImages, false);
  assert.equal(createScoringClients({ EVALUATION_QWEN_MODEL: 'custom', EVALUATION_QWEN_VISION_ENABLED: 'true' }).qwenScore.supportsImages, true);
});

test('只有收到图片的评委可引用图片，未发送的图片令该评委分数仅供参考', async () => {
  const rubric = { requirements: [{ requirement: '识别图中的结果', critical: true }], visualAidsApplicable: false, visualAidsReason: '无需额外图表' };
  const seen = [];
  const client = supportsImages => ({ model: 'test', supportsImages, isConfigured: () => true, callJson: async (prompt, options) => {
    if (prompt.startsWith('仅根据题目')) return rubric;
    seen.push({ supportsImages, images: options.images || [], prompt });
    return { dimensions: { readability: { score: 80, note: '清楚' }, professionalism: { score: 80, note: '有依据' }, visualAids: { score: null, note: '不适用' } },
      requirements: [{ id: 'R1', status: 'met', evidence: [supportsImages ? 'image:1' : 'answer:0'], note: '已提供' }], comment: '已检查', suggestions: ['继续核对'] };
  } });
  const service = createScoringService({ clients: { deepSeekScore: client(true), qwenScore: client(false) }, imageLoader: async () => [{ id: 'image:1', dataUrl }] });
  const result = await service.score(job());
  const deep = result.scores.deepSeekScore.quality; const qwen = result.scores.qwenScore.quality;
  assert.equal(seen.find(item => item.supportsImages).images.length, 1);
  assert.equal(seen.find(item => !item.supportsImages).images.length, 0);
  assert.deepEqual(deep.source.imageCoverage, { found: 1, sent: 1, overflow: false });
  assert.equal(deep.source.truncated, false); assert.equal(deep.source.imagesInspected, true);
  assert.equal(deep.taskCompletion.requirements[0].evidenceRefs[0].imageId, 'image:1');
  assert.equal(qwen.source.truncated, true); assert.equal(qwen.source.imagesInspected, false);
  assert.equal(qwen.taskCompletion.status, 'unclear');
  assert.equal(evidence(['image:1'], { answer: '', structured: '', images: [] }).valid, false);
  assert.ok(!JSON.stringify(result).includes(dataUrl));
});

test('图片加载异常不破坏文字评分，但必须标记图片未覆盖', async () => {
  const rubric = { requirements: [{ requirement: '说明结果', critical: true }], visualAidsApplicable: false, visualAidsReason: '无需图表' };
  const client = { model: 'test', supportsImages: true, isConfigured: () => true, callJson: async prompt => prompt.startsWith('仅根据题目') ? rubric : {
    dimensions: { readability: { score: 80, note: '清楚' }, professionalism: { score: 80, note: '明确' }, visualAids: { score: null, note: '不适用' } },
    requirements: [{ id: 'R1', status: 'met', evidence: ['answer:0'], note: '有文字' }], comment: '文字可读', suggestions: ['补充图片'] } };
  const result = await createScoringService({ clients: { deepSeekScore: client }, imageLoader: async () => { throw Error('读取失败'); } }).score(job());
  assert.equal(result.scores.deepSeekScore.status, 'ready');
  assert.deepEqual(result.scores.deepSeekScore.quality.source.imageCoverage, { found: 1, sent: 0, overflow: false });
  assert.equal(result.scores.deepSeekScore.quality.source.truncated, true);
});

test('正文外部引用图片只记录数量，不把完整输入判为不完整', async () => {
  const rubric = { requirements: [{ requirement: '说明结果', critical: true }], visualAidsApplicable: false, visualAidsReason: '无需额外图表' };
  let prompt = '';
  const client = { model: 'test', supportsImages: true, isConfigured: () => true, callJson: async text => {
    if (text.startsWith('仅根据题目')) return rubric;
    prompt = text;
    return { dimensions: { readability: { score: 80, note: '清楚' }, professionalism: { score: 80, note: '明确' }, visualAids: { score: null, note: '不适用' } },
      requirements: [{ id: 'R1', status: 'met', evidence: ['answer:0'], note: '有文字' }], comment: '文字完整', suggestions: ['继续核对'] };
  } };
  const value = job();
  value.answer += '\n<img src="http://36.103.236.211:1106/api/v1/images/a/x.jpg">';
  const service = createScoringService({ clients: { deepSeekScore: client }, imageLoader: async (_job, discovery) => discovery.candidates.map(item => ({ id: item.id, dataUrl })) });
  const quality = (await service.score(value)).scores.deepSeekScore.quality;
  assert.equal(quality.source.truncated, false);
  assert.deepEqual(quality.source.imageCoverage, { found: 1, sent: 1, overflow: false, external: 1 });
  assert.equal(quality.taskCompletion.status, 'completed');
  assert.match(prompt, /1 张运行产物之外的外部图片/);
  assert.ok(quality.limitations.some(item => item.includes('外部图片')));
  assert.ok(!quality.limitations.includes('评分输入不完整，仅供参考；无法确认完整任务合格。'));
});
