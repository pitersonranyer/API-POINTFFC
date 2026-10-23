// Explicit, pinned local executor. Importing never connects or writes.
const fs = require('fs');
const path = require('path');
const os = require('os');
const { createHash, randomUUID } = require('crypto');
const { spawnSync, execFileSync } = require('child_process');
const { PrismaClient } = require('@prisma/client');
const { structure } = require('./point-fantasy-schema-read.cjs');
const root = path.resolve(__dirname, '..');
const names = ['0029_point_fantasy_current_scoring', '0030_point_fantasy_writer_admission'];
const pinned = ['df2a5744867641f015ed6e28d447d66ffd705f589ec7c6f2c270d12f913e9c48', '57b2cb49a10f6a33e6673196fed5986fee120431f3aebeb93f26b57b4d936bb8'];
const exceptions = {
  '0024_point_fantasy_foundation': ['01a5023fd78293a0a02cb38943e1066545c56031d9ec8650ca27174d69d349f4', '3ad34fcd32e9f0c8de1b992d1dc4cf0842156bdb5ca1bdd31bb77e94c9411eb0'],
  '0025_point_fantasy_lineups': ['d6514954e86ce2b5d2c8a3aa69225a72c3804fe9ca5271ef802c7c6195a65b1b', '7fa6c71056791a429ecc57c9a33e4ff0cc84338f1f705a7f33266c294b1376e2'],
};
const hash = value => createHash('sha256').update(value).digest('hex');
const stable = value => JSON.stringify(value, (_, v) => typeof v === 'bigint' ? v.toString() : v && typeof v === 'object' && !Array.isArray(v) ? Object.fromEntries(Object.keys(v).sort().map(k => [k, v[k]])) : v);
const fail = code => { throw Error(code); };
function destination(value, isolated = false) {
  const u = new URL(value);
  if (process.env.NODE_ENV === 'production' || u.protocol !== 'mysql:' || u.hostname !== '127.0.0.1' || (u.port || '3306') !== '3306'
    || !(isolated ? /^point_fantasy_observation_3b2_test_\d+$/.test(u.pathname.slice(1)) : u.pathname === '/fantasy_point_do_jogador')) fail('EXACT_LOCAL_DESTINATION_REQUIRED');
  return u;
}
function sqlFiles() {
  return Object.fromEntries(fs.readdirSync(path.join(root, 'prisma/migrations'), { withFileTypes: true }).filter(e => e.isDirectory()).map(e => [e.name, hash(fs.readFileSync(path.join(root, 'prisma/migrations', e.name, 'migration.sql')))]));
}
function statements(sql) {
  let delimiter = ';', pending = ''; const result = [];
  for (const line of sql.split(/\r?\n/)) {
    const command = /^DELIMITER (\S+)\s*$/.exec(line);
    if (command) { if (pending.trim()) fail('UNSUPPORTED_SQL_BOUNDARY'); delimiter = command[1]; continue; }
    if (!pending && (!line.trim() || /^\s*--/.test(line))) continue;
    pending += line + '\n';
    if (line.trimEnd().endsWith(delimiter)) { result.push(pending.trimEnd().slice(0, -delimiter.length).trim()); pending = ''; }
  }
  if (pending.trim()) fail('INCOMPLETE_SQL');
  return result;
}
function sql(url, content) {
  const u = new URL(url);
  if (/^\s*(USE|CREATE DATABASE|DROP DATABASE)\b/im.test(content)) fail('SCHEMA_SWITCH_FORBIDDEN');
  const r = spawnSync('C:/Program Files/MySQL/MySQL Server 8.0/bin/mysql.exe', ['--host=' + u.hostname, '--port=' + (u.port || '3306'), '--user=' + decodeURIComponent(u.username), '--default-character-set=utf8mb4', u.pathname.slice(1)],
    { input: content, env: { ...process.env, MYSQL_PWD: decodeURIComponent(u.password) }, encoding: 'utf8', maxBuffer: 16777216 });
  if (r.status !== 0 || r.error || r.signal) fail('MYSQL_EXECUTION_FAILED_' + (r.stderr?.match(/ERROR (\d+)/)?.[1] || 'PROCESS'));
}
const executeStatement = (url, statement) => sql(url, 'DELIMITER $$\n' + statement + '$$\nDELIMITER ;\n');
const history = db => db.$queryRawUnsafe('SELECT * FROM _prisma_migrations ORDER BY migration_name,id');
async function signature(db) {
  const tables = await structure(db);
  const triggers = await db.$queryRawUnsafe('SELECT TRIGGER_NAME,ACTION_TIMING,EVENT_MANIPULATION,EVENT_OBJECT_TABLE,ACTION_STATEMENT FROM information_schema.TRIGGERS WHERE TRIGGER_SCHEMA=DATABASE() ORDER BY TRIGGER_NAME');
  const routines = await db.$queryRawUnsafe('SELECT ROUTINE_NAME,ROUTINE_TYPE,ROUTINE_DEFINITION,SECURITY_TYPE,SQL_MODE FROM information_schema.ROUTINES WHERE ROUTINE_SCHEMA=DATABASE() ORDER BY ROUTINE_NAME');
  return hash(stable({ tables, triggers, routines }));
}
async function dataManifest(db, columns) {
  if (!columns) {
    columns = {};
    const rows = await db.$queryRawUnsafe('SELECT TABLE_NAME,COLUMN_NAME FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() ORDER BY TABLE_NAME,ORDINAL_POSITION');
    for (const r of rows) (columns[r.TABLE_NAME] ??= []).push(r.COLUMN_NAME);
  }
  const data = {};
  for (const [table, fields] of Object.entries(columns)) {
    if (table === '_prisma_migrations') continue;
    if (![table, ...fields].every(s => /^\w+$/.test(s))) fail('INVALID_IDENTIFIER');
    const rows = await db.$queryRawUnsafe('SELECT ' + fields.map(f => '`' + f + '`').join(',') + ' FROM `' + table + '`');
    data[table] = hash(stable(rows.map(r => stable(r)).sort()));
  }
  return { columns, data };
}
async function drained(db) {
  const [r] = await db.$queryRawUnsafe("SELECT COUNT(*) AS n FROM FANTASY_APURACAO_RODADA WHERE LOCK_TOKEN IS NOT NULL OR LOCK_ATE IS NOT NULL");
  const [c] = await db.$queryRawUnsafe("SELECT COUNT(*) AS n FROM FANTASY_PONTUACAO_COLETA WHERE ESTADO='EM_ANDAMENTO'");
  if (Number(r.n) || Number(c.n)) fail('WRITERS_NOT_DRAINED');
}
function verifyBase(rows, files) {
  const old = rows.filter(r => !names.includes(r.migration_name));
  const successful = old.filter(r => r.finished_at && !r.rolled_back_at);
  if (successful.length !== 28 || new Set(successful.map(r => r.migration_name)).size !== 28 || old.some(r => !r.finished_at && !r.rolled_back_at)) fail('EXACT_0028_BASE_REQUIRED');
  const expected = Object.keys(files).filter(n => !names.includes(n)).sort();
  if (expected.length !== 28 || expected.at(-1) !== '0028_point_fantasy_scoring_observation') fail('UNEXPECTED_MIGRATION_SET');
  for (const r of successful) {
    const x = exceptions[r.migration_name];
    if (!r.finished_at || r.rolled_back_at || !expected.includes(r.migration_name) || (x ? r.checksum !== x[0] || files[r.migration_name] !== x[1] : r.checksum !== files[r.migration_name])) fail('HISTORICAL_MIGRATION_CHANGED');
  }
  return old;
}
function resolveApplied(url, name) {
  // Only exact, byte-identical migration directories are visible to Prisma resolve.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'point-ffc-resolve-'));
  fs.mkdirSync(path.join(dir, 'migrations'));
  fs.copyFileSync(path.join(root, 'prisma/schema.prisma'), path.join(dir, 'schema.prisma'));
  fs.copyFileSync(path.join(root, 'prisma/migrations/migration_lock.toml'), path.join(dir, 'migrations/migration_lock.toml'));
  for (const n of names) { fs.mkdirSync(path.join(dir, 'migrations', n)); fs.copyFileSync(path.join(root, 'prisma/migrations', n, 'migration.sql'), path.join(dir, 'migrations', n, 'migration.sql')); }
  const r = spawnSync(process.execPath, [require.resolve('prisma/build/index.js'), 'migrate', 'resolve', '--applied', name, '--schema', path.join(dir, 'schema.prisma')], { cwd: dir, env: { ...process.env, DATABASE_URL: url, CHECKPOINT_DISABLE: '1' }, encoding: 'utf8' });
  if (r.status !== 0 || r.error || r.signal) fail('PRISMA_RESOLVE_FAILED');
}
async function apply({ url, plan, isolated = false, approval, recover = false, interruptAfter }) {
  const u = destination(url, isolated), files = sqlFiles();
  if (stable(files) !== stable(plan.files) || names.some((n, i) => files[n] !== pinned[i])) fail('PINNED_ARTIFACT_CHANGED');
  if (plan.executorHash !== hash(fs.readFileSync(__filename))) fail('EXECUTOR_CHANGED_NEW_PREPARATION_REQUIRED');
  if (execFileSync('git', ['branch', '--show-current'], { cwd: root, encoding: 'utf8' }).trim() !== 'feat/point-fantasy-scoring-observation-3b2') fail('EXPECTED_BRANCH_REQUIRED');
  if (!isolated && (plan.homologated !== true || approval?.authorized !== true || approval.writersStopped !== true || approval.planHash !== hash(stable(plan)) || approval.target !== '127.0.0.1:3306/fantasy_point_do_jogador' || !approval.operator?.trim())) fail('EXPLICIT_BOUND_APPROVAL_REQUIRED');
  if (!isolated && interruptAfter !== undefined) fail('FIXTURE_FORBIDDEN');
  if (hash(fs.readFileSync(plan.backup.file)) !== plan.backup.hash) fail('BACKUP_HASH_MISMATCH');
  const db = new PrismaClient({ datasources: { db: { url: u.toString() } }, log: [] });
  try {
    const [identity] = await db.$queryRawUnsafe('SELECT DATABASE() AS name,@@server_uuid AS server,@@port AS port');
    if (identity.name !== u.pathname.slice(1) || identity.server !== plan.identity.server || Number(identity.port) !== 3306) fail('SERVER_IDENTITY_CHANGED');
    // Connection-bound advisory lock serializes this executor across processes.
    return await db.$transaction(async lock => {
      const [acquired] = await lock.$queryRawUnsafe("SELECT GET_LOCK('point_ffc_0029_0030',0) AS ok");
      if (Number(acquired.ok) !== 1) fail('EXECUTOR_BUSY');
      try {
        const original = verifyBase(await history(db), files);
        if (stable(original) !== stable(plan.history)) fail('BASE_HISTORY_CHANGED');
        await drained(db);
        if (stable((await dataManifest(db, plan.data.columns)).data) !== stable(plan.data.data)) fail('BASE_DATA_CHANGED_NEW_PREPARATION_REQUIRED');
        for (const [i, name] of names.entries()) {
          const rows = (await history(db)).filter(r => r.migration_name === name);
          const applied = rows.filter(r => r.finished_at && !r.rolled_back_at);
          if (rows.some(r => r.checksum !== pinned[i]) || applied.length > 1) fail('MIGRATION_HISTORY_CONFLICT');
          if (applied.length) continue;
          const failed = rows.filter(r => !r.finished_at && !r.rolled_back_at);
          if (failed.length > 1 || (failed.length && !recover) || (!failed.length && rows.length)) fail('RECOVERY_REQUIRED');
          const steps = statements(fs.readFileSync(path.join(root, 'prisma/migrations', name, 'migration.sql'), 'utf8'));
          const boundary = plan.boundaries[name].indexOf(await signature(db));
          if (boundary < 0 || (!failed.length && boundary !== 0)) fail('UNKNOWN_DDL_BOUNDARY');
          const id = failed[0]?.id || randomUUID();
          if (!failed.length) await db.$executeRaw`INSERT INTO _prisma_migrations (id,checksum,migration_name,started_at,applied_steps_count,logs) VALUES (${id},${pinned[i]},${name},UTC_TIMESTAMP(3),0,'POINT_FFC: started; no completed DDL assumed')`;
          try {
            for (let n = boundary; n < steps.length; n++) {
              await drained(db); executeStatement(u.toString(), steps[n]);
              if (await signature(db) !== plan.boundaries[name][n + 1]) fail('DDL_POSTCONDITION_FAILED');
              await db.$executeRaw`UPDATE _prisma_migrations SET logs=CONCAT(COALESCE(logs,''),CHAR(10),${'POINT_FFC: completed SQL statement ' + (n + 1) + '/' + steps.length}) WHERE id=${id}`;
              if (interruptAfter === name + ':' + (n + 1)) fail('FIXTURE_DDL_INTERRUPTION');
            }
            if (await signature(db) !== plan.boundaries[name].at(-1)) fail('INCOMPLETE_MIGRATION');
            if (failed.length) resolveApplied(u.toString(), name);
            else await db.$executeRaw`UPDATE _prisma_migrations SET finished_at=UTC_TIMESTAMP(3),applied_steps_count=1,logs=NULL WHERE id=${id} AND finished_at IS NULL AND rolled_back_at IS NULL`;
          } catch (error) {
            await db.$executeRaw`UPDATE _prisma_migrations SET logs=CONCAT(COALESCE(logs,''),CHAR(10),${'POINT_FFC: ' + (error.message.match(/^[A-Z_0-9]+$/) ? error.message : 'DDL_FAILED') + '; recover only from verified schema boundary'}) WHERE id=${id} AND finished_at IS NULL AND rolled_back_at IS NULL`;
            throw error;
          }
        }
        if (await signature(db) !== plan.boundaries[names[1]].at(-1) || stable((await dataManifest(db, plan.data.columns)).data) !== stable(plan.data.data)) fail('FINAL_INTEGRITY_FAILED');
        if (stable(verifyBase(await history(db), files)) !== stable(plan.history)) fail('HISTORY_CHANGED');
        return { applied: names, recovered: recover, originalDataAndHistoryPreserved: true };
      } finally { await lock.$queryRawUnsafe("SELECT RELEASE_LOCK('point_ffc_0029_0030') AS released"); }
    }, { timeout: 900000, maxWait: 10000 });
  } finally { await db.$disconnect(); }
}
async function main() {
  require('dotenv').config({ quiet: true });
  const [action, file, approvalFile, ...extra] = process.argv.slice(2);
  if (!['apply','recover'].includes(action) || !file || !approvalFile || extra.length) fail('USE_APPLY_OR_RECOVER_PLAN_APPROVAL');
  const plan = JSON.parse(fs.readFileSync(file)), approval = JSON.parse(fs.readFileSync(approvalFile));
  console.log(JSON.stringify(await apply({ url: process.env.DATABASE_URL, plan, approval, recover: action === 'recover' })));
}
if (require.main === module) main().catch(e => { console.error(/^[A-Z_0-9]+$/.test(e.message) ? e.message : 'LOCAL_MIGRATION_EXECUTOR_FAILED'); process.exitCode = 1; });
module.exports = { apply, destination, names, pinned, exceptions, hash, stable, sqlFiles, statements, sql, executeStatement, history, signature, dataManifest, drained, verifyBase };
