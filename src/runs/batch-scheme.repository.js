const { TeamServiceError } = require('../errors');

function createBatchSchemeRepository({ pgPool } = {}) {
  let checked;
  async function db() {
    if (!checked) checked = pgPool.query('SELECT current_database() AS name').then(result => {
      if (!['science_admin', 'science_evaluation'].includes(result.rows[0]?.name)) throw new Error('测评方案只能使用测评数据库');
      return pgPool;
    }).catch(error => { checked = null; throw error; });
    return checked;
  }
  async function ready() {
    const result = await (await db()).query("SELECT to_regclass('public.evaluation_batch_schemes') IS NOT NULL AND to_regclass('public.evaluation_manual_batch_plans') IS NOT NULL AS ready");
    return result.rows[0]?.ready === true;
  }
  function map(row) { return { id: row.id, name: row.name, config: row.config, version: row.version, isNightly: row.is_nightly, updatedBy: row.updated_by, updatedAt: row.updated_at }; }
  return {
    ready,
    async list() { if (!await ready()) return { storageReady: false, items: [] }; const r = await (await db()).query('SELECT * FROM evaluation_batch_schemes ORDER BY is_nightly DESC, updated_at DESC'); return { storageReady: true, items: r.rows.map(map) }; },
    async nightly() { if (!await ready()) return null; const r = await (await db()).query('SELECT * FROM evaluation_batch_schemes WHERE is_nightly=true'); return r.rows[0] ? map(r.rows[0]) : null; },
    async save({ id, name, config, version, userId, nightly }) {
      if (!await ready()) throw new TeamServiceError(503, 'BATCH_SCHEMES_NOT_MIGRATED', '测评方案存储尚未迁移');
      const client = await (await db()).connect();
      try {
        await client.query('BEGIN');
        await client.query("SELECT pg_advisory_xact_lock(hashtext('evaluation-batch-scheme'))");
        const current = await client.query('SELECT version FROM evaluation_batch_schemes WHERE id=$1 FOR UPDATE', [id]);
        if ((current.rows[0]?.version || 0) !== version) throw new TeamServiceError(409, 'BATCH_SCHEME_CONFLICT', '方案已被修改，请刷新后重试');
        if (nightly) {
          const previous = await client.query('UPDATE evaluation_batch_schemes SET is_nightly=false,version=version+1,updated_by=$2,updated_at=now() WHERE is_nightly=true AND id<>$1 RETURNING *', [id, userId]);
          for (const row of previous.rows) await client.query('INSERT INTO evaluation_batch_scheme_history(scheme_id,version,name,config,is_nightly,updated_by) VALUES($1,$2,$3,$4::jsonb,false,$5)', [row.id, row.version, row.name, JSON.stringify(row.config), userId]);
        }
        const result = await client.query(`INSERT INTO evaluation_batch_schemes(id,name,config,version,is_nightly,updated_by)
          VALUES($1,$2,$3::jsonb,1,$4,$5) ON CONFLICT(id) DO UPDATE SET name=EXCLUDED.name,config=EXCLUDED.config,
          version=evaluation_batch_schemes.version+1,is_nightly=EXCLUDED.is_nightly,updated_by=EXCLUDED.updated_by,updated_at=now() RETURNING *`, [id, name, JSON.stringify(config), nightly, userId]);
        const row = result.rows[0];
        await client.query('INSERT INTO evaluation_batch_scheme_history(scheme_id,version,name,config,is_nightly,updated_by) VALUES($1,$2,$3,$4::jsonb,$5,$6)', [id, row.version, name, JSON.stringify(config), nightly, userId]);
        await client.query('COMMIT'); return map(row);
      } catch (error) { await client.query('ROLLBACK'); throw error; } finally { client.release(); }
    },
  };
}
module.exports = { createBatchSchemeRepository };
