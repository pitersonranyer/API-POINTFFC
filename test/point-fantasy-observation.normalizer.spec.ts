import { normalizeOfficial, ObservationError, parseOfficialJson } from '../src/point-fantasy/observation/official-normalizer';

const wrap = (athletes: string) => `{"rodada":31,"atletas":{${athletes}}}`;
describe('official observation normalization', () => {
  it.each(['12.4', '0', '-1.3', '8.030000000000001', '0.000000000000000001'])('preserves exact numeric token %s', token => {
    const a = normalizeOfficial(wrap(`"1":{"pontuacao":${token}}`), 2026, 31).athletes[0];
    expect(a.pontuacaoTokenOriginal).toBe(token);
    expect(a.pontuacao?.equals(token)).toBe(true);
  });
  it('distinguishes null/absent/zero, scouts and observed participation without final inference', () => {
    const rows = normalizeOfficial(wrap('"1":{},"2":{"pontuacao":null,"scout":null,"entrou_em_campo":null},"3":{"pontuacao":0,"scout":{},"entrou_em_campo":false},"4":{"posicao_id":6,"pontuacao":8.030000000000001,"entrou_em_campo":true}'),2026,31).athletes;
    expect(rows.map(a=>a.estadoPontuacao)).toEqual(['AUSENTE','NULO','VALOR','VALOR']);
    expect(rows.map(a=>a.estadoScouts)).toEqual(['AUSENTE','NULO','VALOR','AUSENTE']);
    expect(rows[2].participacaoObservada).toBe('INFORMADA_FALSE');
    expect(rows[3].posicaoId).toBe(6);
    expect(rows.map(a=>a.atletaIdCartola)).not.toContain(5);
  });
  it.each(['100000000000000000000','0.0000000000000000001','1e1000'])('rejects decimal overflow without truncation %s',token=>{
    expect(()=>normalizeOfficial(wrap(`"1":{"pontuacao":${token}}`),2026,31)).toThrow(ObservationError);
  });
  it.each(['0','-1','01','4294967296','1.5'])('rejects invalid ID %s',id=>{
    expect(()=>normalizeOfficial(wrap(`"${id}":{}`),2026,31)).toThrow();
  });
  it.each(['{"a":1,"a":2}','{"a":{"x":1,"x":2}}','{"a":1,"\\u0061":2}','{"a":NaN}','{"a":1,}','[1,]','{"a":01}','{} trailing'])('rejects ambiguous/invalid JSON %s',text=>expect(()=>parseOfficialJson(text)).toThrow());
  it('rejects mismatched round, season, count and invalid values',()=>{
    for(const text of ['{"rodada":30,"atletas":{}}','{"rodada":31,"temporada":2025,"atletas":{}}','{"rodada":31,"total_atletas":2,"atletas":{}}',wrap('"1":{"entrou_em_campo":1}'),wrap('"1":{"pontuacao":"1.2"}')])expect(()=>normalizeOfficial(text,2026,31)).toThrow();
  });
});
describe('official semantic hash',()=>{
  const hash=(rows:string, version?:string)=>normalizeOfficial(wrap(rows),2026,31,version).hashConteudo;
  const a='"2":{"scout":{"Z":1,"A":2},"pontuacao":1.20},"1":{}';
  it('ignores object order and equivalent numeric formatting',()=>expect(hash(a)).toBe(hash('"1":{},"2":{"pontuacao":1.2,"scout":{"A":2,"Z":1}}')));
  it.each(['"1":{}','"1":{},"2":{"pontuacao":2}','"1":{},"2":{"entrou_em_campo":false}','"1":{},"2":{"scout":{"A":3,"Z":1},"pontuacao":1.2}'])('detects changes/removals %s',b=>expect(hash(a)).not.toBe(hash(b)));
  it('includes normalizer and source identity',()=>expect(hash(a)).not.toBe(hash(a,'v2')));
  it('distinguishes null, absent, zero and empty scouts',()=>{
    const hashes=['{}','{"pontuacao":null}','{"pontuacao":0}','{"scout":null}','{"scout":{}}'].map(x=>hash(`"1":${x}`));
    expect(new Set(hashes).size).toBe(hashes.length);
  });
  it('A → B → A restores the same hash',()=>{expect(hash(a)).not.toBe(hash('"1":{}'));expect(hash(a)).toBe(hash(a));});
});
