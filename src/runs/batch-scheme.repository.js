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
  async function managementReady() {
    if (!await ready()) return false;
    const result = await (await db()).query("SELECT count(*)::int=2 AS ready FROM pg_attribute WHERE attrelid=to_regclass('public.evaluation_batch_schemes') AND attname IN ('created_by','deleted_at') AND attnum>0 AND NOT attisdropped");
    return result.rows[0]?.ready === true;
  }
  async function requireManagement() { if (!await managementReady()) throw new TeamServiceError(503, 'BATCH_SCHEMES_NOT_MIGRATED', '批次配置管理尚未迁移'); }
  function map(row) { return { id: row.id, name: row.name, config: row.config, version: row.version, isNightly: row.is_nightly, createdBy: row.created_by || null, updatedBy: row.updated_by, updatedAt: row.updated_at }; }
  async function history(client, row, userId) {
    await client.query('INSERT INTO evaluation_batch_scheme_history(scheme_id,version,name,config,is_nightly,updated_by) VALUES($1,$2,$3,$4::jsonb,$5,$6)', [row.id, row.version, row.name, JSON.stringify(row.config), row.is_nightly, userId]);
  }
  return {
    ready, managementReady,
    async list({ userId = null, admin = false } = {}) {
      if (!await managementReady()) return { storageReady: false, items: [] };
      const r = await (await db()).query(`SELECT * FROM evaluation_batch_schemes WHERE deleted_at IS NULL${userId && !admin ? ' AND created_by=$1' : ''} ORDER BY is_nightly DESC, updated_at DESC`, userId && !admin ? [String(userId)] : []);
      return { storageReady: true, items: r.rows.map(map) };
    },
    async nightly() { if (!await ready()) return null; const r = await (await db()).query('SELECT * FROM evaluation_batch_schemes WHERE is_nightly=true'); return r.rows[0] ? map(r.rows[0]) : null; },
    async save({ id, name, config, version, userId, nightly }) {
      await requireManagement();
      const client = await (await db()).connect();
      try {
        await client.query('BEGIN');
        await client.query("SELECT pg_advisory_xact_lock(hashtext('evaluation-batch-scheme'))");
        const current = await client.query('SELECT * FROM evaluation_batch_schemes WHERE id=$1 FOR UPDATE', [id]);
        if (current.rows[0] && (current.rows[0].deleted_at || current.rows[0].created_by !== String(userId))) throw new TeamServiceError(404, 'BATCH_SCHEME_NOT_FOUND', '方案不存在或无权修改');
        if ((current.rows[0]?.version || 0) !== version) throw new TeamServiceError(409, 'BATCH_SCHEME_CONFLICT', '方案已被修改，请刷新后重试');
        if (nightly) {
          const previous = await client.query('UPDATE evaluation_batch_schemes SET is_nightly=false,version=version+1,updated_by=$2,updated_at=now() WHERE is_nightly=true AND id<>$1 RETURNING *', [id, userId]);
          for (const row of previous.rows) await history(client, row, userId);
        }
        const result = await client.query(`INSERT INTO evaluation_batch_schemes(id,name,config,version,is_nightly,updated_by,created_by)
          VALUES($1,$2,$3::jsonb,1,$4,$5,$5) ON CONFLICT(id) DO UPDATE SET name=EXCLUDED.name,config=EXCLUDED.config,
          version=evaluation_batch_schemes.version+1,is_nightly=(evaluation_batch_schemes.is_nightly OR EXCLUDED.is_nightly),updated_by=EXCLUDED.updated_by,updated_at=now() RETURNING *`, [id, name, JSON.stringify(config), nightly, userId]);
        const row = result.rows[0];
        await history(client, row, userId);
        await client.query('COMMIT'); return map(row);
      } catch (error) { await client.query('ROLLBACK'); throw error; } finally { client.release(); }
    },
    async remove({ id, version, userId }) {
      await requireManagement();
      const client = await (await db()).connect();
      try {
        await client.query('BEGIN'); await client.query("SELECT pg_advisory_xact_lock(hashtext('evaluation-batch-scheme'))");
        const row = (await client.query('SELECT * FROM evaluation_batch_schemes WHERE id=$1 AND created_by=$2 AND deleted_at IS NULL FOR UPDATE', [id, userId])).rows[0];
        if (!row) throw new TeamServiceError(404, 'BATCH_SCHEME_NOT_FOUND', '方案不存在或无权删除');
        if (row.version !== version) throw new TeamServiceError(409, 'BATCH_SCHEME_CONFLICT', '方案已被修改，请刷新后重试');
        if (row.is_nightly) throw new TeamServiceError(409, 'BATCH_SCHEME_NIGHTLY', '请先由管理员切换夜间方案');
        await client.query('UPDATE evaluation_batch_schemes SET deleted_at=now(),updated_by=$2,updated_at=now() WHERE id=$1', [id, userId]);
        await client.query('COMMIT'); return { ok: true };
      } catch (error) { await client.query('ROLLBACK'); throw error; } finally { client.release(); }
    },
    async setNightly({ id, version, userId }) {
      await requireManagement();
      const client = await (await db()).connect();
      try {
        await client.query('BEGIN'); await client.query("SELECT pg_advisory_xact_lock(hashtext('evaluation-batch-scheme'))");
        const row = (await client.query('SELECT * FROM evaluation_batch_schemes WHERE id=$1 AND deleted_at IS NULL FOR UPDATE', [id])).rows[0];
        if (!row) throw new TeamServiceError(404, 'BATCH_SCHEME_NOT_FOUND', '方案不存在');
        if (row.version !== version) throw new TeamServiceError(409, 'BATCH_SCHEME_CONFLICT', '方案已被修改，请刷新后重试');
        if (row.is_nightly) { await client.query('COMMIT'); return map(row); }
        const previous = await client.query('UPDATE evaluation_batch_schemes SET is_nightly=false,version=version+1,updated_by=$1,updated_at=now() WHERE is_nightly=true AND id<>$2 RETURNING *', [userId, id]);
        for (const item of previous.rows) await history(client, item, userId);
        const selected = (await client.query('UPDATE evaluation_batch_schemes SET is_nightly=true,version=version+1,updated_by=$2,updated_at=now() WHERE id=$1 RETURNING *', [id, userId])).rows[0];
        await history(client, selected, userId); await client.query('COMMIT'); return map(selected);
      } catch (error) { await client.query('ROLLBACK'); throw error; } finally { client.release(); }
    },
  };
}
module.exports = { createBatchSchemeRepository };
