// Preparation only: source SELECT/dump, all DDL and tests use generated isolated schemas.
const fs = require('fs'), path = require('path'), os = require('os');
const { spawnSync } = require('child_process');
const { PrismaClient } = require('@prisma/client');
const x = require('./point-fantasy-local-migrations.cjs');
const { fingerprint } = require('./point-fantasy-scoring-rehearsal.cjs');
async function main() {
  require('dotenv').config({ quiet: true });
  const source = x.destination(process.env.DATABASE_URL);
  const evidence = fs.mkdtempSync(path.join(os.tmpdir(), 'point-ffc-local-preparation-'));
  const db = new PrismaClient({ datasources: { db: { url: source.toString() } }, log: [] });
  const plan = { version: 1, createdAt: new Date().toISOString(), evidence, files: x.sqlFiles(), boundaries: {}, exceptions: x.exceptions, homologated: false };
  const planFile = path.join(evidence, 'plan.json');
  const report = { success: false, evidence };
  const save = () => { fs.writeFileSync(planFile, x.stable(plan)); fs.writeFileSync(path.join(evidence, 'results.json'), x.stable(report)); };
  let before, reference;
  try {
    if (x.names.some((n, i) => plan.files[n] !== x.pinned[i])) throw Error('PINNED_MIGRATION_CHANGED');
    before = await fingerprint(db); plan.history = x.verifyBase(await x.history(db), plan.files);
    if ((await x.history(db)).some(r => x.names.includes(r.migration_name))) throw Error('EXACT_PENDING_0029_0030_REQUIRED');
    await x.drained(db);
    const engine = await db.$queryRawUnsafe("SELECT TABLE_NAME FROM information_schema.TABLES WHERE TABLE_SCHEMA=DATABASE() AND TABLE_TYPE='BASE TABLE' AND ENGINE<>'InnoDB'");
    if (engine.length) throw Error('TRANSACTIONAL_BACKUP_REQUIRED');
    const [identity] = await db.$queryRawUnsafe('SELECT DATABASE() AS name,@@server_uuid AS server,@@port AS port,VERSION() AS version');
    plan.identity = { ...identity, port: Number(identity.port) };
    plan.data = await x.dataManifest(db);
    const backup = path.join(evidence, 'principal-before.sql'), fd = fs.openSync(backup, 'wx'); let dump;
    try {
      dump = spawnSync('C:/Program Files/MySQL/MySQL Server 8.0/bin/mysqldump.exe', ['--host=' + source.hostname, '--port=3306', '--user=' + decodeURIComponent(source.username), '--single-transaction', '--skip-lock-tables', '--skip-add-locks', '--skip-add-drop-table', '--routines', '--events', '--hex-blob', '--no-tablespaces', '--set-gtid-purged=OFF', source.pathname.slice(1)], { env: { ...process.env, MYSQL_PWD: decodeURIComponent(source.password) }, stdio: ['ignore', fd, 'pipe'] });
    } finally { fs.closeSync(fd); }
    if (dump.status !== 0 || dump.error || dump.signal || fs.statSync(backup).size < 100) throw Error('BACKUP_FAILED');
    plan.backup = { file: backup, hash: x.hash(fs.readFileSync(backup)) };
    if (x.stable(before) !== x.stable(await fingerprint(db))) throw Error('SOURCE_CHANGED_DURING_BACKUP');
    const target = new URL(source); target.pathname = '/point_fantasy_observation_3b2_test_' + Date.now(); x.destination(target.toString(), true);
    await db.$executeRawUnsafe('CREATE DATABASE `' + target.pathname.slice(1) + '` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci');
    reference = new PrismaClient({ datasources: { db: { url: target.toString() } }, log: [] });
    x.sql(target.toString(), fs.readFileSync(backup, 'utf8'));
    if (x.stable(await fingerprint(reference)) !== x.stable(before)) throw Error('RESTORE_MISMATCH');
    report.backupRestoreVerified = true; report.referenceSchema = target.pathname.slice(1);
    // Reference every statement boundary, including triggers and routine bodies, from exact SQL.
    for (const name of x.names) {
      const boundaries = [await x.signature(reference)];
      for (const statement of x.statements(fs.readFileSync(path.resolve(__dirname, '../prisma/migrations', name, 'migration.sql'), 'utf8'))) {
        x.executeStatement(target.toString(), statement); boundaries.push(await x.signature(reference));
      }
      if (new Set(boundaries).size !== boundaries.length) throw Error('AMBIGUOUS_RECOVERY_BOUNDARY');
      plan.boundaries[name] = boundaries;
    }
    if (x.stable((await x.dataManifest(reference, plan.data.columns)).data) !== x.stable(plan.data.data)) throw Error('REFERENCE_DATA_CHANGED');
    plan.executorHash = x.hash(fs.readFileSync(path.join(__dirname, 'point-fantasy-local-migrations.cjs')));
    save();
    const run = spawnSync(process.execPath, [require.resolve('jest/bin/jest'), '--runInBand', '--no-cache', '--runTestsByPath', 'test/point-fantasy-local-migrations.integration.spec.ts', '--json', '--outputFile=' + path.join(evidence, 'executor-tests.json')], {
      cwd: path.resolve(__dirname, '..'), env: { ...process.env, DATABASE_URL: target.toString(), POINT_FANTASY_LOCAL_PLAN: planFile, POINT_FANTASY_LOCAL_TEST_URL: target.toString() }, encoding: 'utf8', maxBuffer: 16777216,
    });
    fs.writeFileSync(path.join(evidence, 'executor-tests.log'), (run.stdout || '') + (run.stderr || '')); process.stdout.write((run.stdout || '') + (run.stderr || ''));
    if (run.status !== 0 || run.error || run.signal) throw Error('EXECUTOR_TESTS_FAILED');
    report.executorTestsPassed = true;
    report.sourceUnchanged = x.stable(before) === x.stable(await fingerprint(db));
    if (!report.sourceUnchanged) throw Error('SOURCE_CHANGED');
    report.success = true; plan.homologated = true;
    plan.authorizationTemplate = { authorized: false, writersStopped: false, target: '127.0.0.1:3306/fantasy_point_do_jogador', operator: 'PREENCHER_APOS_AUTORIZACAO' };
  } finally {
    if (before) report.sourceUnchanged = x.stable(before) === x.stable(await fingerprint(db));
    report.planHash = x.hash(x.stable(plan));
    save();
    if (report.success && report.sourceUnchanged) fs.writeFileSync(path.join(evidence, 'authorization.json'), JSON.stringify({ ...plan.authorizationTemplate, planHash: report.planHash }, null, 2));
    if (reference) await reference.$disconnect(); await db.$disconnect();
    console.log(JSON.stringify({ ...report, plan: planFile, planHash: x.hash(x.stable(plan)) }, null, 2));
  }
  if (!report.success || !report.sourceUnchanged) throw Error('PREPARATION_FAILED');
}
if (require.main === module) main().catch(e => { console.error(/^[A-Z_0-9]+$/.test(e.message) ? e.message : 'PREPARATION_FAILED'); process.exitCode = 1; });
