#!/usr/bin/env node
'use strict';

// Direct Mission probe: uses the same adapter as the platform, without its queue,
// database or scoring. The service itself may persist tasks and generate files.
const { createMissionEvaluator } = require('../src/runs/mission-evaluator');

const DEFAULT_QUESTION = '请简要比较氮化铝和氮化硼作为芯片封装散热填料的优点与限制。';
const HELP = `Mission 流式并发探针（Node.js 22）
用法：node --env-file-if-exists=.env.local scripts/mission-stream-probe.js [选项]
  --url 地址            Mission WebSocket 地址；也可设置 EVALUATION_MISSION_MATERIAL_WS_URL
  --count 数量          同时发起的独立任务，1–20，默认 5
  --question 题目       每个任务使用的题目；默认使用内置材料对比题
  --timeout-minutes 分  每个任务的等待上限，1–120，默认 15
  --interval-seconds 秒 每条连接的状态输出间隔，1–60，默认 5
  --show-text           在状态中显示最近的文字片段（链接会隐藏）
  --help                显示帮助
脚本不写平台数据库、不评分；上游服务仍可能保存任务或生成文件。
Ctrl+C 或超时只结束本地等待，不代表上游任务已取消。`;

function parseArgs(args, env = process.env) {
  const options = { url: env.EVALUATION_MISSION_MATERIAL_WS_URL, count: 5, question: DEFAULT_QUESTION, timeoutMinutes: 15, intervalSeconds: 5, showText: false };
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--help' || arg === '-h') { options.help = true; continue; }
    if (arg === '--show-text') { options.showText = true; continue; }
    if (!['--url', '--count', '--question', '--timeout-minutes', '--interval-seconds'].includes(arg)) throw new Error(`未知参数：${arg}`);
    const value = args[++i];
    if (!value || value.startsWith('--')) throw new Error(`${arg} 需要参数`);
    if (arg === '--url') options.url = value;
    if (arg === '--question') options.question = value;
    if (arg === '--count') options.count = Number(value);
    if (arg === '--timeout-minutes') options.timeoutMinutes = Number(value);
    if (arg === '--interval-seconds') options.intervalSeconds = Number(value);
  }
  if (options.help) return options;
  for (const [name, value, max] of [['并发数', options.count, 20], ['超时分钟', options.timeoutMinutes, 120], ['状态间隔秒', options.intervalSeconds, 60]]) {
    if (!Number.isInteger(value) || value < 1 || value > max) throw new Error(`${name}必须为 1–${max} 的整数`);
  }
  if (!options.question.trim() || options.question.length > 4000) throw new Error('题目不能为空且不能超过 4000 字符');
  let url; try { url = new URL(options.url); } catch { throw new Error('请通过 --url 或环境变量提供 Mission WebSocket 地址'); }
  if (!['ws:', 'wss:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new Error('地址须为不含凭据、查询参数和片段的 ws/wss 地址');
  options.url = url.href;
  return options;
}

function preview(value) {
  return value.replace(/https?:\/\/[^\s<>"']+/gi, '[链接已隐藏]').replace(/[\x00-\x1f\x7f-\x9f]+/g, ' ').replace(/\s+/g, ' ').trim().slice(-120);
}
function elapsed(ms) { return ms == null ? '—' : `${(ms / 1000).toFixed(1)}秒`; }
function ago(at, now) { return at == null ? '从未' : `${Math.max(0, (now - at) / 1000).toFixed(1)}秒前`; }

async function runProbe(options, { createSocket = url => new WebSocket(url), write = line => console.log(line), now = () => Date.now() } = {}) {
  const rows = Array.from({ length: options.count }, (_, index) => ({ index: index + 1, taskId: null, state: '连接中', start: now(), frameCount: 0, businessCount: 0, textCount: 0, maxFrameBytes: 0, largeFrameSeen: false, lastFrame: null, lastBusiness: null, lastText: null, lastType: '—', textPreview: '', reviewCount: 0, result: null, closeCode: null }));
  const label = row => `[${String(row.index).padStart(2, '0')}]`;
  const report = row => {
    const time = now();
    write(`${label(row)} ${row.state} | 已用 ${elapsed(time - row.start)} | 总帧 ${row.frameCount} / 业务 ${row.businessCount} / 文字 ${row.textCount} | 最大帧 ${row.maxFrameBytes} 字节 | 最近帧 ${ago(row.lastFrame, time)} | 最近业务 ${ago(row.lastBusiness, time)} | 最近文字 ${ago(row.lastText, time)} | 类型 ${row.lastType}${options.showText && row.textPreview ? ` | 文字 ${row.textPreview}` : ''}`);
  };
  const socketFor = row => url => {
    const socket = createSocket(url);
    socket.addEventListener('open', () => { row.state = '已连接'; write(`${label(row)} 已连接 taskid=${row.taskId || '待分配'}`); });
    socket.addEventListener('message', event => {
      const time = now(); row.frameCount++; row.lastFrame = time;
      const raw = typeof event.data === 'string' ? event.data : null;
      const bytes = raw == null ? (event.data?.size ?? event.data?.byteLength ?? 0) : Buffer.byteLength(raw);
      row.maxFrameBytes = Math.max(row.maxFrameBytes, bytes);
      if (bytes > 256 * 1024 && !row.largeFrameSeen) { row.largeFrameSeen = true; write(`${label(row)} 收到超过 256 KiB 的帧（${bytes} 字节）；旧版平台可能因接收上限失败。`); }
      if (raw == null) { row.businessCount++; row.lastBusiness = time; row.lastType = '二进制帧'; return; }
      let frame; try { frame = JSON.parse(raw); } catch {}
      if (frame?.type === 'timeline.event' && frame.event && typeof frame.event === 'object') frame = frame.event;
      const type = frame && typeof frame === 'object' && !Array.isArray(frame) ? String(frame.type || 'JSON') : '文本';
      const heartbeat = /^(?:heartbeat(?:\.ping)?|ping|pong)$/i.test(type);
      row.lastType = type.slice(0, 80) + (typeof frame?.phase === 'string' ? `/${frame.phase.slice(0, 30)}` : '');
      if (heartbeat) return;
      row.businessCount++; row.lastBusiness = time;
      const text = type === '文本' ? raw : ['text.delta', 'display.final_answer', 'display.team_output'].includes(type) ? [frame.delta, frame.content, frame.text].find(x => typeof x === 'string' && x.trim()) : null;
      if (text && text.trim()) { row.textCount++; row.lastText = time; if (options.showText) row.textPreview = preview(text); }
    });
    socket.addEventListener('close', event => { row.closeCode = Number.isInteger(event?.code) ? event.code : null; row.state = '连接关闭，等待结果'; });
    return socket;
  };
  write(`Mission 流式探针：${options.count} 个任务，每题超时 ${options.timeoutMinutes} 分钟；不写平台数据库、不评分。`);
  write('提示：心跳不算业务输出；中断或超时不代表上游任务已取消。');
  const interval = setInterval(() => rows.filter(row => !row.result).forEach(report), options.intervalSeconds * 1000);
  try {
    await Promise.all(rows.map(async row => {
      const adapter = createMissionEvaluator({ url: options.url, timeoutMs: options.timeoutMinutes * 60000, createSocket: socketFor(row) });
      try {
        const job = await adapter.startQuestionRun({ question: options.question }, { onText() {}, onState(value) {
          if (Array.isArray(value.review) && value.review.length > row.reviewCount) {
            for (const item of value.review.slice(row.reviewCount)) write(`${label(row)} 交互 ${item.request?.type || '确认'}：${item.action || '未知'} / ${item.delivery || '未知'}`);
            row.reviewCount = value.review.length;
          }
        } });
        row.taskId = job.run.id;
        const result = await job.completion; row.result = result; row.state = result.status === 'done' ? '正常关闭' : '失败';
        const transport = result.details?.transport || {};
        row.closeCode = transport.closeCode ?? row.closeCode;
        write(`${label(row)} ${row.state} taskid=${row.taskId} 耗时=${elapsed(result.elapsedMs)} 关闭码=${row.closeCode ?? '无'}${result.error ? ` 原因=${result.error}` : ''}`);
        report(row);
      } catch (error) {
        row.result = { status: 'error', error: error.message }; row.state = '客户端异常';
        write(`${label(row)} 客户端异常 taskid=${row.taskId || '无'}：${error.message}`);
      }
    }));
  } finally { clearInterval(interval); }
  const done = rows.filter(row => row.result?.status === 'done').length;
  write(`汇总：正常关闭 ${done}/${rows.length}，失败 ${rows.length - done}/${rows.length}。正常关闭不代表答案完整或质量合格。`);
  return rows;
}

if (require.main === module) {
  let options; try { options = parseArgs(process.argv.slice(2)); } catch (error) { console.error(error.message); process.exitCode = 2; }
  if (options?.help) console.log(HELP);
  else if (options) runProbe(options).then(rows => { if (rows.some(row => row.result?.status !== 'done')) process.exitCode = 1; }).catch(error => { console.error(`探针失败：${error.message}`); process.exitCode = 1; });
}
module.exports = { parseArgs, runProbe };
