import { Prisma, PrismaClient } from '@prisma/client';
import { randomUUID } from 'crypto';
import { CurrentScoringService } from '../src/point-fantasy/observation/current-scoring.service';
import { partialScoringPolicy, ScoringEvidencePolicy } from '../src/point-fantasy/observation/current-scoring-policy';
import { ObservationService } from '../src/point-fantasy/observation/observation.service';
import { ObservationSource, SourceResponse } from '../src/point-fantasy/observation/observation-source';
import { PrismaService } from '../src/prisma/prisma.service';

const url=process.env.POINT_FANTASY_CURRENT_TEST_DATABASE_URL;
const integration=url?describe:describe.skip;
integration('differential scoring, isolated MySQL and fixture-only evidence',()=>{
  let db:PrismaClient,season=62000,roundNumber=0;
  const next=()=>++roundNumber;
  const initial='"1":{"pontuacao":1.2,"entrou_em_campo":true,"posicao_id":4}';
  // Deliberately test-only authority. These headers are NOT interpreted as proof by production code.
  const policy:ScoringEvidencePolicy={certify:input=>({policyVersion:'fixture-only-v1',temporada:input.temporada,rodada:input.rodada,
    payloadHash:input.payloadHash,baseHash:input.baseHash,complete:input.points.headers['x-fixture-complete']!=='false',
    order:{stream:`fixture-${input.temporada}-${input.rodada}`,sequence:BigInt(input.points.headers['x-fixture-sequence'])},
    supersedesUnorderedBase:true,correctionApproved:input.points.headers['x-fixture-correction']==='yes'})};
  function source(round:number,rows=initial,sequence=1,headers:Record<string,string>={},sourceSeason=season,
    override?: (endpoint:string,call:number)=>Promise<SourceResponse>|undefined):ObservationSource{
    let calls=0;const received=new Date(Date.UTC(2026,9,20,12,0,sequence)).toISOString();
    return {get:jest.fn(async endpoint=>{
      const special=override?.(endpoint,++calls);if(special)return special;
      return {endpoint,status:200,error:null,receivedAt:received,
        headers:{age:'0',date:new Date(received).toUTCString(),'x-fixture-sequence':String(sequence),...headers},
        text:endpoint==='/mercado/status'?JSON.stringify({temporada:sourceSeason,rodada_atual:round,status_mercado:2})
          :endpoint.startsWith('/partidas/')?JSON.stringify({rodada:round,partidas:[]})
            :`{"rodada":${round},"atletas":{${rows}}}`};
    })};
  }
  const observer=(s:ObservationSource,p:ScoringEvidencePolicy|typeof partialScoringPolicy|null=policy,client=db)=>new CurrentScoringService(client as PrismaService,s,url!,p??undefined);
  const collect=(round:number,rows=initial,sequence=1,headers:Record<string,string>={})=>observer(source(round,rows,sequence,headers)).collect(season,round);
  const apuracao=(round:number)=>db.fantasyApuracaoRodada.findUniqueOrThrow({where:{temporada_rodada:{temporada:season,rodada:round}}});
  const athletes=(round:number)=>db.fantasyPontuacaoAtleta.findMany({where:{temporada:season,rodada:round},orderBy:{atletaIdCartola:'asc'}});
  const audit=(id:number)=>db.fantasyPontuacaoColeta.findUniqueOrThrow({where:{id}});
  function instrument(wrap:(tx:any)=>any,afterCommit?:(call:number)=>void,afterRollback?:(error:unknown)=>Promise<void>):PrismaClient{
    let calls=0;
    return new Proxy(db,{get(target,key){
      if(key==='$transaction')return async(action:any,options:any)=>{
        const call=++calls;let result;
        try{result=await target.$transaction(async tx=>{const overrides=wrap(tx);
          return action(new Proxy(tx,{get(original,k){return k in overrides?Reflect.get(overrides,k):Reflect.get(original,k);}}));},options);}
        catch(error){await afterRollback?.(error);throw error;}
        afterCommit?.(call);return result;
      };
      return Reflect.get(target,key);
    }});
  }
  beforeAll(async()=>{
    const u=new URL(url!);if(u.hostname!=='127.0.0.1'||!/^\/point_fantasy_observation_3b2_test_\d+$/.test(u.pathname))throw Error('ISOLATED_REQUIRED');
    db=new PrismaClient({datasources:{db:{url}},log:[]});while(await db.fantasyApuracaoRodada.count({where:{temporada:season}}))season--;
  });
  afterAll(async()=>{await db?.$disconnect();});

  it('loads athletes and technicians into revision 1 without snapshots or raw payloads',async()=>{
    const round=next();const result=await collect(round,initial+',"2":{"posicao_id":6,"pontuacao":0}');
    expect(result).toMatchObject({estado:'SUCESSO',modeloPersistencia:'ATUAL',revisaoBase:'0',revisaoResultante:'1',inseridos:2,snapshotId:null});
    expect((await athletes(round))[1].posicaoId).toBe(6);
    const r=await apuracao(round);expect(r.estado).toBe('OBSERVANDO');expect(r.revisaoValidada).toBeNull();
    expect(await db.fantasyPontuacaoSnapshot.count({where:{rodadaId:r.id}})).toBe(0);
    const c=await audit(result.coletaId);expect(c.payloadRecebido).toBeNull();expect(c.statusAntes).not.toHaveProperty('text');
    expect(c.cabecalhos).not.toHaveProperty('x-fixture-sequence');expect(c.alteracoes).toHaveLength(2);
  });
  it('leaves identical rows, original tokens and revision untouched despite new HTTP query',async()=>{
    const round=next();await collect(round,'"1":{"pontuacao":1.20,"scout":{"Z":1,"A":2}}');
    const before=await athletes(round);const result=await collect(round,'"1":{"pontuacao":1.2,"scout":{"A":2.0,"Z":1}}',2);
    expect(result).toMatchObject({resultadoAplicacao:'SEM_ALTERACAO',revisaoBase:'1',revisaoResultante:'1',alterados:0});
    expect(await athletes(round)).toEqual(before);expect((await audit(result.coletaId)).alteracoes).toEqual([]);
  });
  it('changes one athlete only, then several athletes and inserts a new technician',async()=>{
    const round=next();await collect(round,initial+',"2":{"pontuacao":0}');const old=await athletes(round);
    const one=await collect(round,'"1":{"pontuacao":8.030000000000001},"2":{"pontuacao":0}',2);
    expect(one).toMatchObject({revisaoResultante:'2',alterados:1});expect((await athletes(round))[1]).toEqual(old[1]);
    const delta=(await audit(one.coletaId)).alteracoes as Prisma.JsonArray;
    expect(delta).toHaveLength(1);expect(delta[0]).toMatchObject({atletaIdCartola:1,revisao:'2',depois:{pontuacao:'8.030000000000001',estadoPontuacao:'VALOR'}});
    const many=await collect(round,'"1":{"pontuacao":-1.3},"2":{"pontuacao":1},"3":{"posicao_id":6}',3);
    expect(many).toMatchObject({revisaoResultante:'3',alterados:2,inseridos:1});expect((await athletes(round))[2].posicaoId).toBe(6);
  });
  it('preserves all numeric, participation and scout field states',async()=>{
    const round=next();await collect(round,'"1":{"pontuacao":0,"entrou_em_campo":false,"scout":{}},"2":{"pontuacao":-1.3,"entrou_em_campo":true,"scout":null},"3":{"pontuacao":null},"4":{},"5":{"pontuacao":8.030000000000001}');
    const a=await athletes(round);
    expect(a.map(r=>r.estadoPontuacao)).toEqual(['VALOR','VALOR','NULO','AUSENTE','VALOR']);
    expect(a.map(r=>r.participacaoObservada)).toEqual(['INFORMADA_FALSE','INFORMADA_TRUE','NAO_INFORMADA','NAO_INFORMADA','NAO_INFORMADA']);
    expect(a.slice(0,4).map(r=>r.estadoScouts)).toEqual(['VALOR','NULO','AUSENTE','AUSENTE']);
    expect(a.map(r=>r.pontuacao?.toFixed()??null)).toEqual(['0','-1.3',null,null,'8.030000000000001']);
    expect(a[4].pontuacaoTokenOriginal).toBe('8.030000000000001');expect(a[0].presenteNaUltimaLista).toBe(true);
  });
  it('accepts proven omission, preserves score/participation and accepts reappearance',async()=>{
    const round=next();const rows=initial+',"2":{"pontuacao":-1.3,"entrou_em_campo":false}';await collect(round,rows);
    const omitted=await collect(round,initial,2);expect(omitted).toMatchObject({omitidos:1,revisaoResultante:'2'});
    const a=(await athletes(round))[1];expect(a.presenteNaUltimaLista).toBe(false);expect(a.pontuacao?.toFixed()).toBe('-1.3');expect(a.entrouEmCampo).toBe(false);
    expect((await audit(omitted.coletaId)).alteracoes).toEqual([expect.objectContaining({tipo:'OMISSAO',depois:{presenteNaUltimaLista:false}})]);
    expect(await collect(round,rows,3)).toMatchObject({alterados:1,revisaoResultante:'3'});expect((await athletes(round))[1].presenteNaUltimaLista).toBe(true);
  });
  it('rejects unproven completeness without changing any row or marking omissions',async()=>{
    const round=next();await collect(round,initial+',"2":{}');const before=await athletes(round);
    const result=await collect(round,initial,2,{'x-fixture-complete':'false'});
    expect(result).toMatchObject({estado:'RESPOSTA_INVALIDA',erroCodigo:'COMPLETENESS_UNPROVEN',revisaoResultante:null});
    expect(await athletes(round)).toEqual(before);expect((await apuracao(round)).revisaoAtual).toBe(1n);
  });
  it('defaults to refusal of unproven mutation but can acknowledge a truly identical query',async()=>{
    const round=next();const first=await observer(source(round),null).collect(season,round);
    expect(first).toMatchObject({erroCodigo:'OFFICIAL_EVIDENCE_UNAVAILABLE'});expect(await athletes(round)).toEqual([]);
    await collect(round);const before=await athletes(round);
    expect(await observer(source(round),null).collect(season,round)).toMatchObject({resultadoAplicacao:'SEM_ALTERACAO'});
    expect(await observer(source(round,'"1":{"pontuacao":0}',2),null).collect(season,round)).toMatchObject({erroCodigo:'OFFICIAL_EVIDENCE_UNAVAILABLE'});
    expect(await athletes(round)).toEqual(before);
  });
  it('creates a new revision on certified A -> B -> A rather than reusing an old revision',async()=>{
    const round=next();await collect(round);const a=await apuracao(round);
    await collect(round,'"1":{"pontuacao":0}',2);
    const again=await collect(round,initial,3);expect(again).toMatchObject({revisaoBase:'2',revisaoResultante:'3'});
    expect((await apuracao(round)).hashConteudoAtual).toBe(a.hashConteudoAtual);
  });
  it('rejects old payload despite a newer valid fence and retains the highest certified order after repeated queries',async()=>{
    const round=next();await collect(round);await collect(round,'"1":{"pontuacao":0}',2);
    const result=await collect(round,initial,1);expect(result).toMatchObject({erroCodigo:'SOURCE_ORDER_NOT_NEWER'});
    expect((await apuracao(round)).revisaoAtual).toBe(2n);
    await collect(round,'"1":{"pontuacao":0}',4); // Same content, newer source order must advance the floor.
    await collect(round,'"1":{"pontuacao":0}',1); // Harmless old repetition must not lower it.
    expect(await collect(round,initial,3)).toMatchObject({erroCodigo:'SOURCE_ORDER_NOT_NEWER'});
  });
  it('rejects cache and source Date regression rather than treating receipt time as freshness',async()=>{
    const round=next();await collect(round);
    expect(await collect(round,'"1":{"pontuacao":0}',2,{age:'180'})).toMatchObject({erroCodigo:'CACHED_OR_INVALID_AGE'});
    expect(await collect(round,'"1":{"pontuacao":0}',3,{date:'Tue, 20 Oct 2026 11:00:00 GMT'})).toMatchObject({erroCodigo:'SOURCE_DATE_REGRESSION'});
    expect((await apuracao(round)).revisaoAtual).toBe(1n);
  });
  it('keeps changed-market and historical-season observations pending without changing scores',async()=>{
    const round=next();await collect(round);const before=await athletes(round);
    const changed=source(round,'"1":{"pontuacao":0}',2,{},season,(endpoint,call)=>endpoint==='/mercado/status'&&call===4
      ?Promise.resolve({endpoint,status:200,error:null,receivedAt:new Date().toISOString(),headers:{},text:JSON.stringify({temporada:season,rodada_atual:round,status_mercado:1})}):undefined);
    expect(await observer(changed).collect(season,round)).toMatchObject({estado:'IDENTIDADE_PENDENTE'});
    const historical=source(round+1,initial);expect(await observer(historical).collect(season,round)).toMatchObject({estado:'RESPOSTA_INVALIDA',erroCodigo:'ROUND_MISMATCH'});
    // Numbered route with matching round still has no historical season proof.
    const h=source(round+1,initial,1,{},season,(endpoint)=>endpoint.startsWith('/atletas/')?Promise.resolve({endpoint,status:200,error:null,
      headers:{},receivedAt:new Date().toISOString(),text:`{"rodada":${round},"atletas":{${initial}}}`}):undefined);
    expect(await observer(h).collect(season,round)).toMatchObject({estado:'IDENTIDADE_PENDENTE'});
    expect(await athletes(round)).toEqual(before);
  });
  it('rejects incompatible season and distinguishes two seasons with the same round and athlete',async()=>{
    const round=next();await collect(round);const otherSeason=season-1;const s=source(round,'"1":{"pontuacao":-2}',1,{},otherSeason);
    expect(await observer(s).collect(season,round)).toMatchObject({estado:'IDENTIDADE_PENDENTE'});
    expect(await observer(s).collect(otherSeason,round)).toMatchObject({estado:'SUCESSO',revisaoResultante:'1'});
    expect((await athletes(round))[0].pontuacao?.toFixed()).toBe('1.2');
    expect((await db.fantasyPontuacaoAtleta.findFirstOrThrow({where:{temporada:otherSeason,rodada:round}})).pontuacao?.toFixed()).toBe('-2');
  });
  it('requires explicit correction after VALIDADA, preserves validated revision and enters EM_REVISAO',async()=>{
    const round=next();const first=await collect(round);const r=await apuracao(round);
    // Test fixture only. No service path validates or closes a round.
    await db.fantasyApuracaoRodada.update({where:{id:r.id},data:{estado:'VALIDADA',revisaoValidada:1n,coletaValidacaoId:first.coletaId,validadaEm:new Date()}});
    expect(await collect(round,initial,2)).toMatchObject({resultadoAplicacao:'SEM_ALTERACAO',revisaoResultante:'1'});
    expect(await collect(round,'"1":{"pontuacao":0}',3)).toMatchObject({erroCodigo:'CORRECTION_NOT_CERTIFIED'});
    expect((await apuracao(round)).estado).toBe('VALIDADA');
    expect(await collect(round,'"1":{"pontuacao":0}',4,{'x-fixture-correction':'yes'})).toMatchObject({revisaoResultante:'2'});
    expect(await apuracao(round)).toMatchObject({estado:'EM_REVISAO',revisaoAtual:2n,revisaoValidada:1n,coletaValidacaoId:first.coletaId});
    expect(await collect(round,'"1":{"pontuacao":-1}',5)).toMatchObject({erroCodigo:'CORRECTION_NOT_CERTIFIED'});
  });
  it('reuses a UUID without HTTP and rejects reuse across persistence models',async()=>{
    const round=next(),op=randomUUID();const s=source(round);const first=await observer(s).collect(season,round,op);
    const noHttp:ObservationSource={get:()=>{throw Error('must not request');}};
    expect((await observer(noHttp).collect(season,round,op)).coletaId).toBe(first.coletaId);expect(s.get).toHaveBeenCalledTimes(4);
    await expect(new ObservationService(db as PrismaService,noHttp).collect(season,round,op)).rejects.toThrow('OPERATION_MODEL_CONFLICT');
  });
  it('serializes concurrent operations and applies a repeated UUID only once',async()=>{
    const round=next(),op=randomUUID();const s=source(round);const same=observer(s);
    const results=await Promise.all([same.collect(season,round,op),same.collect(season,round,op)]);
    expect(results[0].coletaId).toBe(results[1].coletaId);expect(s.get).toHaveBeenCalledTimes(4);
    expect(await db.fantasyPontuacaoColeta.count({where:{operacaoId:op}})).toBe(1);expect((await apuracao(round)).revisaoAtual).toBe(1n);
    const different=await Promise.all([collect(round,initial,2),collect(round,initial,2)]);
    expect(different.some(r=>r.estado==='SUCESSO')).toBe(true);expect((await apuracao(round)).revisaoAtual).toBe(1n);
  });
  it.each(['rollback','deadlock'] as const)('handles failure between athlete batches with %s and no HTTP repetition',async kind=>{
    const round=next();let batches=0;const rows=Array.from({length:201},(_,i)=>`"${i+1}":{"pontuacao":${i%2?'-1':'0'}}`).join(',');
    const client=instrument(tx=>({fantasyPontuacaoAtleta:{...tx.fantasyPontuacaoAtleta,createMany:async(args:any)=>{
      const result=await tx.fantasyPontuacaoAtleta.createMany(args);if(++batches===2){
        if(kind==='deadlock')throw new Prisma.PrismaClientKnownRequestError('private',{code:'P2010',clientVersion:Prisma.prismaVersion.client,meta:{code:'1213'}});
        throw Error('private database details');}return result;
    }}}));
    const s=source(round,rows);const result=await observer(s,policy,client).collect(season,round);
    expect(s.get).toHaveBeenCalledTimes(4);
    if(kind==='rollback'){
      expect(result).toMatchObject({estado:'RESPOSTA_INVALIDA',erroCodigo:'DB_CURRENT_WRITE_FAILED'});
      expect(await athletes(round)).toEqual([]);expect((await apuracao(round)).revisaoAtual).toBe(0n);
    }else{
      expect(result).toMatchObject({estado:'SUCESSO',revisaoResultante:'1',inseridos:201});expect(batches).toBe(5);
      expect(await athletes(round)).toHaveLength(201);expect((await apuracao(round)).revisaoAtual).toBe(1n);
    }
  });
  it.each(['lease','fence'] as const)('rolls back all current scoring when %s expires during finalization',async kind=>{
    const round=next();const client=instrument(tx=>({fantasyPontuacaoAtleta:{...tx.fantasyPontuacaoAtleta,createMany:async(args:any)=>{
      const result=await tx.fantasyPontuacaoAtleta.createMany(args);
      if(kind==='lease')await tx.$executeRaw`UPDATE FANTASY_APURACAO_RODADA SET LOCK_ATE=DATE_SUB(UTC_TIMESTAMP(3),INTERVAL 1 SECOND) WHERE TEMPORADA=${season} AND RODADA=${round}`;
      else await tx.$executeRaw`UPDATE FANTASY_APURACAO_RODADA SET FENCE=FENCE+1 WHERE TEMPORADA=${season} AND RODADA=${round}`;
      return result;
    }}}));
    expect(await observer(source(round),policy,client).collect(season,round)).toMatchObject({estado:'INTERROMPIDA',erroCodigo:'AUTHORIZATION_LOST'});
    expect(await athletes(round)).toEqual([]);expect((await apuracao(round)).revisaoAtual).toBe(0n);
  });
  it('retains committed current data when commit confirmation is lost',async()=>{
    const round=next(),op=randomUUID();const client=instrument(()=>({}),call=>{if(call===2)throw Error('lost commit confirmation');});
    const s=source(round);const result=await observer(s,policy,client).collect(season,round,op);
    expect(result).toMatchObject({estado:'SUCESSO',revisaoResultante:'1'});expect(await athletes(round)).toHaveLength(1);
    expect(await db.fantasyPontuacaoColeta.count({where:{operacaoId:op}})).toBe(1);expect(s.get).toHaveBeenCalledTimes(4);
  });
  it('rolls back already updated rows and their audit when a later update fails',async()=>{
    const round=next();await collect(round,initial+',"2":{"pontuacao":0}');const before=await athletes(round);let updates=0;
    const client=instrument(tx=>({fantasyPontuacaoAtleta:{...tx.fantasyPontuacaoAtleta,updateMany:async(args:any)=>{
      const result=await tx.fantasyPontuacaoAtleta.updateMany(args);if(++updates===2)throw Error('permanent failure');return result;
    }}}));
    const s=source(round,'"1":{"pontuacao":2},"2":{"pontuacao":-1}',2);
    const result=await observer(s,policy,client).collect(season,round);
    expect(result).toMatchObject({estado:'RESPOSTA_INVALIDA',erroCodigo:'DB_CURRENT_WRITE_FAILED'});
    expect(await athletes(round)).toEqual(before);expect((await apuracao(round)).revisaoAtual).toBe(1n);
    expect((await audit(result.coletaId)).alteracoes).toBeNull();expect(s.get).toHaveBeenCalledTimes(4);
  });
  it('never lets an expired delayed worker overwrite a newer revision',async()=>{
    const round=next();let release!:()=>void,entered!:()=>void;
    const gate=new Promise<void>(r=>{release=r;}),ready=new Promise<void>(r=>{entered=r;});
    const oldSource=source(round,initial,1,{},season,endpoint=>endpoint.startsWith('/atletas/')?(async()=>{entered();await gate;return {
      endpoint,status:200,error:null,headers:{age:'0','x-fixture-sequence':'1'},receivedAt:new Date().toISOString(),text:`{"rodada":${round},"atletas":{${initial}}}`};})():undefined);
    const old=observer(oldSource).collect(season,round);await ready;
    await db.$executeRaw`UPDATE FANTASY_APURACAO_RODADA SET LOCK_ATE=DATE_SUB(UTC_TIMESTAMP(3),INTERVAL 1 SECOND) WHERE TEMPORADA=${season} AND RODADA=${round}`;
    await collect(round,'"1":{"pontuacao":0}',2);release();expect(await old).toMatchObject({estado:'INTERROMPIDA'});
    expect((await athletes(round))[0].pontuacao?.toFixed()).toBe('0');expect((await apuracao(round)).revisaoAtual).toBe(1n);
  });
  it('blocks a legacy writer that advanced after current initialization',async()=>{
    const round=next();await collect(round);const before=await athletes(round);
    await new ObservationService(db as PrismaService,source(round,'"1":{"pontuacao":2}',2)).collect(season,round);
    expect(await collect(round,'"1":{"pontuacao":3}',3)).toMatchObject({erroCodigo:'LEGACY_WRITER_ADVANCED_BACKFILL_REQUIRED'});
    expect(await athletes(round)).toEqual(before);
  });
  it('records incomplete/invalid JSON and HTTP failures without current rows or raw secrets',async()=>{
    const round=next();const s=source(round,initial,1,{},season,endpoint=>endpoint.startsWith('/atletas/')?Promise.resolve({endpoint,
      status:500,error:'HTTP_500',headers:{authorization:'secret','set-cookie':'secret'},receivedAt:new Date().toISOString(),text:'{"secret":"not retained"}'}):undefined);
    const result=await observer(s).collect(season,round);expect(result).toMatchObject({estado:'FALHA_HTTP',erroCodigo:'HTTP_500'});
    const row=await audit(result.coletaId);expect(row.payloadRecebido).toBeNull();expect(JSON.stringify(row,(_,v)=>typeof v==='bigint'?v.toString():v)).not.toContain('not retained');
    expect(JSON.stringify(row.cabecalhos)).not.toContain('secret');expect(await athletes(round)).toEqual([]);
    const invalid=source(round,initial,1,{},season,endpoint=>endpoint.startsWith('/atletas/')?Promise.resolve({endpoint,status:200,error:null,
      headers:{},receivedAt:new Date().toISOString(),text:`{"rodada":${round},"atletas":`}):undefined);
    expect(await observer(invalid).collect(season,round)).toMatchObject({estado:'RESPOSTA_INVALIDA',erroCodigo:'INVALID_JSON'});
  });
  describe('PARCIAL operational policy without source certificates',()=>{
    beforeAll(async()=>{season--;while(await db.fantasyApuracaoRodada.count({where:{temporada:season}}))season--;roundNumber=0;});
    const partial=(round:number,rows=initial,sequence=1,headers:Record<string,string>={})=>observer(source(round,rows,sequence,headers),partialScoringPolicy).collect(season,round);
    it('loads exact source points, changes one/many, adds technicians and preserves identical rows',async()=>{
      const round=next();await partial(round,initial+',"2":{"pontuacao":0}');
      const first=await athletes(round);
      const one=await partial(round,initial.replace('1.2','-1.3')+',"2":{"pontuacao":0}',2);
      expect(one).toMatchObject({revisaoResultante:'2',alterados:1});
      expect((await athletes(round))[1]).toEqual(first[1]);
      const rows=initial.replace('1.2','8.030000000000001')+',"2":{"pontuacao":-2},"3":{"posicao_id":6,"pontuacao":0}';
      const many=await partial(round,rows,3);expect(many).toMatchObject({alterados:2,inseridos:1,revisaoResultante:'3'});
      expect((await athletes(round))[0].pontuacaoTokenOriginal).toBe('8.030000000000001');
      const before=await athletes(round);expect(await partial(round,rows,4)).toMatchObject({revisaoResultante:'3',alterados:0});
      expect(await athletes(round)).toEqual(before);
      const auditRow=await audit(many.coletaId);expect(auditRow.limitacoes).toMatchObject({modalidade:'PARCIAL',evidenciaFonte:null});
      expect(auditRow.alteracoes).toHaveLength(3);expect(auditRow.snapshotId).toBeNull();expect(auditRow.payloadRecebido).toBeNull();
      expect((await apuracao(round)).estado).toBe('OBSERVANDO');expect((await apuracao(round)).revisaoValidada).toBeNull();
    });
    it('retains omitted athletes and presence, records omission and allows reappearance',async()=>{
      const round=next(),rows=initial+',"2":{"pontuacao":0},"3":{"pontuacao":-2}';await partial(round,rows);
      const before=await athletes(round);const result=await partial(round,initial+',"2":{"pontuacao":1}',2);
      expect((await athletes(round))[2]).toEqual(before[2]);expect((await audit(result.coletaId)).limitacoes).toMatchObject({omitidosObservados:[3]});
      expect(result).toMatchObject({omitidos:0,revisaoResultante:'2'});
      expect(await partial(round,initial+',"2":{"pontuacao":1},"3":{"pontuacao":-3}',3)).toMatchObject({alterados:1,revisaoResultante:'3'});
    });
    it('preserves distinct initial null/absent states and refuses an empty initial list',async()=>{
      const empty=next();expect(await partial(empty,'')).toMatchObject({erroCodigo:'EMPTY_PARTIAL_LIST'});
      expect((await apuracao(empty)).revisaoAtual).toBe(0n);
      const round=next();await partial(round,'"1":{"pontuacao":null},"2":{},"3":{"pontuacao":0},"4":{"pontuacao":-1}');
      expect((await athletes(round)).map(a=>a.estadoPontuacao)).toEqual(['NULO','AUSENTE','VALOR','VALOR']);
      expect((await athletes(round)).map(a=>a.pontuacao?.toFixed()??null)).toEqual([null,null,'0','-1']);
    });
    it.each(['"1":{"pontuacao":1,"scout":{}}','"1":{"pontuacao":1,"scout":null}','"1":{"pontuacao":1}'])('retains lost scout data and records reasons %#',async rows=>{
      const round=next();await partial(round,'"1":{"pontuacao":1,"scout":{"G":1}}');const before=await athletes(round);
      const result=await partial(round,rows,2);expect(result).toMatchObject({erroCodigo:'INFORMED_FIELD_LOST'});
      expect(await athletes(round)).toEqual(before);expect((await audit(result.coletaId)).limitacoes).toMatchObject({retencoes:expect.any(Array)});
    });
    it.each(['{}','{"pontuacao":null}'])('retains all values and audits field loss %s',async replacement=>{
      const round=next();await partial(round);const before=await athletes(round);
      const result=await partial(round,'"1":'+replacement,2);expect(result).toMatchObject({erroCodigo:'INFORMED_FIELD_LOST'});
      expect(await athletes(round)).toEqual(before);expect((await apuracao(round)).revisaoAtual).toBe(1n);
      expect((await audit(result.coletaId)).limitacoes).toMatchObject({retencoes:expect.arrayContaining([expect.objectContaining({campo:'estadoPontuacao'})])});
    });
    it('rejects broad disappearance and repeated A after B without rejecting a new lower score',async()=>{
      const round=next();await partial(round);await partial(round,initial.replace('1.2','-2'),2);
      expect(await partial(round,initial,3)).toMatchObject({erroCodigo:'PREVIOUSLY_OBSERVED_CONTENT'});
      expect((await athletes(round))[0].pontuacao?.toFixed()).toBe('-2');
      expect(await partial(round,'',4)).toMatchObject({erroCodigo:'BROAD_ATHLETE_OMISSION'});
      expect((await apuracao(round)).revisaoAtual).toBe(2n);
    });
    it.each<Record<string,string>>([{age:'5'},{date:'bad'},{date:'Mon, 19 Oct 2026 12:00:00 GMT'}])('rejects suspicious cache even with a newer receipt %#',async headers=>{
      const round=next();await partial(round);const before=await athletes(round);
      expect((await partial(round,initial.replace('1.2','2'),2,headers)).estado).toBe('RESPOSTA_INVALIDA');expect(await athletes(round)).toEqual(before);
    });
    it('rejects identity, market transitions and declared count inconsistency',async()=>{
      for(const kind of ['identity','market','count']){
        const round=next();const s=source(round,initial,1,{},season,(endpoint,call)=>{
          if(kind==='identity'&&endpoint==='/mercado/status'||kind==='market'&&call===4)
            return Promise.resolve({endpoint,status:200,error:null,headers:{},receivedAt:new Date().toISOString(),text:JSON.stringify({temporada:kind==='identity'?season-1:season,rodada_atual:round,status_mercado:3})});
          if(kind==='count'&&endpoint==='/atletas/pontuados')return Promise.resolve({endpoint,status:200,error:null,headers:{},receivedAt:new Date().toISOString(),text:`{"rodada":${round},"total_atletas":2,"atletas":{${initial}}}`});
          return undefined;
        });
        expect((await observer(s,partialScoringPolicy).collect(season,round)).estado).not.toBe('SUCESSO');expect(await athletes(round)).toEqual([]);
      }
    });
    it('serializes concurrent UUIDs and never repeats HTTP for an existing operation',async()=>{
      const round=next(),op=randomUUID(),s=source(round),service=observer(s,partialScoringPolicy);
      const results=await Promise.all([service.collect(season,round,op),service.collect(season,round,op)]);
      expect(results[0].coletaId).toBe(results[1].coletaId);expect(s.get).toHaveBeenCalledTimes(4);
      await service.collect(season,round,op);expect(s.get).toHaveBeenCalledTimes(4);
      await Promise.all([partial(round,initial,2),partial(round,initial,2)]);expect((await apuracao(round)).revisaoAtual).toBe(1n);
    });
    it.each(['rollback','deadlock','lease','fence'])('preserves atomic partial writes with %s',async kind=>{
      const round=next();let attempts=0;
      const client=instrument(tx=>({fantasyPontuacaoAtleta:{...tx.fantasyPontuacaoAtleta,createMany:async(args:any)=>{
        const result=await tx.fantasyPontuacaoAtleta.createMany(args);attempts++;
        if(kind==='rollback')throw Error('permanent');
        if(kind==='deadlock'&&attempts===1)throw new Prisma.PrismaClientKnownRequestError('deadlock',{code:'P2010',clientVersion:Prisma.prismaVersion.client,meta:{code:'1213'}});
        if(kind==='lease')await tx.$executeRaw`UPDATE FANTASY_APURACAO_RODADA SET LOCK_ATE=DATE_SUB(UTC_TIMESTAMP(3),INTERVAL 1 SECOND) WHERE TEMPORADA=${season} AND RODADA=${round}`;
        if(kind==='fence')await tx.$executeRaw`UPDATE FANTASY_APURACAO_RODADA SET FENCE=FENCE+1 WHERE TEMPORADA=${season} AND RODADA=${round}`;
        return result;
      }}}));
      const s=source(round);const result=await observer(s,partialScoringPolicy,client).collect(season,round);expect(s.get).toHaveBeenCalledTimes(4);
      if(kind==='deadlock'){
        expect(result).toMatchObject({estado:'SUCESSO',revisaoResultante:'1'});expect(attempts).toBe(2);expect(await athletes(round)).toHaveLength(1);
        expect((await audit(result.coletaId)).alteracoes).toHaveLength(1);
      }else{expect(result.estado).not.toBe('SUCESSO');expect(await athletes(round)).toEqual([]);expect((await apuracao(round)).revisaoAtual).toBe(0n);}
    });
    it.each(['VALIDADA','EM_REVISAO'] as const)('cannot change previously validated points in %s',async state=>{
      const round=next();const first=await partial(round);await db.fantasyApuracaoRodada.update({where:{temporada_rodada:{temporada:season,rodada:round}},data:{estado:state,revisaoValidada:1n,validadaEm:new Date(),coletaValidacaoId:first.coletaId}});
      const before=await athletes(round);expect(await partial(round,initial.replace('1.2','3'),2)).toMatchObject({erroCodigo:'PARTIAL_VALIDATED_ROUND_BLOCKED'});
      expect(await athletes(round)).toEqual(before);expect((await apuracao(round)).estado).toBe(state);expect((await apuracao(round)).revisaoAtual).toBe(1n);
    });
  });
  it('refuses the principal or remote URLs before any request',()=>{
    const s=source(1);expect(()=>new CurrentScoringService(db as PrismaService,s,'mysql://test:test@127.0.0.1/fantasy_point_do_jogador')).toThrow('ISOLATED_CURRENT_WRITER_REQUIRED');
    expect(()=>new CurrentScoringService(db as PrismaService,s,'mysql://test:test@remote/point_fantasy_observation_3b2_test_1')).toThrow();expect(s.get).not.toHaveBeenCalled();
  });
});
