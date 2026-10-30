// 单次运行的事件缓冲。可同时订阅；断线不取消执行，不承诺历史事件重放。
function createRunEvents() {
  const listeners = new Set();
  let subscribed = false;
  let pending = [];
  return {
    get subscribed() { return subscribed; },
    send(event, data) {
      if (listeners.size) {
        for (const listener of listeners) {
          try { listener(event, data); } catch { /* 单个监听者失败不影响执行 */ }
        }
      } else if (!subscribed) {
        // 结构化状态是完整快照，订阅前只保留最新一份，避免重复累积大结果。
        if (event === 'state') pending = pending.filter(item => item.event !== 'state');
        pending.push({ event, data });
      }
    },
    subscribe(next, { discardPending = false } = {}) {
      listeners.add(next);
      subscribed = true;
      const events = pending;
      pending = [];
      if (!discardPending) for (const event of events) next(event.event, event.data);
      return () => listeners.delete(next);
    },
  };
}
module.exports = { createRunEvents };
