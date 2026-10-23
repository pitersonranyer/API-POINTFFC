// Integration-test helper; refuses non-isolated destinations. No automatic execution.
const { spawnSync } = require('child_process');
const { isolatedUrl } = require('../../scripts/point-fantasy-scoring-backfill.cjs');
function isolatedSql(url, sql) {
  const target = new URL(isolatedUrl(url));
  if (/^\s*(USE|CREATE DATABASE|DROP DATABASE)\b/im.test(sql)) throw Error('SCHEMA_SWITCH_FORBIDDEN');
  const result = spawnSync('C:/Program Files/MySQL/MySQL Server 8.0/bin/mysql.exe', [
    '--host=' + target.hostname, '--port=' + (target.port || '3306'), '--user=' + decodeURIComponent(target.username),
    '--default-character-set=utf8mb4', target.pathname.slice(1),
  ], { input: sql, env: { ...process.env, MYSQL_PWD: decodeURIComponent(target.password) }, encoding: 'utf8', maxBuffer: 16777216 });
  if (result.status !== 0 || result.error || result.signal) throw Error('ISOLATED_DDL_FAILED');
}
module.exports = { isolatedSql };
