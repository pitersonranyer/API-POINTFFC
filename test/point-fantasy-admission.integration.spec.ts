import { PrismaClient } from '@prisma/client';
import { fork, ChildProcess } from 'child_process';
import { randomUUID } from 'crypto';
import { resolve } from 'path';
import { readFileSync } from 'fs';
import { AdmissionRequest } from '../src/point-fantasy/observation/writer-admission.service';
// Same isolated CommonJS boundary as the structure/backfill suites.
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { backfill, isolatedUrl } = require('../scripts/point-fantasy-scoring-backfill.cjs');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { fingerprint } = require('../scripts/point-fantasy-schema-read.cjs');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { isolatedSql } = require('./support/point-fantasy-isolated-sql.cjs');
const url=process.env.POINT_FANTASY_ADMISSION_TEST_URL;
const integration=url?describe:describe.skip;
jest.setTimeout(120000);
integration('durable MySQL admission, independent processes and frozen old writer',()=>{
  let db:PrismaClient,number=0,baseline:any;
  const season=63000,children=new Set<ChildProcess>();
  function start(request:Record<string,unknown>){
    const child=fork(resolve(__dirname,'support/admission-worker.cjs'),[],{silent:true,env:{...process.env,POINT_FANTASY_ADMISSION_TEST_URL:url}});
    children.add(child);child.once('exit',()=>children.delete(child));
    let readyResolve!:()=>void;
    const ready=new Promise<void>(done=>{readyResolve=done;});
    const done=new Promise<any>((resolveDone,reject)=>{
      const timer=setTimeout(()=>{child.kill();reject(Error('WORKER_TIMEOUT'));},60000);
      child.on('message',(message:any)=>{if(message.ready)readyResolve();if(message.done){clearTimeout(timer);resolveDone(message);}});
      child.on('error',error=>{clearTimeout(timer);reject(error);});
      child.on('exit',code=>{clearTimeout(timer);if(code!==0)reject(Error('WORKER_EXIT_'+code));});
    });
    child.send(request);return {child,ready,done};
  }
  const run=(request:Record<string,unknown>)=>start(request).done;
  const collect=(round:number,kind='LEGACY',extra:Record<string,unknown>={})=>run({action:'collect',season,round,kind,...extra});
  const row=(round:number)=>db.fantasyApuracaoRodada.findUniqueOrThrow({where:{temporada_rodada:{temporada:season,rodada:round}}});
  async function input(round:number,target:'LEGADO'|'BLOQUEADO'|'ATUAL',operationId=randomUUID()):Promise<AdmissionRequest>{
    const r=await db.fantasyApuracaoRodada.findUnique({where:{temporada_rodada:{temporada:season,rodada:round}}});
    const c=await db.fantasyEscritaControle.findUnique({where:{temporada_rodada:{temporada:season,rodada:round}}});
    return {season,round,target,operationId,operator:'fixture-operator',reason:'explicit isolated transition',expectedMode:c?.modo??null,
      expectedGeneration:c?.geracao??0n,expectedRevision:r?.revisaoAtual??0n,expectedHash:r?.hashConteudoAtual??null,expectedFence:r?.fence??0n};
  }
  const admin=(action:string,request:AdmissionRequest)=>run({action,input:JSON.parse(JSON.stringify(request,(_,v)=>typeof v==='bigint'?v.toString():v))});
  async function initialized(){const round=++number;expect((await admin('initialize',await input(round,'LEGADO'))).error).toBeUndefined();return round;}
  async function current(){const round=await initialized();expect((await collect(round)).result.estado).toBe('SUCESSO');
    expect((await admin('transition',await input(round,'BLOQUEADO'))).error).toBeUndefined();await backfill(url,season,round);
    expect((await admin('transition',await input(round,'ATUAL'))).error).toBeUndefined();return round;}
  beforeAll(async()=>{
    isolatedUrl(url);db=new PrismaClient({datasources:{db:{url}},log:[]});baseline=await fingerprint(db);
    expect(readFileSync(process.env.POINT_FANTASY_PRE_ADMISSION_SOURCE!,'utf8')).not.toContain('assertWriterAdmission');
  });
  afterAll(async()=>{for(const child of children)child.kill();await db?.$disconnect();});
  it('fails closed for missing scope without changing historical collections',async()=>{
    expect((await collect(30)).error).toBe('ADMISSION_WRITER_BLOCKED');
    expect((await collect(30,'OLD')).error).toBeTruthy();
    expect(await db.fantasyPontuacaoColeta.count()).toBe(3);
  });
  it('serializes two legacy processes on one UUID and preserves idempotence across restart',async()=>{
    const round=await initialized(),operationId=randomUUID();
    const results=await Promise.all([collect(round,'LEGACY',{operationId}),collect(round,'LEGACY',{operationId})]);
    expect(results.every(r=>!r.error)).toBe(true);expect(results[0].result.coletaId).toBe(results[1].result.coletaId);
    expect(results.reduce((sum,r)=>sum+r.calls,0)).toBe(4);
    expect((await collect(round,'LEGACY',{operationId})).calls).toBe(0);
    expect(await db.fantasyPontuacaoSnapshot.count({where:{rodadaId:(await row(round)).id}})).toBe(1);
  });
  it('initializes an explicitly authorized pristine scope without fabricating a legacy snapshot',async()=>{
    const round=await initialized();await admin('transition',await input(round,'BLOQUEADO'));
    expect((await admin('transition',await input(round,'ATUAL'))).error).toBeUndefined();
    expect((await collect(round,'CURRENT')).result).toMatchObject({estado:'SUCESSO',revisaoResultante:'1'});
    expect(await db.fantasyPontuacaoSnapshot.count({where:{rodadaId:(await row(round)).id}})).toBe(0);
  });
  it('serializes two current processes and refuses a competing legacy process',async()=>{
    const round=await current(),operationId=randomUUID();
    const results=await Promise.all([collect(round,'CURRENT',{operationId,points:'2'}),collect(round,'CURRENT',{operationId,points:'2'}),collect(round,'LEGACY')]);
    expect(results[0].result.coletaId).toBe(results[1].result.coletaId);expect(results[2].error).toBe('ADMISSION_WRITER_BLOCKED');
    expect((await row(round)).revisaoAtual).toBe(2n);
  });
  it('blocks old binaries at admission and at finalization after suspension, even when ignoring the service gate',async()=>{
    const round=await initialized();expect((await collect(round)).result.estado).toBe('SUCESSO');
    // Old writer reuses a known snapshot: the collection trigger must still reject its commit.
    const worker=start({action:'collect',kind:'OLD',season,round,hold:true});await worker.ready;
    expect((await admin('transition',await input(round,'BLOQUEADO'))).error).toBeUndefined();
    const before=await fingerprint(db);worker.child.send('release');expect((await worker.done).error).toBeTruthy();
    const after=await fingerprint(db);for(const name of ['fantasy_pontuacao_coleta','fantasy_pontuacao_snapshot','fantasy_pontuacao_atleta_snapshot'])expect(after[name].data).toBe(before[name].data);
    expect((await collect(round,'OLD')).error).toBeTruthy();
    await expect(db.$executeRaw`UPDATE FANTASY_APURACAO_RODADA SET ULTIMA_VERSAO_SNAPSHOT=ULTIMA_VERSAO_SNAPSHOT+1 WHERE TEMPORADA=${season} AND RODADA=${round}`).rejects.toThrow();
    expect((await admin('transition',await input(round,'ATUAL'))).error).toBe('ADMISSION_NOT_QUIESCENT_OR_BACKFILLED');
    expect((await admin('recoverExpired',await input(round,'BLOQUEADO'))).error).toBe('ADMISSION_RECOVERY_BLOCKED');
    await db.$executeRaw`UPDATE FANTASY_APURACAO_RODADA SET LOCK_ATE=DATE_SUB(UTC_TIMESTAMP(3),INTERVAL 1 SECOND) WHERE TEMPORADA=${season} AND RODADA=${round}`;
    const recovery=await input(round,'BLOQUEADO');expect((await admin('recoverExpired',recovery)).error).toBeUndefined();
    expect((await admin('recoverExpired',recovery)).result.reused).toBe(true);
    expect((await row(round)).fence).toBe(recovery.expectedFence+1n);
  });
  it('rejects a new worker finalization after generation changes without rewriting its admitted collection',async()=>{
    const round=await current();const worker=start({action:'collect',kind:'CURRENT',season,round,points:'3',hold:true});await worker.ready;
    const before=await db.fantasyPontuacaoColeta.findMany({where:{rodadaId:(await row(round)).id}});
    await admin('transition',await input(round,'BLOQUEADO'));worker.child.send('release');
    expect((await worker.done).error).toBe('ADMISSION_WRITER_BLOCKED');
    expect(await db.fantasyPontuacaoColeta.findMany({where:{rodadaId:(await row(round)).id}})).toEqual(before);
    expect((await row(round)).revisaoAtual).toBe(1n);
  });
  it('survives process death and restart during collection, recovering only after expiry',async()=>{
    const round=await initialized(),operationId=randomUUID();const worker=start({action:'collect',kind:'LEGACY',season,round,operationId,hold:true});
    worker.done.catch(()=>undefined);await worker.ready;worker.child.kill();
    expect((await collect(round,'LEGACY')).result.estado).toBe('LEASE_OCUPADO');
    await admin('transition',await input(round,'BLOQUEADO'));
    expect((await collect(round,'LEGACY')).error).toBe('ADMISSION_WRITER_BLOCKED');
    await db.$executeRaw`UPDATE FANTASY_APURACAO_RODADA SET LOCK_ATE=DATE_SUB(UTC_TIMESTAMP(3),INTERVAL 1 SECOND) WHERE TEMPORADA=${season} AND RODADA=${round}`;
    expect((await admin('recoverExpired',await input(round,'BLOQUEADO'))).error).toBeUndefined();
    expect((await db.fantasyPontuacaoColeta.findUniqueOrThrow({where:{operacaoId:operationId}})).estado).toBe('INTERROMPIDA');
  });
  it('rejects an old admission generation even after the same writer mode is enabled again',async()=>{
    const round=await current();const worker=start({action:'collect',kind:'CURRENT',season,round,points:'3',hold:true});await worker.ready;
    await admin('transition',await input(round,'BLOQUEADO'));
    await db.$executeRaw`UPDATE FANTASY_APURACAO_RODADA SET LOCK_ATE=DATE_SUB(UTC_TIMESTAMP(3),INTERVAL 1 SECOND) WHERE TEMPORADA=${season} AND RODADA=${round}`;
    expect((await admin('recoverExpired',await input(round,'BLOQUEADO'))).error).toBeUndefined();
    expect((await admin('transition',await input(round,'ATUAL'))).error).toBeUndefined();worker.child.send('release');
    expect((await worker.done).error).toBe('ADMISSION_GENERATION_CHANGED');expect((await row(round)).revisaoAtual).toBe(1n);
  });
  it('rolls back both the transition audit and the mode when its transaction fails',async()=>{
    const round=await initialized(),request=await input(round,'BLOQUEADO');
    isolatedSql(url,"CREATE TRIGGER fixture_admission_failure BEFORE UPDATE ON FANTASY_ESCRITA_CONTROLE FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='FIXTURE_ADMISSION_FAILURE';");
    try{expect((await admin('transition',request)).error).toBeTruthy();}
    finally{isolatedSql(url,'DROP TRIGGER fixture_admission_failure;');}
    expect(await db.fantasyEscritaTransicao.findUnique({where:{operacaoId:request.operationId}})).toBeNull();
    expect((await db.fantasyEscritaControle.findUniqueOrThrow({where:{temporada_rodada:{temporada:season,rodada:round}}})).modo).toBe('LEGADO');
    expect((await admin('transition',request)).error).toBeUndefined();
  });
  it('rejects direct cut, stale references and conflicting transition UUIDs, and arbitrates concurrent transitions',async()=>{
    const round=await initialized();expect((await admin('transition',await input(round,'ATUAL'))).error).toBe('ADMISSION_TRANSITION_INVALID');
    const request=await input(round,'BLOQUEADO');
    expect((await admin('transition',{...request,expectedHash:'a'.repeat(64)})).error).toBe('ADMISSION_REFERENCE_CHANGED');
    const competing={...request,operationId:randomUUID()};const results=await Promise.all([admin('transition',request),admin('transition',competing)]);
    expect(results.filter(r=>!r.error)).toHaveLength(1);
    const winner=results[0].error?competing:request;
    expect((await admin('transition',winner)).result.reused).toBe(true);
    expect((await admin('transition',{...winner,reason:'different'})).error).toBe('ADMISSION_OPERATION_CONFLICT');
  });
  it('never reactivates legacy after current, and DB rejects raw direct mode changes',async()=>{
    const round=await current();expect((await collect(round,'OLD')).error).toBeTruthy();
    const before=await row(round);await admin('transition',await input(round,'BLOQUEADO'));
    expect((await admin('transition',await input(round,'LEGADO'))).error).toBe('ADMISSION_TRANSITION_INVALID');
    await expect(db.$executeRaw`UPDATE FANTASY_ESCRITA_CONTROLE SET MODO='LEGADO',GERACAO=GERACAO+1 WHERE TEMPORADA=${season} AND RODADA=${round}`).rejects.toThrow();
    expect((await row(round)).revisaoAtual).toBe(before.revisaoAtual);
    expect((await admin('transition',await input(round,'ATUAL'))).error).toBeUndefined();
  });
  it.each(['deadlock','permanent'])('retries only supported persistence conflicts or rolls back %s',async failure=>{
    const round=await current();const result=await collect(round,'CURRENT',{points:'2',failure});
    expect(result.error).toBeUndefined();expect(result.calls).toBe(4);
    expect(result.result.estado).toBe(failure==='deadlock'?'SUCESSO':'RESPOSTA_INVALIDA');
    expect((await row(round)).revisaoAtual).toBe(failure==='deadlock'?2n:1n);
    const legacyRound=await initialized();const legacy=await collect(legacyRound,'LEGACY',{failure});
    expect(legacy.calls).toBe(4);
    expect(legacy.result.estado).toBe(failure==='deadlock'?'SUCESSO':'RESPOSTA_INVALIDA');
    expect(await db.fantasyPontuacaoSnapshot.count({where:{rodadaId:(await row(legacyRound)).id}})).toBe(failure==='deadlock'?1:0);
  });
  it('rejects stale fence in a held current transaction and creates no scoring revision',async()=>{
    const round=await current();const worker=start({action:'collect',kind:'CURRENT',season,round,points:'3',hold:true});await worker.ready;
    await db.$executeRaw`UPDATE FANTASY_APURACAO_RODADA SET FENCE=FENCE+1 WHERE TEMPORADA=${season} AND RODADA=${round}`;
    worker.child.send('release');expect((await worker.done).result.estado).toBe('INTERROMPIDA');expect((await row(round)).revisaoAtual).toBe(1n);
  });
  it('preserves original snapshots, historical collections, decimal tokens and traditional history',async()=>{
    const after=await fingerprint(db);
    for(const [name,value] of Object.entries(baseline))if(!name.startsWith('fantasy_'))expect(after[name]).toEqual(value);
    expect(await db.fantasyPontuacaoAtletaSnapshot.count({where:{snapshotId:1}})).toBe(275);
    expect(await db.fantasyPontuacaoAtletaSnapshot.count({where:{snapshotId:1,posicaoId:6}})).toBe(20);
    expect((await db.fantasyPontuacaoColeta.findMany({where:{id:{in:[1,2,3]}},orderBy:{id:'asc'}})).map(r=>r.estado)).toEqual(['FALHA_REDE','SUCESSO','SUCESSO']);
    expect(await db.fantasyEscritaTransicao.count()).toBeGreaterThan(0);
    await expect(db.fantasyEscritaTransicao.updateMany({data:{justificativa:'tampered'}})).rejects.toThrow();
  });
  it('refuses new admissions and transitions when a required database guard is missing',async()=>{
    const round=await initialized();const [definition]=await db.$queryRawUnsafe<any[]>('SHOW CREATE TRIGGER FPS_ADMISSAO');
    const sql=Object.values(definition).find(value=>typeof value==='string'&&/CREATE[\s\S]+TRIGGER/i.test(value));expect(typeof sql).toBe('string');
    isolatedSql(url,'DROP TRIGGER FPS_ADMISSAO;');
    try{
      expect((await collect(round)).error).toBe('ADMISSION_GUARDS_INCOMPLETE');
      expect((await admin('transition',await input(round,'BLOQUEADO'))).error).toBe('ADMISSION_GUARDS_INCOMPLETE');
    }finally{isolatedSql(url,'DELIMITER $$\n'+sql+'$$\nDELIMITER ;');}
    expect((await collect(round)).result.estado).toBe('SUCESSO');
  });
});
