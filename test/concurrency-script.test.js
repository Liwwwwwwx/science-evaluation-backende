'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { SERVICES, validateQuestions, resolveAddresses, runBatch } = require('../scripts/concurrency-test');
const questions = require('../scripts/concurrency-questions.json');

test('题目与地址完整性在发起任务前校验', () => {
  assert.equal(validateQuestions(questions), questions);
  assert.throws(() => validateQuestions({ ...questions, 'alpha-rsi': questions['alpha-rsi'].slice(1) }), /10 道/);
  assert.throws(() => validateQuestions({ ...questions, 'alpha-rsi': Array(10).fill('相同题目') }), /不同/);
  const env = Object.fromEntries(SERVICES.map(item => [item.env, `ws://127.0.0.1/${item.key}/start`]));
  assert.equal(Object.keys(resolveAddresses(env)).length, 5);
  assert.throws(() => resolveAddresses({ ...env, EVALUATION_ALPHA_RSI_WS_URL: 'ws://user:password@host/start' }), /地址/);
  assert.throws(() => resolveAddresses({ ...env, EVALUATION_ALPHA_RSI_WS_URL: 'ws://host/start?token=x' }), /地址/);
});

test('五个服务各自保持五并发，运行 50 道并生成本地结果', async () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'science-batch-test-'));
  const active = {}, peaks = {}, started = {};
  let releaseFirstWave;
  const firstWave = new Promise(resolve => { releaseFirstWave = resolve; });
  let startedTotal = 0;
  const adapters = Object.fromEntries(SERVICES.map(service => [service.key, {
    async startQuestionRun({ question }, { onText }) {
      active[service.key] = (active[service.key] || 0) + 1;
      peaks[service.key] = Math.max(peaks[service.key] || 0, active[service.key]);
      started[service.key] = (started[service.key] || 0) + 1;
      const index = started[service.key];
      startedTotal++;
      if (startedTotal === 25) releaseFirstWave();
      const completion = (async () => {
        await firstWave;
        await new Promise(resolve => setTimeout(resolve, 2));
        active[service.key]--;
        onText(`[start]回答：${question}[end]`);
        return { status: 'done', elapsedMs: 100, details: { review: [] } };
      })();
      return { run: { id: `${service.key}-${index}` }, completion };
    },
  }]));
  try {
    const report = await runBatch({ adapters, questions, outputDirectory: temp, timeoutMinutes: 30 });
    for (const service of SERVICES) { assert.equal(peaks[service.key], 5); assert.equal(started[service.key], 10); }
    assert.equal(report.tasks.length, 50);
    assert.equal(report.tasks.filter(row => row.status === 'completed').length, 50);
    assert.ok(report.finishedAt);
    const saved = JSON.parse(fs.readFileSync(path.join(temp, 'results.json'), 'utf8'));
    assert.equal(saved.tasks.length, 50);
    assert.ok(saved.tasks[0].detailsFile);
    assert.match(JSON.parse(fs.readFileSync(path.join(temp, saved.tasks[0].detailsFile), 'utf8')).answer, /回答：/);
    assert.match(fs.readFileSync(path.join(temp, 'summary.md'), 'utf8'), /材料配比 RSI \| 10 \| 0 \| 0/);
    assert.equal(fs.statSync(path.join(temp, 'results.json')).mode & 0o777, 0o600);
  } finally { fs.rmSync(temp, { recursive: true, force: true }); }
});

test('超时后不继续给该服务补发，其他服务仍完成全部任务', async () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'science-batch-stop-test-'));
  const started = {};
  const adapters = Object.fromEntries(SERVICES.map(service => [service.key, {
    async startQuestionRun(_input, { onText }) {
      const index = started[service.key] = (started[service.key] || 0) + 1;
      const completion = (async () => {
        await new Promise(resolve => setTimeout(resolve, index === 1 ? 2 : 10));
        if (service.key === 'alpha-rsi' && index === 1) return { status: 'error', error: '服务执行超时', elapsedMs: 99, details: {} };
        onText('[start]有效回答[end]');
        return { status: 'done', elapsedMs: 100, details: {} };
      })();
      return { run: { id: `${service.key}-${index}` }, completion };
    },
  }]));
  try {
    const report = await runBatch({ adapters, questions, outputDirectory: temp, timeoutMinutes: 30 });
    assert.equal(started['alpha-rsi'], 5);
    assert.equal(report.tasks.filter(row => row.serviceKey === 'alpha-rsi' && row.status === 'timeout').length, 1);
    assert.equal(report.tasks.filter(row => row.serviceKey === 'alpha-rsi' && row.status === 'not_started').length, 5);
    for (const service of SERVICES.filter(item => item.key !== 'alpha-rsi')) assert.equal(started[service.key], 10);
  } finally { fs.rmSync(temp, { recursive: true, force: true }); }
});
