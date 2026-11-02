const crypto = require('node:crypto');
const fingerprint = value => crypto.createHash('sha256').update(value).digest('hex');
function createAuthRepository(pool) {
  if (!pool || typeof pool.query !== 'function') throw new Error('Authentication requires an explicit database pool');
  let checked;
  async function db() {
    if (!checked) checked = pool.query('SELECT current_database() AS name').then(r => {
      if (!['science_admin', 'science_evaluation'].includes(r.rows[0]?.name)) throw new Error('Authentication requires science_admin or science_evaluation database');
      return pool;
    }).catch(e => { checked = null; throw e; });
    return checked;
  }
  async function permissions(id) {
    const r = await (await db()).query(`SELECT DISTINCT p.code FROM public.admin_permissions p
      JOIN public.admin_role_permissions rp ON rp.permission_id=p.id
      JOIN public.admin_user_roles ur ON ur.role_id=rp.role_id
      WHERE ur.user_id=$1 AND ur.is_active=true`, [String(id)]);
    return r.rows.map(row => row.code);
  }
  return {
    async userByName(name) {
      const r = await (await db()).query('SELECT * FROM public.auth_users WHERE username=$1', [name]);
      return r.rows[0] || null;
    },
    permissions,
    async consumeBackupCode(id, hash) {
      const r = await (await db()).query(`UPDATE public.auth_users SET backup_codes=backup_codes - $2
        WHERE id=$1 AND two_factor_enabled=true AND backup_codes ? $2 RETURNING id`, [id, hash]);
      return r.rowCount === 1;
    },
    async createSession(hash, user, expires) {
      await (await db()).query('INSERT INTO public.evaluation_auth_sessions (token_hash,user_id,token_version,password_fingerprint,expires_at) VALUES ($1,$2,$3,$4,$5)', [hash, user.id, user.token_version, fingerprint(user.password_hash), expires]);
    },
    async session(hash) {
      const r = await (await db()).query(`SELECT u.*, s.password_fingerprint AS session_password_fingerprint FROM public.evaluation_auth_sessions s
        JOIN public.auth_users u ON u.id=s.user_id WHERE s.token_hash=$1 AND s.expires_at>now()
        AND s.token_version=u.token_version`, [hash]);
      const user = r.rows[0];
      return user && fingerprint(user.password_hash) === user.session_password_fingerprint ? user : null;
    },
    async deleteSession(hash) { await (await db()).query('DELETE FROM public.evaluation_auth_sessions WHERE token_hash=$1', [hash]); },
    async deleteUserSessions(id) { await (await db()).query('DELETE FROM public.evaluation_auth_sessions WHERE user_id=$1', [id]); },
  };
}
module.exports = { createAuthRepository };
