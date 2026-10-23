import { FantasyPontuacaoAtleta } from '@prisma/client';
import { changeEvidence, currentScoringPlan } from '../src/point-fantasy/observation/current-scoring-plan';
import { certificateError, CertifiedScoringObservation, ScoringPolicyInput, suspiciousCache } from '../src/point-fantasy/observation/current-scoring-policy';
import { normalizeOfficial } from '../src/point-fantasy/observation/official-normalizer';
import { CurrentScoringService } from '../src/point-fantasy/observation/current-scoring.service';
import { PrismaService } from '../src/prisma/prisma.service';
import { ObservationSource } from '../src/point-fantasy/observation/observation-source';

describe('isolated current writer execution guards',()=>{
  const url='mysql://test:test@127.0.0.1/point_fantasy_observation_3b2_test_123';
  it('rejects production even with an isolated URL and an injected evidence policy',()=>{
    const previous=process.env.NODE_ENV;
    try {
      process.env.NODE_ENV='production';
      const certify=jest.fn();
      expect(()=>new CurrentScoringService({} as PrismaService,{} as ObservationSource,url,{certify}))
        .toThrow('ISOLATED_CURRENT_WRITER_REQUIRED');
      expect(certify).not.toHaveBeenCalled();
    } finally {
      if(previous===undefined) delete process.env.NODE_ENV; else process.env.NODE_ENV=previous;
    }
  });
  it('checks the actual connected schema before transaction, HTTP or evidence evaluation',async()=>{
    const db={ $queryRaw:jest.fn().mockResolvedValue([{name:'fantasy_point_do_jogador'}]),$transaction:jest.fn() };
    const source={get:jest.fn()};
    const certify=jest.fn();
    const service=new CurrentScoringService(db as unknown as PrismaService,source as unknown as ObservationSource,url,{certify});
    await expect(service.collect(2026,31)).rejects.toThrow('ISOLATED_CURRENT_WRITER_REQUIRED');
    expect(db.$transaction).not.toHaveBeenCalled();
    expect(source.get).not.toHaveBeenCalled();
    expect(certify).not.toHaveBeenCalled();
  });
});

const normalize = (rows: string) => normalizeOfficial(`{"rodada":31,"atletas":{${rows}}}`,2026,31);
function existing(rows: string): FantasyPontuacaoAtleta[] {
  return normalize(rows).athletes.map(a=>{const {canonical,...content}=a;void canonical;return {...content,temporada:2026,rodada:31,
    apuracaoId:1,coletaAlteracaoId:1,revisaoAlteracao:1n,criadoEm:new Date(0),alteradoEm:new Date(0),
    presenteNaUltimaLista:true,versaoNormalizador:'cartola-observation-v1'};});
}
describe('differential scoring plan',()=>{
  it('ignores semantic numeric/scout formatting and preserves unchanged original rows',()=>{
    const old=existing('"1":{"pontuacao":1.20,"scout":{"Z":1,"A":2}}');
    expect(currentScoringPlan(old,normalize('"1":{"pontuacao":1.2,"scout":{"A":2.0,"Z":1}}'),2026,31).changes).toEqual([]);
    expect(old[0].pontuacaoTokenOriginal).toBe('1.20');expect(old[0].alteradoEm.getTime()).toBe(0);
  });
  it('audits exact decimals, zero, negative, null and absent with their field states',()=>{
    const old=existing('"1":{"pontuacao":0}');
    for(const text of ['"1":{"pontuacao":8.030000000000001}','"1":{"pontuacao":-1.3}','"1":{"pontuacao":null}','"1":{}']){
      const plan=currentScoringPlan(old,normalize(text),2026,31);
      const delta=changeEvidence(plan.changes[0],2n);
      expect(delta.revisao).toBe('2');expect(delta.antes).toMatchObject({pontuacao:'0',estadoPontuacao:'VALOR'});
      expect(delta.depois).toHaveProperty('estadoPontuacao');
      expect(JSON.stringify(delta)).not.toContain('apelido');
    }
    const delta=changeEvidence(currentScoringPlan(old,normalize('"1":{"pontuacao":8.030000000000001}'),2026,31).changes[0],2n);
    expect(delta.depois).toMatchObject({pontuacao:'8.030000000000001',pontuacaoTokenOriginal:'8.030000000000001'});
  });
  it('plans omissions separately from points/participation and recognizes reappearance',()=>{
    const old=existing('"1":{"pontuacao":-1.3,"entrou_em_campo":false}');
    const omission=currentScoringPlan(old,normalize(''),2026,31);
    expect(omission.omitted).toBe(1);expect(omission.changes[0].after.pontuacao?.toFixed()).toBe('-1.3');
    expect(changeEvidence(omission.changes[0],2n).depois).toEqual({presenteNaUltimaLista:false});
    expect(currentScoringPlan([{...old[0],presenteNaUltimaLista:false}],normalize('"1":{"pontuacao":-1.3,"entrou_em_campo":false}'),2026,31).changes[0].type).toBe('REAPARECIMENTO');
  });
  it('includes technicians and only changed IDs in deltas',()=>{
    const old=existing('"1":{"pontuacao":0},"2":{}');
    const plan=currentScoringPlan(old,normalize('"1":{"pontuacao":1},"2":{},"3":{"posicao_id":6}'),2026,31);
    expect(plan.changes.map(c=>c.after.atletaIdCartola)).toEqual([1,3]);expect(plan.inserted).toBe(1);expect(plan.updated).toBe(1);
  });
  it('changes effective hash for presence/season and restores A hash after B',()=>{
    const a=normalize('"1":{"pontuacao":0}'),b=normalize('"1":{"pontuacao":1}');
    const hash=currentScoringPlan([],a,2026,31).hash;
    expect(currentScoringPlan(existing('"1":{"pontuacao":1}'),a,2026,31).hash).toBe(hash);
    expect(currentScoringPlan(existing('"1":{"pontuacao":0}'),b,2026,31).hash).not.toBe(hash);
    expect(currentScoringPlan(existing('"1":{"pontuacao":0}'),normalize(''),2026,31).hash).not.toBe(hash);
    expect(currentScoringPlan([],a,2025,31).hash).not.toBe(hash);
  });
});

