const crypto = require('node:crypto');
const argon2 = require('argon2');

const failure = (status, code, message) => Object.assign(new Error(message), { status, code });
const canManageAccounts = user => user?.username === 'admin' && user.permissions?.includes('team-services:read') && user.permissions?.includes('team-services:write');
const passwordOptions = { type: argon2.argon2id, memoryCost: 65536, timeCost: 3, parallelism: 4 };
function validPassword(password) {
  if (typeof password !== 'string' || password.length < 4 || password.length > 12 || !password.trim()) throw failure(400, 'INVALID_PASSWORD', '密码需为 4–12 个字符');
}
function validId(id) {
  if (typeof id !== 'string' || !id || id === '.' || id === '..' || id.length > 200 || /[\u0000-\u001f\u007f]/.test(id)) throw failure(400, 'INVALID_ACCOUNT_ID', '用户标识无效');
}

function createAccountService(repo) {
  function requireAdmin(user) {
    if (!canManageAccounts(user)) throw failure(403, 'FORBIDDEN', '只有管理员可以管理账号');
  }
  return {
    async list(user, query = {}) {
      requireAdmin(user);
      const page = query.page === undefined ? 1 : Number(query.page);
      const pageSize = query.pageSize === undefined ? 20 : Number(query.pageSize);
      const search = typeof query.search === 'string' ? query.search.trim() : '';
      if (!Number.isInteger(page) || page < 1 || page > 10000 || !Number.isInteger(pageSize) || pageSize < 1 || pageSize > 100 || (query.search !== undefined && typeof query.search !== 'string') || search.length > 100) throw failure(400, 'INVALID_ACCOUNT_QUERY', '账号搜索或分页参数无效');
      return { ...await repo.listAccounts({ search, page, pageSize }), page, pageSize };
    },
    async create(user, input) {
      requireAdmin(user);
      const username = typeof input?.username === 'string' ? input.username.trim().toLowerCase() : '';
      const displayName = typeof input?.displayName === 'string' ? input.displayName.trim() : '';
      const password = input?.password;
      if (!/^[a-z0-9_]{3,32}$/.test(username)) throw failure(400, 'INVALID_USERNAME', '用户名需为 3–32 位英文字母、数字或下划线');
      if (typeof input.displayName !== 'string' || displayName.length > 50) throw failure(400, 'INVALID_DISPLAY_NAME', '显示名称不能超过 50 个字符');
      validPassword(password);
      const passwordHash = await argon2.hash(password, passwordOptions);
      const account = await repo.createAccount({ id: crypto.randomUUID(), username, displayName: displayName || username, passwordHash });
      return { account };
    },
    async update(user, id, input) {
      requireAdmin(user); validId(id);
      const displayName = typeof input?.displayName === 'string' ? input.displayName.trim() : '';
      if (!displayName || displayName.length > 50) throw failure(400, 'INVALID_DISPLAY_NAME', '显示名称需为 1–50 个字符');
      return { account: await repo.updateAccount(id, displayName) };
    },
    async resetPassword(user, id, input) {
      requireAdmin(user); validId(id); validPassword(input?.password);
      const passwordHash = await argon2.hash(input.password, passwordOptions);
      await repo.resetAccountPassword(id, passwordHash);
      return { ok: true };
    },
    async remove(user, id) {
      requireAdmin(user); validId(id);
      await repo.removeAccount(id);
      return { ok: true };
    },
  };
}

