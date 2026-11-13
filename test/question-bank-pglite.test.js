// 可选隔离验证：PGLITE_PACKAGE 指向独立安装的 @electric-sql/pglite，不连接共享数据库。
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createQuestionBankService } = require('../src/question-bank/service');
const { createEvalQuestionBankRepository } = require('../src/question-bank/repository');
const { fixedDatasetVersionOf, fixedQuestionId, fingerprintOf } = require('../src/question-bank/identity');
const cases = require('../src/question-bank/builtin-cases.json');

test('隔离数据库：测试集迁移回填并允许两个材料服务选择同一批题', { skip: !process.env.PGLITE_PACKAGE }, async t => {
  const { PGlite } = require(process.env.PGLITE_PACKAGE);
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'science-question-bank-pglite-'));
  let db = new PGlite(root);
  await db.exec('CREATE DATABASE science_admin'); await db.close();
  db = new PGlite(root, { database: 'science_admin' }); t.after(() => db.close());
  await db.exec(`CREATE TABLE eval_questions (id text NOT NULL, layer text NOT NULL, service_key text, source_type text NOT NULL, question text NOT NULL, fingerprint text, criteria jsonb, criteria_version text, dataset_version text NOT NULL, status text NOT NULL DEFAULT 'active', retired_reason text, created_at timestamptz NOT NULL DEFAULT now(), UNIQUE(id,dataset_version));
    CREATE TABLE eval_fixed_case_overrides (service_key text NOT NULL, case_id text NOT NULL, question_id text NOT NULL, dataset_version text NOT NULL, status text NOT NULL, retired_reason text, created_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(service_key,case_id,dataset_version));`);
  await db.exec(fs.readFileSync(path.join(__dirname, '../migrations/002_question_domains.sql'), 'utf8'));
  for (const c of cases) {
    const version = fixedDatasetVersionOf(c.serviceKey, cases.filter(item => item.serviceKey === c.serviceKey));
    await db.query("INSERT INTO eval_questions(id,layer,service_key,source_type,question,fingerprint,dataset_version) VALUES($1,'base',$2,'fixed',$3,$4,$5)", [fixedQuestionId(c.serviceKey, c.id), c.serviceKey, c.question, fingerprintOf(c.question), version]);
  }
  const migration = fs.readFileSync(path.join(__dirname, '../migrations/015_question_test_sets.sql'), 'utf8');
  await db.exec(migration); await db.exec(migration);
  const query = async (sql, args = []) => { const result = await db.query(sql, args); return { ...result, rowCount: result.rowCount ?? result.affectedRows }; };
  const pool = { query, async connect() { return { query, release() {} }; } };
  const service = createQuestionBankService(createEvalQuestionBankRepository({ pool }));
  assert.deepEqual((await service.testSets()).items, [{ name: '材料研发测试案例集', count: 23 }]);
  const listing = await service.list(new URLSearchParams({ source: 'fixed', testSet: '材料研发测试案例集', runnableFor: 'alloy', comparisonWith: 'alpha-rsi' }));
  assert.equal(listing.total, 23);
  assert.ok(listing.items.every(item => item.applicableServices.includes('alloy') && item.applicableServices.includes('alpha-rsi')));
});
