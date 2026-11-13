// 把「材料研发测试案例集」中尚未入库的配比题补导为领域固定题，
// 允许合金材料与材料 RSI 共用；重复题（忽略编号前缀和空白）会跳过。
const fs = require('node:fs');
const path = require('node:path');
const { Client } = require('pg');
const { fingerprintOf } = require('../src/question-bank/identity');

const TEST_SET = '材料研发测试案例集';
const SERVICES = ['alloy', 'alpha-rsi'];
const normalize = value => String(value || '').replace(/^\s*\d+\s*[｜|]\s*/, '').replace(/\s+/g, '');

async function main() {
  const url = process.env.EVALUATION_DATABASE_URL;
  if (!url) throw new Error('缺少 EVALUATION_DATABASE_URL');
  const items = JSON.parse(fs.readFileSync(path.join(__dirname, '../src/question-bank/material-case-set-extra.json'), 'utf8'));
  const client = new Client({ connectionString: url });
  await client.connect();
  try {
    const existing = await client.query("SELECT question FROM eval_questions WHERE source_type = 'fixed' AND status = 'active'");
    const seen = new Set(existing.rows.map(row => normalize(row.question)));
    let inserted = 0; let skipped = 0;
    for (const item of items) {
      const question = typeof item.question === 'string' ? item.question.trim() : '';
      if (question.length < 8 || question.length > 500) { skipped++; continue; }
      const key = normalize(question);
      if (seen.has(key)) { skipped++; continue; }
      const fingerprint = fingerprintOf(question);
      const result = await client.query(
        `INSERT INTO eval_questions (id, layer, service_key, source_type, question, fingerprint, dataset_version, status, domain_key, test_set, applicable_services)
         VALUES ($1, 'base', NULL, 'fixed', $2, $3, 'fixed-upload-v1', 'active', 'materials-rd', $4, $5::text[])
         ON CONFLICT (id, dataset_version) DO NOTHING`,
        [`fixed-upload:domain:${fingerprint}`, question, fingerprint, TEST_SET, SERVICES],
      );
      if (result.rowCount) { inserted++; seen.add(key); } else skipped++;
    }
    console.log(JSON.stringify({ testSet: TEST_SET, total: items.length, inserted, skipped }));
  } finally { await client.end(); }
}
main().catch(error => { console.error(error.message); process.exit(1); });
