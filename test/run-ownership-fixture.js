const fs = require('node:fs');
const path = require('node:path');

// 仅供各个独立临时 PostgreSQL 测试库使用，不能连接共享或远端数据库。
async function setupRunOwnership(pool) {
  await pool.query('CREATE TABLE auth_users (id text PRIMARY KEY, username text NOT NULL UNIQUE)');
  await pool.query("INSERT INTO auth_users VALUES ('admin','admin'),('1','user1'),('test','test'),('user','user'),('writer','writer'),('owner','owner'),('other','other'),('reader','reader')");
  await pool.query(fs.readFileSync(path.join(__dirname, '../migrations/011_run_ownership.sql'), 'utf8'));
}
module.exports = { setupRunOwnership };
