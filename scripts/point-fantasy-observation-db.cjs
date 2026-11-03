// Explicit operations only. Importing this file never runs a migration or collection.
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const os = require('os');
const { randomUUID } = require('crypto');
const { spawnSync } = require('child_process');
const { PrismaClient } = require('@prisma/client');
const safety = require('./point-fantasy-observation-safety.cjs');
const root = path.resolve(__dirname, '..');
const statePath = path.join(os.tmpdir(), 'point-fantasy-observation-3b2-state.json');
const migrationName = '0028_point_fantasy_scoring_observation';
function runPrisma(args, url) {
  const r = spawnSync(process.execPath, [require.resolve('prisma/build/index.js'), ...args], {
    cwd: root, env: { ...process.env, DATABASE_URL: url, CHECKPOINT_DISABLE: '1' }, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024,
  });
  if (r.status !== 0 || r.error || r.signal) throw new Error('PRISMA_COMMAND_FAILED');
  return r.stdout;
}
const metadata = db => db.$queryRawUnsafe('SELECT id,migration_name,checksum,finished_at,rolled_back_at FROM _prisma_migrations ORDER BY migration_name,id');
function save(state) {
  const temporary = statePath + '.' + randomUUID();
  fs.writeFileSync(temporary, JSON.stringify(state)); fs.renameSync(temporary, statePath);
}
async function main(action = process.argv[2]) {
  const target = new URL(process.env.DATABASE_URL); safety.destination(target.toString());
  const db = new PrismaClient({ datasources: { db: { url: target.toString() } }, log: [] });
  const current = async () => safety.capture(root, target.toString(), await metadata(db));
  try {
    if (action === 'prepare') {
      // Rehearse existing files. Never generate or rewrite migrations.
      const context = await current();
      if (context.manifest.pending.length !== 1 || context.manifest.pending[0].name !== migrationName) throw new Error('EXACT_0028_PENDING_REQUIRED');
      const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'point-fantasy-observation-'));
      const baseline = spawnSync('git', ['show', 'main:prisma/schema.prisma'], { cwd: root, encoding: 'utf8' });
      if (baseline.status !== 0) throw new Error('BASE_SCHEMA_UNAVAILABLE');
      const basePath = path.join(tmp, 'baseline.prisma'); fs.writeFileSync(basePath, baseline.stdout);
      runPrisma(['migrate', 'diff', '--from-url', target.toString(), '--to-schema-datamodel', basePath, '--exit-code'], target.toString());
      const sql = fs.readFileSync(path.join(root, 'prisma/migrations', migrationName, 'migration.sql'), 'utf8');
      if (/^\s*(DROP|TRUNCATE|DELETE|UPDATE|INSERT)\b/im.test(sql)) throw new Error('NON_ADDITIVE_SQL');
      const backup = path.join(tmp, 'before-observation.sql'); const fd = fs.openSync(backup, 'wx'); let dump;
      try { dump = spawnSync('C:\\Program Files\\MySQL\\MySQL Server 8.0\\bin\\mysqldump.exe', ['--single-transaction', '--skip-lock-tables', '--hex-blob',
        '--host=' + target.hostname, '--port=' + (target.port || '3306'), '--user=' + decodeURIComponent(target.username), decodeURIComponent(target.pathname.slice(1))],
        { env: { ...process.env, MYSQL_PWD: decodeURIComponent(target.password) }, stdio: ['ignore', fd, 'pipe'] }); }
      finally { fs.closeSync(fd); }
      if (dump.status !== 0 || dump.error || fs.statSync(backup).size < 100) throw new Error('BACKUP_FAILED');
      const testSchema = 'point_fantasy_observation_3b2_test_' + Date.now();
      await db.$executeRawUnsafe('CREATE DATABASE `' + testSchema + '` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci');
      const testTarget = new URL(target); testTarget.pathname = '/' + testSchema;
      runPrisma(['migrate', 'deploy'], testTarget.toString());
      runPrisma(['migrate', 'diff', '--from-url', testTarget.toString(), '--to-schema-datamodel', 'prisma/schema.prisma', '--exit-code'], testTarget.toString());
      const testDb = new PrismaClient({ datasources: { db: { url: testTarget.toString() } }, log: [] });
      let testHistoryHash;
      try { testHistoryHash = safety.hash(JSON.stringify(await metadata(testDb))); }
      finally { await testDb.$disconnect(); }
      const after = await current();
      if (JSON.stringify(context) !== JSON.stringify(after)) throw new Error('REHEARSAL_INPUT_CHANGED');
      save({ formatVersion: 2, context, tmp, backup, testSchema, rehearsalId: randomUUID(),
        migration0028Hash: safety.hash(sql), rehearsal: { success: true, testSchema, testHistoryHash, finishedAt: new Date().toISOString() }, testsPassed: false, approval: null });
      console.log(JSON.stringify({ rehearsed: true, testSchema, backup }));
    } else if (action === 'test') {
      const state = JSON.parse(fs.readFileSync(statePath, 'utf8'));
      await safety.runApprovedTests({ state, save, current, run: async () => {
        const testTarget = new URL(target); testTarget.pathname = '/' + state.testSchema;
        const testDb = new PrismaClient({ datasources: { db: { url: testTarget.toString() } }, log: [] });
        try {
          if (safety.hash(JSON.stringify(await metadata(testDb))) !== state.rehearsal.testHistoryHash) throw new Error('TEST_HISTORY_CHANGED');
        } finally { await testDb.$disconnect(); }
        return spawnSync(process.execPath, [require.resolve('jest/bin/jest'), '--runInBand', '--testPathPattern=point-fantasy-observation'], {
          cwd: root, env: { ...process.env, POINT_FANTASY_OBSERVATION_TEST_DATABASE_URL: testTarget.toString() }, stdio: 'inherit',
        });
      } });
    } else if (action === 'apply') {
      const state = JSON.parse(fs.readFileSync(statePath, 'utf8')); safety.assertApply(state, await current());
      if (!fs.existsSync(state.backup) || fs.statSync(state.backup).size < 100) throw new Error('BACKUP_REQUIRED');
      runPrisma(['migrate', 'diff', '--from-url', target.toString(), '--to-schema-datamodel', path.join(state.tmp, 'baseline.prisma'), '--exit-code'], target.toString());
      safety.assertApply(state, await current());
      runPrisma(['migrate', 'deploy'], target.toString());
      console.log(JSON.stringify({ applied: state.context.manifest.pending.map(m => m.name) }));
    } else throw new Error('Use prepare, test or apply');
  } finally { await db.$disconnect(); }
}
if (require.main === module) main().catch(error => {
  const code = /^[A-Z_0-9]+$/.test(error.message || '') ? error.message : 'LOCAL_OBSERVATION_HELPER_FAILED';
  console.error(code); process.exitCode = 1;
});
module.exports = { main };
