const { test } = require('node:test');
const assert = require('node:assert/strict');
const argon2 = require('argon2');
const { createApp } = require('../src/app');
const { createAuthService } = require('../src/auth/service');
const { canManageAccounts, createAccountService, createAccountRepository } = require('../src/auth/accounts');

const admin = { id: 'admin-id', username: 'admin', permissions: ['team-services:read', 'team-services:write'] };
const member = { id: 'member-id', username: 'member', permissions: ['team-services:read', 'team-services:write'] };
const valid = { username: 'New_User', displayName: '测试用户', password: 'example123' };

test('只有具有评测读写权限的 admin 可以创建账号，密码仅保存为 Argon2 哈希', async () => {
  let stored;
  const service = createAccountService({ createAccount: async input => { stored = input; return { id: input.id, username: input.username, displayName: input.displayName }; }, listAccounts: async () => ({ items: [], total: 0 }) });
  assert.equal(Boolean(canManageAccounts(member)), false);
  assert.equal(Boolean(canManageAccounts({ ...admin, permissions: ['team-services:read'] })), false);
  await assert.rejects(() => service.create(member, valid), e => e.status === 403);
  await assert.rejects(() => service.list(member), e => e.status === 403);
  const result = await service.create(admin, valid);
  assert.equal(result.account.username, 'new_user');
  assert.equal(await argon2.verify(stored.passwordHash, valid.password), true);
  assert.equal(JSON.stringify(result).includes(valid.password), false);
  for (const input of [{ ...valid, username: '无效' }, { ...valid, password: '123' }, { ...valid, password: 'a'.repeat(13) }, { ...valid, password: '    ' }, { ...valid, displayName: '名'.repeat(51) }]) {
    await assert.rejects(() => service.create(admin, input), e => e.status === 400);
  }
  for (const password of ['1234', 'a'.repeat(12)]) assert.equal((await service.create(admin, { ...valid, password })).account.username, 'new_user');
});

test('账号列表支持分页和字面搜索，并拒绝无效参数', async () => {
  let received;
  const service = createAccountService({ listAccounts: async query => { received = query; return { items: [{ username: 'alice' }], total: 23 }; } });
  const result = await service.list(admin, { page: '2', pageSize: '10', search: ' a_% ' });
  assert.deepEqual(received, { page: 2, pageSize: 10, search: 'a_%' });
  assert.deepEqual(result, { items: [{ username: 'alice' }], total: 23, page: 2, pageSize: 10 });
  for (const query of [{ page: 0 }, { page: 1.2 }, { pageSize: 101 }, { search: 'x'.repeat(101) }]) await assert.rejects(() => service.list(admin, query), e => e.code === 'INVALID_ACCOUNT_QUERY');
});