function createAccountRepository(pool) {
  async function checkDatabase(connection) {
    const result = await connection.query('SELECT current_database() AS name');
    if (result.rows[0]?.name !== 'science_evaluation') throw failure(503, 'ACCOUNT_DATABASE_INVALID', '账号管理仅支持独立评测数据库');
  }
  async function mutateAccount(id, action) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await checkDatabase(client);
      // 防止检查期间角色权限或账号角色被并发修改。
      await client.query('LOCK TABLE public.admin_role_permissions, public.admin_permissions IN SHARE MODE');
      await client.query('LOCK TABLE public.admin_user_roles IN SHARE ROW EXCLUSIVE MODE');
      const result = await client.query('SELECT id,username,is_admin FROM public.auth_users WHERE id=$1 FOR UPDATE', [id]);
      const target = result.rows[0];
      if (!target) throw failure(404, 'ACCOUNT_NOT_FOUND', '用户不存在或已移除');
      if (target.username.toLowerCase() === 'admin' || target.is_admin) throw failure(403, 'ACCOUNT_PROTECTED', '管理员账号不能在这里修改或删除');
      const roles = await client.query(`SELECT r.code FROM public.admin_user_roles ur
        JOIN public.admin_roles r ON r.id=ur.role_id WHERE ur.user_id=$1 AND ur.is_active=true`, [id]);
      const codes = roles.rows.map(row => row.code);
      if (!codes.includes('evaluation-local')) throw failure(404, 'ACCOUNT_NOT_FOUND', '用户不存在或已移除');
      if (codes.length !== 1) throw failure(403, 'ACCOUNT_PROTECTED', '此账号具有其他角色，不能在这里修改或删除');
      const permissions = await client.query(`SELECT p.code FROM public.admin_role_permissions rp
        JOIN public.admin_permissions p ON p.id=rp.permission_id JOIN public.admin_roles r ON r.id=rp.role_id
        WHERE r.code='evaluation-local' AND r.is_active=true`);
      const permissionCodes = permissions.rows.map(row => row.code).sort();
      if (permissionCodes.length !== 2 || permissionCodes[0] !== 'team-services:read' || permissionCodes[1] !== 'team-services:write') throw failure(503, 'ACCOUNT_ROLE_UNSAFE', '评测账号角色权限异常，请联系管理员');
      const value = await action(client, target);
      await client.query('COMMIT');
      return value;
    } catch (error) {
      try { await client.query('ROLLBACK'); } catch {}
      throw error;
    } finally { client.release(); }
  }
  return {
    async listAccounts({ search = '', page = 1, pageSize = 20 } = {}) {
      await checkDatabase(pool);
      const result = await pool.query(`WITH matching AS (
        SELECT u.id,u.username,u.display_name,u.created_at,
          (lower(u.username) <> 'admin' AND NOT u.is_admin AND NOT EXISTS (
            SELECT 1 FROM public.admin_user_roles other JOIN public.admin_roles other_role ON other_role.id=other.role_id
            WHERE other.user_id=u.id AND other.is_active=true AND other_role.code <> 'evaluation-local'
          ) AND NOT EXISTS (
            SELECT 1 FROM public.admin_roles managed_role JOIN public.admin_role_permissions rp ON rp.role_id=managed_role.id
            JOIN public.admin_permissions p ON p.id=rp.permission_id
            WHERE managed_role.code='evaluation-local' AND p.code NOT IN ('team-services:read','team-services:write')
          ) AND 2 = (
            SELECT count(*) FROM public.admin_roles managed_role JOIN public.admin_role_permissions rp ON rp.role_id=managed_role.id
            JOIN public.admin_permissions p ON p.id=rp.permission_id
            WHERE managed_role.code='evaluation-local' AND p.code IN ('team-services:read','team-services:write')
          )) AS manageable FROM public.auth_users u
        WHERE EXISTS (SELECT 1 FROM public.admin_user_roles ur JOIN public.admin_roles r ON r.id=ur.role_id
          WHERE ur.user_id=u.id AND ur.is_active=true AND r.code='evaluation-local' AND r.is_active=true)
        AND ($1 = '' OR position(lower($1) in lower(u.username)) > 0 OR position(lower($1) in lower(COALESCE(u.display_name, ''))) > 0)
      ) SELECT (SELECT count(*)::int FROM matching) AS total,
        COALESCE((SELECT json_agg(row_to_json(page_rows) ORDER BY page_rows.created_at DESC,page_rows.id DESC)
          FROM (SELECT * FROM matching ORDER BY created_at DESC,id DESC LIMIT $2 OFFSET $3) page_rows), '[]'::json) AS items`,
      [search, pageSize, (page - 1) * pageSize]);
      return { total: result.rows[0].total, items: result.rows[0].items.map(row => ({ id: row.id, username: row.username, displayName: row.display_name, createdAt: row.created_at, manageable: row.manageable === true })) };
    },
    async createAccount(input) {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        await checkDatabase(client);
        // 创建期间锁住角色权限及权限代码，避免并发修改导致错误授权。
        await client.query('LOCK TABLE public.admin_role_permissions, public.admin_permissions IN SHARE MODE');
        const role = await client.query("SELECT id FROM public.admin_roles WHERE code='evaluation-local' AND is_active=true FOR SHARE");
        if (!role.rows[0]) throw failure(503, 'ACCOUNT_ROLE_UNAVAILABLE', '评测账号角色不可用，请联系管理员');
        const roleId = role.rows[0].id;
        const permissions = await client.query('SELECT p.code FROM public.admin_role_permissions rp JOIN public.admin_permissions p ON p.id=rp.permission_id WHERE rp.role_id=$1', [roleId]);
        const codes = permissions.rows.map(row => row.code).sort();
        if (codes.length !== 2 || codes[0] !== 'team-services:read' || codes[1] !== 'team-services:write') throw failure(503, 'ACCOUNT_ROLE_UNSAFE', '评测账号角色权限异常，请联系管理员');
        const created = await client.query(`INSERT INTO public.auth_users (id,username,password_hash,display_name,is_admin,token_version)
          VALUES ($1,$2,$3,$4,false,0) ON CONFLICT (username) DO NOTHING RETURNING id,username,display_name,created_at`,
        [input.id, input.username, input.passwordHash, input.displayName]);
        if (!created.rows[0]) throw failure(409, 'USERNAME_TAKEN', '用户名已存在，请更换');
        await client.query('INSERT INTO public.admin_user_roles (user_id,role_id) VALUES ($1,$2)', [input.id, roleId]);
        await client.query('COMMIT');
        const row = created.rows[0];
        return { id: row.id, username: row.username, displayName: row.display_name, createdAt: row.created_at };
      } catch (error) {
        try { await client.query('ROLLBACK'); } catch {}
        throw error;
      } finally { client.release(); }
    },
    async updateAccount(id, displayName) {
      return mutateAccount(id, async client => {
        const result = await client.query('UPDATE public.auth_users SET display_name=$2,updated_at=now() WHERE id=$1 RETURNING id,username,display_name,created_at', [id, displayName]);
        const row = result.rows[0];
        return { id: row.id, username: row.username, displayName: row.display_name, createdAt: row.created_at, manageable: true };
      });
    },
    async resetAccountPassword(id, passwordHash) {
      return mutateAccount(id, client => client.query('UPDATE public.auth_users SET password_hash=$2,token_version=token_version+1,updated_at=now() WHERE id=$1', [id, passwordHash]));
    },
    async removeAccount(id) {
      return mutateAccount(id, async client => {
        await client.query(`UPDATE public.admin_user_roles SET is_active=false WHERE user_id=$1 AND role_id=(SELECT id FROM public.admin_roles WHERE code='evaluation-local') AND is_active=true`, [id]);
        await client.query('UPDATE public.auth_users SET token_version=token_version+1,updated_at=now() WHERE id=$1', [id]);
      });
    },
  };
}

module.exports = { canManageAccounts, createAccountService, createAccountRepository };
