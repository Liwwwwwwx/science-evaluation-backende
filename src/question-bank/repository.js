const { fingerprintOf } = require('./identity');

function parseJson(value) {
  if (value == null) return null;
  if (typeof value === 'object') return value;
  try { return JSON.parse(value); } catch { return null; }
}

function dateKey(value) {
  if (!value) return null;
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  return String(value).slice(0, 10);
}

function mapQuestionRow(row) {
  if (!row) return null;
  return {
    id: row.id,
    layer: row.layer,
    serviceKey: row.service_key || null,
    domainKey: row.domain_key || null,
    sourceType: row.source_type,
    question: row.question,
    fingerprint: row.fingerprint || null,
    criteria: parseJson(row.criteria),
    criteriaVersion: row.criteria_version || null,
    datasetVersion: row.dataset_version,
    status: row.status,
    retiredReason: row.retired_reason || null,
    createdAt: row.created_at ? new Date(row.created_at).toISOString() : null,
  };
}

function mapRunRow(row) {
  if (!row) return null;
  return {
    id: Number(row.id),
    questionId: row.question_id,
    datasetVersion: row.dataset_version,
    serviceKey: row.service_key,
    runDate: dateKey(row.run_date),
    attempt: Number(row.attempt || 1),
    batchId: row.batch_id || null,
    isRegression: row.is_regression === true,
    regressionRound: row.regression_round == null ? null : Number(row.regression_round),
    answerRef: row.answer_ref || null,
    evidenceRef: row.evidence_ref || null,
    verdict: row.verdict || null,
    checks: parseJson(row.checks),
    clauseSetVersion: row.clause_set_version || null,
    quality: parseJson(row.quality),
    qualityRubricVersion: row.quality_rubric_version || null,
    judgeModel: row.judge_model || null,
    promptHash: row.prompt_hash || null,
    scoreState: row.score_state,
    recomputeReason: row.recompute_reason || null,
    backfilled: row.backfilled === true,
    error: row.error || null,
    startedAt: row.started_at ? new Date(row.started_at).toISOString() : null,
    createdAt: row.created_at ? new Date(row.created_at).toISOString() : null,
  };
}

function mapFixedCaseOverrideRow(row) {
  if (!row) return null;
  return {
    serviceKey: row.service_key,
    caseId: row.case_id,
    questionId: row.question_id,
    datasetVersion: row.dataset_version,
    status: row.status,
    retiredReason: row.retired_reason || null,
    question: row.question || null,
    fingerprint: row.fingerprint || null,
    criteria: parseJson(row.criteria),
    criteriaVersion: row.criteria_version || null,
    createdAt: row.created_at ? new Date(row.created_at).toISOString() : null,
  };
}

function questionBankError(status, code, message) {
  const error = new Error(message);
  error.status = status;
  error.code = code;
  return error;
}

// 固定案例覆盖层是迁移 040 提供的存储。运行端不能在缺表时静默回退到代码清单，
// 写端也要把“迁移尚未部署/数据库暂不可用”明确返回给调用方，而不是伪装成普通 500。
function normalizeFixedCaseStorageError(error) {
  if (error && Number.isInteger(error.status)) return error;
  const code = error && String(error.code || '');
  if (code === '42703') return questionBankError(503, 'QUESTION_DOMAIN_MIGRATION_REQUIRED', '题库领域存储尚未启用，请先完成数据库迁移');
  if (code === '42P01' || code === '3F000' || code === '57P01'
    || code === 'ECONNREFUSED' || code === 'ENOTFOUND' || code === 'ETIMEDOUT') {
    return questionBankError(503, 'FIXED_CASE_STORAGE_UNAVAILABLE', '固定案例版本存储不可用，请先完成题库迁移或检查数据库连接');
  }
  return error;
}

function assertUploadedFixedQuestionRow(row, sourceType = 'fixed') {
  if (!row) throw questionBankError(404, 'QUESTION_NOT_FOUND', '题目不存在');
  if (sourceType === 'random' && row.layer === 'base' && row.source_type === 'random') return;
  if (row.layer !== 'base' || row.source_type !== 'fixed' || sourceType !== 'fixed') {
    throw questionBankError(400, 'FIXED_CASE_NOT_EDITABLE', '只有 base/fixed 固定案例可以编辑或删除');
  }
  // 代码内置固定案例的 ID 是 serviceKey:caseId；只有用户导入的题目带有
  // fixed-upload 前缀，避免后台操作伪造/覆盖静态清单。
  if (!String(row.id || '').startsWith('fixed-upload:')) {
    throw questionBankError(400, 'FIXED_CASE_READ_ONLY', '系统内置固定案例不可编辑或删除，请使用用户导入的固定案例');
  }
}

function nextFixedUploadDatasetVersion(rows) {
  let maxVersion = 1;
  for (const row of rows || []) {
    const match = /^fixed-upload-v(\d+)$/.exec(String(row.dataset_version || ''));
    if (match) maxVersion = Math.max(maxVersion, Number(match[1]));
  }
  return `fixed-upload-v${maxVersion + 1}`;
}

function nextFixedOverrideDatasetVersion(rows) {
  let maxVersion = 0;
  for (const row of rows || []) {
    const match = /^fixed-override-v(\d+)$/.exec(String(row.dataset_version || row.datasetVersion || ''));
    if (match) maxVersion = Math.max(maxVersion, Number(match[1]));
  }
  return `fixed-override-v${maxVersion + 1}`;
}

// 所有固定题写路径必须共享同一组锁键：用户上传/编辑与内置覆盖编辑
// 不能因前缀不同而绕过同指纹互斥。
function fixedFingerprintLockKey(serviceKey, fingerprint) {
  return `${String(serviceKey)}:${String(fingerprint || '')}`;
}

function fixedCaseIdentityLockKey(serviceKey, caseId) {
  return `fixed-case:${String(serviceKey)}:${String(caseId)}`;
}

