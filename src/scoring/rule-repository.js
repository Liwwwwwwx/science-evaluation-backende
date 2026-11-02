const { TeamServiceError } = require('../errors');
const { hash, validateConfig } = require('./rules');
const conflict = message => { throw new TeamServiceError(409, 'RULE_CONFLICT', message); };
function map(row) {
  if (!row?.id) return null;
  return { id: row.id, version: Number(row.version_no), revision: row.revision, name: row.name, status: row.status, config: row.config,
    changeNote: row.change_note, createdBy: row.created_by, updatedBy: row.updated_by, publishedBy: row.published_by,
    createdAt: new Date(row.created_at).toISOString(), updatedAt: new Date(row.updated_at).toISOString(), publishedAt: row.published_at ? new Date(row.published_at).toISOString() : null };
}
function createRuleRepository(pool) {
  let checked;
  async function db() {
    if (!checked) checked = pool.query('SELECT current_database() AS name').then(r => { if (r.rows[0]?.name !== 'science_admin') throw new Error('规则仅允许使用science_admin数据库'); return pool; }).catch(e => { checked = null; throw e; });
    return checked;
  }
  async function transaction(fn) {
    const client = await (await db()).connect();
    try { await client.query('BEGIN'); const result = await fn(client); await client.query('COMMIT'); return result; }
    catch (e) { await client.query('ROLLBACK'); throw e; } finally { client.release(); }
  }
  const event = (client, row, action, actor) => client.query('INSERT INTO public.evaluation_scoring_rule_events(rule_id,action,actor,revision) VALUES ($1,$2,$3,$4)', [row.id,action,actor,row.revision]);
  return {
    async active() {
      const r = await (await db()).query('SELECT r.* FROM public.evaluation_scoring_rule_state s LEFT JOIN public.evaluation_scoring_rules r ON r.id=s.active_rule_id WHERE s.id=1');
      if (!r.rows.length) throw new Error('规则状态尚未初始化');
      const row = map(r.rows[0]); if (row && row.status !== 'published') throw new Error('生效规则状态异常'); return row;
    },
    async catalog() {
      const p = await db();
      const result = await p.query('SELECT r.*,s.revision AS state_revision FROM public.evaluation_scoring_rule_state s LEFT JOIN public.evaluation_scoring_rules r ON r.id=s.active_rule_id WHERE s.id=1');
      if (!result.rows.length) throw new Error('规则状态尚未初始化');
      const items = await p.query('SELECT * FROM public.evaluation_scoring_rules ORDER BY version_no DESC LIMIT 50');
      const events = await p.query('SELECT rule_id AS "ruleId",action,actor,revision,created_at AS "createdAt" FROM public.evaluation_scoring_rule_events ORDER BY id DESC LIMIT 50');
      return { items: items.rows.map(map), active: map(result.rows[0]), stateRevision: result.rows[0].state_revision, events: events.rows };
    },
    async create(input, actor) {
      return transaction(async client => {
        const signature = hash({ name: input.name, config: input.config, changeNote: input.changeNote });
        const r = await client.query(`INSERT INTO public.evaluation_scoring_rules(id,name,config,change_note,created_by,updated_by,creation_hash)
          VALUES ($1,$2,$3,$4,$5,$5,$6) ON CONFLICT (id) DO NOTHING RETURNING *`, [input.id,input.name,input.config,input.changeNote,actor,signature]);
        if (r.rows[0]) { await event(client,r.rows[0],'created',actor); return map(r.rows[0]); }
        const existing = (await client.query('SELECT * FROM public.evaluation_scoring_rules WHERE id=$1',[input.id])).rows[0];
        if (!existing || existing.created_by !== actor || existing.creation_hash !== signature) conflict('创建请求已被用于其他规则');
        return map(existing);
      });
    },
    async change(id, action, input, actor) {
      return transaction(async client => {
        // 固定锁顺序，发布/生效与归档互斥，并避免并发维护覆盖。
        const state = (await client.query('SELECT * FROM public.evaluation_scoring_rule_state WHERE id=1 FOR UPDATE')).rows[0];
        const row = (await client.query('SELECT * FROM public.evaluation_scoring_rules WHERE id=$1 FOR UPDATE',[id])).rows[0];
        if (!row) throw new TeamServiceError(404,'RULE_NOT_FOUND','规则不存在');
        if (!state) throw new Error('规则状态未初始化');
        if (row.revision !== input.revision) conflict('规则已更新，请刷新后重试；当前输入可复制保留');
        if (action === 'activate') {
          if (state.revision !== input.stateRevision) conflict('生效规则已被其他操作修改，请刷新确认');
          if (row.status !== 'published') conflict('只能启用已发布规则');
          await client.query('UPDATE public.evaluation_scoring_rule_state SET active_rule_id=$1,revision=revision+1,updated_by=$2,updated_at=now() WHERE id=1',[id,actor]);
          await event(client,row,'activated',actor); return map(row);
        }
        if (action === 'save') {
          if (row.status !== 'draft') conflict('已发布版本不可编辑，请复制为新草稿');
          const r = await client.query('UPDATE public.evaluation_scoring_rules SET name=$2,config=$3,change_note=$4,revision=revision+1,updated_by=$5,updated_at=now() WHERE id=$1 RETURNING *',[id,input.name,input.config,input.changeNote,actor]);
          await event(client,r.rows[0],'saved',actor); return map(r.rows[0]);
        }
        if (action === 'publish') {
          if (row.status !== 'draft') conflict('当前版本不能再次发布');
          if (!row.change_note.trim()) throw new TeamServiceError(400,'INVALID_RULE','发布前请填写变更说明');
          validateConfig(row.config);
          const r = await client.query("UPDATE public.evaluation_scoring_rules SET status='published',revision=revision+1,published_by=$2,published_at=now(),updated_by=$2,updated_at=now() WHERE id=$1 RETURNING *",[id,actor]);
          await event(client,r.rows[0],'published',actor); return map(r.rows[0]);
        }
        if (state.active_rule_id === id) conflict('生效中的规则不能归档，请先切换生效版本');
        if (row.status === 'archived') conflict('规则已归档');
        const r = await client.query("UPDATE public.evaluation_scoring_rules SET status='archived',revision=revision+1,updated_by=$2,updated_at=now() WHERE id=$1 RETURNING *",[id,actor]);
        await event(client,r.rows[0],'archived',actor); return map(r.rows[0]);
      });
    },
  };
}
module.exports = { createRuleRepository };
