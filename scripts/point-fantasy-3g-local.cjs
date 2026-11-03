// Explicit authorized local homologation. No bootstrap, HTTP, collector or scheduler.
require('dotenv').config({ quiet: true });
require('ts-node/register/transpile-only');
const fs = require('fs'), path = require('path'), assert = require('assert/strict');
const { createHash, randomUUID } = require('crypto');
const { execFileSync, spawnSync } = require('child_process');
const { PrismaClient, Prisma } = require('@prisma/client');
const { LineupScoringService } = require('../src/point-fantasy/scoring/lineup-scoring.service');
const { PointFantasyService } = require('../src/point-fantasy/point-fantasy.service');
const root = path.resolve(__dirname, '..');
const stateFile = path.join(root, 'docs/point-fantasy-3g-state.json');
const resultFile = path.join(root, 'docs/point-fantasy-3g-results.json');
const sourceHash = '125a24de4479be5b5f37013a1370e2630465f40186d89686dab708b36bbef435';
const names = ['0031_point_fantasy_lineup_results', '0032_point_fantasy_closure_audit'];
const pinned = ['2a38f6a1856c12792106be5573dd465246277bfd7e2662d36f37f12fcb9dbdd7', '6967b83c7932cf4942b320cd9aa91435df0398924ac0208b05047af2630baeeb'];
const newTables = ['FANTASY_ESCALACAO_RESULTADO', 'FANTASY_FECHAMENTO_AUDITORIA'];
const exceptions = {
  '0024_point_fantasy_foundation': ['01a5023fd78293a0a02cb38943e1066545c56031d9ec8650ca27174d69d349f4', '3ad34fcd32e9f0c8de1b992d1dc4cf0842156bdb5ca1bdd31bb77e94c9411eb0'],
  '0025_point_fantasy_lineups': ['d6514954e86ce2b5d2c8a3aa69225a72c3804fe9ca5271ef802c7c6195a65b1b', '7fa6c71056791a429ecc57c9a33e4ff0cc84338f1f705a7f33266c294b1376e2'],
};
const hash = v => createHash('sha256').update(v).digest('hex');
const stable = v => JSON.stringify(v, (_, x) => typeof x === 'bigint' ? x.toString() : x && typeof x === 'object' && !Array.isArray(x)
  ? Object.fromEntries(Object.keys(x).sort().map(k => [k,x[k]])) : x);
