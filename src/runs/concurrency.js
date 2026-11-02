'use strict';

// 有界队列：空闲服务可以越过被同服务上限阻塞的任务，避免不同服务互相饿死。
function createConcurrency({ maxActive, maxPerKey = maxActive, maxQueued = 300, limitsByKey = {} }) {
  if (![maxActive, maxPerKey, maxQueued].every(Number.isInteger) || maxActive < 1 || maxPerKey < 1 || maxQueued < 0) throw new RangeError('并发配置无效');
  if (!limitsByKey || typeof limitsByKey !== 'object' || Array.isArray(limitsByKey) || Object.values(limitsByKey).some(limit => !Number.isInteger(limit) || limit < 1 || limit > maxPerKey)) throw new RangeError('服务并发配置无效');
  const limits = { ...limitsByKey };
  const queue = [];
  const activeByKey = new Map();
  let active = 0;

  function drain() {
    while (active < maxActive) {
      const index = queue.findIndex(item => (activeByKey.get(item.key) || 0) < (limits[item.key] ?? maxPerKey));
      if (index < 0) return;
      const [item] = queue.splice(index, 1);
      active++;
      activeByKey.set(item.key, (activeByKey.get(item.key) || 0) + 1);
      let released = false;
      item.resolve(() => {
        if (released) return;
        released = true;
        active--;
        const remaining = activeByKey.get(item.key) - 1;
        if (remaining) activeByKey.set(item.key, remaining); else activeByKey.delete(item.key);
        drain();
      });
    }
  }

  function reserve(key) {
    if (typeof key !== 'string' || !key) throw new TypeError('并发分组无效');
    if ((active >= maxActive || (activeByKey.get(key) || 0) >= (limits[key] ?? maxPerKey) || queue.length) && queue.length >= maxQueued) {
      const error = new Error('等待队列已满');
      error.code = 'CONCURRENCY_QUEUE_FULL';
      throw error;
    }
    let entry;
    const ready = new Promise(resolve => { entry = { key, resolve }; queue.push(entry); drain(); });
    return {
      ready,
      queued: queue.includes(entry),
      cancel() {
        const index = queue.indexOf(entry);
        if (index < 0) return false;
        queue.splice(index, 1);
        // 取消只用于尚未开始的预约，调用方仍会等待结果，避免留下悬空 promise。
        entry.resolve(null);
        drain();
        return true;
      },
    };
  }

  return { reserve, acquire: key => reserve(key).ready, stats: () => ({ active, queued: queue.length }) };
}
module.exports = { createConcurrency };
