// 将现有服务接口约束在适配边界内；原生运行与评分语义保持不变。
function createUnifiedEvaluationAdapters(evaluators = {}) {
  return Object.fromEntries(Object.entries(evaluators).map(([serviceKey, evaluator]) => {
    const isAlphaRsi = serviceKey === 'alpha-rsi';
    return [serviceKey, {
      start(body, onText) {
        return isAlphaRsi
          ? evaluator.askQuestionStream(body, { onText })
          : evaluator.startQuestionRun(body, { onText });
      },
      async startCase(caseDef, onText) {
        let completion;
        const run = await evaluator.startCaseRun(caseDef, { beginCase(_run, execute) { completion = Promise.resolve().then(() => execute(onText)); } });
        if (!completion) throw new Error('case adapter did not start execution');
        return { run, completion };
      },
      async readScores(nativeRunId) {
        if (isAlphaRsi) {
          const result = await evaluator.getAskResult(nativeRunId);
          if (!result || !result.deepSeekScore || !result.qwenScore) throw new Error('invalid score response');
          return { deepSeekScore: result.deepSeekScore, qwenScore: result.qwenScore };
        }
        const quality = await evaluator.getRunQuality(nativeRunId);
        if (!quality || typeof quality.status !== 'string') throw new Error('invalid score response');
        return { quality };
      },
    }];
  }));
}
module.exports = { createUnifiedEvaluationAdapters };