function createEvalQuestionBankRepository({ pool } = {}) {
  if (!pool || typeof pool.query !== 'function' || typeof pool.connect !== 'function') throw new Error('题库需要显式提供数据库连接池');
  let checked;
  async function ensureDatabase() {
    if (!checked) checked = pool.query('SELECT current_database() AS name').then((r) => {
      if (!['science_admin', 'science_evaluation'].includes(r.rows[0]?.name)) throw new Error('题库只能使用 science_admin 或 science_evaluation 数据库');
    }).catch((e) => { checked = null; throw e; });
    return checked;
  }
  const guardedPool = {
    async query(...args) { await ensureDatabase(); return pool.query(...args); },
    async connect() { await ensureDatabase(); return pool.connect(); },
  };
  const getPool = () => guardedPool;

  // 代码内置固定案例的初始版本登记。导入检查与写入必须在同一事务、同一案例锁
  // 内完成；已存在覆盖（包括 retired tombstone）时原样返回覆盖版本，绝不复活基线。
  async function ensureStaticFixedQuestion({ caseDef, datasetVersion } = {}) {
    if (!caseDef || !caseDef.id || !caseDef.serviceKey) {
      throw questionBankError(400, 'FIXED_CASE_DEFINITION_INVALID', '内置固定案例定义无效');
    }
    const question = String(caseDef.question || '').trim();
    if (!question) throw questionBankError(400, 'FIXED_CASE_DEFINITION_INVALID', '内置固定案例题面为空');
    const fingerprint = caseDef.fingerprint || fingerprintOf(question);
    const id = `${String(caseDef.serviceKey)}:${String(caseDef.id)}`;
    const version = String(datasetVersion || '').trim();
    if (!version) throw questionBankError(400, 'FIXED_CASE_DATASET_VERSION_REQUIRED', '内置固定案例缺少版本');
    const client = await getPool().connect();
    try {
      await client.query('BEGIN');
      await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [fixedCaseIdentityLockKey(caseDef.serviceKey, caseDef.id)]);
      // 静态基线与用户上传共用题面指纹锁。否则两条写事务可能分别通过
      // “当前没有 active 同题”检查，最终留下两个 active 固定案例。
      await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [fixedFingerprintLockKey(caseDef.serviceKey, fingerprint)]);
      const managed = await client.query(
        `SELECT q.*
         FROM eval_fixed_case_overrides o
         JOIN eval_questions q ON q.id = o.question_id AND q.dataset_version = o.dataset_version
         WHERE o.service_key = $1 AND o.case_id = $2
         ORDER BY o.created_at DESC, o.dataset_version DESC
         LIMIT 1
         FOR UPDATE OF o, q`,
        [String(caseDef.serviceKey), String(caseDef.id)],
      );
      if (managed.rows[0]) {
        await client.query('COMMIT');
        return mapQuestionRow(managed.rows[0]);
      }
      const duplicate = await client.query(
        `SELECT id, dataset_version
         FROM eval_questions
         WHERE service_key = $1
           AND fingerprint = $2
           AND layer = 'base'
           AND source_type = 'fixed'
           AND status = 'active'
           AND id <> $3
         LIMIT 1
         FOR UPDATE`,
        [String(caseDef.serviceKey), fingerprint || null, id],
      );
      if (duplicate.rows[0]) {
        throw questionBankError(409, 'FIXED_CASE_DUPLICATE', '固定案例题面与已有 active 固定案例重复');
      }
      const inserted = await client.query(
        `INSERT INTO eval_questions (
           id, layer, service_key, source_type, question, fingerprint,
           criteria, criteria_version, dataset_version, status
         ) VALUES ($1, 'base', $2, 'fixed', $3, $4, $5::jsonb, $6, $7, 'active')
         ON CONFLICT (id, dataset_version) DO NOTHING
         RETURNING *`,
        [
          id,
          String(caseDef.serviceKey),
          question,
          fingerprint || null,
          JSON.stringify(caseDef.expectation ? { expectation: caseDef.expectation } : null),
          caseDef.expectation ? 'expectation-v1' : null,
          version,
        ],
      );
      const row = inserted.rows[0] || (await client.query(
        'SELECT * FROM eval_questions WHERE id = $1 AND dataset_version = $2 LIMIT 1 FOR UPDATE',
        [id, version],
      )).rows[0];
      if (!row) throw questionBankError(500, 'FIXED_CASE_IMPORT_FAILED', '内置固定案例登记失败');
      await client.query('COMMIT');
      return mapQuestionRow(row);
    } catch (error) {
      try { await client.query('ROLLBACK'); } catch {}
      throw normalizeFixedCaseStorageError(error);
    } finally {
      client.release();
    }
  }

  // 返回指定内置案例的最新覆盖记录。最新退休记录是停用 tombstone，不能回退代码默认值。
  async function getFixedCaseOverride(serviceKey, caseId, { client } = {}) {
    const db = client || getPool();
    try {
      const result = await db.query(
        `SELECT o.*, q.question, q.fingerprint, q.criteria, q.criteria_version
         FROM eval_fixed_case_overrides o
         JOIN eval_questions q ON q.id = o.question_id AND q.dataset_version = o.dataset_version
         WHERE o.service_key = $1 AND o.case_id = $2
         ORDER BY o.created_at DESC, o.dataset_version DESC
         LIMIT 1`,
        [String(serviceKey), String(caseId)],
      );
      return mapFixedCaseOverrideRow(result.rows[0]);
    } catch (error) {
      throw normalizeFixedCaseStorageError(error);
    }
  }

  // 一次检查全部内置案例：存在有效覆盖记录或对应的静态基线即可。
  // 与 getFixedCaseOverride 使用相同的 JOIN 语义；退休覆盖仍是有效的停用标记。
  async function findMissingFixedCaseBaselines(cases) {
    if (!cases.length) return [];
    try {
      const result = await getPool().query(
        `SELECT c.question_id
         FROM unnest($1::text[], $2::text[], $3::text[], $4::text[])
           AS c(service_key, case_id, question_id, dataset_version)
         WHERE NOT EXISTS (
           SELECT 1 FROM eval_fixed_case_overrides o
           JOIN eval_questions q ON q.id = o.question_id AND q.dataset_version = o.dataset_version
           WHERE o.service_key = c.service_key AND o.case_id = c.case_id
         )
         AND NOT EXISTS (
           SELECT 1 FROM eval_questions q
           WHERE q.id = c.question_id AND q.dataset_version = c.dataset_version
         )`,
        [cases.map((item) => item.serviceKey), cases.map((item) => item.caseId),
          cases.map((item) => item.questionId), cases.map((item) => item.datasetVersion)],
      );
      return result.rows.map((row) => row.question_id);
    } catch (error) {
      throw normalizeFixedCaseStorageError(error);
    }
  }

  // 用于列表/运行前确认指定版本是否属于当前内置覆盖，避免旧 active 行绕过停用 tombstone。
  async function getFixedCaseOverrideVersion(serviceKey, caseId, datasetVersion, { client } = {}) {
    const db = client || getPool();
    try {
      const result = await db.query(
        `SELECT o.*, q.question, q.fingerprint, q.criteria, q.criteria_version
         FROM eval_fixed_case_overrides o
         JOIN eval_questions q ON q.id = o.question_id AND q.dataset_version = o.dataset_version
         WHERE o.service_key = $1 AND o.case_id = $2 AND o.dataset_version = $3
         LIMIT 1`,
        [String(serviceKey), String(caseId), String(datasetVersion)],
      );
      return mapFixedCaseOverrideRow(result.rows[0]);
    } catch (error) {
      throw normalizeFixedCaseStorageError(error);
    }
  }

  // 幂等登记题目：同 (id, dataset_version) 已存在时返回既有行，不覆盖（升版本走新行）。
  async function upsertQuestion(input) {
    const result = await getPool().query(
      `INSERT INTO eval_questions (id, layer, service_key, source_type, question, fingerprint, criteria, criteria_version, dataset_version, status)
       VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8, $9, 'active')
       ON CONFLICT (id, dataset_version) DO NOTHING
       RETURNING *`,
      [
        String(input.id),
        String(input.layer),
        input.serviceKey || null,
        String(input.sourceType),
        String(input.question || ''),
        input.fingerprint || null,
        JSON.stringify(input.criteria == null ? null : input.criteria),
        input.criteriaVersion || null,
        String(input.datasetVersion),
      ],
    );
    if (result.rows[0]) return mapQuestionRow(result.rows[0]);
    return getQuestion(input.id, input.datasetVersion);
  }

  // 批量写入用户固定案例：同一事务内全部成功或全部回滚。
  // 调用方已完成字段和题面校验；这里仍以唯一键作为并发下的最后一道保护。
  async function insertFixedQuestionsAtomic(inputs) {
    const client = await getPool().connect();
    try {
      await client.query('BEGIN');
      // 与编辑共用事务锁，避免导入和编辑并发时把同服务同题面写成两个 active 版本。
      const lockKeys = [...new Set((inputs || []).map((input) => fixedFingerprintLockKey(input.domainKey ? `domain:${input.domainKey}` : input.serviceKey, input.fingerprint)))].sort();
      for (const lockKey of lockKeys) {
        await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [lockKey]);
      }
      const rows = [];
      for (const input of inputs) {
        // 路由层的预检查不在事务锁内；这里必须再查一次，覆盖与编辑/另一批导入的并发窗口。
        const duplicateResult = await client.query(
          `SELECT 1 FROM eval_questions
           WHERE (($3::text IS NOT NULL AND domain_key = $3 AND service_key IS NULL) OR ($3::text IS NULL AND service_key = $1))
             AND fingerprint = $2
             AND layer = 'base'
             AND source_type = 'fixed'
             AND status = 'active'
           LIMIT 1`,
          [input.serviceKey || null, input.fingerprint || null, input.domainKey || null],
        );
        if (duplicateResult.rows[0]) {
          const duplicate = questionBankError(409, 'FIXED_CASE_DUPLICATE', '固定案例已存在，未覆盖历史记录');
          throw duplicate;
        }
        const result = await client.query(
          `INSERT INTO eval_questions (id, layer, service_key, source_type, question, fingerprint, criteria, criteria_version, dataset_version, status, domain_key)
           VALUES ($1, 'base', $2, 'fixed', $3, $4, $5::jsonb, $6, $7, 'active', $8)
           ON CONFLICT (id, dataset_version) DO NOTHING
           RETURNING *`,
          [
            String(input.id),
            input.serviceKey || null,
            String(input.question),
            input.fingerprint || null,
            JSON.stringify(input.criteria == null ? null : input.criteria),
            input.criteriaVersion || null,
            String(input.datasetVersion),
            input.domainKey || null,
          ],
        );
        if (!result.rows[0]) {
          const duplicate = new Error('固定案例已存在，未覆盖历史记录');
          duplicate.status = 409;
          duplicate.code = 'FIXED_CASE_DUPLICATE';
          throw duplicate;
        }
        rows.push(mapQuestionRow(result.rows[0]));
      }
      await client.query('COMMIT');
      return rows;
    } catch (error) {
      try { await client.query('ROLLBACK'); } catch {}
      throw normalizeFixedCaseStorageError(error);
    } finally {
      client.release();
    }
  }

  // 与旧随机题保持相同的服务、指纹和题目 ID；同批保存要么全部成功，要么全部回滚。
  async function insertRandomQuestionsAtomic(inputs) {
    const client = await getPool().connect();
    try {
      await client.query('BEGIN');
      const keys = [...new Set(inputs.map(item => `random:${item.domainKey ? `domain:${item.domainKey}` : item.serviceKey}:${item.fingerprint}`))].sort();
      for (const key of keys) await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [key]);
      const items = []; let created = 0;
      for (const item of inputs) {
        const found = await client.query(`SELECT * FROM eval_questions WHERE (($3::text IS NOT NULL AND domain_key=$3 AND service_key IS NULL) OR ($3::text IS NULL AND service_key=$1)) AND fingerprint=$2
          AND source_type='random' AND layer='base' AND status='active' ORDER BY dataset_version DESC LIMIT 1`, [item.serviceKey, item.fingerprint, item.domainKey || null]);
        if (found.rows[0]) { items.push(mapQuestionRow(found.rows[0])); continue; }
        const inserted = await client.query(`INSERT INTO eval_questions
          (id,layer,service_key,source_type,question,fingerprint,dataset_version,status,domain_key)
          VALUES ($1,'base',$2,'random',$3,$4,$5,'active',$6) ON CONFLICT (id,dataset_version) DO NOTHING RETURNING *`,
        [item.id, item.serviceKey, item.question, item.fingerprint, item.datasetVersion, item.domainKey || null]);
        if (inserted.rows[0]) { created++; items.push(mapQuestionRow(inserted.rows[0])); continue; }
        // 旧夜检写入不使用这里的 advisory lock，以共同的 ID/版本唯一键解决并发。
        const concurrent = await client.query(`SELECT * FROM eval_questions WHERE id=$1 AND dataset_version=$2
          AND service_key IS NOT DISTINCT FROM $3 AND fingerprint=$4 AND domain_key IS NOT DISTINCT FROM $5 AND layer='base' AND source_type='random' AND status='active'`,
        [item.id, item.datasetVersion, item.serviceKey, item.fingerprint, item.domainKey || null]);
        if (!concurrent.rows[0]) throw questionBankError(409, 'RANDOM_QUESTION_VERSION_CONFLICT', '相同随机题版本已存在但不可用，请刷新后检查');
        items.push(mapQuestionRow(concurrent.rows[0]));
      }
      await client.query('COMMIT');
      return { items, created, reused: items.length - created };
    } catch (error) {
      try { await client.query('ROLLBACK'); } catch {}
      throw normalizeFixedCaseStorageError(error);
    } finally { client.release(); }
  }

  // 用户题目编辑（固定/随机）：锁住当前版本后退休旧行，并以同一个题目 ID 新增版本。
  // 旧行和已有运行记录永远不 UPDATE/DELETE，确保运行中的旧题仍能按原版本归档。
  async function updateFixedQuestionVersion({ id, datasetVersion, question, fingerprint, sourceType = 'fixed' } = {}) {
    const client = await getPool().connect();
    try {
      await client.query('BEGIN');

      const currentResult = await client.query(
        `SELECT * FROM eval_questions
         WHERE id = $1 AND dataset_version = $2
         LIMIT 1
         FOR UPDATE`,
        [String(id), String(datasetVersion)],
      );
      const current = currentResult.rows[0];
      assertUploadedFixedQuestionRow(current, sourceType);
      if (current.status !== 'active') {
        throw questionBankError(409, 'FIXED_CASE_VERSION_CONFLICT', '当前题目版本已停用或已被其他操作更新');
      }

      if (current.fingerprint && current.fingerprint === fingerprint) {
        throw questionBankError(409, 'FIXED_CASE_DUPLICATE', '修改后的题面与当前题目相同');
      }

      await client.query(
        'SELECT pg_advisory_xact_lock(hashtext($1))',
        [`${sourceType === 'random' ? 'random:' : ''}${fixedFingerprintLockKey(current.service_key || `domain:${current.domain_key}`, fingerprint)}`],
      );

      const duplicateResult = await client.query(
        `SELECT 1 FROM eval_questions
         WHERE (($5::text IS NOT NULL AND domain_key = $5 AND service_key IS NULL) OR ($5::text IS NULL AND service_key = $1))
           AND fingerprint = $2
           AND layer = 'base'
           AND source_type = $6
           AND status = 'active'
           AND NOT (id = $3 AND dataset_version = $4)
         LIMIT 1`,
        [current.service_key || null, fingerprint || null, String(id), String(datasetVersion), current.service_key ? null : current.domain_key || null, sourceType],
      );
      if (duplicateResult.rows[0]) {
        throw questionBankError(409, 'FIXED_CASE_DUPLICATE', '修改后的题面与同一分类范围内其他有效题目重复');
      }

      const versionsResult = await client.query(
        'SELECT dataset_version FROM eval_questions WHERE id = $1 FOR UPDATE',
        [String(id)],
      );
      const newDatasetVersion = sourceType === 'random' ? `gen-edit-v${1 + Math.max(0, ...versionsResult.rows.map(r => Number(/^gen-edit-v(\d+)$/.exec(r.dataset_version)?.[1] || 0)))}` : nextFixedUploadDatasetVersion(versionsResult.rows);
      const retiredResult = await client.query(
        `UPDATE eval_questions
         SET status = 'retired', retired_reason = $3
         WHERE id = $1 AND dataset_version = $2 AND status = 'active'
         RETURNING *`,
        [String(id), String(datasetVersion), 'edited: new dataset version'],
      );
      if (!retiredResult.rows[0]) {
        throw questionBankError(409, 'FIXED_CASE_VERSION_CONFLICT', '当前题目版本已停用或已被其他操作更新');
      }

      const insertedResult = await client.query(
        `INSERT INTO eval_questions (
           id, layer, service_key, source_type, question, fingerprint,
           criteria, criteria_version, dataset_version, status, domain_key
         ) VALUES ($1, 'base', $2, $9, $3, $4, $5::jsonb, $6, $7, 'active', $8)
         RETURNING *`,
        [
          String(id),
          current.service_key || null,
          String(question),
          fingerprint || null,
          JSON.stringify(parseJson(current.criteria)),
          current.criteria_version || null,
          newDatasetVersion,
          current.domain_key || null,
          sourceType,
        ],
      );
      if (!insertedResult.rows[0]) {
        throw questionBankError(500, 'FIXED_CASE_VERSION_WRITE_FAILED', '题目新版本写入失败');
      }

      await client.query('COMMIT');
      return mapQuestionRow(insertedResult.rows[0]);
    } catch (error) {
      try { await client.query('ROLLBACK'); } catch {}
      throw normalizeFixedCaseStorageError(error);
    } finally {
      client.release();
    }
  }

  // 编辑代码内置固定案例：代码定义作为当前基线，数据库覆盖作为新版本；
  // 同一事务内锁住案例身份、目标指纹和题目版本，避免编辑/导入并发产生两个 active 题。
  async function updateBuiltinFixedQuestionVersion({ caseDef, datasetVersion, question, fingerprint } = {}) {
    if (!caseDef || !caseDef.id || !caseDef.serviceKey) {
      throw questionBankError(400, 'FIXED_CASE_DEFINITION_INVALID', '内置固定案例定义无效');
    }
    const client = await getPool().connect();
    const serviceKey = String(caseDef.serviceKey);
    const caseId = String(caseDef.id);
    const questionId = `${serviceKey}:${caseId}`;
    try {
      await client.query('BEGIN');
      // 先锁案例身份，再读取覆盖记录/题目版本；停用路径使用相同顺序，避免
      // 编辑与停用并发时出现“覆盖行锁 -> advisory lock”的反向等待。
      await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [fixedCaseIdentityLockKey(serviceKey, caseId)]);

      const overrideResult = await client.query(
        `SELECT * FROM eval_fixed_case_overrides
         WHERE service_key = $1 AND case_id = $2
         ORDER BY created_at DESC, dataset_version DESC
         LIMIT 1
         FOR UPDATE`,
        [serviceKey, caseId],
      );
      const latestOverride = overrideResult.rows[0] || null;
      if (latestOverride && (latestOverride.dataset_version !== String(datasetVersion) || latestOverride.status !== 'active')) {
        throw questionBankError(409, 'FIXED_CASE_VERSION_CONFLICT', '当前内置固定案例版本已停用或已被其他操作更新');
      }

      const currentResult = await client.query(
        `SELECT * FROM eval_questions
         WHERE id = $1 AND dataset_version = $2
         LIMIT 1
         FOR UPDATE`,
        [questionId, String(datasetVersion)],
      );
      const current = currentResult.rows[0];
      if (!current) throw questionBankError(404, 'QUESTION_NOT_FOUND', '题目不存在');
      if (current.layer !== 'base' || current.source_type !== 'fixed' || current.id !== questionId) {
        throw questionBankError(400, 'FIXED_CASE_NOT_EDITABLE', '只有 base/fixed 固定案例可以编辑');
      }
      if (current.status !== 'active') {
        throw questionBankError(409, 'FIXED_CASE_VERSION_CONFLICT', '当前内置固定案例版本已停用或已被其他操作更新');
      }
      if (current.fingerprint && current.fingerprint === fingerprint) {
        throw questionBankError(409, 'FIXED_CASE_DUPLICATE', '修改后的题面与当前固定案例相同');
      }

      const lockKeys = [
        fixedFingerprintLockKey(serviceKey, fingerprint),
      ].sort();
      for (const lockKey of lockKeys) {
        await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [lockKey]);
      }
      const duplicateResult = await client.query(
        `SELECT 1 FROM eval_questions
         WHERE service_key = $1
           AND fingerprint = $2
           AND layer = 'base'
           AND source_type = 'fixed'
           AND status = 'active'
           AND NOT (id = $3 AND dataset_version = $4)
         LIMIT 1
         FOR UPDATE`,
        [serviceKey, fingerprint || null, questionId, String(datasetVersion)],
      );
      if (duplicateResult.rows[0]) {
        throw questionBankError(409, 'FIXED_CASE_DUPLICATE', '修改后的题面与同服务其他 active 固定案例重复');
      }

      const versionsResult = await client.query(
        'SELECT dataset_version FROM eval_questions WHERE id = $1 FOR UPDATE',
        [questionId],
      );
      const newDatasetVersion = nextFixedOverrideDatasetVersion(versionsResult.rows);
      const retiredResult = await client.query(
        `UPDATE eval_questions
         SET status = 'retired', retired_reason = $3
         WHERE id = $1 AND dataset_version = $2 AND status = 'active'
         RETURNING *`,
        [questionId, String(datasetVersion), 'edited: new dataset version'],
      );
      if (!retiredResult.rows[0]) {
        throw questionBankError(409, 'FIXED_CASE_VERSION_CONFLICT', '当前内置固定案例版本已停用或已被其他操作更新');
      }
      if (latestOverride) {
        await client.query(
          `UPDATE eval_fixed_case_overrides
           SET status = 'retired', retired_reason = $4
           WHERE service_key = $1 AND case_id = $2 AND dataset_version = $3 AND status = 'active'`,
          [serviceKey, caseId, String(datasetVersion), 'edited: new dataset version'],
        );
      }
      const insertedResult = await client.query(
        `INSERT INTO eval_questions (
           id, layer, service_key, source_type, question, fingerprint,
           criteria, criteria_version, dataset_version, status, domain_key
         ) VALUES ($1, 'base', $2, 'fixed', $3, $4, $5::jsonb, $6, $7, 'active', $8)
         RETURNING *`,
        [
          questionId,
          serviceKey,
          String(question),
          fingerprint || null,
          JSON.stringify(parseJson(current.criteria)),
          current.criteria_version || null,
          newDatasetVersion,
          current.domain_key || null,
        ],
      );
      if (!insertedResult.rows[0]) {
        throw questionBankError(500, 'FIXED_CASE_VERSION_WRITE_FAILED', '内置固定案例新版本写入失败');
      }
      await client.query(
        `INSERT INTO eval_fixed_case_overrides (
           service_key, case_id, question_id, dataset_version, status
         ) VALUES ($1, $2, $3, $4, 'active')`,
        [serviceKey, caseId, questionId, newDatasetVersion],
      );
      await client.query('COMMIT');
      return mapQuestionRow(insertedResult.rows[0]);
    } catch (error) {
      try { await client.query('ROLLBACK'); } catch {}
      throw normalizeFixedCaseStorageError(error);
    } finally {
      client.release();
    }
  }

  // 题目软删除：仅将当前 active 版本置为 retired，绝不物理删除历史。
  async function retireFixedQuestion({ id, datasetVersion, reason, sourceType = 'fixed' } = {}) {
    const client = await getPool().connect();
    try {
      await client.query('BEGIN');
      const currentResult = await client.query(
        `SELECT * FROM eval_questions
         WHERE id = $1 AND dataset_version = $2
         LIMIT 1
         FOR UPDATE`,
        [String(id), String(datasetVersion)],
      );
      const current = currentResult.rows[0];
      assertUploadedFixedQuestionRow(current, sourceType);
      if (current.status !== 'active') {
        throw questionBankError(409, 'FIXED_CASE_VERSION_CONFLICT', '当前题目版本已停用或已被其他操作更新');
      }

      const result = await client.query(
        `UPDATE eval_questions
         SET status = 'retired', retired_reason = $3
         WHERE id = $1 AND dataset_version = $2 AND status = 'active'
         RETURNING *`,
        [String(id), String(datasetVersion), String(reason || 'manual delete').slice(0, 200) || null],
      );
      if (!result.rows[0]) {
        throw questionBankError(409, 'FIXED_CASE_VERSION_CONFLICT', '当前题目版本已停用或已被其他操作更新');
      }
      await client.query('COMMIT');
      return mapQuestionRow(result.rows[0]);
    } catch (error) {
      try { await client.query('ROLLBACK'); } catch {}
      throw normalizeFixedCaseStorageError(error);
    } finally {
      client.release();
    }
  }

  // 停用代码内置固定案例：退休当前题目版本并写入 retired 覆盖 tombstone。
  async function retireBuiltinFixedQuestion({ caseDef, datasetVersion, reason } = {}) {
    if (!caseDef || !caseDef.id || !caseDef.serviceKey) {
      throw questionBankError(400, 'FIXED_CASE_DEFINITION_INVALID', '内置固定案例定义无效');
    }
    const client = await getPool().connect();
    const serviceKey = String(caseDef.serviceKey);
    const caseId = String(caseDef.id);
    const questionId = `${serviceKey}:${caseId}`;
    try {
      await client.query('BEGIN');
      await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [fixedCaseIdentityLockKey(serviceKey, caseId)]);
      const overrideResult = await client.query(
        `SELECT * FROM eval_fixed_case_overrides
         WHERE service_key = $1 AND case_id = $2
         ORDER BY created_at DESC, dataset_version DESC
         LIMIT 1
         FOR UPDATE`,
        [serviceKey, caseId],
      );
      const latestOverride = overrideResult.rows[0] || null;
      if (latestOverride && (latestOverride.dataset_version !== String(datasetVersion) || latestOverride.status !== 'active')) {
        throw questionBankError(409, 'FIXED_CASE_VERSION_CONFLICT', '当前内置固定案例版本已停用或已被其他操作更新');
      }
      const currentResult = await client.query(
        `SELECT * FROM eval_questions
         WHERE id = $1 AND dataset_version = $2
         LIMIT 1
         FOR UPDATE`,
        [questionId, String(datasetVersion)],
      );
      const current = currentResult.rows[0];
      if (!current) throw questionBankError(404, 'QUESTION_NOT_FOUND', '题目不存在');
      if (current.layer !== 'base' || current.source_type !== 'fixed' || current.id !== questionId) {
        throw questionBankError(400, 'FIXED_CASE_NOT_EDITABLE', '只有 base/fixed 固定案例可以删除');
      }
      if (current.status !== 'active') {
        throw questionBankError(409, 'FIXED_CASE_VERSION_CONFLICT', '当前内置固定案例版本已停用或已被其他操作更新');
      }
      const retiredResult = await client.query(
        `UPDATE eval_questions
         SET status = 'retired', retired_reason = $3
         WHERE id = $1 AND dataset_version = $2 AND status = 'active'
         RETURNING *`,
        [questionId, String(datasetVersion), String(reason || 'manual delete').slice(0, 200) || null],
      );
      if (!retiredResult.rows[0]) {
        throw questionBankError(409, 'FIXED_CASE_VERSION_CONFLICT', '当前内置固定案例版本已停用或已被其他操作更新');
      }
      if (latestOverride) {
        await client.query(
          `UPDATE eval_fixed_case_overrides
           SET status = 'retired', retired_reason = $4
           WHERE service_key = $1 AND case_id = $2 AND dataset_version = $3 AND status = 'active'`,
          [serviceKey, caseId, String(datasetVersion), String(reason || 'manual delete').slice(0, 200) || null],
        );
      } else {
        await client.query(
          `INSERT INTO eval_fixed_case_overrides (
             service_key, case_id, question_id, dataset_version, status, retired_reason
           ) VALUES ($1, $2, $3, $4, 'retired', $5)`,
          [serviceKey, caseId, questionId, String(datasetVersion), String(reason || 'manual delete').slice(0, 200) || null],
        );
      }
      await client.query('COMMIT');
      return mapQuestionRow(retiredResult.rows[0]);
    } catch (error) {
      try { await client.query('ROLLBACK'); } catch {}
      throw normalizeFixedCaseStorageError(error);
    } finally {
      client.release();
    }
  }

  async function getQuestion(id, datasetVersion) {
    try {
      const result = await getPool().query(
        'SELECT * FROM eval_questions WHERE id = $1 AND dataset_version = $2 LIMIT 1',
        [String(id), String(datasetVersion)],
      );
      return mapQuestionRow(result.rows[0]);
    } catch (error) {
      throw normalizeFixedCaseStorageError(error);
    }
  }

  // 随机题去重：同服务 + 同指纹的活跃题已存在则命中（判定「同题」）。
  async function findActiveByFingerprint(serviceKey, fingerprint, { sourceType } = {}) {
    const params = [String(serviceKey), String(fingerprint)];
    const sourceClause = sourceType ? ` AND source_type = $${params.push(String(sourceType))}` : '';
    try {
      const result = await getPool().query(
        `SELECT * FROM eval_questions
         WHERE service_key = $1 AND fingerprint = $2 AND status = 'active'
         ${sourceClause}
         ORDER BY dataset_version DESC
         LIMIT 1`,
        params,
      );
      return mapQuestionRow(result.rows[0]);
    } catch (error) {
      throw normalizeFixedCaseStorageError(error);
    }
  }

  async function listQuestions({ serviceKey, layer, sourceType, status = 'active', search, limit = 50, offset = 0 } = {}) {
    const where = ['1 = 1'];
    const params = [];
    if (status) { params.push(status); where.push(`status = $${params.length}`); }
    if (serviceKey) { params.push(serviceKey); where.push(`service_key = $${params.length}`); }
    if (layer) { params.push(layer); where.push(`layer = $${params.length}`); }
    if (sourceType) { params.push(sourceType); where.push(`source_type = $${params.length}`); }
    if (search) { params.push(`%${search}%`); where.push(`question ILIKE $${params.length}`); }
    try {
      const result = await getPool().query(
        `SELECT * FROM eval_questions WHERE ${where.join(' AND ')}
         ORDER BY created_at DESC, id DESC
         LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
        [...params, Math.min(Number(limit) || 50, 500), Math.max(Number(offset) || 0, 0)],
      );
      return result.rows.map(mapQuestionRow);
    } catch (error) {
      throw normalizeFixedCaseStorageError(error);
    }
  }

  // 退休不删数据：趋势仍可回看，回归抽样自动跳过。
  async function retireQuestion(id, datasetVersion, reason) {
    const result = await getPool().query(
      `UPDATE eval_questions SET status = 'retired', retired_reason = $3
       WHERE id = $1 AND dataset_version = $2 AND status = 'active'
       RETURNING *`,
      [String(id), String(datasetVersion), String(reason || '').slice(0, 200) || null],
    );
    return mapQuestionRow(result.rows[0]);
  }

  // 幂等写入成绩：命中唯一键时返回 null（多实例重复触发不写重）。
  async function insertRun(input) {
    const result = await getPool().query(
      `INSERT INTO eval_question_runs (
         question_id, dataset_version, service_key, run_date, attempt, batch_id,
         is_regression, regression_round, answer_ref, evidence_ref, verdict, checks,
         clause_set_version, quality, quality_rubric_version, judge_model, prompt_hash,
         score_state, recompute_reason, backfilled, error, started_at
       ) VALUES (
         $1, $2, $3, $4::date, $5, $6,
         $7, $8, $9, $10, $11, $12::jsonb,
         $13, $14::jsonb, $15, $16, $17,
         $18, $19, $20, $21, $22
       )
       ON CONFLICT (question_id, dataset_version, service_key, run_date, attempt) DO NOTHING
       RETURNING *`,
      [
        String(input.questionId),
        String(input.datasetVersion),
        String(input.serviceKey),
        dateKey(input.runDate),
        Number(input.attempt || 1),
        input.batchId || null,
        input.isRegression === true,
        input.regressionRound == null ? null : Number(input.regressionRound),
        input.answerRef || null,
        input.evidenceRef || null,
        input.verdict || null,
        JSON.stringify(input.checks == null ? null : input.checks),
        input.clauseSetVersion || null,
        JSON.stringify(input.quality == null ? null : input.quality),
        input.qualityRubricVersion || null,
        input.judgeModel || null,
        input.promptHash || null,
        input.scoreState === 'recomputed' ? 'recomputed' : 'first',
        input.recomputeReason || null,
        input.backfilled === true,
        input.error || null,
        input.startedAt || null,
      ],
    );
    return result.rows[0] ? mapRunRow(result.rows[0]) : null;
  }

  async function getRuns({ serviceKey, runDate, questionId, isRegression, limit = 500 } = {}) {
    const where = ['1 = 1'];
    const params = [];
    if (serviceKey) { params.push(serviceKey); where.push(`service_key = $${params.length}`); }
    if (runDate) { params.push(dateKey(runDate)); where.push(`run_date = $${params.length}::date`); }
    if (questionId) { params.push(questionId); where.push(`question_id = $${params.length}`); }
    if (isRegression != null) { params.push(isRegression); where.push(`is_regression = $${params.length}`); }
    const result = await getPool().query(
      `SELECT * FROM eval_question_runs WHERE ${where.join(' AND ')}
       ORDER BY run_date DESC, service_key, attempt DESC
       LIMIT $${params.length + 1}`,
      [...params, Math.min(Number(limit) || 500, 2000)],
    );
    return result.rows.map(mapRunRow);
  }

  // 同源运行查找：checks.sourceRunId 埋在条款结果里，用于同步重跑的幂等判定。
  async function findBySourceRunId(sourceRunId) {
    const result = await getPool().query(
      `SELECT * FROM eval_question_runs WHERE checks->>'sourceRunId' = $1 LIMIT 1`,
      [String(sourceRunId)],
    );
    return result.rows[0] ? mapRunRow(result.rows[0]) : null;
  }

  // 同源幂等 + 同日同题 attempt 递增：sourceRunId 已入库直接返回 resynced（重跑同步不写重）；
  // 撞唯一键（同题同日已有别的运行，如随机重复出题/回归与随机同日撞题）时 attempt 自增重试。
  async function insertRunTracked(input) {
    if (input.sourceRunId) {
      const existing = await findBySourceRunId(input.sourceRunId);
      if (existing) return { status: 'resynced', run: existing };
    }
    for (let attempt = 1; attempt <= 9; attempt += 1) {
      const run = await insertRun({ ...input, attempt });
      if (run) return { status: 'written', run };
    }
    return { status: 'conflict', run: null };
  }

  async function getQuestionHistory(questionId, { limit = 100 } = {}) {
    try {
      const result = await getPool().query(
        `SELECT * FROM eval_question_runs
         WHERE question_id = $1
         ORDER BY run_date ASC, service_key, attempt DESC
         LIMIT $2`,
        [String(questionId), Math.min(Number(limit) || 100, 1000)],
      );
      return result.rows.map(mapRunRow);
    } catch (error) {
      throw normalizeFixedCaseStorageError(error);
    }
  }

  // 回归候选：时间窗内 verdict='fail'（排除 error 的基础设施失败）、题目仍活跃、按题取最近一次失败运行。
  async function listRecentFailQuestions({ serviceKey, sinceDate, untilDate, limit = 200 } = {}) {
    const params = [String(serviceKey), dateKey(sinceDate)];
    let until = `AND r.run_date <= CURRENT_DATE`;
    if (untilDate) {
      params.push(dateKey(untilDate));
      until = `AND r.run_date <= $${params.length}::date`;
    }
    params.push(Math.min(Number(limit) || 200, 1000));
    let result;
    try {
      result = await getPool().query(
        `SELECT DISTINCT ON (r.question_id) r.*, q.question, q.source_type, q.status AS question_status
         FROM eval_question_runs r
         JOIN eval_questions q
           ON q.id = r.question_id AND q.dataset_version = r.dataset_version
         WHERE r.service_key = $1
           AND r.run_date >= $2::date ${until}
           AND r.verdict = 'fail'
           AND r.score_state = 'first'
           AND q.source_type = 'random'
           AND q.status = 'active'
         ORDER BY r.question_id, r.run_date DESC, r.attempt DESC
         LIMIT $${params.length}`,
        params,
      );
    } catch (error) {
      throw normalizeFixedCaseStorageError(error);
    }
    return result.rows.map((row) => ({
      ...mapRunRow(row),
      question: row.question,
      sourceType: row.source_type,
    }));
  }

  // 回归重考查询：某日的回归运行 + 每题在此前最近一次首评结果（判定「转通过」的对照基准）。
  async function getRegressionRuns({ runDate } = {}) {
    let result;
    try {
      result = await getPool().query(
        `SELECT r.question_id, r.dataset_version, r.service_key, r.run_date, r.attempt,
                r.verdict, r.checks, r.answer_ref, r.regression_round, r.quality,
                q.question, q.source_type,
                prev.verdict AS previous_verdict, prev.checks AS previous_checks
         FROM eval_question_runs r
         JOIN eval_questions q
           ON q.id = r.question_id AND q.dataset_version = r.dataset_version
         LEFT JOIN LATERAL (
           SELECT p.verdict, p.checks
           FROM eval_question_runs p
           WHERE p.question_id = r.question_id
             AND p.dataset_version = r.dataset_version
             AND p.service_key = r.service_key
             AND p.run_date < r.run_date
             AND p.score_state = 'first'
           ORDER BY p.run_date DESC, p.attempt DESC
           LIMIT 1
         ) prev ON true
         WHERE r.run_date = $1::date
           AND r.is_regression = true
           AND r.score_state = 'first'
         ORDER BY r.service_key, r.question_id`,
        [dateKey(runDate)],
      );
    } catch (error) {
      throw normalizeFixedCaseStorageError(error);
    }
    return result.rows.map((row) => ({
      questionId: row.question_id,
      datasetVersion: row.dataset_version,
      serviceKey: row.service_key,
      runDate: dateKey(row.run_date),
      attempt: Number(row.attempt || 1),
      verdict: row.verdict || null,
      checks: parseJson(row.checks),
      answerRef: row.answer_ref || null,
      regressionRound: row.regression_round == null ? null : Number(row.regression_round),
      quality: parseJson(row.quality),
      question: row.question,
      sourceType: row.source_type,
      previousVerdict: row.previous_verdict || null,
      previousChecks: parseJson(row.previous_checks),
    }));
  }

  async function setQuestionDomain(id, datasetVersion, domainKey) {
    const client = await getPool().connect();
    try {
      await client.query('BEGIN');
      const current = (await client.query('SELECT * FROM eval_questions WHERE id=$1 AND dataset_version=$2 FOR UPDATE', [id, datasetVersion])).rows[0];
      if (!current || current.layer !== 'base' || !['fixed', 'random'].includes(current.source_type) || current.status !== 'active') {
        throw questionBankError(409, 'QUESTION_VERSION_CONFLICT', '题目已停用或版本已变化，请刷新题库');
      }
      if (!current.service_key) {
        const prefix = current.source_type === 'random' ? 'random:' : '';
        const keys = [...new Set([current.domain_key, domainKey].map(domain => `${prefix}domain:${domain}:${current.fingerprint}`))].sort();
        for (const key of keys) await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [key]);
        const duplicate = await client.query(`SELECT 1 FROM eval_questions WHERE layer='base' AND service_key IS NULL
          AND domain_key=$1 AND fingerprint=$2 AND source_type=$3 AND status='active' AND id<>$4 LIMIT 1`, [domainKey, current.fingerprint, current.source_type, id]);
        if (duplicate.rows.length) throw questionBankError(409, 'QUESTION_DOMAIN_DUPLICATE', '目标领域已存在相同题目，请先处理重复题');
      }
      const result = await client.query(`UPDATE eval_questions SET domain_key=$3 WHERE id=$1 AND dataset_version=$2 RETURNING *`, [id, datasetVersion, domainKey]);
      await client.query('COMMIT');
      return mapQuestionRow(result.rows[0]);
    } catch (error) {
      try { await client.query('ROLLBACK'); } catch {}
      throw normalizeFixedCaseStorageError(error);
    } finally { client.release(); }
  }

  // 分页检索（管理端题库页）：筛选 + 题面搜索 + 总数。
  async function listQuestionsPaged({ serviceKey, domainKey, runnableFor, layer, sourceType, status = 'active', search, limit = 20, offset = 0 } = {}) {
    const where = ['1 = 1'];
    const params = [];
    if (status) { params.push(status); where.push(`status = $${params.length}`); }
    if (serviceKey) { params.push(serviceKey); where.push(`service_key = $${params.length}`); }
    if (domainKey === 'unclassified') where.push('domain_key IS NULL');
    else if (domainKey) { params.push(domainKey); where.push(`domain_key = $${params.length}`); }
    if (runnableFor) {
      params.push(runnableFor); where.push(`(service_key IS NULL OR service_key = $${params.length})`);
      where.push("layer = 'base' AND source_type IN ('fixed', 'random') AND (criteria IS NULL OR criteria = 'null'::jsonb)");
    }
    if (layer) { params.push(layer); where.push(`layer = $${params.length}`); }
    if (sourceType) { params.push(sourceType); where.push(`source_type = $${params.length}`); }
    if (search) { params.push(`%${search}%`); where.push(`question ILIKE $${params.length}`); }
    // 管理端默认只看 active：同一题目 ID 可能因编辑存在多个 active 历史行，
    // 分页必须先按版本取有效的一行再 count/limit，否则会出现重复题和错误总数。
    const activeEffectiveSql = status === 'active'
      ? `WITH ranked AS (
           SELECT q.*,
             ROW_NUMBER() OVER (
               PARTITION BY q.id
               ORDER BY CASE
                 WHEN q.dataset_version ~ '^gen-edit-v[0-9]+$'
                   THEN substring(q.dataset_version FROM '^gen-edit-v([0-9]+)$')::integer
                 WHEN q.dataset_version ~ '^fixed-upload-v[0-9]+$'
                   THEN substring(q.dataset_version FROM '^fixed-upload-v([0-9]+)$')::integer
                 WHEN q.dataset_version ~ '^fixed-override-v[0-9]+$'
                   THEN substring(q.dataset_version FROM '^fixed-override-v([0-9]+)$')::integer
                 ELSE NULL
               END DESC NULLS LAST,
               q.created_at DESC NULLS LAST,
               q.dataset_version DESC
             ) AS effective_rank
           FROM eval_questions q
           WHERE ${where.join(' AND ')}
         )
         SELECT ranked.*, count(*) OVER () AS total_count
         FROM ranked
         WHERE effective_rank = 1
         ORDER BY created_at DESC NULLS LAST, id DESC
         LIMIT $${params.length + 1} OFFSET $${params.length + 2}`
      : `SELECT *, count(*) OVER () AS total_count FROM eval_questions
         WHERE ${where.join(' AND ')}
         ORDER BY created_at DESC, id DESC
         LIMIT $${params.length + 1} OFFSET $${params.length + 2}`;
    try {
      const result = await getPool().query(
        activeEffectiveSql,
        [...params, Math.min(Number(limit) || 20, 100), Math.max(Number(offset) || 0, 0)],
      );
      const total = result.rows.length > 0 ? Number(result.rows[0].total_count) : 0;
      return {
        items: result.rows.map((row) => {
          const { total_count, effective_rank, ...rest } = row;
          return mapQuestionRow(rest);
        }),
        total,
      };
    } catch (error) {
      throw normalizeFixedCaseStorageError(error);
    }
  }

  // 题目详情：不指定版本时取该 ID 的最新数据集版本。
  async function getQuestionLatest(id) {
    try {
      const result = await getPool().query(
        `SELECT * FROM eval_questions
         WHERE id = $1
         ORDER BY CASE
           WHEN dataset_version ~ '^gen-edit-v[0-9]+$'
           THEN substring(dataset_version FROM '^gen-edit-v([0-9]+)$')::integer
           WHEN dataset_version ~ '^fixed-upload-v[0-9]+$'
           THEN substring(dataset_version FROM '^fixed-upload-v([0-9]+)$')::integer
           WHEN dataset_version ~ '^fixed-override-v[0-9]+$'
           THEN substring(dataset_version FROM '^fixed-override-v([0-9]+)$')::integer
           ELSE NULL
         END DESC NULLS LAST,
         created_at DESC NULLS LAST,
         dataset_version DESC
         LIMIT 1`,
        [String(id)],
      );
      return mapQuestionRow(result.rows[0]);
    } catch (error) {
      throw normalizeFixedCaseStorageError(error);
    }
  }

  return {
    upsertQuestion,
    ensureStaticFixedQuestion,
    getFixedCaseOverride,
    findMissingFixedCaseBaselines,
    getFixedCaseOverrideVersion,
    insertFixedQuestionsAtomic,
    insertRandomQuestionsAtomic,
    updateFixedQuestionVersion,
    updateBuiltinFixedQuestionVersion,
    retireFixedQuestion,
    retireBuiltinFixedQuestion,
    getQuestion,
    getQuestionLatest,
    listQuestions,
    listQuestionsPaged,
    setQuestionDomain,
    findActiveByFingerprint,
    retireQuestion,
    insertRun,
    insertRunTracked,
    findBySourceRunId,
    getRuns,
    getQuestionHistory,
    listRecentFailQuestions,
    getRegressionRuns,
  };
}

module.exports = { createEvalQuestionBankRepository };
