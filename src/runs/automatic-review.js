const { createFollowupAnswers } = require('./followup-answers');

// 无问题时确认继续；有明确问题时生成并逐项发送答复。
function createAutomaticReview({ taskid, question = '', review, send, onRecord, onError, isActive = () => true, signal, generateAnswers = createFollowupAnswers() }) {
  const seen = new Set();
  let pending = 0;
  const handle = async frame => {
    const requestId = frame.request_id;
    if (!['string', 'number'].includes(typeof requestId) || !String(requestId) || String(requestId).length > 200
      || (frame.taskid != null && frame.taskid !== taskid) || Buffer.byteLength(JSON.stringify(frame)) > 256 * 1024) {
      onError('服务确认请求格式异常'); return;
    }
    if (seen.has(String(requestId))) return;
    if (seen.size >= 10) { onError('服务重复确认次数超过上限，已停止自动继续'); return; }
    seen.add(String(requestId));
    review.push({ at: new Date().toISOString(), requestId, action: 'requested', data: frame.data || {}, source: 'service' });
    const data = frame.data && typeof frame.data === 'object' && !Array.isArray(frame.data) ? frame.data : {};
    if (data.questions != null && !Array.isArray(data.questions)) { onRecord(); onError('服务追问格式异常'); return; }
    const questions = Array.isArray(data.questions) ? data.questions : [];
    if (questions.length > 20 || questions.some(q => !q || !['string','number'].includes(typeof q.id) || !String(q.id) || String(q.id).length > 200 || typeof q.question !== 'string' || !q.question.trim() || q.question.length > 2000) || new Set(questions.map(q => String(q.id))).size !== questions.length) { onError('服务追问格式异常'); return; }
    const record = { at: new Date().toISOString(), requestId, action: questions.length ? 'apply' : 'continue', answers: [], source: 'automatic', delivery: 'pending' };
    review.push(record);
    onRecord();
    if (questions.length) {
      let result;
      pending++;
      const timeout = AbortSignal.timeout(90000); const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;
      try { result = await Promise.race([generateAnswers({ question, title: typeof data.title === 'string' ? data.title.slice(0,500) : '', questions: questions.map(q => ({ id:q.id, question:q.question, required:q.required === true })), signal: combined }), new Promise((_, reject) => { if (combined.aborted) reject(Error('aborted')); else combined.addEventListener('abort', () => reject(Error('aborted')), {once:true}); })]); }
      catch { if (isActive()) { record.delivery = 'failed'; onRecord(); onError('自动补充生成失败，未发送答复'); } return; }
      finally { pending--; }
      if (!isActive()) return;
      if (!Array.isArray(result?.answers) || result.answers.length !== questions.length || questions.some(q => result.answers.filter(a => String(a?.id) === String(q.id) && typeof a.answer === 'string' && a.answer.trim() && a.answer.length <= 2000).length !== 1)) { record.delivery = 'failed'; onRecord(); onError('自动补充内容无效，未发送答复'); return; }
      record.answers = result.answers; record.model = result.model || null; record.summary = '已自动补充追问；假设请结合题目核对。';
    }
    try { send({ type: 'checkpoint.reply', schema_version: 1, taskid, request_id: requestId, action: record.action, ...(questions.length ? { data: { edits: [], answers: record.answers } } : {}) }); }
    catch { record.delivery = 'failed'; onRecord(); onError('自动继续答复发送失败'); return; }
    record.delivery = 'sent'; onRecord();
  };
  handle.hasPending = () => pending > 0;
  return handle;
}
module.exports = { createAutomaticReview };
