// Shared read-only schema helpers. No executor, connection setup or database writes.
const { createHash } = require('crypto');
const hash = value => createHash('sha256').update(value).digest('hex');
const stringify = value => JSON.stringify(value, (_, v) => typeof v === 'bigint' ? v.toString() : v);
const stable = value => JSON.stringify(value, (_, v) => typeof v === 'bigint' ? v.toString() : v && typeof v === 'object' && !Array.isArray(v) ? Object.fromEntries(Object.keys(v).sort().map(k => [k, v[k]])) : v);
function normalizeDdl(ddl) {
  const charset = /DEFAULT CHARSET=(\w+)/.exec(ddl)?.[1];
  // MySQL SHOW CREATE can print an explicit, redundant column charset after a dump restore.
  return charset ? ddl.replaceAll(' CHARACTER SET ' + charset + ' COLLATE ', ' COLLATE ') : ddl;
}
async function fingerprint(db) {
  const tables = await db.$queryRawUnsafe('SHOW TABLES');
  const result = {};
  for (const row of tables) {
    const name = Object.values(row)[0];
    if (!/^[a-z0-9_]+$/i.test(name)) throw new Error('INVALID_TABLE');
    const data = await db.$queryRawUnsafe('SELECT * FROM `' + name + '`');
    const ddl = await db.$queryRawUnsafe('SHOW CREATE TABLE `' + name + '`');
    result[name] = { data: hash(stringify(data.map(r => stable(r)).sort())), ddl: hash(normalizeDdl(Object.values(ddl[0])[1])) };
  }
  return result;
}
async function structure(db) {
  const result = {};
  const tables = await db.$queryRawUnsafe('SHOW TABLES');
  for (const row of tables) {
    const name = Object.values(row)[0];
    if (!/^[a-z0-9_]+$/i.test(name)) throw new Error('INVALID_TABLE');
    const ddl = await db.$queryRawUnsafe('SHOW CREATE TABLE `' + name + '`');
    result[name] = normalizeDdl(Object.values(ddl[0])[1]).replace(/ AUTO_INCREMENT=\d+/g, '');
  }
  return result;
}
module.exports = { fingerprint, structure };
