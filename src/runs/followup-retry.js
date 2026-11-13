const { createAlphaRsiSupplement } = require('./alpha-rsi-supplement');
const { TeamServiceError } = require('../errors');

function waitingDetails(result) {
  const value = result && typeof result === 'object' ? result : {};
  const interpretation = value.requirement_interpretation && typeof value.requirement_interpretation === 'object' ? value.requirement_interpretation : {};
  const title = [value.user_conclusion, interpretation.confirmation_message, value.message].find(item => typeof item === 'string' && item.trim())?.trim().slice(0, 500) || '';
  const candidates = [interpretation.questions_to_confirm, value.questions_to_confirm, interpretation.missing_required_inputs].flatMap(item => Array.isArray(item) ? item : []);
  const questions = [...new Set(candidates.map(item => typeof item === 'string' ? item : item && typeof item === 'object' ? item.question || item.label : '').filter(item => typeof item === 'string' && item.trim()).map(item => item.trim().slice(0, 500)))].slice(0, 20);
  const inputError = [interpretation.input_error, value.input_error]
    .map(item => typeof item === 'string' ? item : item && typeof item === 'object' ? item.message : '')
    .find(item => typeof item === 'string' && item.trim())?.trim().slice(0, 1000) || '';
  return { title, questions, inputError };
}

function abortableSupplement(generate, input, signal) {
  return new Promise((resolve, reject) => {
    if (signal.aborted) return reject(new Error('自动补充已结束'));
    const abort = () => reject(new Error('自动补充已结束'));
    signal.addEventListener('abort', abort, { once: true });
    Promise.resolve().then(() => generate({ ...input, signal })).then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
  });
}

// 服务只返回等待状态并结束时，以新的下游 taskid 补充后最多重试一次。
function withWaitingRetry(single, { generateSupplement = createAlphaRsiSupplement() } = {}) {
  return {
    ...single,
    async startQuestionRun({ question }, { onText = () => {}, onState = () => {}, onTextReset = () => {} } = {}) {
      let cancelled = false; let active; let firstText = '';
      const controller = new AbortController();
      active = await single.startQuestionRun({ question }, { onText: delta => { firstText += delta; onText(delta); }, onState });
      const first = active;
      const completion = (async () => {
        const initial = await first.completion;
        const result = initial.details?.snapshot?.data?.status ? initial.details.snapshot.data : initial.details?.result;
        if (cancelled || result?.status !== 'waiting_for_input' || (initial.status !== 'done' && initial.error !== '服务返回等待补充信息，但未提供可回复的交互请求，本轮未完成。')) return initial;
        const { title, questions, inputError } = waitingDetails(result);
        const retry = { state: 'generating', source: 'automatic', title, questions, previousResult: result, previousReview: initial.details.review, previousAnswer: firstText.slice(0, 64000), previousAnswerTruncated: firstText.length > 64000, message: null, model: null, taskId: null };
        const publish = details => { try { onState({ ...details, autoRetry: structuredClone(retry) }); } catch {} };
        publish(initial.details);
        // 服务未发起追问、而是返回失败/输入校验错误时，视为不支持修改问题后继续回答；
        // 不生成补充、不重发，直接保留服务错误。
        const errorLike = !questions.length && /无法回答|无法完成|执行失败|输入校验|invalid_input|must use/i.test(title);
        if (inputError || errorLike) {
          retry.state = 'unsupported'; retry.title = inputError || title; publish(initial.details);
          return { ...initial, status: 'error', error: `该服务不支持修改问题后继续回答：${retry.title}`, details: { ...initial.details, autoRetry: retry } };
        }
        if (!title && !questions.length) {
          retry.state = 'unavailable'; publish(initial.details);
          return { ...initial, status:'error', error: '服务要求补充，但未说明需要什么信息，无法自动重新发起。', details: { ...initial.details, autoRetry: retry } };
        }
        let supplement;
        try { supplement = await abortableSupplement(generateSupplement, { question, title, questions }, AbortSignal.any([controller.signal, AbortSignal.timeout(90000)])); }
        catch {
          if (cancelled) return initial;
          retry.state = 'failed'; publish(initial.details);
          return { ...initial, status:'error', error: '服务要求补充，自动补充生成失败，未重新发起。', details: { ...initial.details, autoRetry: retry } };
        }
        if (cancelled) return initial;
        if (!supplement || typeof supplement.message !== 'string' || !supplement.message.trim() || supplement.message.length > 4000) {
          retry.state = 'failed'; publish(initial.details);
          return { ...initial, status:'error', error: '服务要求补充，自动补充内容无效，未重新发起。', details: { ...initial.details, autoRetry: retry } };
        }
        retry.message = supplement.message.trim(); retry.model = supplement.model || null; retry.state = 'restarting';
        publish(initial.details);
        onTextReset();
        const nextQuestion = `${question}\n\n针对服务追问的自动补充（含假设，需核对）：${retry.message}`;
        active = await single.startQuestionRun({ question: nextQuestion }, { onText, onState: details => publish(details) });
        retry.taskId = active.run.id; retry.state = 'running'; publish({ ...initial.details, result:null, snapshot:null, displayEvents:[], protocolFrames:[], generatedFiles:[], artifacts:[], review:[] });
        if (cancelled) active.cancel?.();
        const second = await active.completion;
        const secondResult = second.details?.snapshot?.data?.status ? second.details.snapshot.data : second.details?.result;
        const stillWaiting = secondResult?.status === 'waiting_for_input';
        retry.state = second.status === 'done' && !stillWaiting ? 'completed' : 'failed';
        return { ...second, ...(stillWaiting ? { status:'error',error:'重新发起后服务仍要求补充，本轮未完成。' } : {}), taskid: first.run.id, details: { ...second.details, autoRetry: retry } };
      })();
      return { run: first.run, completion, cancel: () => { cancelled = true; controller.abort(); active?.cancel?.(); },
        ...(typeof first.reply === 'function' ? { reply: input => {
          if (typeof active?.reply !== 'function') throw new TeamServiceError(409, 'REVIEW_UNAVAILABLE', '当前运行无法答复，请刷新运行');
          return active.reply(input);
        } } : {}) };
    },
  };
}

module.exports = { withWaitingRetry };
