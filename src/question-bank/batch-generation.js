const { fingerprintOf } = require('./identity');

// 逐批生成并跨批去重；数量不足时不返回不完整清单供调度使用。
async function generateBatchQuestions({ generator, input, count, maxAttempts = 20 } = {}) {
  if (!generator || typeof generator.generate !== 'function' || !input || typeof input !== 'object' || !Number.isInteger(count) || count < 1 || count > 100 || !Number.isInteger(maxAttempts) || maxAttempts < 1) throw new TypeError('批次出题参数无效');
  const questions = []; const seen = new Set();
  for (let attempt = 0; attempt < maxAttempts && questions.length < count; attempt++) {
    let result;
    try { result = await generator.generate({ ...input, count: Math.min(10, count - questions.length) }); }
    catch (error) {
      if (error?.code === 'QUESTION_GENERATION_INVALID' || error?.code === 'QUESTION_GENERATION_UNAVAILABLE') throw error;
      continue;
    }
    for (const item of Array.isArray(result?.items) ? result.items : []) {
      const question = typeof item?.question === 'string' ? item.question.trim() : '';
      const fingerprint = fingerprintOf(question);
      if (question.length < 8 || question.length > (input.serviceKey === 'synthesis' ? 200 : 500) || !fingerprint || seen.has(fingerprint)) continue;
      seen.add(fingerprint); questions.push({ ...item, question });
      if (questions.length === count) break;
    }
  }
  if (questions.length !== count) {
    const error = new Error(`题目生成不足：需要 ${count} 道，生成 ${questions.length} 道`);
    error.code = 'BATCH_QUESTIONS_INSUFFICIENT';
    throw error;
  }
  return questions;
}

module.exports = { generateBatchQuestions };