test('账号列表 SQL 使用参数化分页，不把搜索字符当通配符', async () => {
  let params;
  const pool = { query: async (sql, args) => {
    if (sql.includes('current_database()')) return { rows: [{ name: 'science_evaluation' }] };
    params = args;
    assert.match(sql, /position\(lower\(\$1\)/);
    return { rows: [{ total: 1, items: [{ id: 'id', username: 'alice', display_name: 'Alice', created_at: '2026-11-03', manageable: true }] }] };
  } };
  const result = await createAccountRepository(pool).listAccounts({ search: 'a_%', page: 2, pageSize: 10 });
  assert.deepEqual(params, ['a_%', 10, 10]);
  assert.deepEqual(result.items[0], { id: 'id', username: 'alice', displayName: 'Alice', createdAt: '2026-11-03', manageable: true });
});

test('管理操作拒绝非管理员、无效参数，重置密码只向仓储传入哈希', async () => {
  let reset;
  const service = createAccountService({ resetAccountPassword: async (id, hash) => { reset = { id, hash }; }, updateAccount: async (id, name) => ({ id, displayName: name }), removeAccount: async () => {} });
  await assert.rejects(() => service.update(member, 'id', { displayName: '修改' }), e => e.status === 403);
  await assert.rejects(() => service.remove(member, 'id'), e => e.status === 403);
  await assert.rejects(() => service.resetPassword(member, 'id', { password: '1234' }), e => e.status === 403);
  await assert.rejects(() => service.update(admin, 'id', { displayName: ' ' }), e => e.code === 'INVALID_DISPLAY_NAME');
  await assert.rejects(() => service.resetPassword(admin, 'id', { password: '123' }), e => e.code === 'INVALID_PASSWORD');
  await assert.rejects(() => service.remove(admin, '..'), e => e.code === 'INVALID_ACCOUNT_ID');
  assert.deepEqual(await service.update(admin, 'id', { displayName: ' 用户 ' }), { account: { id: 'id', displayName: '用户' } });
  assert.deepEqual(await service.resetPassword(admin, 'id', { password: 'test1234' }), { ok: true });
  assert.equal(reset.id, 'id'); assert.equal(await argon2.verify(reset.hash, 'test1234'), true);
});

function mutationFixture({ target = { id: 'user-id', username: 'member', is_admin: false }, roles = ['evaluation-local'], permissions = ['team-services:read', 'team-services:write'] } = {}) {
  const commands = [];
  const client = { query: async (sql, args) => {
    commands.push({ sql, args });
    if (sql.includes('current_database()')) return { rows: [{ name: 'science_evaluation' }] };
    if (sql.includes('SELECT id,username,is_admin')) return { rows: target ? [target] : [] };
    if (sql.includes('SELECT r.code FROM public.admin_user_roles')) return { rows: roles.map(code => ({ code })) };
    if (sql.includes('SELECT p.code FROM public.admin_role_permissions')) return { rows: permissions.map(code => ({ code })) };
    if (sql.includes('RETURNING id,username,display_name,created_at')) return { rows: [{ id: args[0], username: target.username, display_name: args[1], created_at: '2026-11-03' }] };
    return { rows: [] };
  }, release() { commands.push({ sql: 'RELEASE' }); } };
  return { commands, repo: createAccountRepository({ connect: async () => client }) };
}

test('普通用户编辑、重置和移除在事务中执行；保护 admin 和其他角色账号', async () => {
  const updated = mutationFixture();
  assert.equal((await updated.repo.updateAccount('user-id', '新名字')).displayName, '新名字');
  assert.ok(updated.commands.some(c => c.sql === 'COMMIT'));
  const reset = mutationFixture(); await reset.repo.resetAccountPassword('user-id', 'hashed');
  assert.ok(reset.commands.some(c => /password_hash=\$2,token_version=token_version\+1/.test(c.sql)));
  const removed = mutationFixture(); await removed.repo.removeAccount('user-id');
  assert.ok(removed.commands.some(c => /UPDATE public.admin_user_roles SET is_active=false/.test(c.sql)));
  assert.ok(removed.commands.some(c => /token_version=token_version\+1/.test(c.sql)));
  assert.ok(!removed.commands.some(c => /DELETE FROM public\.(auth_users|unified_evaluation_runs)/.test(c.sql)));
  for (const opts of [{ target: { id: 'a', username: 'admin', is_admin: false } }, { target: { id: 'a', username: 'ADMIN', is_admin: false } }, { target: { id: 'b', username: 'other', is_admin: true } }, { roles: ['evaluation-local', 'super_admin'] }, { permissions: ['team-services:read', 'team-services:write', 'users:write'] }, { target: null }, { roles: [] }]) {
    const fixture = mutationFixture(opts);
    await assert.rejects(() => fixture.repo.removeAccount('user-id'), e => [403, 404, 503].includes(e.status));
    assert.ok(fixture.commands.some(c => c.sql === 'ROLLBACK'));
    assert.ok(!fixture.commands.some(c => c.sql.startsWith('UPDATE ')));
  }
});

function repositoryFixture({ database = 'science_evaluation', permissions = ['team-services:read', 'team-services:write'], duplicate = false, roleFailure = false } = {}) {
  const commands = [];
  const client = {
    async query(sql, args) {
      commands.push({ sql, args });
      if (sql.includes('current_database()')) return { rows: [{ name: database }] };
      if (sql.includes('SELECT id FROM public.admin_roles')) return { rows: [{ id: 7 }] };
      if (sql.includes('SELECT p.code FROM')) return { rows: permissions.map(code => ({ code })) };
      if (sql.includes('INSERT INTO public.auth_users')) return { rows: duplicate ? [] : [{ id: args[0], username: args[1], display_name: args[3], created_at: '2026-11-03' }] };
      if (sql.includes('INSERT INTO public.admin_user_roles') && roleFailure) throw new Error('role insert failed');
      return { rows: [] };
    },
    release() { commands.push({ sql: 'RELEASE' }); },
  };
  return { commands, repo: createAccountRepository({ connect: async () => client }) };
}

test('账号及评测角色在同一事务创建，失败、越权角色和错误数据库均回滚', async () => {
  const input = { id: 'new-id', username: 'alice', displayName: 'Alice', passwordHash: 'hashed' };
  const ok = repositoryFixture();
  assert.equal((await ok.repo.createAccount(input)).username, 'alice');
  assert.deepEqual(ok.commands.filter(c => /^(BEGIN|COMMIT|ROLLBACK|RELEASE)$/.test(c.sql)).map(c => c.sql), ['BEGIN', 'COMMIT', 'RELEASE']);
  assert.ok(ok.commands.some(c => c.sql.includes('INSERT INTO public.admin_user_roles') && c.args[0] === 'new-id' && c.args[1] === 7));
  for (const options of [{ database: 'science_admin' }, { permissions: ['team-services:read', 'team-services:write', 'users:write'] }, { duplicate: true }, { roleFailure: true }]) {
    const fixture = repositoryFixture(options);
    await assert.rejects(() => fixture.repo.createAccount(input));
    assert.ok(fixture.commands.some(c => c.sql === 'ROLLBACK'));
    assert.ok(!fixture.commands.some(c => c.sql === 'COMMIT'));
  }
});

test('账号接口校验登录、管理员身份和同源，返回内容不含密码', async t => {
  const users = new Map();
  const sessions = new Map();
  const auth = createAuthService({
    userByName: async name => users.get(name) || null,
    permissions: async id => [...users.values()].find(user => user.id === id)?.removed ? [] : ['team-services:read', 'team-services:write'],
    createSession: async (token, user) => sessions.set(token, { username: user.username, version: user.token_version, hash: user.password_hash }),
    session: async token => { const saved = sessions.get(token); const user = saved && users.get(saved.username); return user && user.token_version === saved.version && user.password_hash === saved.hash ? user : null; },
  });
  function manageable(id) {
    const target = [...users.values()].find(user => user.id === id && !user.removed);
    if (!target) throw Object.assign(new Error('用户不存在或已移除'), { status: 404, code: 'ACCOUNT_NOT_FOUND' });
    if (target.username === 'admin') throw Object.assign(new Error('管理员账号不能修改'), { status: 403, code: 'ACCOUNT_PROTECTED' });
    return target;
  }
  const accountService = createAccountService({
    listAccounts: async ({ search, page, pageSize }) => { const matched = [...users.values()].filter(user => user.username.includes(search)).map(({ id, username, display_name }) => ({ id, username, displayName: display_name })); return { items: matched.slice((page - 1) * pageSize, page * pageSize), total: matched.length }; },
    createAccount: async input => {
      if (users.has(input.username)) throw Object.assign(new Error('用户名已存在，请更换'), { status: 409, code: 'USERNAME_TAKEN' });
      users.set(input.username, { id: input.id, username: input.username, display_name: input.displayName, password_hash: input.passwordHash, token_version: 0 });
      return { id: input.id, username: input.username, displayName: input.displayName };
    },
    updateAccount: async (id, name) => { const target = manageable(id); target.display_name = name; return { id, username: target.username, displayName: name }; },
    resetAccountPassword: async (id, hash) => { const target = manageable(id); target.password_hash = hash; target.token_version++; },
    removeAccount: async id => { const target = manageable(id); target.removed = true; target.token_version++; },
  });
  const hash = await argon2.hash('administrator-password');
  users.set('admin', { id: 'admin-id', username: 'admin', display_name: '管理员', password_hash: hash, token_version: 0 });
  users.set('member', { id: 'member-id', username: 'member', display_name: '普通用户', password_hash: hash, token_version: 0 });
  const server = createApp({ token: 'x'.repeat(32), authService: auth, accounts: accountService, publicOrigin: 'http://localhost:4000', secureCookies: false });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); t.after(() => server.close());
  const base = `http://127.0.0.1:${server.address().port}`;
  async function login(username, password = 'administrator-password') {
    const response = await fetch(`${base}/api/auth/login`, { method: 'POST', headers: { origin: 'http://localhost:4000', 'content-type': 'application/json' }, body: JSON.stringify({ username, password }) });
    assert.equal(response.status, 200);
    const body = await response.json();
    return { cookie: response.headers.get('set-cookie').split(';')[0], user: body.user };
  }
  const root = await login('admin'); const ordinary = await login('member');
  assert.equal(root.user.canManageAccounts, true); assert.equal(ordinary.user.canManageAccounts, false);
  const request = (cookie, origin, body = valid) => fetch(`${base}/api/evaluation/accounts`, { method: 'POST', headers: { cookie, origin, 'content-type': 'application/json' }, body: JSON.stringify(body) });
  assert.equal((await request('', 'http://localhost:4000')).status, 401);
  assert.equal((await fetch(`${base}/api/evaluation/accounts`, { headers: { authorization: `Bearer ${'x'.repeat(32)}` } })).status, 401);
  assert.equal((await request(ordinary.cookie, 'http://localhost:4000')).status, 403);
  assert.equal((await request(root.cookie, 'http://evil.invalid')).status, 403);
  assert.equal((await fetch(`${base}/api/evaluation/accounts`, { headers: { cookie: ordinary.cookie } })).status, 403);
  const list = await fetch(`${base}/api/evaluation/accounts?search=member&page=1&pageSize=1`, { headers: { cookie: root.cookie } });
  assert.deepEqual((await list.json()).items.map(item => item.username), ['member']);
  assert.equal((await fetch(`${base}/api/evaluation/accounts?pageSize=101`, { headers: { cookie: root.cookie } })).status, 400);
  const response = await request(root.cookie, 'http://localhost:4000');
  assert.equal(response.status, 201); assert.equal(JSON.stringify(await response.json()).includes(valid.password), false);
  assert.equal((await request(root.cookie, 'http://localhost:4000')).status, 409);
  const newUser = await login('new_user', valid.password);
  assert.equal(newUser.user.canManageAccounts, false);
  assert.equal((await fetch(`${base}/api/evaluation/accounts`, { headers: { cookie: newUser.cookie } })).status, 403);
  const targetId = newUser.user.id;
  const change = (cookie, method, path, input, origin = 'http://localhost:4000') => fetch(`${base}/api/evaluation/accounts/${path}`, { method, headers: { cookie, origin, ...(input ? { 'content-type': 'application/json' } : {}) }, ...(input ? { body: JSON.stringify(input) } : {}) });
  assert.equal((await change(ordinary.cookie, 'DELETE', targetId)).status, 403);
  assert.equal((await change(root.cookie, 'DELETE', 'admin-id')).status, 403);
  assert.equal((await change(root.cookie, 'POST', 'admin-id/reset-password', { password: 'new123' })).status, 403);
  assert.equal((await change(root.cookie, 'PATCH', targetId, { displayName: '新名称' }, 'http://evil.invalid')).status, 403);
  assert.equal((await change(root.cookie, 'PATCH', targetId, { displayName: '新名称' })).status, 200);
  assert.equal((await change(root.cookie, 'POST', `${targetId}/reset-password`, { password: 'new123' })).status, 200);
  assert.equal((await fetch(`${base}/api/auth/me`, { headers: { cookie: newUser.cookie } })).status, 401);
  const resetUser = await login('new_user', 'new123');
  assert.equal((await change(root.cookie, 'DELETE', targetId)).status, 200);
  assert.equal((await fetch(`${base}/api/auth/me`, { headers: { cookie: resetUser.cookie } })).status, 401);
  assert.equal(users.get('new_user').removed, true);
  assert.equal((await change(root.cookie, 'DELETE', targetId)).status, 404);
});
