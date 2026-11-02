#!/usr/bin/env node
'use strict';

// Directly exercises service adapters. It does not create platform runs or use a database.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { spawnSync } = require('node:child_process');
const { createMissionEvaluator } = require('../src/runs/mission-evaluator');
const { createLiteratureEvaluator } = require('../src/runs/literature-evaluator');
const { createMaterialEvaluator } = require('../src/runs/material-evaluator');

const SERVICES = [
  { key: 'mission-material', label: 'Mission 上游', env: 'EVALUATION_MISSION_MATERIAL_WS_URL' },
  { key: 'literature', label: '文献检索', env: 'EVALUATION_LITERATURE_WS_URL' },
  { key: 'literature-aircraft', label: '航空文献', env: 'EVALUATION_AIRCRAFT_LITERATURE_WS_URL' },
  { key: 'alloy', label: '合金材料', env: 'EVALUATION_ALLOY_WS_URL' },
  { key: 'synthesis', label: '合成制备', env: 'EVALUATION_SYNTHESIS_WS_URL' },
  { key: 'new-material', label: '新材料', env: 'EVALUATION_NEW_MATERIAL_WS_URL' },
];
const QUESTIONS_PER_SERVICE = 10;
const PER_SERVICE_CONCURRENCY = 5;
const MAX_TEXT = 1024 * 1024;

function parseArgs(args) {
  const opts = { timeoutMinutes: 30, questions: path.join(__dirname, 'concurrency-questions.json'), dryRun: false };
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--help' || arg === '-h') opts.help = true;
    else if (arg === '--dry-run') opts.dryRun = true;
    else if (['--output', '--questions', '--timeout-minutes', '--running-backend'].includes(arg)) {
      const value = args[++i];
      if (!value || value.startsWith('--')) throw new Error(`${arg} 需要参数`);
      if (arg === '--output') opts.output = value;
      if (arg === '--questions') opts.questions = value;
      if (arg === '--timeout-minutes') opts.timeoutMinutes = Number(value);
      if (arg === '--running-backend') opts.runningBackend = value;
    } else throw new Error(`未知参数：${arg}`);
  }
  if (!Number.isInteger(opts.timeoutMinutes) || opts.timeoutMinutes < 1 || opts.timeoutMinutes > 120) throw new Error('超时须为 1 至 120 分钟的整数');
  if (opts.runningBackend && !/^[1-9]\d*$/.test(opts.runningBackend)) throw new Error('后端进程 PID 无效');
  return opts;
}

function validateQuestions(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('题目文件必须是服务到题目数组的 JSON 对象');
  for (const service of SERVICES) {
    const items = value[service.key];
    if (!Array.isArray(items) || items.length !== QUESTIONS_PER_SERVICE || items.some(q => typeof q !== 'string' || !q.trim() || q.length > 4000) || new Set(items.map(q => q.trim())).size !== QUESTIONS_PER_SERVICE) {
      throw new Error(`${service.label}必须有 ${QUESTIONS_PER_SERVICE} 道不同的非空题目`);
    }
  }
  return value;
}

function addressesFromProcess(pid) {
  const command = spawnSync('ps', ['-p', pid, '-o', 'command='], { encoding: 'utf8' });
  if (command.status !== 0 || !command.stdout.includes(path.join('backend', 'src', 'server.js'))) throw new Error('指定 PID 不是当前测评后端进程');
  const env = spawnSync('ps', ['eww', '-p', pid, '-o', 'command='], { encoding: 'utf8', maxBuffer: 2 * 1024 * 1024 });
  if (env.status !== 0) throw new Error('无法读取指定后端进程的环境配置');
  return Object.fromEntries(SERVICES.map(service => {
    const match = env.stdout.match(new RegExp(`(?:^|\\s)${service.env}=([^\\s]*)`));
    return [service.env, match?.[1] || ''];
  }));
}

