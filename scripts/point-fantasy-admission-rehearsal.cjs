// Explicit isolated-schema rehearsal; not an activation command.
const fs = require('fs'), os = require('os'), path = require('path');
const { createHash } = require('crypto');
const { spawnSync } = require('child_process');
const { PrismaClient } = require('@prisma/client');
const { isolatedUrl } = require('./point-fantasy-scoring-backfill.cjs');
const { isolatedSql } = require('./point-fantasy-activation-rehearsal.cjs');
const { fingerprint } = require('./point-fantasy-scoring-rehearsal.cjs');
const hash = content => createHash('sha256').update(content).digest('hex');
const stable = value => JSON.stringify(value,(_,v)=>typeof v==='bigint'?v.toString():v&&typeof v==='object'&&!Array.isArray(v)?Object.fromEntries(Object.keys(v).sort().map(key=>[key,v[key]])):v);
async function main() {
  require('dotenv').config({ quiet: true });
  const source = new URL(process.env.DATABASE_URL);
  if (source.protocol !== 'mysql:' || source.hostname !== '127.0.0.1' || source.pathname !== '/fantasy_point_do_jogador' || process.env.NODE_ENV === 'production') throw Error('LOCAL_SOURCE_REQUIRED');
  const e = fs.readFileSync(path.join(os.tmpdir(),'point-fantasy-3b33b5-location.txt'),'utf8');
  const old = fs.readFileSync(path.join(os.tmpdir(),'point-fantasy-3b33a2-location.txt'),'utf8');
  for (const dir of [e,old]) if (!path.resolve(dir).startsWith(path.resolve(os.tmpdir())+path.sep)) throw Error('TEMP_REQUIRED');
  const previous = JSON.parse(fs.readFileSync(path.join(old,'rehearsal.json'),'utf8'));
  const backup = fs.readFileSync(previous.backup.file,'utf8');
  if (hash(backup) !== previous.backup.hash) throw Error('BACKUP_HASH_MISMATCH');
  const db = new PrismaClient({ datasources: { db: { url: source.toString() } }, log: [] });
  let test;
  const state = { success: false, sourceUnchanged: false, migrations: {} };
  try {
    if (JSON.stringify(await fingerprint(db)) !== JSON.stringify(previous.sourceBefore)) throw Error('SOURCE_CHANGED');
    const target = new URL(source); target.pathname = '/point_fantasy_observation_3b2_test_' + Date.now();
    isolatedUrl(target.toString()); state.schema = target.pathname.slice(1);
    await db.$executeRawUnsafe('CREATE DATABASE `' + state.schema + '` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci');
    test = new PrismaClient({ datasources: { db: { url: target.toString() } }, log: [] });
    isolatedSql(target.toString(), backup);
    if (JSON.stringify(await fingerprint(test)) !== JSON.stringify(previous.sourceBefore)) throw Error('RESTORE_MISMATCH');
    state.restoreVerified = true;
    for (const name of ['0029_point_fantasy_current_scoring','0030_point_fantasy_writer_admission']) {
      const sql = fs.readFileSync(path.resolve(__dirname,'../prisma/migrations',name,'migration.sql'),'utf8');
      if (name.startsWith('0029') && hash(sql) !== previous.migrationHash) throw Error('0029_CHANGED');
      state.migrations[name] = hash(sql); isolatedSql(target.toString(),sql);
    }
    const triggers = await test.$queryRawUnsafe('SELECT TRIGGER_NAME,ACTION_STATEMENT FROM information_schema.TRIGGERS WHERE TRIGGER_SCHEMA=DATABASE() ORDER BY TRIGGER_NAME');
    const routines = await test.$queryRawUnsafe('SELECT ROUTINE_NAME,ROUTINE_DEFINITION FROM information_schema.ROUTINES WHERE ROUTINE_SCHEMA=DATABASE() ORDER BY ROUTINE_NAME');
    if (triggers.length !== 18 || routines.length !== 3) throw Error('DATABASE_GUARDS_MISSING');
    fs.writeFileSync(path.join(e,'database-guards.json'),JSON.stringify({triggers,routines},null,2));
    const legacyBefore = await test.$queryRawUnsafe('SELECT * FROM FANTASY_PONTUACAO_COLETA WHERE ID IN (1,2,3) ORDER BY ID');
    const run = spawnSync(process.execPath,[require.resolve('jest/bin/jest'),'--runInBand','--no-cache','--testPathPattern=point-fantasy-admission','--json','--outputFile='+path.join(e,'admission-tests.json')],{
      env:{...process.env,DATABASE_URL:target.toString(),POINT_FANTASY_ADMISSION_TEST_URL:target.toString(),POINT_FANTASY_PRE_ADMISSION_SOURCE:path.join(e,'pre-admission-observation.service.ts')}, encoding:'utf8', maxBuffer:16777216,
    });
    fs.writeFileSync(path.join(e,'admission-tests.log'),(run.stdout||'')+(run.stderr||''));process.stdout.write((run.stdout||'')+(run.stderr||''));
    const after = await fingerprint(test);
    const legacyAfter = await test.$queryRawUnsafe('SELECT * FROM FANTASY_PONTUACAO_COLETA WHERE ID IN (1,2,3) ORDER BY ID');
    if (stable(legacyBefore)!==stable(legacyAfter)) throw Error('ORIGINAL_COLLECTION_CHANGED');
    for (const [table,key] of [['fantasy_pontuacao_snapshot','ID'],['fantasy_pontuacao_atleta_snapshot','SNAPSHOT_ID']]) {
      const original = await test.$queryRawUnsafe('SELECT * FROM '+table+' WHERE '+key+'=1');
      if (hash(JSON.stringify(original.map(row=>stable(row)).sort()))!==previous.sourceBefore[table].data) throw Error('ORIGINAL_SNAPSHOT_CHANGED');
    }
    const finalTriggers = await test.$queryRawUnsafe('SELECT TRIGGER_NAME,ACTION_STATEMENT FROM information_schema.TRIGGERS WHERE TRIGGER_SCHEMA=DATABASE() ORDER BY TRIGGER_NAME');
    const finalRoutines = await test.$queryRawUnsafe('SELECT ROUTINE_NAME,ROUTINE_DEFINITION FROM information_schema.ROUTINES WHERE ROUTINE_SCHEMA=DATABASE() ORDER BY ROUTINE_NAME');
    if (stable(finalTriggers)!==stable(triggers)||stable(finalRoutines)!==stable(routines)) throw Error('DATABASE_GUARDS_CHANGED');
    state.originalSnapshotAndCollectionsPreserved = true; state.databaseGuardsVerified = true;
    for (const [name,value] of Object.entries(previous.sourceBefore)) if (!name.startsWith('fantasy_pontuacao_') && name!=='fantasy_apuracao_rodada') {
      if (JSON.stringify(after[name])!==JSON.stringify(value)) throw Error('TRADITIONAL_OR_HISTORY_CHANGED');
    }
    state.historyAndTraditionalPreserved = true;
    state.success = run.status === 0 && !run.error && !run.signal;
  } finally {
    state.sourceUnchanged = JSON.stringify(await fingerprint(db)) === JSON.stringify(previous.sourceBefore);
    fs.writeFileSync(path.join(e,'admission-rehearsal.json'),JSON.stringify(state,null,2));
    if (test) await test.$disconnect(); await db.$disconnect();
  }
  console.log(JSON.stringify(state,null,2));
  if (!state.success || !state.sourceUnchanged) throw Error('ADMISSION_REHEARSAL_FAILED');
}
if (require.main === module) main().catch(error=>{console.error(/^[A-Z_0-9]+$/.test(error.message)?error.message:'ADMISSION_REHEARSAL_FAILED');process.exitCode=1;});
