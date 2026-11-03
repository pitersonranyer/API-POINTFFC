// Explicit local rehearsal only. Principal is SELECT/mysqldump-only; all SQL writes target fresh isolated schemas.
const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawnSync, execFileSync } = require('child_process');
const { createHash } = require('crypto');
const { PrismaClient } = require('@prisma/client');
const { isolatedUrl, backfill } = require('./point-fantasy-scoring-backfill.cjs');
const root = path.resolve(__dirname, '..');
const migration = '0029_point_fantasy_current_scoring';
const mysqlBin = 'C:/Program Files/MySQL/MySQL Server 8.0/bin';
const hash = value => createHash('sha256').update(value).digest('hex');
const stringify = value => JSON.stringify(value, (_, v) => typeof v === 'bigint' ? v.toString() : v);
const stable = value => JSON.stringify(value, (_, v) => typeof v === 'bigint' ? v.toString()
  : v && typeof v === 'object' && !Array.isArray(v) ? Object.fromEntries(Object.keys(v).sort().map(k => [k, v[k]])) : v);
const observationTables = ['fantasy_apuracao_rodada', 'fantasy_pontuacao_snapshot', 'fantasy_pontuacao_atleta_snapshot', 'fantasy_pontuacao_coleta'];
function normalizeDdl(ddl) {
  const charset = /DEFAULT CHARSET=(\w+)/.exec(ddl)?.[1];
  // MySQL SHOW CREATE can print an explicit, redundant column charset after a dump restore.
  return charset ? ddl.replaceAll(' CHARACTER SET ' + charset + ' COLLATE ', ' COLLATE ') : ddl;
}
const exceptions = {
  '0024_point_fantasy_foundation': ['01a5023fd78293a0a02cb38943e1066545c56031d9ec8650ca27174d69d349f4', '3ad34fcd32e9f0c8de1b992d1dc4cf0842156bdb5ca1bdd31bb77e94c9411eb0'],
  '0025_point_fantasy_lineups': ['d6514954e86ce2b5d2c8a3aa69225a72c3804fe9ca5271ef802c7c6195a65b1b', '7fa6c71056791a429ecc57c9a33e4ff0cc84338f1f705a7f33266c294b1376e2'],
};
const sqlFiles = () => fs.readdirSync(path.join(root, 'prisma/migrations'), { withFileTypes: true })
  .filter(e => e.isDirectory()).map(e => e.name).sort();
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
function mysql(url, sql) {
  const checked = new URL(isolatedUrl(url));
  const result = spawnSync(path.join(mysqlBin, 'mysql.exe'), ['--host=' + checked.hostname,
    '--port=' + (checked.port || '3306'), '--user=' + decodeURIComponent(checked.username),
    '--default-character-set=utf8mb4', decodeURIComponent(checked.pathname.slice(1))], {
    input: sql, env: { ...process.env, MYSQL_PWD: decodeURIComponent(checked.password) },
    encoding: 'utf8', maxBuffer: 16 * 1024 * 1024,
  });
  if (result.status !== 0 || result.error || result.signal) {
    // SQL diagnostics contain no connection URL; retain locally for review, never raw credentials.
    throw new Error('ISOLATED_SQL_FAILED_' + (result.stderr.match(/ERROR \d+/)?.[0].replace(' ', '_') || 'PROCESS'));
  }
}
function dump(url, file, dataOnly = false) {
  const target = new URL(url);
  const fd = fs.openSync(file, 'wx');
  try {
    const args = ['--host=' + target.hostname, '--port=' + (target.port || '3306'),
      '--user=' + decodeURIComponent(target.username), '--single-transaction', '--skip-lock-tables',
      '--skip-add-locks', '--skip-add-drop-table', '--no-tablespaces', '--hex-blob', '--set-gtid-purged=OFF'];
    if (dataOnly) args.push('--no-create-info', '--skip-triggers', '--complete-insert');
    args.push(decodeURIComponent(target.pathname.slice(1)));
    if (dataOnly) args.push(...observationTables);
    const r = spawnSync(path.join(mysqlBin, 'mysqldump.exe'), args, {
      env: { ...process.env, MYSQL_PWD: decodeURIComponent(target.password) }, stdio: ['ignore', fd, 'pipe'],
    });
    if (r.status !== 0 || r.error || r.signal) throw new Error('BACKUP_FAILED');
  } finally { fs.closeSync(fd); }
  const content = fs.readFileSync(file, 'utf8');
  if (content.length < 100 || /^\s*(USE|CREATE DATABASE)\b/im.test(content)) throw new Error('UNSAFE_BACKUP');
  return content;
}
async function main() {
  require('dotenv').config({ quiet: true });
  const source = new URL(process.env.DATABASE_URL);
  if (process.env.NODE_ENV === 'production' || source.protocol !== 'mysql:' || source.hostname !== '127.0.0.1'
    || source.pathname !== '/fantasy_point_do_jogador') throw new Error('EXPECTED_LOCAL_SOURCE_REQUIRED');
  const pointer = path.join(os.tmpdir(), 'point-fantasy-3b33a2-location.txt');
  let evidence = fs.existsSync(pointer) ? fs.readFileSync(pointer, 'utf8') : null;
  if (evidence && !path.resolve(evidence).startsWith(path.resolve(os.tmpdir()) + path.sep)) throw new Error('TEMP_EVIDENCE_REQUIRED');
  if (!evidence || fs.existsSync(path.join(evidence, 'rehearsal.json'))) {
    evidence = fs.mkdtempSync(path.join(os.tmpdir(), 'point-fantasy-3b33a2-'));
    fs.writeFileSync(pointer, evidence);
  }
  if (!fs.existsSync(path.join(evidence, 'initial-files.json'))) {
    const initialFiles = execFileSync('git', ['ls-files','--cached','--others','--exclude-standard'], { cwd: root, encoding: 'utf8' })
      .trim().split(/\r?\n/).filter(f => fs.existsSync(path.join(root, f)) && fs.statSync(path.join(root, f)).isFile());
    fs.writeFileSync(path.join(evidence, 'initial-files.json'), stringify({
      status: execFileSync('git', ['status','--short'], { cwd: root, encoding: 'utf8' }),
      files: Object.fromEntries(initialFiles.map(f => [f, hash(fs.readFileSync(path.join(root, f)))])),
    }));
  }
  const branch = execFileSync('git', ['branch', '--show-current'], { cwd: root, encoding: 'utf8' }).trim();
  if (branch !== 'feat/point-fantasy-scoring-observation-3b2') throw new Error('EXPECTED_BRANCH_REQUIRED');
  const files = sqlFiles();
  if (files.length !== 29 || files.at(-1) !== migration) throw new Error('EXACT_MIGRATION_SET_REQUIRED');
  const db = new PrismaClient({ datasources: { db: { url: source.toString() } }, log: [] });
  const clients = [];
  const state = { evidence, migration, unresolvedProvenance: exceptions, scenarios: {} };
  const save = () => fs.writeFileSync(path.join(evidence, 'rehearsal.json'), stringify(state));
  let before;
  try {
    before = await fingerprint(db);
    const history = await db.$queryRawUnsafe('SELECT * FROM _prisma_migrations ORDER BY migration_name,id');
    if (history.some(r => !r.finished_at && !r.rolled_back_at)) throw new Error('UNRESOLVED_MIGRATION');
    const applied = history.filter(r => r.finished_at && !r.rolled_back_at);
    if (applied.length !== 28) throw new Error('EXACT_SOURCE_HISTORY_REQUIRED');
    for (const row of applied) {
      if (!files.includes(row.migration_name)) throw new Error('UNKNOWN_HISTORY');
      const actual = hash(fs.readFileSync(path.join(root, 'prisma/migrations', row.migration_name, 'migration.sql')));
      const known = exceptions[row.migration_name];
      if (known ? row.checksum !== known[0] || actual !== known[1] : actual !== row.checksum) throw new Error('UNEXPECTED_CHECKSUM');
    }
    const backup = path.join(evidence, 'principal-before.sql');
    const fullSql = dump(source.toString(), backup);
    const fixtureSql = dump(source.toString(), path.join(evidence, 'observation-fixture.sql'), true);
    if (stringify(before) !== stringify(await fingerprint(db))) throw new Error('SOURCE_CHANGED_DURING_BACKUP');
    state.backup = { file: backup, hash: hash(fullSql) };
    state.sourceBefore = before;
    const stamp = Date.now();
    for (const [index, label] of ['A', 'B'].entries()) {
      const name = 'point_fantasy_observation_3b2_test_' + (stamp + index);
      const target = new URL(source); target.pathname = '/' + name;
      isolatedUrl(target.toString());
      // Name is validated and generated, never taken from an arbitrary path or source schema.
      await db.$executeRawUnsafe('CREATE DATABASE `' + name + '` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci');
      const test = new PrismaClient({ datasources: { db: { url: target.toString() } }, log: [] });
      clients.push(test);
      state.scenarios[label] = { schema: name }; save();
      if (label === 'A') {
        mysql(target.toString(), fullSql);
        if (stringify(before) !== stringify(await fingerprint(test))) throw new Error('RESTORE_MISMATCH');
        state.scenarios.A.restoreVerified = true;
      } else {
        // Curated 0001..0028 only. 0001..0027 match Git HEAD; 0028 is preserved uncommitted phase 3B.2.
        const staged = path.join(evidence, 'reconstructed'); fs.mkdirSync(path.join(staged, 'migrations'), { recursive: true });
        // migrate deploy reads connection/config here; only the staged migration folders are executed.
        fs.copyFileSync(path.join(root, 'prisma/schema.prisma'), path.join(staged, 'schema.prisma'));
        fs.copyFileSync(path.join(root, 'prisma/migrations/migration_lock.toml'), path.join(staged, 'migrations/migration_lock.toml'));
        for (const name of files.filter(n => n !== migration)) {
          const rel = 'prisma/migrations/' + name + '/migration.sql'; const content = fs.readFileSync(path.join(root, rel));
          if (!name.startsWith('0028_') && !content.equals(execFileSync('git', ['show', 'HEAD:' + rel], { cwd: root }))) throw new Error('GIT_MIGRATION_CHANGED');
          fs.mkdirSync(path.join(staged, 'migrations', name)); fs.writeFileSync(path.join(staged, 'migrations', name, 'migration.sql'), content);
        }
        const r = spawnSync(process.execPath, [require.resolve('prisma/build/index.js'), 'migrate', 'deploy', '--schema', path.join(staged, 'schema.prisma')], {
          cwd: root, env: { ...process.env, DATABASE_URL: isolatedUrl(target.toString()), CHECKPOINT_DISABLE: '1' }, encoding: 'utf8',
        });
        fs.writeFileSync(path.join(evidence, 'reconstruction.log'), (r.stdout || '') + (r.stderr || ''));
        if (r.status !== 0 || r.error || r.signal) throw new Error('RECONSTRUCTION_FAILED');
        mysql(target.toString(), fixtureSql);
        state.scenarios.B.reconstructed = true;
      }
      const beforeNew = await fingerprint(test);
      const oldHistoryHash = beforeNew._prisma_migrations.data;
      const newSql = fs.readFileSync(path.join(root, 'prisma/migrations', migration, 'migration.sql'), 'utf8');
      state.migrationHash = hash(newSql);
      // Execute exactly 0029; deliberately no resolve, metadata rewriting or deploy on restored history.
      mysql(target.toString(), newSql);
      if ((await fingerprint(test))._prisma_migrations.data !== oldHistoryHash) throw new Error('HISTORY_CHANGED');
      state.scenarios[label].migrationApplied = true;
      state.scenarios[label].backfill = await backfill(target.toString(), 2026, 31);
      const first = await fingerprint(test);
      state.scenarios[label].secondBackfill = await backfill(target.toString(), 2026, 31);
      if (stringify(first) !== stringify(await fingerprint(test))) throw new Error('BACKFILL_NOT_IDEMPOTENT');
      const after = await fingerprint(test);
      for (const [name, fingerprintBefore] of Object.entries(beforeNew)) {
        if (['fantasy_apuracao_rodada', 'fantasy_pontuacao_coleta'].includes(name)) continue;
        if (stringify(fingerprintBefore) !== stringify(after[name])) throw new Error('PRESERVED_TABLE_CHANGED');
      }
      const columns = await test.$queryRawUnsafe("SELECT COLUMN_NAME FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='fantasy_pontuacao_coleta'");
      const originalColumns = columns.map(c => c.COLUMN_NAME).filter(n => !['ALTERACOES','EVIDENCIA_ENCERRAMENTO','FONTE','HASH_CONTEUDO','MODELO_PERSISTENCIA','MOTIVO','QTD_ALTERADOS','QTD_INSERIDOS','QTD_OMITIDOS','QTD_RECEBIDOS','RECEBIDA_EM','RESULTADO_APLICACAO','REVISAO_BASE','REVISAO_RESULTANTE','VERSAO_NORMALIZADOR','VERSAO_POLITICA_VALIDACAO'].includes(n));
      const legacy = await test.$queryRawUnsafe('SELECT ' + originalColumns.map(c => '`' + c + '`').join(',') + ' FROM FANTASY_PONTUACAO_COLETA WHERE ID IN (1,2,3)');
      if (hash(stringify(legacy.map(r => stable(r)).sort())) !== beforeNew.fantasy_pontuacao_coleta.data) throw new Error('LEGACY_COLLECTION_CHANGED');
      state.scenarios[label].legacyPreserved = true;
      state.scenarios[label].structure = await structure(test);
      save();
    }
    const { A, B } = state.scenarios;
    state.equalStructures = stringify(A.structure) === stringify(B.structure);
    if (!state.equalStructures) throw new Error('SCENARIO_STRUCTURE_MISMATCH');
    state.success = true;
  } finally {
    if (before) {
      state.sourceUnchanged = stringify(before) === stringify(await fingerprint(db));
      if (!state.sourceUnchanged) state.success = false;
    }
    save();
    await Promise.all(clients.map(c => c.$disconnect())); await db.$disconnect();
  }
  if (!state.success || !state.sourceUnchanged) throw new Error('REHEARSAL_INCOMPLETE');
  console.log(stringify({ success: state.success, equalStructures: state.equalStructures, sourceUnchanged: state.sourceUnchanged,
    schemas: Object.fromEntries(Object.entries(state.scenarios).map(([k,v]) => [k, { schema: v.schema, backfill: v.backfill, secondBackfill: v.secondBackfill }])), evidence }));
}
if (require.main === module) main().catch(error => {
  console.error(/^[A-Z_0-9]+$/.test(error.message) ? error.message : 'REHEARSAL_FAILED'); process.exitCode = 1;
});
module.exports = { fingerprint, structure };