function resolveAddresses(env, runningEnv = {}) {
  const addresses = {};
  for (const service of SERVICES) {
    let target;
    try { target = new URL(env[service.env] || runningEnv[service.env] || ''); } catch { throw new Error(`缺少或无法解析 ${service.label} 的 ${service.env}`); }
    // Credentials and query parameters are deliberately not accepted in reports or CLI output.
    if (!['ws:', 'wss:'].includes(target.protocol) || target.username || target.password || target.search || target.hash) throw new Error(`${service.label} 地址须为不含凭据和参数的 WebSocket 地址`);
    addresses[service.key] = target.href;
  }
  return addresses;
}

function createAdapters(addresses, timeoutMs) {
  return Object.fromEntries(SERVICES.map(({ key }) => {
    const options = { url: addresses[key], timeoutMs };
    const adapter = key === 'mission-material' ? createMissionEvaluator(options)
      : key === 'literature' || key === 'literature-aircraft' ? createLiteratureEvaluator({ ...options, serviceKey: key })
        : createMaterialEvaluator({ ...options, serviceKey: key });
    return [key, adapter];
  }));
}

function writeReport(directory, report) {
  const target = path.join(directory, 'results.json');
  const temp = path.join(directory, '.results.json.tmp');
  fs.writeFileSync(temp, JSON.stringify(report, null, 2), { mode: 0o600 });
  fs.renameSync(temp, target);
}

function summaryMarkdown(report) {
  const lines = ['# 服务并发测试汇总', '', `开始：${report.startedAt}`, `结束：${report.finishedAt || '尚未结束'}`, '', '每个服务 10 道题，最多同时执行 5 道；未调用平台评分或写入平台数据库。', '', '| 服务 | 完成 | 失败 | 超时 | 未完成 | 最长耗时 |', '| --- | ---: | ---: | ---: | ---: | ---: |'];
  for (const service of SERVICES) {
    const rows = report.tasks.filter(row => row.serviceKey === service.key);
    const count = status => rows.filter(row => row.status === status).length;
    const elapsed = rows.filter(row => typeof row.elapsedMs === 'number').map(row => row.elapsedMs);
    lines.push(`| ${service.label} | ${count('completed')} | ${count('failed')} | ${count('timeout')} | ${rows.length - count('completed') - count('failed') - count('timeout')} | ${elapsed.length ? `${(Math.max(...elapsed) / 1000).toFixed(1)} 秒` : '—'} |`);
  }
  lines.push('', '“完成”表示收到符合适配器协议的结束信号并存在输出，不代表答案正确或测评通过。', '任务失败或超时后，该服务不再补发排队题目；其他服务继续运行。', '超时或本地进程中断不代表服务端任务已取消；任务索引见 results.json，回答保存在 tasks 目录。', '上游可能调用下游，各下游实际承受的总负载可能高于脚本直接并发。', '');
  return lines.join('\n');
}

function visibleOutput(details) {
  const events = Array.isArray(details?.displayEvents) ? details.displayEvents : [];
  let remaining = MAX_TEXT;
  return events.filter(event => ['display.team_output', 'display.final_answer'].includes(event.type)).flatMap(event => {
    if (remaining <= 0) return [];
    const body = typeof event.content === 'string' ? event.content : typeof event.delta === 'string' ? event.delta : '';
    if (!body.trim()) return [];
    const content = body.slice(0, remaining); remaining -= content.length;
    return [{ type: event.type, team: typeof event.team?.name === 'string' ? event.team.name : null, content }];
  });
}

