const { randomUUID } = require('node:crypto');
const { normalize } = require('./service');
const fail = (status, code, message) => Object.assign(new Error(message), { status, code });
function createStandardsRepository({ pool, questions }) {
  let checked;
  async function db() {
    if (!checked) checked = pool.query('SELECT current_database() AS name').then(r => { if (!['science_admin','science_evaluation'].includes(r.rows[0]?.name)) throw Error('数据库不匹配'); return pool; }).catch(e => { checked = null; throw e; });
    return checked;
  }
  const valid = (id, version) => typeof id === 'string' && id.length > 0 && id.length <= 200 && typeof version === 'string' && version.length > 0 && version.length <= 200;
  return {
    async list(id, version) {
      if (!valid(id, version)) throw fail(400,'INVALID_QUESTION','题目版本无效');
      const result = await (await db()).query("SELECT id,state,question,content,model,created_at,confirmed_at FROM evaluation_question_standards WHERE question_id=$1 AND dataset_version=$2 ORDER BY (state='confirmed') DESC,created_at DESC,id DESC LIMIT 100",[id,version]);
      return { items: result.rows.map(row => ({ id:row.id,state:row.state,question:row.question,content:row.content,model:row.model,createdAt:row.created_at,confirmedAt:row.confirmed_at })) };
    },
    async save(input, actor) {
      if (!valid(input?.questionId,input?.datasetVersion) || typeof input.question !== 'string') throw fail(400,'INVALID_QUESTION','题目版本无效');
      const row = await questions.getQuestion(input.questionId,input.datasetVersion);
      if (!row || row.status !== 'active' || row.question.trim() !== input.question.trim()) throw fail(409,'QUESTION_CHANGED','题目不存在、已停用或题面已变化，请重新选择');
      let content; try { content = normalize(input.content, row.question.trim()); } catch { throw fail(400,'INVALID_STANDARDS','评判标准格式或题目引用无效'); }
      const id=randomUUID();
      await (await db()).query("INSERT INTO evaluation_question_standards(id,question_id,dataset_version,question,content,model,state,created_by) VALUES ($1,$2,$3,$4,$5::jsonb,$6,'draft',$7)",[id,input.questionId,input.datasetVersion,row.question.trim(),JSON.stringify(content),typeof input.model==='string'?input.model.slice(0,120):null,String(actor)]);
      return { id,state:'draft' };
    },
    async confirm(id, actor) {
      if (typeof id !== 'string' || !/^[a-f\d]{8}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{12}$/i.test(id)) throw fail(400,'INVALID_STANDARD','标准标识无效');
      const client=await (await db()).connect();
      try {
        await client.query('BEGIN');
        const found=await client.query('SELECT * FROM evaluation_question_standards WHERE id=$1',[id]);
        if (!found.rowCount) throw fail(404,'STANDARD_NOT_FOUND','标准不存在');
        const item=found.rows[0];
        await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[JSON.stringify([item.question_id,item.dataset_version])]);
        const current=await client.query('SELECT state FROM evaluation_question_standards WHERE id=$1 FOR UPDATE',[id]);
        if (current.rows[0].state==='confirmed') { await client.query('COMMIT'); return {id,state:'confirmed'}; }
        if (current.rows[0].state!=='draft') throw fail(409,'STANDARD_CHANGED','标准状态已变化');
        const q=await client.query('SELECT question,status FROM eval_questions WHERE id=$1 AND dataset_version=$2 FOR SHARE',[item.question_id,item.dataset_version]);
        if (!q.rowCount || q.rows[0].status!=='active' || q.rows[0].question.trim()!==item.question) throw fail(409,'QUESTION_CHANGED','题目已变化或停用，请重新选择');
        await client.query("UPDATE evaluation_question_standards SET state='superseded' WHERE question_id=$1 AND dataset_version=$2 AND state='confirmed'",[item.question_id,item.dataset_version]);
        await client.query("UPDATE evaluation_question_standards SET state='confirmed',confirmed_at=now() WHERE id=$1",[id]);
        await client.query('COMMIT'); return {id,state:'confirmed'};
      } catch(e) { await client.query('ROLLBACK').catch(()=>{}); throw e; } finally { client.release(); }
    },
  };
}
module.exports = { createStandardsRepository };
