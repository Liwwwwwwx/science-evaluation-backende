const test = require('node:test');
const assert = require('node:assert/strict');
const { createAuthRepository } = require('../src/auth/repository');
const { createEvalQuestionBankRepository } = require('../src/question-bank/repository');
const { createUnifiedEvaluationRepository } = require('../src/runs/unified-evaluation.repository');
const { createMissionDailyRepository } = require('../src/runs/mission-daily.repository');
const { createRuleRepository } = require('../src/scoring/rule-repository');
const { createMissionDailyReportRepository } = require('../src/notifications/mission-daily-report.repository');

const operations = [
  pool => createAuthRepository(pool).userByName('test'),
  pool => createEvalQuestionBankRepository({ pool }).listQuestionsPaged(),
  pool => createUnifiedEvaluationRepository({ pgPool: pool }).create({}),
  pool => createMissionDailyRepository({ pgPool: pool }).latest(),
  pool => createRuleRepository(pool).active(),
  pool => createMissionDailyReportRepository({ pgPool: pool }).candidates(),
];
function fakePool(name) {
  return { async connect() { throw new Error('unexpected connection'); }, async query(sql) {
    if (sql.includes('current_database()')) return { rows: [{ name }] };
    throw new Error('reached-approved-database');
  } };
}
test('六类测评仓储只允许独立测评库和原管理库', async () => {
  for (const operation of operations) {
    for (const name of ['science_evaluation', 'science_admin']) {
      await assert.rejects(operation(fakePool(name)), /reached-approved-database/);
    }
    for (const name of ['postgres', 'other_database', 'science_evaluation_extra']) {
      await assert.rejects(operation(fakePool(name)), /science_admin/);
    }
  }
});
