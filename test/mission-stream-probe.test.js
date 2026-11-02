const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { parseArgs, runProbe } = require('../scripts/mission-stream-probe');

test('探针分别记录并发连接、心跳、文字与异常关闭，沿用平台消息协议', async () => {
  const sent = []; const lines = []; let count = 0;
  class Socket extends EventEmitter {
    constructor(index) { super(); this.index = index; }
    addEventListener(...args) { this.on(...args); }
    send(value) {
      const frame = JSON.parse(value); sent.push(frame);
      if (!frame.idea) return;
      setImmediate(() => {
        this.emit('message', { data: JSON.stringify({ type: 'heartbeat.ping' }) });
        this.emit('message', { data: JSON.stringify({ type: 'display.final_answer', event_id: `f${this.index}`, phase: 'end', content: `${'x'.repeat(256 * 1024)} 测试 ${this.index} https://example.test/file?token=private` }) });
        this.emit('close', { code: this.index === 1 ? 1000 : 1006, wasClean: this.index === 1 });
      });
    }
    close() {}
  }
  const opts = parseArgs(['--url', 'ws://127.0.0.1/start', '--count', '2', '--show-text']);
  const rows = await runProbe(opts, { write: line => lines.push(line), createSocket: () => { const socket = new Socket(++count); queueMicrotask(() => socket.emit('open')); return socket; } });
  assert.equal(sent.length, 2); assert.equal(new Set(sent.map(x => x.taskid)).size, 2);
  assert.ok(sent.every(x => x.has_context === false && !('type' in x)));
  assert.deepEqual(rows.map(x => [x.frameCount, x.businessCount, x.textCount, x.closeCode]), [[2, 1, 1, 1000], [2, 1, 1, 1006]]);
  assert.deepEqual(rows.map(x => x.result.status), ['done', 'error']);
  assert.ok(lines.some(x => x.includes('正常关闭 1/2'))); assert.ok(lines.some(x => x.includes('1006')));
  assert.ok(rows.every(x => x.maxFrameBytes > 256 * 1024)); assert.ok(lines.some(x => x.includes('超过 256 KiB')));
  assert.ok(lines.some(x => x.includes('[链接已隐藏]'))); assert.ok(lines.every(x => !x.includes('token=private')));
});

test('拒绝不安全地址和无效并发配置', () => {
  assert.throws(() => parseArgs(['--url', 'ws://user:secret@localhost/start']), /不含凭据/);
  assert.throws(() => parseArgs(['--url', 'ws://localhost/start', '--count', '0']), /并发数/);
  assert.throws(() => parseArgs(['--url', 'ws://localhost/start', '--count', '21']), /并发数/);
});
