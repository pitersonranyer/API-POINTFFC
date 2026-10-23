import { Prisma, PrismaClient } from '@prisma/client';
import { randomUUID } from 'crypto';
import { readFileSync } from 'fs';
import { resolve } from 'path';
import { ObservationService } from '../src/point-fantasy/observation/observation.service';
import { CurrentScoringService } from '../src/point-fantasy/observation/current-scoring.service';
import { partialScoringPolicy } from '../src/point-fantasy/observation/current-scoring-policy';
import { ObservationSource } from '../src/point-fantasy/observation/observation-source';
import { PrismaService } from '../src/prisma/prisma.service';
import { IsolatedWriterGate } from './support/scoring-activation-model';

// CommonJS rehearsal helpers have no application bootstrap (same boundary as structure tests).
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { backfill, isolatedUrl } = require('../scripts/point-fantasy-scoring-backfill.cjs');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { isolatedSql } = require('./support/point-fantasy-isolated-sql.cjs');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { fingerprint } = require('../scripts/point-fantasy-schema-read.cjs');
const url=process.env.POINT_FANTASY_ACTIVATION_TEST_URL;
const integration=url?describe:describe.skip;
integration('full transition from restored pre-0029 schema, fixture HTTP only',()=>{
  let db:PrismaClient,payload:string,pending:string,original:any,snapshotBaseline:any,legacyOriginal:any[];
  const gate=new IsolatedWriterGate();
  let release!:()=>void,running:Promise<void>;
  const stable=(value:unknown)=>JSON.stringify(value,(_,v)=>typeof v==='bigint'?v.toString():v);
  const source=(text:string,season=2026,round=31):ObservationSource=>({get:jest.fn(async endpoint=>({
    endpoint,status:200,error:null,headers:{},receivedAt:new Date().toISOString(),
    text:endpoint==='/mercado/status'?JSON.stringify({temporada:season,rodada_atual:round,status_mercado:2}):endpoint.startsWith('/partidas/')?JSON.stringify({rodada:round,partidas:[]}):text,
  }))});
  const current=(text:string,client=db)=>new CurrentScoringService(client as PrismaService,source(text),url!,partialScoringPolicy);
  const points=(value:string)=>payload.replace(/("pontuacao"\s*:\s*)-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?/,(_,prefix:string)=>prefix+value);
  const round=()=>db.fantasyApuracaoRodada.findUniqueOrThrow({where:{temporada_rodada:{temporada:2026,rodada:31}}});
  beforeAll(async()=>{
    isolatedUrl(url);db=new PrismaClient({datasources:{db:{url}},log:[]});
    const [identity]=await db.$queryRaw<Array<{name:string}>>`SELECT DATABASE() AS name`;
    if(identity.name!==new URL(url!).pathname.slice(1))throw Error('ISOLATED_REQUIRED');
    original=await fingerprint(db);
    legacyOriginal=await db.$queryRaw`SELECT * FROM FANTASY_PONTUACAO_COLETA WHERE ID IN (1,2,3) ORDER BY ID`;
    const [snapshot]=await db.$queryRaw<Array<{PAYLOAD_ORIGINAL:string}>>`SELECT PAYLOAD_ORIGINAL FROM FANTASY_PONTUACAO_SNAPSHOT WHERE ID=1`;
    payload=snapshot.PAYLOAD_ORIGINAL;
  });
  afterAll(async()=>{release?.();await db?.$disconnect();});
  it('starts before 0029 and models an active legacy operation without using the incompatible new Prisma client',async()=>{
    const columns=await db.$queryRaw<any[]>`SELECT COLUMN_NAME FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND COLUMN_NAME='REVISAO_ATUAL'`;
    expect(columns).toHaveLength(0);
    pending=randomUUID();
    await db.$executeRaw`UPDATE FANTASY_APURACAO_RODADA SET LOCK_TOKEN=${randomUUID()},LOCK_ATE=DATE_ADD(UTC_TIMESTAMP(3),INTERVAL 120 SECOND),FENCE=FENCE+1 WHERE TEMPORADA=2026 AND RODADA=31`;
    await db.$executeRaw`INSERT INTO FANTASY_PONTUACAO_COLETA (OPERACAO_ID,RODADA_ID,ENDPOINT,FENCE) SELECT ${pending},ID,'FIXTURE_ACTIVE_LEGACY',FENCE FROM FANTASY_APURACAO_RODADA WHERE TEMPORADA=2026 AND RODADA=31`;
    running=gate.run('LEGACY',()=>new Promise<void>(done=>{release=done;}));gate.stopLegacy();
    await expect(gate.run('LEGACY',async()=>{})).rejects.toThrow('WRITER_NOT_ADMITTED');
    expect(()=>gate.drained()).toThrow('OPERATIONS_RUNNING');
    const [alive]=await db.$queryRaw<Array<{n:bigint}>>`SELECT COUNT(*) AS n FROM FANTASY_APURACAO_RODADA WHERE LOCK_ATE>UTC_TIMESTAMP(3)`;
    expect(Number(alive.n)).toBe(1);
  });
  it('recovers only expired work under row lock, preserves its audit, and fences stale authorization',async()=>{
    const recover=()=>db.$transaction(async tx=>{
      const [r]=await tx.$queryRaw<Array<{ID:number;alive:bigint}>>`SELECT ID,LOCK_ATE>UTC_TIMESTAMP(3) AS alive FROM FANTASY_APURACAO_RODADA WHERE TEMPORADA=2026 AND RODADA=31 FOR UPDATE`;
      if(Number(r.alive))throw Error('LIVE_LEASE');
      await tx.$executeRaw`UPDATE FANTASY_PONTUACAO_COLETA SET ESTADO='INTERROMPIDA',ERRO_CODIGO='FIXTURE_CUTOVER_EXPIRED',CONCLUIDA_EM=UTC_TIMESTAMP(3) WHERE RODADA_ID=${r.ID} AND ESTADO='EM_ANDAMENTO'`;
      await tx.$executeRaw`UPDATE FANTASY_APURACAO_RODADA SET LOCK_TOKEN=NULL,LOCK_ATE=NULL,FENCE=FENCE+1 WHERE ID=${r.ID}`;
    });
    await expect(recover()).rejects.toThrow('LIVE_LEASE');
    await db.$executeRaw`UPDATE FANTASY_APURACAO_RODADA SET LOCK_ATE=DATE_SUB(UTC_TIMESTAMP(3),INTERVAL 1 SECOND) WHERE TEMPORADA=2026 AND RODADA=31`;
    await recover();release();await running;gate.drained();gate.drained();
    const [row]=await db.$queryRaw<Array<{ESTADO:string}>>`SELECT ESTADO FROM FANTASY_PONTUACAO_COLETA WHERE OPERACAO_ID=${pending}`;
    expect(row.ESTADO).toBe('INTERROMPIDA');
  });
  it('executes exactly 0029 preserving legitimate migration history and old snapshot bytes',async()=>{
    isolatedSql(url,readFileSync(resolve(__dirname,'../prisma/migrations/0029_point_fantasy_current_scoring/migration.sql'),'utf8'));
    const after=await fingerprint(db);
    expect(after._prisma_migrations.data).toBe(original._prisma_migrations.data);
    expect(after.fantasy_pontuacao_snapshot).toEqual(original.fantasy_pontuacao_snapshot);
    expect(after.fantasy_pontuacao_atleta_snapshot).toEqual(original.fantasy_pontuacao_atleta_snapshot);
    expect((await round()).revisaoAtual).toBe(0n);
  });
  it('rolls back the backfill audit and rows if copying athletes fails',async()=>{
    const before=await fingerprint(db);
    isolatedSql(url,"CREATE TRIGGER fixture_backfill_failure BEFORE INSERT ON FANTASY_PONTUACAO_ATLETA FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='FIXTURE_BACKFILL_FAILURE';");
    try{await expect(backfill(url,2026,31)).rejects.toThrow();}
    finally{isolatedSql(url,'DROP TRIGGER fixture_backfill_failure;');}
    const after=await fingerprint(db);
    for(const name of Object.keys(before))expect(after[name].data).toBe(before[name].data);
    expect((await round()).revisaoAtual).toBe(0n);
    expect(await db.fantasyPontuacaoAtleta.count()).toBe(0);
    // MySQL may consume an auto-increment value on rollback; data and revisions are the invariant.
  });
  it('runs real legacy code after DDL, blocks backfill during its HTTP and drains before copying the latest success',async()=>{
    // Separate fixture round proves the actual writer/lease protocol after additive DDL.
    const s=source('{"rodada":1,"atletas":{"1":{"pontuacao":0,"posicao_id":6}}}',64000,1);
    let entered!:()=>void,unblock!:()=>void;
    const ready=new Promise<void>(done=>{entered=done;}),wait=new Promise<void>(done=>{unblock=done;});
    const get=s.get;s.get=async endpoint=>{if(endpoint==='/atletas/pontuados'){entered();await wait;}return get(endpoint);};
    const work=new ObservationService(db as PrismaService,s).collect(64000,1);await ready;
    try{
      await expect(backfill(url,64000,1)).rejects.toThrow('QUIESCENT_OBSERVING_ROUND_REQUIRED');
      const competingSource=source('{"rodada":1,"atletas":{"1":{"pontuacao":1}}}',64000,1);
      expect(await new CurrentScoringService(db as PrismaService,competingSource,url!,partialScoringPolicy).collect(64000,1)).toMatchObject({estado:'LEASE_OCUPADO'});
      expect(competingSource.get).not.toHaveBeenCalled();
    }
    finally{unblock();}
    expect((await work).estado).toBe('SUCESSO');
    const seed=await backfill(url,64000,1);expect(Number(seed.total)).toBe(1);
    expect((await backfill(url,64000,1)).reused).toBe(true);
    const first=await backfill(url,2026,31);expect(Number(first.total)).toBe(275);expect(Number(first.tecnicos)).toBe(20);
    expect(first.soma).toBe('1169.590000000000001000');
    const before=await fingerprint(db);expect((await backfill(url,2026,31)).reused).toBe(true);
    expect(await fingerprint(db)).toEqual(before);snapshotBaseline=before;
    gate.enableCurrent({migration:true,backfill:true,noLease:(await round()).lockToken===null});
  });
  it('admits only differential writes, preserves identical revision, then applies one changed athlete',async()=>{
    await expect(gate.run('LEGACY',()=>new ObservationService(db as PrismaService,source(payload)).collect(2026,31))).rejects.toThrow('WRITER_NOT_ADMITTED');
    expect(await gate.run('CURRENT',()=>current(payload).collect(2026,31))).toMatchObject({estado:'SUCESSO',revisaoResultante:'1',alterados:0});
    expect(await gate.run('CURRENT',()=>current(points('-999')).collect(2026,31))).toMatchObject({estado:'SUCESSO',revisaoResultante:'2',alterados:1});
    expect((await round()).estado).toBe('OBSERVANDO');
  });
  it('quarantines historical A and retains its reference without changing revision',async()=>{
    const before=await round();const result=await gate.run('CURRENT',()=>current(payload).collect(2026,31));
    expect(result).toMatchObject({estado:'RESPOSTA_INVALIDA',erroCodigo:'PREVIOUSLY_OBSERVED_CONTENT'});
    const row=await db.fantasyPontuacaoColeta.findUniqueOrThrow({where:{id:result.coletaId}});
    expect(row.revisaoBase).toBe(before.revisaoAtual);expect(row.payloadRecebido).toBeNull();expect((await round()).revisaoAtual).toBe(before.revisaoAtual);
  });
  it('rolls back a partial write and recovers with a new UUID without duplicate revision',async()=>{
    const proxy=new Proxy(db,{get(target,key){if(key==='$transaction')return (action:any,options:any)=>target.$transaction(tx=>action(new Proxy(tx,{get(t,k){
      if(k==='fantasyPontuacaoAtleta')return {...tx.fantasyPontuacaoAtleta,updateMany:async(args:any)=>{await tx.fantasyPontuacaoAtleta.updateMany(args);throw Error('fixture permanent failure');}};
      return Reflect.get(t,k);
    }})),options);return Reflect.get(target,key);}});
    expect((await gate.run('CURRENT',()=>current(points('-998'),proxy).collect(2026,31))).estado).toBe('RESPOSTA_INVALIDA');
    expect((await round()).revisaoAtual).toBe(2n);
    // Persistence failure did not record an observed semantic candidate: a new operation can retry it.
    expect(await gate.run('CURRENT',()=>current(points('-998')).collect(2026,31))).toMatchObject({estado:'SUCESSO',revisaoResultante:'3',alterados:1});
    await expect(backfill(url,2026,31)).rejects.toThrow('BACKFILL_BASE_CHANGED');
  });
  it('preserves all snapshots, original collections, traditional data and legitimate history',async()=>{
    const after=await fingerprint(db);
    expect(after.fantasy_pontuacao_snapshot).toEqual(snapshotBaseline.fantasy_pontuacao_snapshot);
    expect(after.fantasy_pontuacao_atleta_snapshot).toEqual(snapshotBaseline.fantasy_pontuacao_atleta_snapshot);
    expect(after._prisma_migrations).toEqual(original._prisma_migrations);
    const legacy=await db.fantasyPontuacaoColeta.findMany({where:{id:{in:[1,2,3]}},orderBy:{id:'asc'}});
    expect(legacy.map(row=>row.estado)).toEqual(['FALHA_REDE','SUCESSO','SUCESSO']);
    const columns=Object.keys(legacyOriginal[0]);
    if(columns.some(key=>!/^\w+$/.test(key)))throw Error('INVALID_COLUMN');
    const preserved=await db.$queryRawUnsafe('SELECT '+columns.map(key=>'`'+key+'`').join(',')+' FROM FANTASY_PONTUACAO_COLETA WHERE ID IN (1,2,3) ORDER BY ID');
    expect(stable(preserved)).toBe(stable(legacyOriginal));
    for(const [name,expected] of Object.entries(original))if(!name.startsWith('fantasy_pontuacao_')&&name!=='fantasy_apuracao_rodada')expect(stable(after[name])).toBe(stable(expected));
    expect(await db.fantasyPontuacaoAtleta.count({where:{temporada:2026,rodada:31}})).toBe(275);
    expect(await db.fantasyPontuacaoSnapshot.count()).toBe(2);
    expect(Prisma.prismaVersion.client).toBeTruthy();
  });
});