const save = state => fs.writeFileSync(stateFile, JSON.stringify(state, (_,v)=>typeof v==='bigint'?v.toString():v, 2) + '\n');
const history = db => db.$queryRaw`SELECT * FROM _prisma_migrations ORDER BY migration_name,id`;
function sqlFiles() {
  return Object.fromEntries(fs.readdirSync(path.join(root, 'prisma/migrations')).filter(n => /^\d/.test(n)).sort()
    .map(n => [n, hash(fs.readFileSync(path.join(root, 'prisma/migrations', n, 'migration.sql')))]));
}
function checkHistory(rows, files, expectedPending) {
  assert.ok(rows.every(r => r.finished_at || r.rolled_back_at), 'UNRESOLVED_MIGRATION');
  for (const r of rows.filter(r => r.finished_at && !r.rolled_back_at)) {
    const pair = exceptions[r.migration_name];
    assert.ok(pair ? pair[0] === r.checksum && pair[1] === files[r.migration_name] : r.checksum === files[r.migration_name], 'UNEXPECTED_MIGRATION_CHECKSUM');
  }
  const pending = Object.keys(files).filter(n => !rows.some(r => r.migration_name === n && r.finished_at && !r.rolled_back_at));
  assert.deepEqual(pending, expectedPending, 'UNEXPECTED_PENDING_MIGRATIONS');
  for (let i=0; i<names.length; i++) {
    assert.equal(files[names[i]], pinned[i], 'APPROVED_SQL_CHANGED');
    const sql = fs.readFileSync(path.join(root, 'prisma/migrations', names[i], 'migration.sql'), 'utf8');
    assert.ok(!/^\s*(DROP|DELETE|UPDATE|TRUNCATE|INSERT|CREATE DATABASE|USE)\b/im.test(sql), 'NON_ADDITIVE_SQL');
  }
}
function validatePlan(p) {
  assert.equal(p.competition.id, 1); assert.equal(p.competition.temporada, 2026); assert.equal(p.competition.rodada, 31);
  assert.equal(p.round.revisaoAtual, 2n); assert.equal(p.round.hashConteudoAtual, sourceHash);
  assert.ok(p.completeness.eligible);
  assert.deepEqual(p.results.map(r => [r.escalacaoId, r.total, r.posicao]), [[7,'85.51',1],[5,'34.41',2],[6,'30.31',3]]);
  const expected = { 5: [[494,172,2,'0'],[246,704,1,'3.2'],[147,502,1,'2.6']],
    6: [[494,172,1,'0'],[246,704,1,'3.2'],[147,502,1,'2.6']], 7: [[246,704,1,'3.2'],[656,617,1,'1.3']] };
  for (const r of p.results) {
    assert.equal(r.missing.length, 0); assert.equal(r.contributions.length, 12);
    assert.deepEqual(r.substitutions.map(s => [s.out,s.in,s.multiplier,s.contribution]), expected[r.escalacaoId]);
    assert.ok(r.substitutions.every(s => s.kind === 'COMUM'));
    assert.equal(new Set(r.substitutions.map(s => s.in)).size, r.substitutions.length);
    const sum = r.contributions.reduce((n,c) => n.plus(c.points), new (Prisma.Decimal.clone({precision:80}))(0));
    assert.ok(sum.eq(r.total));
  }
  assert.equal(p.results.find(r=>r.escalacaoId===6).contributions.find(c=>c.starter===243).points, '1');
  assert.equal(p.results.find(r=>r.escalacaoId===7).contributions.find(c=>c.starter===626).points, '5');
}
async function identity(db) {
  const [r] = await db.$queryRaw`SELECT DATABASE() AS name,@@server_uuid AS server,@@port AS port`;
  assert.equal(r.name, 'fantasy_point_do_jogador'); return { ...r, port: Number(r.port) };
}
async function protectedData(db) {
  const tables = await db.$queryRaw`SELECT TABLE_NAME AS name FROM information_schema.TABLES WHERE TABLE_SCHEMA=DATABASE() AND TABLE_TYPE='BASE TABLE' ORDER BY TABLE_NAME`;
  const digest = {};
  for (const { name } of tables) {
    assert.ok(/^\w+$/.test(name));
    const upper = name.toUpperCase();
    if (upper === '_PRISMA_MIGRATIONS' || newTables.includes(upper)) continue;
    const rows = await db.$queryRawUnsafe('SELECT * FROM `' + name + '`' + (upper === 'FANTASY_COMPETICAO' ? ' WHERE ID<>1' : ''));
    digest[upper] = { count: rows.length, sha256: hash(rows.map(stable).sort().join('\n')) };
  }
  const [competition] = await db.$queryRaw`SELECT * FROM FANTASY_COMPETICAO WHERE ID=1`;
  delete competition.FECHAMENTO_DEFINITIVO_EM; delete competition.ATUALIZADO_EM;
  return { tables: digest, competition1ProtectedFields: hash(stable(competition)) };
}
async function assertScope(db, state) {
  assert.deepEqual(await identity(db), state.identity);
  const round = await db.fantasyApuracaoRodada.findUniqueOrThrow({ where: { temporada_rodada: { temporada: 2026, rodada: 31 } } });
  assert.equal(round.revisaoAtual, 2n); assert.equal(round.hashConteudoAtual, sourceHash);
  assert.ok(!round.lockAte || round.lockAte <= new Date(), 'ACTIVE_COLLECTION_LEASE');
  const all = await db.fantasyEscalacao.findMany({ where: { competicaoId: 1, status: 'INSCRITA' }, select: { id:true,versao:true,confirmadaEm:true }, orderBy:{id:'asc'} });
  assert.deepEqual(all.map(l=>[l.id,l.versao]), [[5,3],[6,4],[7,2]]);
  assert.ok(all.every(l=>l.confirmadaEm));
  assert.equal(await db.fantasyPontuacaoAtleta.count({where:{temporada:2026,rodada:31}}),306);
}
async function assertSchema(db) {
  const columns = await db.$queryRaw`SELECT TABLE_NAME,COLUMN_NAME,COLUMN_TYPE,IS_NULLABLE FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME IN ('FANTASY_ESCALACAO_RESULTADO','FANTASY_FECHAMENTO_AUDITORIA') ORDER BY TABLE_NAME,ORDINAL_POSITION`;
  assert.equal(columns.length, 13);
  assert.ok(columns.some(c=>c.COLUMN_NAME==='TOTAL' && c.COLUMN_TYPE==='decimal(40,18)' && c.IS_NULLABLE==='YES'));
  const indexes = await db.$queryRaw`SELECT TABLE_NAME,INDEX_NAME,NON_UNIQUE,GROUP_CONCAT(COLUMN_NAME ORDER BY SEQ_IN_INDEX) AS cols FROM information_schema.STATISTICS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME IN ('FANTASY_ESCALACAO','FANTASY_ESCALACAO_RESULTADO','FANTASY_FECHAMENTO_AUDITORIA') GROUP BY TABLE_NAME,INDEX_NAME,NON_UNIQUE`;
  for (const [table,name,cols] of [['FANTASY_ESCALACAO','FE_RESULTADO_OWNER_key','ID,COMPETICAO_ID'],['FANTASY_ESCALACAO_RESULTADO','FER_OWNER_key','ESCALACAO_ID,COMPETICAO_ID'],['FANTASY_ESCALACAO_RESULTADO','PRIMARY','ESCALACAO_ID'],['FANTASY_FECHAMENTO_AUDITORIA','PRIMARY','COMPETICAO_ID']]) {
    assert.ok(indexes.some(i=>i.TABLE_NAME.toUpperCase()===table&&i.INDEX_NAME===name&&Number(i.NON_UNIQUE)===0&&i.cols===cols));
  }
  assert.ok(indexes.some(i=>i.INDEX_NAME==='FER_RANKING_idx'&&i.cols==='COMPETICAO_ID,TOTAL'));
  const keys = await db.$queryRaw`SELECT k.TABLE_NAME,k.CONSTRAINT_NAME,k.COLUMN_NAME,k.REFERENCED_TABLE_NAME,k.REFERENCED_COLUMN_NAME,r.UPDATE_RULE,r.DELETE_RULE FROM information_schema.KEY_COLUMN_USAGE k JOIN information_schema.REFERENTIAL_CONSTRAINTS r ON r.CONSTRAINT_SCHEMA=k.CONSTRAINT_SCHEMA AND r.CONSTRAINT_NAME=k.CONSTRAINT_NAME AND r.TABLE_NAME=k.TABLE_NAME WHERE k.TABLE_SCHEMA=DATABASE() AND k.TABLE_NAME IN ('FANTASY_ESCALACAO_RESULTADO','FANTASY_FECHAMENTO_AUDITORIA') ORDER BY k.CONSTRAINT_NAME,k.ORDINAL_POSITION`;
  assert.deepEqual(keys.map(k=>[k.CONSTRAINT_NAME,k.COLUMN_NAME,k.REFERENCED_TABLE_NAME.toUpperCase(),k.REFERENCED_COLUMN_NAME,k.UPDATE_RULE,k.DELETE_RULE]), [
    ['FER_COMPETICAO_fkey','COMPETICAO_ID','FANTASY_COMPETICAO','ID','RESTRICT','RESTRICT'],
    ['FER_ESCALACAO_fkey','ESCALACAO_ID','FANTASY_ESCALACAO','ID','RESTRICT','RESTRICT'],
    ['FER_ESCALACAO_fkey','COMPETICAO_ID','FANTASY_ESCALACAO','COMPETICAO_ID','RESTRICT','RESTRICT'],
    ['FFA_COMPETICAO_fkey','COMPETICAO_ID','FANTASY_COMPETICAO','ID','RESTRICT','RESTRICT'],
  ]);
  return { columns, indexes: indexes.filter(i=>newTables.includes(i.TABLE_NAME.toUpperCase())||i.INDEX_NAME==='FE_RESULTADO_OWNER_key'), keys };
}
async function main(action) {
  const u = new URL(process.env.DATABASE_URL);
  assert.equal(u.protocol,'mysql:'); assert.ok(['localhost','127.0.0.1','[::1]'].includes(u.hostname));
  assert.equal(decodeURIComponent(u.pathname.slice(1)),'fantasy_point_do_jogador'); assert.notEqual(process.env.NODE_ENV,'production');
  assert.equal(execFileSync('git',['branch','--show-current'],{cwd:root,encoding:'utf8'}).trim(),'feat/point-fantasy-scoring-observation-3b2');
  const db = new PrismaClient({datasources:{db:{url:u.toString()}},log:[]});
  let state;
  try {
    if (action === 'preflight') {
      assert.ok(!fs.existsSync(stateFile),'EXISTING_OPERATION_INSPECT_FIRST');
      const files = sqlFiles(), rows = await history(db); checkHistory(rows, files, names);
      state = { phase:'PREFLIGHT', operationId:randomUUID(), identity:await identity(db), files,
        oldHistory:Object.fromEntries(rows.map(r=>[r.id,hash(stable(r))])), sourceHash, revision:'2' };
      await assertScope(db,state);
      const plan = await new LineupScoringService(db).preview(1); validatePlan(plan);
      assert.equal(plan.competition.fechamentoDefinitivoEm,null); assert.ok(plan.competition.fimInscricao<=new Date());
      const admins = await db.usuario.findMany({where:{tipoUsuario:'PLATFORM_ADMIN',status:'ATIVO'},select:{idUsuario:true}});
      assert.equal(admins.length,1,'UNAMBIGUOUS_ACTIVE_ADMIN_REQUIRED'); state.adminId=admins[0].idUsuario;
      const existing = await db.$queryRaw`SELECT TABLE_NAME FROM information_schema.TABLES WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME IN ('FANTASY_ESCALACAO_RESULTADO','FANTASY_FECHAMENTO_AUDITORIA')`;
      assert.equal(existing.length,0);
      state.protected = await db.$transaction(tx=>protectedData(tx),{isolationLevel:'RepeatableRead',timeout:60000});
      state.preview = JSON.parse(stable(plan.results)); state.evidence=plan.completeness; state.checkedAt=new Date().toISOString(); save(state);
      console.log(JSON.stringify({preflight:'PASSED',revision:2,hash:sourceHash,eligible:[5,6,7],pending:names,protectedTables:Object.keys(state.protected.tables).length}));
    } else {
      state=JSON.parse(fs.readFileSync(stateFile,'utf8')); assert.deepEqual(sqlFiles(),state.files); await assertScope(db,state);
      const rows=await history(db);
      for(const [id,digest] of Object.entries(state.oldHistory)) assert.equal(hash(stable(rows.find(r=>r.id===id))),digest,'HISTORICAL_METADATA_CHANGED');
      assert.deepEqual(await db.$transaction(tx=>protectedData(tx),{isolationLevel:'RepeatableRead',timeout:60000}),state.protected,'PROTECTED_DATA_CHANGED');
      if(action==='migrate') {
        assert.equal(state.phase,'PREFLIGHT'); checkHistory(rows,state.files,names);
        validatePlan(await new LineupScoringService(db).preview(1));
        state.phase='MIGRATION_STARTED'; save(state);
        const result=spawnSync(process.execPath,[require.resolve('prisma/build/index.js'),'migrate','deploy','--schema','prisma/schema.prisma'],{cwd:root,encoding:'utf8',env:{...process.env,DATABASE_URL:u.toString(),CHECKPOINT_DISABLE:'1'},timeout:120000});
        let output=(result.stdout||'')+(result.stderr||'');
        for(const secret of [u.toString(),u.password,decodeURIComponent(u.password)].filter(Boolean)) output=output.split(secret).join('[REDACTED]');
        fs.writeFileSync(path.join(root,'docs/point-fantasy-3g-migrations.log'),output);
        if(result.status!==0) throw Error('MIGRATION_COMMAND_FAILED_INSPECT_STATE');
        checkHistory(await history(db),state.files,[]); state.schema=await assertSchema(db);
        assert.deepEqual(await protectedData(db),state.protected,'MIGRATION_CHANGED_EXISTING_DATA');
        state.phase='MIGRATED'; state.migratedAt=new Date().toISOString(); save(state); console.log(JSON.stringify({applied:names,schemaValidated:true,protectedDataUnchanged:true}));
      } else if(action==='confirm-migration') {
        // Artifact-only recovery after a successful Prisma command. No DDL retry.
        assert.equal(state.phase,'MIGRATION_STARTED');checkHistory(rows,state.files,[]);
        state.schema=await assertSchema(db);assert.deepEqual(await protectedData(db),state.protected);
        state.phase='MIGRATED';state.migratedAt=new Date().toISOString();
        state.reportSerializationRecovered=true;save(state);
        console.log(JSON.stringify({migrationsAlreadyApplied:names,ddlRepeated:false,schemaValidated:true,protectedDataUnchanged:true}));
      } else if(action==='persist') {
        assert.equal(state.phase,'MIGRATED'); checkHistory(rows,state.files,[]); await assertSchema(db);
        // Existing services share one outer transaction: all validations and scope
        // checks run before their writes; closure + results commit together.
        const report=await db.$transaction(async tx=>{
          await tx.$queryRaw`SELECT ID FROM FANTASY_COMPETICAO WHERE ID=1 FOR UPDATE`;
          await tx.$queryRaw`SELECT ID FROM FANTASY_APURACAO_RODADA WHERE TEMPORADA=2026 AND RODADA=31 FOR UPDATE`;
          await assertScope(tx,state);
          const scoped=new Proxy(tx,{get(target,key){return key==='$transaction'?async fn=>fn(tx):Reflect.get(target,key);}});
          const scoring=new LineupScoringService(scoped), service=new PointFantasyService(scoped,{});
          validatePlan(await scoring.preview(1));
          assert.equal(await tx.fantasyEscalacaoResultado.count(),0); assert.equal(await tx.fantasyFechamentoAuditoria.count(),0);
          const closure=await service.closeCompetition(1,state.adminId,{temporada:2026,rodada:31,revisao:'2',hashFonte:sourceHash,
            operacaoId:state.operationId,motivo:'Fase 3G: fechamento e homologacao local expressamente autorizados pelo usuario.'});
          const plan=await scoring.persist(1,{competicaoId:1,temporada:2026,rodada:31,revisao:'2'}); validatePlan(plan);
          const persisted=await tx.fantasyEscalacaoResultado.findMany({orderBy:{escalacaoId:'asc'}});
          assert.deepEqual(persisted.map(r=>r.escalacaoId),[5,6,7]);
          for(const r of persisted){assert.equal(r.competicaoId,1);assert.equal(r.temporada,2026);assert.equal(r.rodada,31);assert.equal(r.revisao,2n);assert.equal(r.hashFonte,sourceHash);
            const expected=plan.results.find(p=>p.escalacaoId===r.escalacaoId);assert.ok(r.total.eq(expected.total));assert.deepEqual(r.auditoria,JSON.parse(JSON.stringify(expected)));}
          assert.deepEqual(await protectedData(tx),state.protected,'UNAUTHORIZED_DATA_CHANGE');
          return {closure,persisted,evidence:plan.completeness};
        },{isolationLevel:'Serializable',timeout:60000});
        state.phase='PERSISTED'; state.persistedAt=new Date().toISOString(); save(state);
        fs.writeFileSync(resultFile,JSON.stringify(report,(_,v)=>typeof v==='bigint'?v.toString():v,2)+'\n');
        console.log(JSON.stringify({closedAt:report.closure.fechamentoDefinitivoEm,persisted:report.persisted.length,protectedDataUnchanged:true}));
      } else if(action==='verify') {
        assert.equal(state.phase,'PERSISTED'); checkHistory(rows,state.files,[]); await assertSchema(db);
        const service=new PointFantasyService(db,{}), first=await service.ranking(1,{page:1,limit:50}), second=await service.ranking(1,{page:1,limit:50});
        assert.deepEqual(first,second,'RANKING_NOT_STABLE');assert.equal(first.total,3);assert.equal(first.estadoPontuacao,'PARCIAL');
        assert.deepEqual(first.items.map(i=>[i.escalacaoId,i.pontuacao,i.posicao]),[[7,'85.51',1],[5,'34.41',2],[6,'30.31',3]]);
        assert.equal(await db.fantasyEscalacaoResultado.count(),3);assert.equal(await db.fantasyFechamentoAuditoria.count(),1);
        assert.deepEqual(await protectedData(db),state.protected,'FINAL_PROTECTED_DATA_CHANGE');
        const report=JSON.parse(fs.readFileSync(resultFile,'utf8')); Object.assign(report,{ranking:first,secondReadIdentical:true,
          protectedTablesUnchanged:Object.keys(state.protected.tables).length,allOriginalMigrationRowsUnchanged:true,verifiedAt:new Date().toISOString()});
        fs.writeFileSync(resultFile,JSON.stringify(report,null,2)+'\n');state.phase='VERIFIED';save(state);console.log(JSON.stringify(report,null,2));
      } else throw Error('USE_PREFLIGHT_MIGRATE_PERSIST_VERIFY');
    }
  } catch(error) {
    // Read-only failure evidence; never mark a failed migration applied or retry writes.
    if(state){state.failure={phase:state.phase,code:error.code||error.name||'FAILURE',message:error.name==='AssertionError'?error.message:'OPERATION_FAILED',at:new Date().toISOString()};
      try{state.failure.database={tables:await db.$queryRaw`SELECT TABLE_NAME FROM information_schema.TABLES WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME IN ('FANTASY_ESCALACAO_RESULTADO','FANTASY_FECHAMENTO_AUDITORIA')`,migrations:(await history(db)).filter(r=>names.includes(r.migration_name)).map(r=>({name:r.migration_name,finished:r.finished_at,rolledBack:r.rolled_back_at}))};save(state);}catch{}}
    throw error;
  } finally {await db.$disconnect();}
}
if(require.main===module)main(process.argv[2]).catch(e=>{console.error(e.code||e.name);if(e.name==='AssertionError')console.error(e.message);else if(/^[A-Z_]+$/.test(e.message))console.error(e.message);process.exitCode=1;});
