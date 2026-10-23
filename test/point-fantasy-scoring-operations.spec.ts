import { Prisma } from '@prisma/client';
import { CurrentScoringService } from '../src/point-fantasy/observation/current-scoring.service';
import { partialScoringPolicy } from '../src/point-fantasy/observation/current-scoring-policy';
import { normalizeOfficial, sha256 } from '../src/point-fantasy/observation/official-normalizer';
import { currentScoringPlan } from '../src/point-fantasy/observation/current-scoring-plan';
import * as authorization from '../src/point-fantasy/observation/local-scoring-authorization';
import { PrismaService } from '../src/prisma/prisma.service';
import { ObservationSource } from '../src/point-fantasy/observation/observation-source';
describe('same differential writer: partials, administrative review and financial isolation',()=>{
  const text=(points:string,more='')=>`{"temporada":2026,"rodada":31,"atletas":{"1":{"pontuacao":${points},"posicao_id":4}${more}}}`;
  function fixture(validated=false,more=''){
    const original=normalizeOfficial(text('1',more),2026,31);
    const rows:any[]=original.athletes.map(a=>{const {canonical,...r}=a;void canonical;return {...r,presenteNaUltimaLista:true,versaoNormalizador:original.version,apuracaoId:1,temporada:2026,rodada:31,revisaoAlteracao:1n,coletaAlteracaoId:1,criadoEm:new Date(0),alteradoEm:new Date(0)};});
    const round:any={id:1,estado:validated?'VALIDADA':'OBSERVANDO',revisaoAtual:1n,revisaoValidada:validated?1n:null,hashConteudoAtual:currentScoringPlan([],original,2026,31,true).hash,ultimaColetaAplicadaId:null};
    const finance={balance:'150.00',payments:1};const beforeFinance=JSON.stringify(finance);
    const financialWrite=jest.fn(()=>{throw Error('financial write forbidden');});
    const tx:any={
      carteira:{update:financialWrite},recargaCarteira:{update:financialWrite},premiacaoCompeticao:{update:financialWrite},
      fantasyApuracaoRodada:{findUniqueOrThrow:async()=>round,update:jest.fn(async({data}:any)=>Object.assign(round,data))},
      fantasyPontuacaoAtleta:{findMany:async()=>rows,createMany:jest.fn(async({data}:any)=>{rows.push(...data);return {count:data.length};}),updateMany:jest.fn(async({where,data}:any)=>{const r=rows.find(a=>a.atletaIdCartola===where.atletaIdCartola&&a.revisaoAlteracao===where.revisaoAlteracao);if(!r)return {count:0};Object.assign(r,data);return {count:1};})},
      fantasyPontuacaoColeta:{findFirst:async()=>null,findUniqueOrThrow:async()=>({id:9,fence:4n})},$queryRaw:jest.fn().mockResolvedValue([]),
    };
    const service=new CurrentScoringService({} as PrismaService,{} as ObservationSource,'mysql://x:y@127.0.0.1/point_fantasy_observation_3b2_test_1',partialScoringPolicy);
    const apply=(payload:string,headers:Record<string,string>={})=>(service as any).persistCurrent(tx,{coletaId:9,rodadaId:1,temporada:2026,rodada:31,normalized:normalizeOfficial(payload,2026,31),limitations:[],stage:jest.fn(),
      points:{endpoint:'/atletas/pontuados',text:payload,receivedAt:new Date().toISOString(),status:200,error:null,headers},
      before:{endpoint:'/mercado/status',text:'{"temporada":2026,"rodada_atual":31,"status_mercado":1}',status:200,error:null,headers:{},receivedAt:new Date().toISOString()},
      after:{endpoint:'/mercado/status',text:'{"temporada":2026,"rodada_atual":31,"status_mercado":1}',status:200,error:null,headers:{},receivedAt:new Date().toISOString()},
      matches:{endpoint:'/partidas/31',text:'{}',status:200,error:null,headers:{},receivedAt:new Date().toISOString()}});
    return {round,rows,tx,apply,financialWrite,checkFinance:()=>expect(JSON.stringify(finance)).toBe(beforeFinance)};
  }
  afterEach(()=>jest.restoreAllMocks());
  it.each(['2.1','-1.5','0'])('corrects positive/negative/zero %s using the same writer',async points=>{
    const f=fixture();expect(await f.apply(text(points))).toMatchObject({accepted:true,collection:{qtdAlterados:1,revisaoResultante:2n}});
    expect(new Prisma.Decimal(f.rows[0].pontuacao).toFixed()).toBe(points);expect(f.round.revisaoAtual).toBe(2n);
    expect(await f.apply(text(points))).toMatchObject({collection:{resultadoAplicacao:'SEM_ALTERACAO',qtdAlterados:0,revisaoResultante:2n}});
    expect(f.financialWrite).not.toHaveBeenCalled();f.checkFinance();
  });
  it('preserves an omitted athlete and writes only the modified athlete',async()=>{
    const extra=',"2":{"pontuacao":0,"posicao_id":6},"3":{"pontuacao":-2,"posicao_id":3}',f=fixture(false,extra),before={...f.rows[2]};
    expect(await f.apply(text('2',',"2":{"pontuacao":0,"posicao_id":6}'))).toMatchObject({accepted:true,collection:{qtdAlterados:1,qtdOmitidos:0}});
    expect(f.rows[2]).toEqual(before);expect(f.rows).toHaveLength(3);f.checkFinance();
  });
  it('records a complete review candidate and never overwrites a validated revision automatically',async()=>{
    const f=fixture(true),before=JSON.stringify(f.rows,(_,v)=>typeof v==='bigint'?v.toString():v);
    const result=await f.apply(text('-2'));
    expect(result).toMatchObject({accepted:false,failure:'PARTIAL_VALIDATED_ROUND_BLOCKED',collection:{payloadRecebido:text('-2'),evidenciaEncerramento:{kind:'CONTROLLED_SCORING_REVIEW',baseRevision:'1',validatedRevision:'1'}}});
    expect(result.collection.alteracoes).toHaveLength(1);expect(JSON.stringify(f.rows,(_,v)=>typeof v==='bigint'?v.toString():v)).toBe(before);
    expect(f.round.revisaoAtual).toBe(1n);expect(f.financialWrite).not.toHaveBeenCalled();
  });
  it('applies only the explicitly approved candidate and marks EM_REVISAO without moving validated revision or payments',async()=>{
    const f=fixture(true),payload=text('0');
    jest.spyOn(authorization,'localScoringContext').mockReturnValue({operator:'fixture-admin',reason:'Reviewed official correction',review:{collectionId:42,payloadHash:sha256(payload),baseRevision:'1',baseHash:f.round.hashConteudoAtual,validatedRevision:'1'}} as any);
    const result=await f.apply(payload);
    expect(result).toMatchObject({accepted:true,collection:{revisaoResultante:2n,evidenciaEncerramento:{approvedReviewId:42,operator:'fixture-admin'}}});
    expect(f.round.estado).toBe('EM_REVISAO');expect(f.round.revisaoValidada).toBe(1n);expect(f.rows[0].pontuacao.toFixed()).toBe('0');
    expect(f.tx.$queryRaw.mock.calls.some((args:any[])=>args.includes(42))).toBe(true);expect(f.financialWrite).not.toHaveBeenCalled();f.checkFinance();
  });
  it.each(['hash','revision','validated'])('rejects stale administrative approval: %s',async kind=>{
    const f=fixture(true),payload=text('2');
    jest.spyOn(authorization,'localScoringContext').mockReturnValue({operator:'fixture',reason:'fixture',review:{collectionId:42,payloadHash:sha256(payload),baseRevision:kind==='revision'?'2':'1',baseHash:kind==='hash'?'0'.repeat(64):f.round.hashConteudoAtual,validatedRevision:kind==='validated'?'2':'1'}} as any);
    expect(await f.apply(payload)).toMatchObject({accepted:false,failure:'REVIEW_REFERENCE_CHANGED'});expect(f.round.revisaoAtual).toBe(1n);expect(f.tx.fantasyPontuacaoAtleta.updateMany).not.toHaveBeenCalled();
  });
  it('cache protection is still enforced for an administratively approved review',async()=>{
    const f=fixture(true),payload=text('2');jest.spyOn(authorization,'localScoringContext').mockReturnValue({operator:'fixture',reason:'fixture',review:{collectionId:42,payloadHash:sha256(payload),baseRevision:'1',baseHash:f.round.hashConteudoAtual,validatedRevision:'1'}} as any);
    expect(await f.apply(payload,{age:'180'})).toMatchObject({accepted:false,failure:'CACHED_OR_INVALID_AGE'});expect(f.round.revisaoAtual).toBe(1n);
  });
});
