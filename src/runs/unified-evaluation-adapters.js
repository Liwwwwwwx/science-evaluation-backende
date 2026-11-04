// 将现有服务接口约束在适配边界内；原生运行与评分语义保持不变。
function createUnifiedEvaluationAdapters(evaluators = {}) {
  return Object.fromEntries(Object.entries(evaluators).map(([serviceKey, evaluator]) => {
    return [serviceKey, {
      start(body, onText, onState) {
        return evaluator.startQuestionRun(body, { onText, onState });
      },
      async startCase(caseDef, onText) {
        let completion;
        const run = await evaluator.startCaseRun(caseDef, { beginCase(_run, execute) { completion = Promise.resolve().then(() => execute(onText)); } });
        if (!completion) throw new Error('case adapter did not start execution');
        return { run, completion };
      },
      async readScores(nativeRunId) {
        const quality = await evaluator.getRunQuality(nativeRunId);
        if (!quality || typeof quality.status !== 'string') throw new Error('invalid score response');
        return { quality };
      },
    }];
  }));
}
module.exports = { createUnifiedEvaluationAdapters };
