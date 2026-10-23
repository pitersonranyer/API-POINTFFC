import { Prisma } from '@prisma/client';
import { assessCompleteness, resolveScoringSource } from '../src/point-fantasy/scoring/source-completeness';
import { scoreLineup } from '../src/point-fantasy/scoring/scoring-engine';
import { completeSource } from './point-fantasy-source.fixture';
import { preservedParticipation } from '../src/point-fantasy/scoring/cartola-evidence';

describe('3F preserved Cartola participation (memory only)', () => {
  let f: ReturnType<typeof completeSource>;
  beforeEach(() => { f = completeSource(); });
  const assess = () => { f.syncLegacy(); return preservedParticipation(f.round, assessCompleteness(f.round, f.collection, f.points), [f.legacy], f.matches); };
  it('infers generic absent catalog athletes only from completed, complete matching source', () => {
    expect(assess().assessment.eligible).toBe(true);
    const result = resolveScoringSource(undefined, f.athletes[0], 2n, assess());
    expect(result).toEqual({ points: '0', played: false, origin: 'NAO_PARTICIPACAO_INFERIDA_CARTOLA' });
  });
  it.each(['in-progress', 'incomplete', 'no-proof', 'season', 'round', 'hash', 'scope', 'truncated', 'duplicates'])('keeps absence pending: %s', reason => {
    if (reason === 'in-progress') f.legacyMatches.partidas[0].periodo_tr = 'PRIMEIRO_TEMPO';
    if (reason === 'incomplete') f.legacyPayload.total_atletas++;
    if (reason === 'no-proof') f.legacy.estado = 'FALHA_REDE';
    if (reason === 'season') f.legacy.statusAntes = { text: '{"temporada":2025}' };
    if (reason === 'round') f.legacyPayload.rodada = 32;
    if (reason === 'hash') f.round.hashConteudoAtual = 'e'.repeat(64);
    if (reason === 'scope') f.matches = [{ ...f.matches[0], partidaIdExterno: 11 }];
    if (reason === 'truncated') f.points.pop();
    if (reason === 'duplicates') f.legacyMatches.partidas.push({ ...f.legacyMatches.partidas[0] });
    const assessment = assess(); expect(assessment.assessment.eligible).toBe(false);
    expect(resolveScoringSource(undefined, f.athletes[0], 2n, assessment)).toMatchObject({ points: null, played: null });
  });
  it('preserves explicit official zero without inferring nonparticipation', () => {
    f.points[0].pontuacao = new Prisma.Decimal(0);
    const result = resolveScoringSource(f.points[0], f.athletes[0], 2n, assess());
    expect(result).toEqual({ points: '0', played: true, origin: 'REGISTRO_OFICIAL' });
  });
  it('never overwrites an existing official row with null points or wrong identity', () => {
    f.points[0].pontuacao = null;
    expect(resolveScoringSource(f.points[0], f.athletes[0], 2n, assess()).points).toBeNull();
    f.points[0].clubeIdCartola = 999;
    expect(resolveScoringSource(f.points[0], f.athletes[0], 2n, assess()).origin).toBe('IDENTIDADE_INCOMPATIVEL');
  });
  it('infers absence from a certified complete latest list while retaining the original old row', () => {
    f.points[0].presenteNaUltimaLista = false; f.rehash();
    expect(assess().assessment.eligible).toBe(true);
    expect(resolveScoringSource(f.points[0], f.athletes[0], 2n, assess())).toMatchObject({ points: '0', played: false });
    expect(f.points[0].pontuacao.toFixed()).toBe('1');
  });
  it('inferred absent captain gets a common replacement with 2x and source audit', () => {
    f.points.shift(); f.rehash();
    const assessment = assess(); expect(assessment.assessment.eligible).toBe(true);
    const players = f.athletes.map((a, i) => ({ id: a.id, position: a.posicaoId,
      role: i < 11 ? 'TITULAR' as const : i === 11 ? 'TECNICO' as const : 'RESERVA' as const,
      ...resolveScoringSource(f.points.find(p => p.atletaIdCartola === a.atletaIdExterno), a, 2n, assessment) }));
    const before = f.points.map(p => p.pontuacao.toFixed());
    const result = scoreLineup(players, 1, 13);
    expect(result.substitutions[0]).toMatchObject({ out: 1, in: 13, multiplier: 2, contribution: '2' });
    expect(result.total).toBe('13');
    expect(f.points.map(p => p.pontuacao.toFixed())).toEqual(before);
  });
  it('ignores unfinished matches outside the competition and needs no global certificate', () => {
    expect(f.legacyMatches.partidas[1].periodo_tr).toBe('PRE_JOGO');
    expect(f.collection.limitacoes.modalidade).toBe('PARCIAL');
    expect(assess().assessment).toMatchObject({ eligible: true, historical: { collectionId: 3, snapshotId: 1, matchIds: [10] } });
  });
  it('rejects tampered historical payload hash', () => {
    f.syncLegacy(); f.legacy.hashPayload = 'bad';
    const result = preservedParticipation(f.round, assessCompleteness(f.round, f.collection, f.points), [f.legacy], f.matches);
    expect(result.assessment.reasons).toContain('PRESERVED_PAYLOAD_HASH_MISMATCH');
  });
  it('does not infer absence for an existing historical athlete with unknown participation', () => {
    const historical = Object.values(f.legacyPayload.atletas)[0];
    delete (historical as any).entrou_em_campo;
    expect(resolveScoringSource(undefined, f.athletes[1], 2n, assess()).played).toBeNull();
  });
  it('does not infer absence when there are no scored athletes of the club', () => {
    for (const row of Object.values(f.legacyPayload.atletas)) row.clube_id = 999;
    expect(resolveScoringSource(undefined, f.athletes[0], 2n, assess()).played).toBeNull();
  });
  it('keeps current points and participation even when a historical score differs', () => {
    f.points[1].pontuacao = new Prisma.Decimal('19.123456789123456789');
    expect(resolveScoringSource(f.points[1], f.athletes[1], 2n, assess())).toMatchObject({
      points: '19.123456789123456789', played: true, origin: 'REGISTRO_OFICIAL',
    });
  });
  it('rejects historical athlete identity mismatch', () => {
    Object.values(f.legacyPayload.atletas)[0].clube_id = 999;
    expect(resolveScoringSource(undefined, f.athletes[1], 2n, assess()).played).toBeNull();
  });
});
