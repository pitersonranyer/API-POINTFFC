import { Prisma, PrismaClient } from '@prisma/client';
import { randomUUID } from 'crypto';
import { PrismaService } from '../src/prisma/prisma.service';
import { ObservationService } from '../src/point-fantasy/observation/observation.service';
import { ObservationSource, SourceResponse } from '../src/point-fantasy/observation/observation-source';

const url=process.env.POINT_FANTASY_OBSERVATION_TEST_DATABASE_URL;
const integration=url?describe:describe.skip;
integration('observation real MySQL (isolated, retained test fixtures)',()=>{
  let db:PrismaClient; let season=65000;
  const response=(endpoint:string,text:string,status=200):SourceResponse=>({endpoint,text,status,receivedAt:new Date().toISOString(),headers:{'cache-control':'max-age=180'},error:status===200?null:`HTTP_${status}`});
  function source(round:number,points='1.2',override?: (path:string)=>Promise<SourceResponse>|undefined):ObservationSource{
    return {get:async path=>{
      const special=override?.(path);if(special)return special;
      return response(path,path==='/mercado/status'?JSON.stringify({temporada:season,rodada_atual:round,status_mercado:2})
        :path.startsWith('/partidas/')?JSON.stringify({rodada:round,partidas:[]})
          :`{"rodada":${round},"total_atletas":1,"atletas":{"1":{"pontuacao":${points},"posicao_id":6,"entrou_em_campo":true}}}`);
    }};
  }
  const service=(round:number,points?:string,override?: (p:string)=>Promise<SourceResponse>|undefined)=>new ObservationService(db as PrismaService,source(round,points,override));
  const instrument = (wrap: (tx: any) => any, afterCommit?: (call: number) => void, beforeCommit?: (call: number) => void) => {
    let calls=0;
    return new Proxy(db,{get(target,key){
      if(key==='$transaction')return async(action:any,options:any)=>{
        const call=++calls;
        const result=await target.$transaction(async tx=>{
          const overrides=wrap(tx);
          // Prisma raw methods are not enumerable; spread-only instrumentation loses them.
          const wrapped=new Proxy(tx,{get(original,key){return key in overrides?Reflect.get(overrides,key):Reflect.get(original,key);}});
          const value=await action(wrapped);beforeCommit?.(call);return value;
        },options);
        afterCommit?.(call);return result;
      };
      return Reflect.get(target,key);
    }}) as PrismaService;
  };
  const multiSource=(round:number,count=201)=>source(round,undefined,p=>p.startsWith('/atletas/')?Promise.resolve(response(p,JSON.stringify({rodada:round,
    atletas:Object.fromEntries(Array.from({length:count},(_,i)=>[String(i+1),{pontuacao:i%2?-1:0,posicao_id:i===0?6:4,entrou_em_campo:true,scout:{FC:i}}]))}))):undefined);
  const expectRollback=async(round:number)=>{
    const r=await db.fantasyApuracaoRodada.findUniqueOrThrow({where:{temporada_rodada:{temporada:season,rodada:round}}});
    expect(r.ultimaVersaoSnapshot).toBe(0);expect(await db.fantasyPontuacaoSnapshot.count({where:{rodadaId:r.id}})).toBe(0);
  };
  beforeAll(async()=>{
    const u=new URL(url!);if(u.protocol!=='mysql:'||!['localhost','127.0.0.1'].includes(u.hostname)||!/^\/point_fantasy_observation_3b2_test_\d+$/.test(u.pathname))throw new Error('ISOLATED_LOCAL_TEST_SCHEMA_REQUIRED');
    db=new PrismaClient({datasources:{db:{url}},log:[]}); while(await db.fantasyApuracaoRodada.count({where:{temporada:season}}))season--;
  });
  afterAll(async()=>{await db?.$disconnect();});
  it('creates, reuses, versions and restores A; operation retry does not contact source',async()=>{
    const op=randomUUID();const s=service(1,'8.030000000000001');const a=await s.collect(season,1,op);
    expect(a).toMatchObject({estado:'SUCESSO',versao:1,tecnicos:1,snapshotCriadoNestaColeta:true});
    const retry=new ObservationService(db as PrismaService,{get:()=>{throw new Error('must not request');}});
    expect((await retry.collect(season,1,op)).coletaId).toBe(a.coletaId);
    await expect(retry.collect(season,2,op)).rejects.toThrow('OPERATION_CONFLICT');
    const equal=await s.collect(season,1);expect(equal.snapshotId).toBe(a.snapshotId);expect(equal.snapshotCriadoNestaColeta).toBe(false);
    expect((await service(1,'9').collect(season,1)).versao).toBe(2);
    expect((await s.collect(season,1)).snapshotId).toBe(a.snapshotId);
    const athlete=await db.fantasyPontuacaoAtletaSnapshot.findFirstOrThrow({where:{snapshotId:a.snapshotId!}});
    expect(athlete.pontuacao?.toFixed()).toBe('8.030000000000001');
    expect(athlete.pontuacaoTokenOriginal).toBe('8.030000000000001');
  });
  it.each([400,404,500])('records HTTP %s without snapshot',async status=>{
    const row=await service(status===400?3:status===404?4:5,undefined,p=>p.startsWith('/atletas/')?Promise.resolve(response(p,'{"error":"unavailable"}',status)):undefined).collect(season,status===400?3:status===404?4:5);
    expect(row).toMatchObject({estado:'FALHA_HTTP',snapshotId:null,erroCodigo:`HTTP_${status}`});
    expect((await db.fantasyPontuacaoColeta.findUniqueOrThrow({where:{id:row.coletaId}})).payloadRecebido).toContain('unavailable');
  });
  it.each([['invalid','{"rodada":6,"atletas":'],['round','{"rodada":7,"atletas":{}}'],['overflow','{"rodada":6,"atletas":{"1":{"pontuacao":1e90}}}']])('records invalid normalization %s',async(_name,text)=>{
    const row=await service(6,undefined,p=>p.startsWith('/atletas/')?Promise.resolve(response(p,text)):undefined).collect(season,6);
    expect(row.estado).toBe('RESPOSTA_INVALIDA');expect(row.snapshotId).toBeNull();
  });
  it('preserves historical observation without assigning guessed season snapshot',async()=>{
    const row=await service(8,undefined,p=>p.startsWith('/atletas/')?Promise.resolve(response(p,'{"rodada":7,"atletas":{}}')):undefined).collect(season,7);
    expect(row.estado).toBe('IDENTIDADE_PENDENTE');expect(row.snapshotId).toBeNull();
    expect((await db.fantasyPontuacaoColeta.findUniqueOrThrow({where:{id:row.coletaId}})).endpoint).toBe('/atletas/pontuados/7');
  });
  it.each(['PROVIDER_TIMEOUT','PROVIDER_NETWORK'])('records source failure %s',async error=>{
    const row=await service(9,undefined,p=>p.startsWith('/atletas/')?Promise.resolve({...response(p,''),status:null,text:null,error}):undefined).collect(season,9);
    expect(row.estado).toBe('FALHA_REDE');expect(row.snapshotId).toBeNull();
  });
  it('fences delayed worker, records concurrent busy attempt and recovers expired operation',async()=>{
    let release!:()=>void,entered!:()=>void;
    const gate=new Promise<void>(resolve=>{release=resolve;});const ready=new Promise<void>(resolve=>{entered=resolve;});
    const op=randomUUID();const old=service(10,undefined,p=>p.startsWith('/atletas/')?(async()=>{entered();await gate;return response(p,'{"rodada":10,"atletas":{}}');})():undefined);
    const pending=old.collect(season,10,op);await ready;
    expect((await service(10).collect(season,10)).estado).toBe('LEASE_OCUPADO');
    await db.$executeRaw`UPDATE FANTASY_APURACAO_RODADA SET LOCK_ATE=DATE_SUB(UTC_TIMESTAMP(3),INTERVAL 1 SECOND) WHERE TEMPORADA=${season} AND RODADA=10`;
    const fresh=await service(10,'3').collect(season,10);expect(fresh.estado).toBe('SUCESSO');
    const interrupted=await db.fantasyPontuacaoColeta.findUniqueOrThrow({where:{operacaoId:op}});
    release();const delayed=await pending;expect(delayed.estado).toBe('INTERROMPIDA');expect(delayed.snapshotId).toBeNull();
    expect(await db.fantasyPontuacaoColeta.findUniqueOrThrow({where:{operacaoId:op}})).toEqual(interrupted);
    expect(await db.fantasyPontuacaoSnapshot.count({where:{rodadaId:(await db.fantasyApuracaoRodada.findUniqueOrThrow({where:{temporada_rodada:{temporada:season,rodada:10}}})).id}})).toBe(1);
  });
  it('recovers crashed operation on retry without recollecting under the same UUID',async()=>{
    const round=await db.fantasyApuracaoRodada.create({data:{temporada:season,rodada:11}});
    const operacaoId=randomUUID();await db.fantasyPontuacaoColeta.create({data:{rodadaId:round.id,operacaoId,endpoint:'/atletas/pontuados'}});
    expect((await service(11).collect(season,11,operacaoId)).estado).toBe('INTERROMPIDA');
  });
  it('enforces cross-round snapshot ownership and does not touch traditional tables',async()=>{
    const snapshot=await db.fantasyPontuacaoSnapshot.findFirstOrThrow();const round=await db.fantasyApuracaoRodada.findUniqueOrThrow({where:{temporada_rodada:{temporada:season,rodada:11}}});
    await expect(db.fantasyPontuacaoColeta.create({data:{rodadaId:round.id,snapshotId:snapshot.id,operacaoId:randomUUID(),endpoint:'/atletas/pontuados'}})).rejects.toThrow();
    expect(await db.rodadaProcessamento.count()).toBe(0);expect(await db.pontuacaoTimeRodada.count()).toBe(0);
    expect(await db.fantasyEscalacao.count()).toBe(0);expect(await db.inscricaoTimeCompeticao.count()).toBe(0);expect(await db.movimentacaoCarteira.count()).toBe(0);
  });
  it('MySQL UTC_TIMESTAMP advances between statements in the same transaction',async()=>{
    await db.$transaction(async tx=>{
      const first=await tx.$queryRaw<Array<{n:bigint}>>`SELECT CAST(UNIX_TIMESTAMP(UTC_TIMESTAMP(3))*1000 AS UNSIGNED) AS n`;
      await new Promise(resolve=>setTimeout(resolve,100));
      const second=await tx.$queryRaw<Array<{n:bigint}>>`SELECT CAST(UNIX_TIMESTAMP(UTC_TIMESTAMP(3))*1000 AS UNSIGNED) AS n`;
      expect(Number(second[0].n-first[0].n)).toBeGreaterThanOrEqual(50);
    });
  });
  it('rolls back every batch/counter when lease expires during final transaction',async()=>{
    let batches=0;
    const proxy=instrument(tx=>({...tx,fantasyPontuacaoAtletaSnapshot:{...tx.fantasyPontuacaoAtletaSnapshot,createMany:async(args:any)=>{
      const result=await tx.fantasyPontuacaoAtletaSnapshot.createMany(args);
      if(++batches===1){await tx.$executeRaw`UPDATE FANTASY_APURACAO_RODADA SET LOCK_ATE=DATE_ADD(UTC_TIMESTAMP(3),INTERVAL 100000 MICROSECOND) WHERE TEMPORADA=${season} AND RODADA=12`;await new Promise(resolve=>setTimeout(resolve,200));}
      return result;
    }}}));
    const row=await new ObservationService(proxy,multiSource(12)).collect(season,12);
    expect(row).toMatchObject({estado:'INTERROMPIDA',erroCodigo:'AUTHORIZATION_LOST',snapshotId:null});
    await expectRollback(12);
  });
  it('rolls back if fencing changes before final authorization',async()=>{
    const proxy=instrument(tx=>({...tx,fantasyPontuacaoAtletaSnapshot:{...tx.fantasyPontuacaoAtletaSnapshot,createMany:async(args:any)=>{
      const result=await tx.fantasyPontuacaoAtletaSnapshot.createMany(args);
      await tx.$executeRaw`UPDATE FANTASY_APURACAO_RODADA SET FENCE=FENCE+1 WHERE TEMPORADA=${season} AND RODADA=13`;
      return result;
    }}}));
    expect((await new ObservationService(proxy,source(13)).collect(season,13)).erroCodigo).toBe('AUTHORIZATION_LOST');
    await expectRollback(13);
  });
  it('rolls back second-batch failure and preserves diagnostic and raw response',async()=>{
    let batches=0;
    const proxy=instrument(tx=>({...tx,fantasyPontuacaoAtletaSnapshot:{...tx.fantasyPontuacaoAtletaSnapshot,createMany:async(args:any)=>{
      if(++batches===2)throw new Error('private connection details');
      return tx.fantasyPontuacaoAtletaSnapshot.createMany(args);
    }}}));
    const row=await new ObservationService(proxy,multiSource(14)).collect(season,14);
    expect(row.erroCodigo).toBe('DB_ATHLETE_BATCH_FAILED');await expectRollback(14);
    expect((await db.fantasyPontuacaoColeta.findUniqueOrThrow({where:{id:row.coletaId}})).payloadRecebido).toContain('atletas');
    const again=await service(14).collect(season,14);expect(again.versao).toBe(1);
  });
  it.each(['snapshot','terminal','zero affected','commit'])('recovers %s failure without incomplete snapshot',async kind=>{
    const round=kind==='snapshot'?15:kind==='terminal'?16:kind==='zero affected'?17:18;
    let injected=false;
    const proxy=instrument(tx=>({...tx,
      fantasyPontuacaoSnapshot:{...tx.fantasyPontuacaoSnapshot,create:async(args:any)=>{
        if(kind==='snapshot'&&!injected){injected=true;throw new Error('private');}return tx.fantasyPontuacaoSnapshot.create(args);
      }},fantasyPontuacaoColeta:{...tx.fantasyPontuacaoColeta,updateMany:async(args:any)=>{
        if(args.data.estado==='SUCESSO'&&!injected&&kind!=='snapshot'){
          injected=true;
          if(kind==='zero affected')return {count:0};
          if(kind==='terminal')throw new Error('private');
        }
        return tx.fantasyPontuacaoColeta.updateMany(args);
      }}}),undefined,call=>{if(kind==='commit'&&call===2)throw new Error('private commit failure');});
    const row=await new ObservationService(proxy,source(round)).collect(season,round);
    expect(row.estado).toBe('RESPOSTA_INVALIDA');expect(row.erroCodigo).not.toBe('OBSERVATION_PERSISTENCE_FAILED');
    if(kind==='commit')expect(row.erroCodigo).toBe('DB_COMMIT_FAILED');
    await expectRollback(round);
  });
  it('keeps success after lost commit acknowledgement and terminal retry makes no HTTP',async()=>{
    const proxy=instrument(tx=>tx,call=>{if(call===2)throw new Error('lost commit acknowledgement');});
    const op=randomUUID();const row=await new ObservationService(proxy,source(19)).collect(season,19,op);
    expect(row.estado).toBe('SUCESSO');
    const before=await db.fantasyPontuacaoColeta.findUniqueOrThrow({where:{operacaoId:op}});
    await new ObservationService(db as PrismaService,{get:()=>{throw new Error('unexpected network');}}).collect(season,19,op);
    expect(await db.fantasyPontuacaoColeta.findUniqueOrThrow({where:{operacaoId:op}})).toEqual(before);
  });
  it('serializes simultaneous lease acquisitions and permits later reuse',async()=>{
    const results=await Promise.all([service(20).collect(season,20),service(20).collect(season,20)]);
    expect(results.some(r=>r.estado==='SUCESSO')).toBe(true);
    const next=await service(20).collect(season,20);expect(next.versao).toBe(1);expect(next.snapshotCriadoNestaColeta).toBe(false);
  });
  it('persists multiple athlete records faithfully',async()=>{
    const row=await new ObservationService(db as PrismaService,multiSource(21)).collect(season,21);
    expect(row).toMatchObject({estado:'SUCESSO',atletas:201});
    const athletes=await db.fantasyPontuacaoAtletaSnapshot.findMany({where:{snapshotId:row.snapshotId!},orderBy:{atletaIdCartola:'asc'}});
    expect(athletes[0].posicaoId).toBe(6);expect(athletes[1].pontuacao?.toFixed()).toBe('-1');expect(athletes[200].scouts).toEqual({FC:'200'});
  });
  it('market change prevents snapshot creation',async()=>{
    let statuses=0;
    const s=source(22,undefined,p=>p==='/mercado/status'?Promise.resolve(response(p,JSON.stringify({temporada:season,rodada_atual:22,status_mercado:++statuses===1?2:1}))):undefined);
    expect((await new ObservationService(db as PrismaService,s).collect(season,22)).estado).toBe('IDENTIDADE_PENDENTE');
    await expectRollback(22);
  });
  const conflict = (code: 'P2010' | 'P2034', mysql = '1213') => new Prisma.PrismaClientKnownRequestError('private database diagnostic', {
    code, clientVersion: Prisma.prismaVersion.client, meta: code === 'P2010' ? { code: mysql } : undefined,
  });
  it.each(['P2010','P2034'] as const)('retries the whole acquisition after %s without duplicate operation or HTTP',async code=>{
    const round=code==='P2010'?23:24;let attempts=0;
    const proxy=instrument(tx=>({...tx,$executeRaw:async(...args:any[])=>{
      const value=await tx.$executeRaw(...args);
      if(Array.isArray(args[0])&&args[0].join('?').includes('INSERT INTO FANTASY_APURACAO_RODADA')&&++attempts===1)throw conflict(code);
      return value;
    }}));
    const s=source(round);const http=jest.spyOn(s,'get');const op=randomUUID();
    const row=await new ObservationService(proxy,s).collect(season,round,op);
    expect(row).toMatchObject({estado:'SUCESSO',versao:1});expect(attempts).toBe(2);expect(http).toHaveBeenCalledTimes(4);
    expect(await db.fantasyPontuacaoColeta.count({where:{operacaoId:op}})).toBe(1);
  });
  it.each(['P2010','P2034'] as const)('rolls back both batches and retries persistence after %s without repeating HTTP',async code=>{
    const round=code==='P2010'?25:26;let batches=0;
    const proxy=instrument(tx=>({...tx,fantasyPontuacaoAtletaSnapshot:{...tx.fantasyPontuacaoAtletaSnapshot,createMany:async(args:any)=>{
      const value=await tx.fantasyPontuacaoAtletaSnapshot.createMany(args);
      if(++batches===2)throw conflict(code);
      return value;
    }}}));
    const s=multiSource(round);const http=jest.spyOn(s,'get');const op=randomUUID();
    const row=await new ObservationService(proxy,s).collect(season,round,op);
    expect(row).toMatchObject({estado:'SUCESSO',versao:1,atletas:201});expect(batches).toBe(5);
    expect(http).toHaveBeenCalledTimes(4);
    const r=await db.fantasyApuracaoRodada.findUniqueOrThrow({where:{temporada_rodada:{temporada:season,rodada:round}}});
    expect(r.ultimaVersaoSnapshot).toBe(1);expect(r.fence).toBe(1n);
    expect(await db.fantasyPontuacaoSnapshot.count({where:{rodadaId:r.id}})).toBe(1);
    expect(await db.fantasyPontuacaoColeta.count({where:{rodadaId:r.id}})).toBe(1);
    expect(await db.fantasyPontuacaoAtletaSnapshot.count({where:{snapshotId:row.snapshotId!}})).toBe(201);
    expect(await db.fantasyPontuacaoAtleta.count({where:{apuracaoId:r.id}})).toBe(0);
    await new ObservationService(db as PrismaService,{get:()=>{throw new Error('UUID retry must not use HTTP');}}).collect(season,round,op);
    expect(await db.fantasyPontuacaoColeta.count({where:{operacaoId:op}})).toBe(1);
  });
  it('exhausts four deadlocked persistence attempts, rolls back every write and retains failure evidence',async()=>{
    let attempts=0;
    const proxy=instrument(tx=>({...tx,fantasyPontuacaoAtletaSnapshot:{...tx.fantasyPontuacaoAtletaSnapshot,createMany:async(args:any)=>{
      await tx.fantasyPontuacaoAtletaSnapshot.createMany(args);attempts++;throw conflict('P2010');
    }}}));
    const s=multiSource(27);const http=jest.spyOn(s,'get');const op=randomUUID();
    const row=await new ObservationService(proxy,s).collect(season,27,op);
    expect(attempts).toBe(4);expect(http).toHaveBeenCalledTimes(4);
    expect(row).toMatchObject({estado:'RESPOSTA_INVALIDA',snapshotId:null,erroCodigo:'DB_TRANSACTION_CONFLICT_ATHLETE_BATCH'});
    await expectRollback(27);
    expect(await db.fantasyPontuacaoColeta.count({where:{operacaoId:op}})).toBe(1);
    expect((await db.fantasyPontuacaoColeta.findUniqueOrThrow({where:{operacaoId:op}})).payloadRecebido).toContain('atletas');
  });
  it('does not retry P2010 syntax failures or hide their rollback',async()=>{
    let attempts=0;
    const proxy=instrument(tx=>({...tx,fantasyPontuacaoAtletaSnapshot:{...tx.fantasyPontuacaoAtletaSnapshot,createMany:async(args:any)=>{
      await tx.fantasyPontuacaoAtletaSnapshot.createMany(args);attempts++;throw conflict('P2010','1064');
    }}}));
    const s=multiSource(28);const http=jest.spyOn(s,'get');
    expect(await new ObservationService(proxy,s).collect(season,28)).toMatchObject({estado:'RESPOSTA_INVALIDA',erroCodigo:'DB_ATHLETE_BATCH_FAILED'});
    expect(attempts).toBe(1);expect(http).toHaveBeenCalledTimes(4);await expectRollback(28);
  });
  it.each(['lease','fence'] as const)('rechecks %s after deadlock rollback and cannot publish under lost authorization',async kind=>{
    const round=kind==='lease'?29:30;let injected=false;
    const fault=instrument(tx=>({...tx,fantasyPontuacaoAtletaSnapshot:{...tx.fantasyPontuacaoAtletaSnapshot,createMany:async(args:any)=>{
      const value=await tx.fantasyPontuacaoAtletaSnapshot.createMany(args);
      if(!injected){injected=true;throw conflict('P2010');}return value;
    }}}));
    const proxy=new Proxy(fault,{get(target,key){
      if(key==='$transaction')return async(action:any,options:any)=>{
        try{return await target.$transaction(action,options);}
        catch(error){
          if(error instanceof Prisma.PrismaClientKnownRequestError&&error.code==='P2010'){
            // A different DB statement after rollback models another worker/time advancement.
            if(kind==='lease')await db.$executeRaw`UPDATE FANTASY_APURACAO_RODADA SET LOCK_ATE=DATE_SUB(UTC_TIMESTAMP(3),INTERVAL 1 SECOND) WHERE TEMPORADA=${season} AND RODADA=${round}`;
            else await db.$executeRaw`UPDATE FANTASY_APURACAO_RODADA SET FENCE=FENCE+1 WHERE TEMPORADA=${season} AND RODADA=${round}`;
          }
          throw error;
        }
      };
      return Reflect.get(target,key);
    }}) as PrismaService;
    const s=source(round);const http=jest.spyOn(s,'get');
    const row=await new ObservationService(proxy,s).collect(season,round);
    expect(row).toMatchObject({estado:'INTERROMPIDA',snapshotId:null,erroCodigo:'AUTHORIZATION_LOST'});
    expect(http).toHaveBeenCalledTimes(4);await expectRollback(round);
    const r=await db.fantasyApuracaoRodada.findUniqueOrThrow({where:{temporada_rodada:{temporada:season,rodada:round}}});
    expect(r.fence).toBe(kind==='lease'?1n:2n);
  });
  it('simultaneous calls with the same UUID share one operation and one HTTP observation',async()=>{
    const s=source(31);const http=jest.spyOn(s,'get');const op=randomUUID();const observer=new ObservationService(db as PrismaService,s);
    const rows=await Promise.all([observer.collect(season,31,op),observer.collect(season,31,op)]);
    expect(rows[0].coletaId).toBe(rows[1].coletaId);expect(rows.some(r=>r.estado==='SUCESSO')).toBe(true);
    expect(http).toHaveBeenCalledTimes(4);expect(await db.fantasyPontuacaoColeta.count({where:{operacaoId:op}})).toBe(1);
    const r=await db.fantasyApuracaoRodada.findUniqueOrThrow({where:{temporada_rodada:{temporada:season,rodada:31}}});
    expect(r.fence).toBe(1n);expect(r.ultimaVersaoSnapshot).toBe(1);
  });
  it('exhausts acquisition retries before HTTP and leaves no partial round or collection',async()=>{
    let attempts=0;const op=randomUUID();
    const proxy=instrument(tx=>({...tx,$executeRaw:async(...args:any[])=>{
      const result=await tx.$executeRaw(...args);
      if(Array.isArray(args[0])&&args[0].join('?').includes('INSERT INTO FANTASY_APURACAO_RODADA')){attempts++;throw conflict('P2010');}
      return result;
    }}));
    const s=source(32);const http=jest.spyOn(s,'get');
    await expect(new ObservationService(proxy,s).collect(season,32,op)).rejects.toThrow('DB_TRANSACTION_CONFLICT_LEASE_ACQUIRE');
    expect(attempts).toBe(4);expect(http).not.toHaveBeenCalled();
    expect(await db.fantasyApuracaoRodada.count({where:{temporada:season,rodada:32}})).toBe(0);
    expect(await db.fantasyPontuacaoColeta.count({where:{operacaoId:op}})).toBe(0);
  });
});
