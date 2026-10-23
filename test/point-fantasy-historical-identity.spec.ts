import { randomUUID } from 'crypto';
import { PrismaService } from '../src/prisma/prisma.service';
import { CurrentScoringService } from '../src/point-fantasy/observation/current-scoring.service';
import { partialScoringPolicy } from '../src/point-fantasy/observation/current-scoring-policy';
import { SourceResponse } from '../src/point-fantasy/observation/observation-source';
import { normalizeOfficial } from '../src/point-fantasy/observation/official-normalizer';

// Exercise collect's normalization/identity/finalization with an entirely in-memory DB.
describe('historical current-writer identity, no database or real HTTP', () => {
  const url = 'mysql://fixture:fixture@127.0.0.1/point_fantasy_observation_3b2_test_1';
  const payload = (identity = '"temporada":2026,"rodada":31') => `{${identity},"atletas":{"1":{"pontuacao":2,"scout":{"DS":1}}}}`;
  function fixture(text: string, marketSeason = 2026, marketRound = 32, finalRound = marketRound, finalStatus = 1, requestedSeason = 2026, requestedRound = 31) {
    const scores = [{ atleta:1, points:'1.2', revision:1 }];
    const round = { id:1, fence:4n, revisaoAtual:1n };
    let collection: any, calls = 0;
    const query = jest.fn(async (parts: TemplateStringsArray) => {
      const sql = parts.join('?');
      if (sql.includes('information_schema.TABLES')) return [{ n:2n }];
      if (sql.includes('MODO,GERACAO')) return [{ MODO:'ATUAL',GERACAO:2n,ATUAL_JA_HABILITADO:true }];
      if (sql.includes(' AS name')) return [{ name:new URL(url).pathname.slice(1) }];
      if (sql.includes(' AS alive')) return [{ alive:1n }];
      if (sql.includes(' AS id')) return [{ id:1 }];
      return [{ ID:1 }];
    });
    const db: any = {
      $queryRaw:query,$executeRaw:jest.fn().mockResolvedValue(1),
      fantasyApuracaoRodada:{findUniqueOrThrow:jest.fn(async()=>round)},
      fantasyPontuacaoAtleta:{findFirst:jest.fn().mockResolvedValue(null)},
      fantasyPontuacaoColeta:{
        findMany:jest.fn().mockResolvedValue([]),
        findUnique:jest.fn(async()=>collection ?? null),
        create:jest.fn(async({data})=>{collection={id:1,...data,estado:'EM_ANDAMENTO',snapshotId:null};return collection;}),
        update:jest.fn(async({data})=>Object.assign(collection,data)),
        updateMany:jest.fn(async({where,data})=>{
          if(where.id?.not)return {count:0}; Object.assign(collection,data);return {count:1};
        }),
        findUniqueOrThrow:jest.fn(async()=>collection),
      },
    };
    db.$transaction=jest.fn(async(action: any)=>action(db));
    const source={get:jest.fn(async(endpoint: string):Promise<SourceResponse>=>{
      calls++;
      return {endpoint,status:200,error:null,headers:{},receivedAt:new Date().toISOString(),
        text:endpoint==='/mercado/status'?JSON.stringify({temporada:marketSeason,rodada_atual:calls===4?finalRound:marketRound,status_mercado:calls===4?finalStatus:1})
          :endpoint.startsWith('/partidas/')?'{}':text};
    })};
    const service=new CurrentScoringService(db as PrismaService,source,url,partialScoringPolicy);
    // This test isolates temporal authorization, not differential scoring rules.
    const persist=jest.spyOn(service as any,'persistCurrent').mockResolvedValue({accepted:true,collection:{resultadoAplicacao:'APLICADA'}});
    return {db,source,persist,scores,round,collect:()=>service.collect(requestedSeason,requestedRound,randomUUID())};
  }
  it('authorizes historical 2026/31 with explicit payload season/round while market is stable at 2026/32',async()=>{
    const f=fixture(payload());expect(await f.collect()).toMatchObject({estado:'SUCESSO'});
    expect(f.source.get).toHaveBeenNthCalledWith(2,'/atletas/pontuados/31');
    expect(f.persist).toHaveBeenCalledTimes(1);
    expect(f.persist.mock.calls[0][1]).toMatchObject({temporada:2026,rodada:31});
  });
  it.each([
    ['other round',payload('"temporada":2026,"rodada":30'),'ROUND_MISMATCH','RESPOSTA_INVALIDA'],
    ['other season',payload('"temporada":2025,"rodada":31'),'SEASON_MISMATCH','RESPOSTA_INVALIDA'],
    ['string season',payload('"temporada":"2026","rodada":31'),'INVALID_ID','RESPOSTA_INVALIDA'],
    ['duplicate season',payload('"temporada":2025,"temporada":2026,"rodada":31'),'DUPLICATE_JSON_KEY','RESPOSTA_INVALIDA'],
  ])('rejects %s and preserves existing scores/revision',async(_label,text,code,state)=>{
    const f=fixture(text),before=JSON.stringify({scores:f.scores,round:f.round},(_,v)=>typeof v==='bigint'?v.toString():v);
    expect(await f.collect()).toMatchObject({estado:state,erroCodigo:code,resultadoAplicacao:'REJEITADA'});
    expect(f.persist).not.toHaveBeenCalled();
    expect(JSON.stringify({scores:f.scores,round:f.round},(_,v)=>typeof v==='bigint'?v.toString():v)).toBe(before);
  });
  it.each([
    ['other market season',2025,32,32,1],['market round changed',2026,32,33,1],['market status changed',2026,32,32,2],['future round',2026,30,30,1],
  ] as const)('rejects %s even with explicit historical identity',async(_label,season,round,finalRound,status)=>{
    const f=fixture(payload(),season,round,finalRound,status);
    expect(await f.collect()).toMatchObject({estado:'IDENTIDADE_PENDENTE',erroCodigo:'SEASON_IDENTITY_UNPROVEN'});
    expect(f.persist).not.toHaveBeenCalled();
  });
  it('preserves current-round acceptance without a declared season when market proves the scope',async()=>{
    const f=fixture(payload('"rodada":31'),2026,31);
    expect(await f.collect()).toMatchObject({estado:'SUCESSO'});
    expect(f.source.get).toHaveBeenNthCalledWith(2,'/atletas/pontuados');
    expect(f.persist).toHaveBeenCalledTimes(1);
  });
  it('rejects another requested season even when the payload explicitly declares it',async()=>{
    const f=fixture(payload('"temporada":2025,"rodada":35'),2026,32,32,1,2025,35);
    expect(await f.collect()).toMatchObject({erroCodigo:'SEASON_IDENTITY_UNPROVEN',resultadoAplicacao:'REJEITADA'});
    expect(f.persist).not.toHaveBeenCalled();
  });
  it('accepts absent payload season under the approved current-season endpoint premise',async()=>{
    const f=fixture(payload('"rodada":31'));
    expect(await f.collect()).toMatchObject({estado:'SUCESSO'});expect(f.persist).toHaveBeenCalledTimes(1);
    const c=await f.db.fantasyPontuacaoColeta.findUniqueOrThrow();
    expect(c.evidenciasPartidas.historicalIdentity).toMatchObject({method:'POINT_FFC_CURRENT_SEASON_ENDPOINT_PREMISE',season:2026,round:31});
  });
  it('anchors season to an exact accepted official snapshot captured when round 31 was current',async()=>{
    const text=payload('"rodada":31'),f=fixture(text);
    const normalized=normalizeOfficial(text,2026,31);
    const proof={status:200,text:JSON.stringify({temporada:2026,rodada_atual:31,status_mercado:2})};
    f.db.fantasyPontuacaoColeta.findMany.mockResolvedValue([{id:7,snapshotId:3,snapshot:{hashConteudo:normalized.hashConteudo},statusAntes:proof,statusDepois:proof}]);
    expect(await f.collect()).toMatchObject({estado:'SUCESSO'});expect(f.persist).toHaveBeenCalledTimes(1);
  });
  it.each(['content','season','market'])('does not depend on historical snapshot equality: %s',async mismatch=>{
    const text=payload('"rodada":31'),f=fixture(text),normalized=normalizeOfficial(text,2026,31);
    const proof={status:200,text:JSON.stringify({temporada:mismatch==='season'?2025:2026,rodada_atual:mismatch==='market'?32:31,status_mercado:2})};
    f.db.fantasyPontuacaoColeta.findMany.mockResolvedValue([{id:7,snapshotId:3,snapshot:{hashConteudo:mismatch==='content'?'different':normalized.hashConteudo},statusAntes:proof,statusDepois:proof}]);
    expect(await f.collect()).toMatchObject({estado:'SUCESSO'});expect(f.persist).toHaveBeenCalledTimes(1);
    const c=await f.db.fantasyPontuacaoColeta.findUniqueOrThrow();
    expect(c.evidenciasPartidas.historicalIdentity.method).toBe('POINT_FFC_CURRENT_SEASON_ENDPOINT_PREMISE');
  });
});
