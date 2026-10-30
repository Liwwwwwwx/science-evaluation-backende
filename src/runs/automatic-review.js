// 测评自动执行策略：使用服务当前条件继续，不伪造问题答案或用户授权。
function createAutomaticReview({ taskid, review, send, onRecord, onError }) {
  const seen = new Set();
  return frame => {
    const requestId = frame.request_id;
    if (!['string', 'number'].includes(typeof requestId) || !String(requestId) || String(requestId).length > 200
      || (frame.taskid != null && frame.taskid !== taskid) || Buffer.byteLength(JSON.stringify(frame)) > 256 * 1024) {
      onError('服务确认请求格式异常'); return;
    }
    if (seen.has(String(requestId))) return;
    if (seen.size >= 10) { onError('服务重复确认次数超过上限，已停止自动继续'); return; }
    seen.add(String(requestId));
    review.push({ at: new Date().toISOString(), requestId, action: 'requested', data: frame.data || {}, source: 'service' });
    const record = { at: new Date().toISOString(), requestId, action: 'continue', answers: [], source: 'automatic', delivery: 'pending' };
    review.push(record);
    try { send({ type: 'checkpoint.reply', schema_version: 1, taskid, request_id: requestId, action: 'continue' }); }
    catch { record.delivery = 'failed'; onRecord(); onError('自动继续答复发送失败'); return; }
    record.delivery = 'sent'; onRecord();
  };
}
module.exports = { createAutomaticReview };