async function runBatch({ adapters, questions, outputDirectory, timeoutMinutes, now = () => new Date() }) {
  const report = { startedAt: now().toISOString(), finishedAt: null, perServiceConcurrency: PER_SERVICE_CONCURRENCY, questionsPerService: QUESTIONS_PER_SERVICE, timeoutMinutes, tasks: [] };
  fs.mkdirSync(path.join(outputDirectory, 'tasks'), { mode: 0o700 });
  for (const service of SERVICES) for (const [index, question] of questions[service.key].entries()) report.tasks.push({ serviceKey: service.key, index: index + 1, question, status: 'queued' });
  writeReport(outputDirectory, report);

  async function execute(task) {
    task.status = 'running'; task.startedAt = now().toISOString();
    writeReport(outputDirectory, report);
    let answer = ''; let outputEvents = [];
    try {
      const { run, completion } = await adapters[task.serviceKey].startQuestionRun({ question: task.question }, {
        onText(chunk) { if (typeof chunk === 'string' && answer.length < MAX_TEXT) answer += chunk.slice(0, MAX_TEXT - answer.length); },
        onState() {},
      });
      task.taskId = run?.id || null;
      writeReport(outputDirectory, report);
      const result = await completion;
      outputEvents = visibleOutput(result.details);
      const meaningful = answer.replace(/\[start\]|\[end\]/gi, '').trim().length > 0 || outputEvents.length > 0 || !!result.details?.result;
      task.status = result.status === 'done' && meaningful ? 'completed' : /超时/.test(result.error || '') ? 'timeout' : 'failed';
      task.error = result.error || (meaningful ? null : '未收到可用输出');
      task.elapsedMs = Number.isFinite(result.elapsedMs) ? result.elapsedMs : null;
      task.confirmationCount = Array.isArray(result.details?.review) ? result.details.review.length : 0;
      task.closeCode = result.details?.transport?.closeCode ?? null;
    } catch {
      task.status = 'failed'; task.error = '客户端运行异常';
    }
    task.finishedAt = now().toISOString();
    task.detailsFile = `tasks/${task.serviceKey}-${String(task.index).padStart(2, '0')}.json`;
    fs.writeFileSync(path.join(outputDirectory, task.detailsFile), JSON.stringify({ ...task, answer, outputs: outputEvents }, null, 2), { mode: 0o600, flag: 'wx' });
    writeReport(outputDirectory, report);
  }

  await Promise.all(SERVICES.map(async service => {
    const queue = report.tasks.filter(task => task.serviceKey === service.key);
    let next = 0; let stopped = false;
    await Promise.all(Array.from({ length: PER_SERVICE_CONCURRENCY }, async () => {
      while (!stopped && next < queue.length) {
        const task = queue[next++];
        await execute(task);
        if (task.status !== 'completed') stopped = true;
      }
    }));
    for (const task of queue) if (task.status === 'queued') { task.status = 'not_started'; task.error = '同服务已有任务失败或超时，未继续补发'; }
    writeReport(outputDirectory, report);
  }));
  report.finishedAt = now().toISOString();
  writeReport(outputDirectory, report);
  fs.writeFileSync(path.join(outputDirectory, 'summary.md'), summaryMarkdown(report), { mode: 0o600 });
  return report;
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) {
    console.log('node scripts/concurrency-test.js [--running-backend PID] [--questions FILE] [--timeout-minutes N] [--output NEW_DIR] [--dry-run]');
    return;
  }
  const questions = validateQuestions(JSON.parse(fs.readFileSync(path.resolve(opts.questions), 'utf8')));
  const addresses = resolveAddresses(process.env, opts.runningBackend ? addressesFromProcess(opts.runningBackend) : {});
  if (opts.dryRun) { console.log(`配置有效：${SERVICES.length} 个服务，每个 ${QUESTIONS_PER_SERVICE} 道，并发 ${PER_SERVICE_CONCURRENCY}；未发起请求。`); return; }
  const parent = path.join(os.homedir(), 'science-evaluation-reports');
  const directory = opts.output ? path.resolve(opts.output) : path.join(parent, `concurrency-${new Date().toISOString().replace(/[:.]/g, '-')}-${randomUUID().slice(0, 8)}`);
  if (!opts.output) fs.mkdirSync(parent, { recursive: true, mode: 0o700 });
  fs.mkdirSync(directory, { mode: 0o700 });
  const adapters = createAdapters(addresses, opts.timeoutMinutes * 60000);
  console.log(`测试已启动，结果目录：${directory}`);
  const report = await runBatch({ adapters, questions, outputDirectory: directory, timeoutMinutes: opts.timeoutMinutes });
  console.log(`测试结束，汇总：${path.join(directory, 'summary.md')}`);
  if (report.tasks.some(task => task.status !== 'completed')) process.exitCode = 1;
}

if (require.main === module) main().catch(error => { console.error(`无法启动或完成测试：${error.message}`); process.exitCode = 1; });
module.exports = { SERVICES, parseArgs, validateQuestions, resolveAddresses, createAdapters, summaryMarkdown, runBatch };