describe('conservative source-evidence policy',()=>{
  const input:ScoringPolicyInput={temporada:2026,rodada:31,payloadHash:'h',baseHash:'b',revision:1n,
    points:{endpoint:'/atletas/pontuados',status:200,text:'{}',receivedAt:'2026-10-20T12:00:00Z',headers:{},error:null}};
  const proof:CertifiedScoringObservation={policyVersion:'fixture-only-v1',temporada:2026,rodada:31,payloadHash:'h',baseHash:'b',
    complete:true,order:{stream:'fixture',sequence:2n},supersedesUnorderedBase:true,correctionApproved:false};
  it('does not turn missing evidence, count or HTTP time into permission',()=>{
    expect(certificateError(null,input,null,false)).toBe('OFFICIAL_EVIDENCE_UNAVAILABLE');
    expect(certificateError({...proof,complete:false},input,null,false)).toBe('COMPLETENESS_UNPROVEN');
    expect(certificateError({...proof,supersedesUnorderedBase:false},input,null,false)).toBe('BASE_ORDER_UNPROVEN');
  });
  it.each([{temporada:2025},{rodada:30},{payloadHash:'different'},{baseHash:'different'}])('binds proof to identity, payload and current base %#',override=>{
    expect(certificateError({...proof,...override},input,null,false)).toBe('INVALID_SOURCE_CERTIFICATE');
  });
  it('requires a strictly increasing source order for changes and explicit corrections',()=>{
    expect(certificateError(proof,input,{stream:'fixture',sequence:2n},false)).toBe('SOURCE_ORDER_NOT_NEWER');
    expect(certificateError(proof,input,{stream:'other',sequence:1n},false)).toBe('SOURCE_ORDER_STREAM_CHANGED');
    expect(certificateError(proof,input,null,true)).toBe('CORRECTION_NOT_CERTIFIED');
    expect(certificateError({...proof,correctionApproved:true},input,{stream:'fixture',sequence:1n},true)).toBeNull();
  });
  it.each(['1','180','bad','-1'])('blocks cached/invalid Age %s as a negative signal',age=>{
    expect(suspiciousCache({...input.points,headers:{age}})).toBe('CACHED_OR_INVALID_AGE');
  });
  it('rejects invalid/future dates but does not certify fresh-looking HTTP metadata',()=>{
    expect(suspiciousCache({...input.points,headers:{date:'bad'}})).toBe('INVALID_SOURCE_DATE');
    expect(suspiciousCache({...input.points,headers:{date:'Wed, 21 Oct 2026 12:00:00 GMT'}})).toBe('INVALID_SOURCE_DATE');
    expect(suspiciousCache({...input.points,headers:{age:'0',date:'Tue, 20 Oct 2026 12:00:00 GMT'}})).toBeNull();
    expect(certificateError(null,input,null,false)).toBe('OFFICIAL_EVIDENCE_UNAVAILABLE');
  });
});
