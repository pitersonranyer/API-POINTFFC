// Test schemas only. No production activation path; existing principal is read-only.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { createHash } = require('crypto');
const { PrismaClient } = require('@prisma/client');
const { isolatedUrl } = require('./point-fantasy-scoring-backfill.cjs');
const { fingerprint, structure } = require('./point-fantasy-scoring-rehearsal.cjs');
const sqlPath = path.resolve(__dirname, '../prisma/migrations/0029_point_fantasy_current_scoring/migration.sql');
const hash = value => createHash('sha256').update(value).digest('hex');
const stable = value => JSON.stringify(value, (_, v) => typeof v === 'bigint' ? v.toString()
  : v && typeof v === 'object' && !Array.isArray(v) ? Object.fromEntries(Object.keys(v).sort().map(key => [key, v[key]])) : v);
function isolatedSql(url, sql) {
  const target = new URL(isolatedUrl(url));
  if (/^\s*(USE|CREATE DATABASE|DROP DATABASE)\b/im.test(sql)) throw Error('SCHEMA_SWITCH_FORBIDDEN');
  const result = spawnSync('C:/Program Files/MySQL/MySQL Server 8.0/bin/mysql.exe', [
    '--host=' + target.hostname, '--port=' + (target.port || '3306'), '--user=' + decodeURIComponent(target.username),
    '--default-character-set=utf8mb4', target.pathname.slice(1),
  ], { input: sql, env: { ...process.env, MYSQL_PWD: decodeURIComponent(target.password) }, encoding: 'utf8', maxBuffer: 16777216 });
  if (result.status !== 0 || result.error || result.signal) throw Error('ISOLATED_DDL_FAILED');
}
async function main() {
  require('dotenv').config({ quiet: true });
  const source = new URL(process.env.DATABASE_URL);
  if (process.env.NODE_ENV === 'production' || source.protocol !== 'mysql:' || source.hostname !== '127.0.0.1'
    || source.pathname !== '/fantasy_point_do_jogador') throw Error('LOCAL_SOURCE_REQUIRED');
  const evidence = fs.readFileSync(path.join(os.tmpdir(), 'point-fantasy-3b33b4-location.txt'), 'utf8');
  const previous = fs.readFileSync(path.join(os.tmpdir(), 'point-fantasy-3b33a2-location.txt'), 'utf8');
  for (const directory of [evidence, previous]) if (!path.resolve(directory).startsWith(path.resolve(os.tmpdir()) + path.sep)) throw Error('TEMP_REQUIRED');
  const prior = JSON.parse(fs.readFileSync(path.join(previous, 'rehearsal.json'), 'utf8'));
  const backup = fs.readFileSync(prior.backup.file, 'utf8');
  const sql = fs.readFileSync(sqlPath, 'utf8');
  if (!prior.success || hash(backup) !== prior.backup.hash || hash(sql) !== prior.migrationHash
    || /^\s*(USE|CREATE DATABASE|DROP DATABASE)\b/im.test(backup)) throw Error('VERIFIABLE_BASE_REQUIRED');
  const manifest = Object.fromEntries(fs.readdirSync(path.resolve(__dirname, '../prisma/migrations'), { withFileTypes: true })
    .filter(e => e.isDirectory()).map(e => [e.name, hash(fs.readFileSync(path.resolve(__dirname, '../prisma/migrations', e.name, 'migration.sql')))]));
  const result = { backupHash: prior.backup.hash, migrations: manifest, unresolvedProvenance: prior.unresolvedProvenance, scenarios: {} };
  const save = () => fs.writeFileSync(path.join(evidence, 'transition.json'), JSON.stringify(result, null, 2));
  const db = new PrismaClient({ datasources: { db: { url: source.toString() } }, log: [] });
  const clients = [];
  try {
    if (JSON.stringify(await fingerprint(db)) !== JSON.stringify(prior.sourceBefore)) throw Error('SOURCE_CHANGED');
    const originalLegacy = await db.$queryRawUnsafe('SELECT * FROM FANTASY_PONTUACAO_COLETA WHERE ID IN (1,2,3) ORDER BY ID');
    const stamp = Date.now();
    for (const [index, label] of ['TRANSITION', 'DDL_RECOVERY'].entries()) {
      const target = new URL(source); target.pathname = '/point_fantasy_observation_3b2_test_' + (stamp + index);
      isolatedUrl(target.toString());
      await db.$executeRawUnsafe('CREATE DATABASE `' + target.pathname.slice(1) + '` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci');
      const test = new PrismaClient({ datasources: { db: { url: target.toString() } }, log: [] }); clients.push(test);
      result.scenarios[label] = { schema: target.pathname.slice(1) }; save();
      isolatedSql(target.toString(), backup);
      if (JSON.stringify(await fingerprint(test)) !== JSON.stringify(prior.sourceBefore)) throw Error('RESTORE_MISMATCH');
      result.scenarios[label].restoreVerified = true;
      if (label === 'TRANSITION') {
        const run = spawnSync(process.execPath, [require.resolve('jest/bin/jest'), '--runInBand', '--no-cache',
          '--testPathPattern=point-fantasy-activation', '--json', '--outputFile=' + path.join(evidence, 'transition-tests.json')], {
          env: { ...process.env, DATABASE_URL: target.toString(), POINT_FANTASY_ACTIVATION_TEST_URL: target.toString() },
          encoding: 'utf8', maxBuffer: 16777216,
        });
        fs.writeFileSync(path.join(evidence, 'transition-tests.log'), (run.stdout || '') + (run.stderr || ''));
        process.stdout.write((run.stdout || '') + (run.stderr || ''));
        if (run.status !== 0 || run.error || run.signal) throw Error('TRANSITION_TESTS_FAILED');
        result.scenarios[label].testsPassed = true;
      } else {
        const boundary = sql.indexOf('-- AlterTable', sql.indexOf('-- AlterTable') + 1);
        if (boundary < 1) throw Error('DDL_BOUNDARY_REQUIRED');
        isolatedSql(target.toString(), sql.slice(0, boundary));
        const columns = await test.$queryRawUnsafe("SELECT COLUMN_NAME FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='FANTASY_APURACAO_RODADA' AND COLUMN_NAME='REVISAO_ATUAL'");
        const tables = await test.$queryRawUnsafe("SELECT TABLE_NAME FROM information_schema.TABLES WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='FANTASY_PONTUACAO_ATLETA'");
        if (columns.length !== 1 || tables.length !== 0) throw Error('DDL_INTERRUPTION_NOT_OBSERVED');
        result.scenarios[label].partialDdlObserved = true;
        // Exact known completed statement boundary; never retry the entire non-idempotent SQL.
        isolatedSql(target.toString(), sql.slice(boundary));
        result.scenarios[label].resumedAtVerifiedBoundary = true;
      }
      const after = await fingerprint(test);
      for (const [table, key] of [['fantasy_pontuacao_snapshot','ID'], ['fantasy_pontuacao_atleta_snapshot','SNAPSHOT_ID']]) {
        const rows = await test.$queryRawUnsafe('SELECT * FROM ' + table + ' WHERE ' + key + '=1');
        if (hash(JSON.stringify(rows.map(row => stable(row)).sort())) !== prior.sourceBefore[table].data) throw Error('ORIGINAL_SNAPSHOT_CHANGED');
      }
      const columns = Object.keys(originalLegacy[0]);
      if (columns.some(key => !/^\w+$/.test(key))) throw Error('INVALID_COLUMN');
      const legacy = await test.$queryRawUnsafe('SELECT ' + columns.map(key => '`' + key + '`').join(',') + ' FROM FANTASY_PONTUACAO_COLETA WHERE ID IN (1,2,3) ORDER BY ID');
      if (stable(legacy) !== stable(originalLegacy)) throw Error('ORIGINAL_COLLECTION_CHANGED');
      result.scenarios[label].originalSnapshotAndCollectionsPreserved = true;
      for (const [name, expected] of Object.entries(prior.sourceBefore)) {
        if (['fantasy_apuracao_rodada','fantasy_pontuacao_coleta','fantasy_pontuacao_snapshot','fantasy_pontuacao_atleta_snapshot'].includes(name)) continue;
        if (after[name].data !== expected.data || after[name].ddl !== expected.ddl) throw Error('PRESERVED_TABLE_CHANGED');
      }
      if (JSON.stringify(await structure(test)) !== JSON.stringify(prior.scenarios.A.structure)) throw Error('FINAL_STRUCTURE_MISMATCH');
      result.scenarios[label].structureVerified = true;
      result.scenarios[label].historyAndTraditionalPreserved = true;
      save();
    }
    result.success = true;
  } finally {
    result.sourceUnchanged = JSON.stringify(await fingerprint(db)) === JSON.stringify(prior.sourceBefore);
    save(); await Promise.all(clients.map(client => client.$disconnect())); await db.$disconnect();
  }
  if (!result.success || !result.sourceUnchanged) throw Error('INCOMPLETE_REHEARSAL');
  console.log(JSON.stringify(result, null, 2));
}
if (require.main === module) main().catch(error => { console.error(/^[A-Z_]+$/.test(error.message) ? error.message : 'ACTIVATION_REHEARSAL_FAILED'); process.exitCode = 1; });
module.exports = { isolatedSql };
