const { test } = require('node:test');
const assert = require('node:assert/strict');
const { Pool } = require('pg');
const fs = require('node:fs');
const path = require('node:path');
const { createQuestionBankService } = require('../src/question-bank/service');
const { createEvalQuestionBankRepository } = require('../src/question-bank/repository');
const { fixedDatasetVersionOf, fixedQuestionId, fingerprintOf } = require('../src/question-bank/identity');
const cases = require('../src/question-bank/builtin-cases.json');

const socket = process.env.EVALUATION_TEST_PG_SOCKET || '';
test('隔离 PostgreSQL 中题库导入、版本更新、内置覆盖及软删除', { skip: !socket }, async () => {
  if (!/^\/tmp\/evaluation-auth-pg\.[A-Za-z0-9]+$/.test(socket)) throw new Error('测试只允许专用临时数据库 socket');
  const pool = new Pool({ host: socket, port: 55481, database: 'science_admin' });
  try {
    const check = await pool.query("SELECT current_database() AS name, to_regclass('public.eval_questions') AS existing");
    assert.equal(check.rows[0].name, 'science_admin'); assert.equal(check.rows[0].existing, null);
    await pool.query(`CREATE TABLE eval_questions (id text NOT NULL, layer text NOT NULL, service_key text, source_type text NOT NULL, question text NOT NULL, fingerprint text, criteria jsonb, criteria_version text, dataset_version text NOT NULL, status text NOT NULL DEFAULT 'active', retired_reason text, created_at timestamptz NOT NULL DEFAULT now(), UNIQUE(id,dataset_version));
      CREATE TABLE eval_fixed_case_overrides (service_key text NOT NULL,case_id text NOT NULL,question_id text NOT NULL,dataset_version text NOT NULL,status text NOT NULL,retired_reason text,created_at timestamptz NOT NULL DEFAULT now(),PRIMARY KEY(service_key,case_id,dataset_version), FOREIGN KEY(question_id,dataset_version) REFERENCES eval_questions(id,dataset_version));
      CREATE UNIQUE INDEX eval_fixed_case_overrides_active_key ON eval_fixed_case_overrides(service_key,case_id) WHERE status='active'`);
    await pool.query(fs.readFileSync(path.join(__dirname, '../migrations/002_question_domains.sql'), 'utf8'));
    for (const c of cases) {
      const datasetVersion = fixedDatasetVersionOf(c.serviceKey, cases.filter(x => x.serviceKey === c.serviceKey));
      await pool.query(`INSERT INTO eval_questions(id,layer,service_key,source_type,question,fingerprint,dataset_version) VALUES($1,'base',$2,'fixed',$3,$4,$5)`, [fixedQuestionId(c.serviceKey,c.id),c.serviceKey,c.question,fingerprintOf(c.question),datasetVersion]);
    }
    await pool.query(fs.readFileSync(path.join(__dirname, '../migrations/015_question_test_sets.sql'), 'utf8'));
    const repo = createEvalQuestionBankRepository({ pool }); const service = createQuestionBankService(repo);
    const listing = await service.list(new URLSearchParams({ source: 'fixed', limit: '20' })); assert.equal(listing.total, cases.length);
    assert.deepEqual((await service.testSets()).items, [{ name: '材料研发测试案例集', count: 23 }]);
    const shared = await service.list(new URLSearchParams({ source: 'fixed', testSet: '材料研发测试案例集', runnableFor: 'alloy', comparisonWith: 'alpha-rsi' }));
    assert.equal(shared.total, 23);
    const input = { items: [{ serviceKey: 'alloy', question: '测试用材料题目：高温下性能如何？' }] };
    const results = await Promise.allSettled([service.import(input), service.import(input)]);
    assert.equal(results.filter(r => r.status === 'fulfilled').length, 1);
    assert.equal(results.find(r => r.status === 'rejected').reason.code, 'FIXED_CASE_DUPLICATE');
    const first = results.find(r => r.status === 'fulfilled').value.items[0];
    const updated = await service.update(first.id, { datasetVersion: first.datasetVersion, question: '测试用材料题目：低温下性能如何？' });
    assert.notEqual(updated.question.datasetVersion, first.datasetVersion);
    await assert.rejects(() => service.retire(first.id, { datasetVersion: first.datasetVersion }), e => e.code === 'FIXED_CASE_VERSION_CONFLICT');
    await service.retire(first.id, { datasetVersion: updated.question.datasetVersion });
    assert.equal((await repo.getQuestion(first.id, first.datasetVersion)).status, 'retired');
    const builtin = cases[0]; const id = fixedQuestionId(builtin.serviceKey, builtin.id); const v = fixedDatasetVersionOf(builtin.serviceKey, cases.filter(c => c.serviceKey === builtin.serviceKey));
    const edit = await service.update(id, { datasetVersion: v, question: '这是隔离环境中修改后的内置题目。' });
    await service.retire(id, { datasetVersion: edit.question.datasetVersion });
    assert.equal((await repo.getFixedCaseOverride(builtin.serviceKey,builtin.id)).status, 'retired');
    await service.list(new URLSearchParams({ source: 'fixed' }));
    const unclassified = (await service.list(new URLSearchParams({ source: 'fixed', domain: 'unclassified' }))).items[0];
    const classified = (await service.setDomain(unclassified.id, { datasetVersion: unclassified.datasetVersion, domainKey: 'materials-rd' })).question;
    assert.equal(classified.domainKey, 'materials-rd');
    assert.equal((await service.list(new URLSearchParams({ source: 'fixed', domain: 'materials-rd' }))).total, 1);
    const domainInput = { items: [{ domainKey: 'chip-packaging', question: '请分析芯片封装中的热管理设计问题。' }] };
    const domainFixed = (await service.import(domainInput)).items[0];
    assert.equal(domainFixed.domainKey, 'chip-packaging'); assert.equal(domainFixed.serviceKey, null);
    await assert.rejects(() => service.import(domainInput), e => e.code === 'FIXED_CASE_DUPLICATE');
    const domainEdit = (await service.update(domainFixed.id, { datasetVersion: domainFixed.datasetVersion, question: '请分析芯片封装中的可靠性设计问题。' })).question;
    assert.equal(domainEdit.domainKey, 'chip-packaging'); assert.equal(domainEdit.serviceKey, null);
    assert.equal((await service.list(new URLSearchParams({ source: 'fixed', domain: 'chip-packaging' }))).total, 1);
    const domainRandom = await Promise.all([service.saveRandom(domainInput), service.saveRandom(domainInput)]);
    assert.equal(domainRandom.reduce((sum, r) => sum + r.created, 0), 1);
    assert.equal(domainRandom[0].items[0].domainKey, 'chip-packaging');
    assert.equal((await service.list(new URLSearchParams({ source: 'random', domain: 'chip-packaging' }))).total, 1);
    assert.ok((await service.list(new URLSearchParams({ source: 'fixed', domain: 'unclassified' }))).total > 0);
    await service.retire(domainEdit.id, { datasetVersion: domainEdit.datasetVersion });
    const randomInput = { items: [{ serviceKey: 'alloy', question: '请分析一种测试合金的抗高温氧化能力。' }] };
    const randomResults = await Promise.all([service.saveRandom(randomInput), service.saveRandom(randomInput)]);
    assert.equal(randomResults.reduce((sum, r) => sum + r.created, 0), 1);
    assert.equal(randomResults.reduce((sum, r) => sum + r.reused, 0), 1);
    const random = randomResults[0].items[0];
    assert.equal(random.sourceType, 'random'); assert.equal(random.datasetVersion, 'gen-v1');
    const randomList = await service.list(new URLSearchParams({ source: 'random', search: '抗高温氧化' }));
    assert.equal(randomList.total, 1); assert.equal(randomList.items[0].id, random.id);
    // 服务型随机题：改题升版本、旧版本冲突、保留引用历史、停用不复活。
    await pool.query(`CREATE TABLE test_run_refs (question_id text, dataset_version text, FOREIGN KEY(question_id,dataset_version) REFERENCES eval_questions(id,dataset_version))`);
    await pool.query('INSERT INTO test_run_refs VALUES ($1,$2)', [random.id, random.datasetVersion]);
    const changed = (await service.update(random.id, { datasetVersion: random.datasetVersion, question: '请分析一种测试合金的低温断裂韧性。' })).question;
    assert.equal(changed.datasetVersion, 'gen-edit-v1'); assert.equal(changed.sourceType, 'random');
    assert.equal((await repo.getQuestion(random.id, random.datasetVersion)).question, random.question);
    await assert.rejects(() => service.update(random.id, { datasetVersion: random.datasetVersion, question: '请分析一种测试合金的疲劳性能变化。' }), e => e.status === 409);
    await assert.rejects(() => service.setDomain(random.id, { datasetVersion: random.datasetVersion, domainKey: 'materials-rd' }), e => e.status === 409);
    const changedTwice = (await service.update(changed.id, { datasetVersion: changed.datasetVersion, question: '请分析一种测试合金的疲劳性能变化。' })).question;
    assert.equal(changedTwice.datasetVersion, 'gen-edit-v2');
    const raced = await Promise.allSettled([
      service.update(changedTwice.id, { datasetVersion: changedTwice.datasetVersion, question: '请比较测试合金在不同载荷下的疲劳寿命。' }),
      service.retire(changedTwice.id, { datasetVersion: changedTwice.datasetVersion }),
    ]);
    assert.equal(raced.filter(r => r.status === 'fulfilled').length, 1);
    assert.equal(raced.find(r => r.status === 'rejected').reason.status, 409);
    const active = await repo.getQuestionLatest(random.id);
    if (active.status === 'active') await service.retire(active.id, { datasetVersion: active.datasetVersion });
    assert.equal((await service.list(new URLSearchParams({source:'random', search:'疲劳寿命'}))).total, 0);
    assert.equal((await pool.query('SELECT count(*)::int AS n FROM test_run_refs')).rows[0].n, 1);
    await assert.rejects(() => service.saveRandom(randomInput), e => e.status === 409);
    // 领域题纠错：稳定身份、目标领域去重、原领域可重新出题，不受旧 ID 中领域影响。
    const native = domainRandom[0].items[0];
    const corrected = (await service.setDomain(native.id, { datasetVersion: native.datasetVersion, domainKey:'materials-rd' })).question;
    assert.equal(corrected.id, native.id); assert.equal(corrected.domainKey, 'materials-rd');
    const originalDomainCopy = (await service.saveRandom(domainInput)).items[0];
    assert.notEqual(originalDomainCopy.id, native.id);
    await assert.rejects(() => service.setDomain(originalDomainCopy.id, { datasetVersion:originalDomainCopy.datasetVersion, domainKey:'materials-rd' }), e => e.code === 'QUESTION_DOMAIN_DUPLICATE');
    const editedNative = (await service.update(native.id, {datasetVersion:native.datasetVersion, question:'请比较芯片封装中不同散热材料的可靠性。'})).question;
    assert.equal(editedNative.domainKey, 'materials-rd');
    const competing = (await service.saveRandom({items:[{domainKey:'materials-rd',question:'请分析测试芯片中焊点的疲劳失效问题。'}]})).items[0];
    await assert.rejects(() => service.update(editedNative.id, {datasetVersion:editedNative.datasetVersion,question:competing.question}), e => e.status === 409);
    const collisionRace = await Promise.allSettled([
      service.setDomain(originalDomainCopy.id, {datasetVersion:originalDomainCopy.datasetVersion,domainKey:'synthesis-preparation'}),
      service.saveRandom({items:[{domainKey:'synthesis-preparation',question:originalDomainCopy.question}]}),
    ]);
    assert.ok(collisionRace.some(r => r.status === 'fulfilled'));
    assert.equal((await service.list(new URLSearchParams({source:'random',domain:'synthesis-preparation'}))).total, 1);
    await service.retire(editedNative.id, {datasetVersion:editedNative.datasetVersion});
    const fixedCorrection = (await service.import({items:[{domainKey:'chip-packaging',question:'请分析不同封装材料的吸湿与界面分层。'}]})).items[0];
    await service.setDomain(fixedCorrection.id, {datasetVersion:fixedCorrection.datasetVersion,domainKey:'materials-rd'});
    const fixedEdited = (await service.update(fixedCorrection.id, {datasetVersion:fixedCorrection.datasetVersion,question:'请比较不同封装材料的吸湿与界面分层。'})).question;
    assert.equal(fixedEdited.domainKey, 'materials-rd');
  } finally { await pool.end(); }
});
