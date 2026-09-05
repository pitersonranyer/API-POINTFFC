import { Prisma } from '@prisma/client';
import { CartolaMatch, CartolaScoredAthlete } from '../src/cartola/cartola.types';
import { effectiveLineup, FrozenAthlete, FrozenTeam, matchEnded, matchStart, resolveReplacements, scoreMap, totalScore } from '../src/round-processing/round-calculator';

const athlete = (id: number, extra: Partial<FrozenAthlete> = {}): FrozenAthlete => ({
  atletaId: id, posicaoId: 5, clubeId: id, titular: true, reserva: false,
  capitao: false, preco: new Prisma.Decimal(10), nome: `Atleta ${id}`, ...extra,
});
const team = (escalacao: FrozenAthlete[], luxury: number | null = null): FrozenTeam => ({
  id: 1, capitaoId: escalacao.find((a) => a.capitao)?.atletaId ?? null, reservaLuxoId: luxury, escalacao,
});
const game = (id: number, extra: Partial<CartolaMatch> = {}): CartolaMatch => ({
  partida_id: id, clube_casa_id: id, clube_visitante_id: id + 100,
  valida: true, periodo_tr: 'F', timestamp: 1000, ...extra,
});
const reserve = athlete(3, { titular: false, reserva: true });
const matches = new Map([1, 2, 3].map((id) => [id, game(id)]));
const scores = (a: number, b: number, c: number, participation = true) => new Map<number, CartolaScoredAthlete>([
  [1, { pontuacao: a, entrou_em_campo: participation }], [2, { pontuacao: b, entrou_em_campo: true }],
  [3, { pontuacao: c, entrou_em_campo: true }],
]);

describe('Regras da escalação efetiva', () => {
  it.each([[10, 15], [-2, -3], [0, 0]])('aplica capitao %s -> %s e inclui tecnico uma vez', (raw, expected) => {
    const lineup = [athlete(1, { capitao: true }), athlete(2, { posicaoId: 6 })];
    expect(totalScore(lineup, scores(raw, 4, 99)).toNumber()).toBe(expected + 4);
  });
  it('nao soma reservas nem altera o snapshot', () => {
    const frozen = team([athlete(1), reserve]);
    expect(totalScore(effectiveLineup(frozen, []), scores(2, 0, 99)).toNumber()).toBe(2);
    expect(frozen.escalacao[1].titular).toBe(false);
  });
  it('ausencia do endpoint nao prova que nao jogou', () => {
    const points = scores(0, 0, 8); points.delete(1);
    const result = resolveReplacements(team([athlete(1), reserve]), points, matches);
    expect(result.replacements).toEqual([]); expect(result.pending.length).toBeGreaterThan(0);
  });
  it('nao troca titular que jogou pelo banco normal', () => {
    expect(resolveReplacements(team([athlete(1), reserve]), scores(1, 0, 8), matches).replacements).toEqual([]);
  });
  it('troca titular ausente e transfere braçadeira', () => {
    const frozen = team([athlete(1, { capitao: true }), reserve]);
    const points = scores(-1, 0, 8, false);
    const result = resolveReplacements(frozen, points, matches);
    expect(result.replacements).toEqual([{ atletaSaiuId: 1, atletaEntrouId: 3, posicaoId: 5 }]);
    expect(totalScore(effectiveLineup(frozen, result.replacements), points).toNumber()).toBe(12);
  });
  it.each([0, -2])('reserva normal com %s nao entra', (points) => {
    expect(resolveReplacements(team([athlete(1), reserve]), scores(0, 0, points, false), matches).replacements).toEqual([]);
  });
  it('reserva que nao jogou nao entra mesmo pontuado', () => {
    const points = scores(0, 0, 3, false); points.set(3, { pontuacao: 3, entrou_em_campo: false });
    expect(resolveReplacements(team([athlete(1), reserve]), points, matches).replacements).toEqual([]);
  });
  it.each(['1T', '2T', 'I', undefined])('aguarda partida no periodo %s', (periodo_tr) => {
    const ongoing = new Map(matches); ongoing.set(1, game(1, { periodo_tr }));
    expect(resolveReplacements(team([athlete(1), reserve]), scores(0, 0, 5, false), ongoing).replacements).toEqual([]);
  });
  it('luxo aceita negativos e compara antes do multiplicador', () => {
    const frozen = team([athlete(1, { capitao: true }), athlete(2), reserve], 3);
    const points = scores(-2, -2, -1);
    const result = resolveReplacements(frozen, points, matches);
    expect(result.replacements[0].atletaSaiuId).toBe(1);
    expect(totalScore(effectiveLineup(frozen, result.replacements), points).toNumber()).toBe(-3.5);
  });
  it('luxo nao entra com pontuacao igual', () => {
    expect(resolveReplacements(team([athlete(1), reserve], 3), scores(2, 0, 2), matches).replacements).toEqual([]);
  });
  it('luxo segue banco normal quando um titular nao joga', () => {
    const frozen = team([athlete(1), athlete(2), reserve], 3);
    expect(resolveReplacements(frozen, scores(-1, -2, 1, false), matches).replacements[0].atletaSaiuId).toBe(1);
    expect(resolveReplacements(frozen, scores(-1, -2, -0.5, false), matches).replacements).toEqual([]);
  });
  it('prioriza partida anterior, mesmo que outro ausente seja capitao', () => {
    const points = scores(0, 0, 5, false); points.set(2, { pontuacao: 0, entrou_em_campo: false });
    const dates = new Map(matches); dates.set(2, game(2, { timestamp: 2000 }));
    const frozen = team([athlete(1), athlete(2, { capitao: true }), reserve]);
    expect(resolveReplacements(frozen, points, dates).replacements[0].atletaSaiuId).toBe(1);
  });
  it('desempata por preco e nome e registra metadados insuficientes', () => {
    const frozen = team([athlete(1, { nome: 'B' }), athlete(2, { nome: 'A' }), reserve], 3);
    expect(resolveReplacements(frozen, scores(1, 1, 5), matches).replacements[0].atletaSaiuId).toBe(2);
    frozen.escalacao[0].preco = new Prisma.Decimal(20);
    expect(resolveReplacements(frozen, scores(1, 1, 5), matches).replacements[0].atletaSaiuId).toBe(1);
    frozen.escalacao[0].preco = null;
    expect(resolveReplacements(frozen, scores(1, 1, 5), matches).pending).toContain('Preco ausente no desempate');
  });
  it('nao inventa reserva para tecnico ou permite reuso', () => {
    const frozen = team([athlete(1), reserve]);
    const replacement = { atletaSaiuId: 1, atletaEntrouId: 3, posicaoId: 5 };
    expect(() => effectiveLineup(frozen, [replacement, replacement])).toThrow();
    expect(() => resolveReplacements(team([athlete(1, { posicaoId: 6 }), { ...reserve, posicaoId: 6 }]), scores(1, 0, 5), matches)).toThrow('Tecnico');
  });
  it('sem reserva conserva titulares; horario e placar nao encerram jogo', () => {
    expect(resolveReplacements(team([athlete(1)]), scores(0, 0, 0, false), matches).replacements).toEqual([]);
    expect(matchEnded(game(1, { periodo_tr: undefined, placar_oficial_mandante: 1, placar_oficial_visitante: 0 }))).toBe(false);
  });
  it('rejeita envelope incorreto e atleta malformado preservando ultima parcial', () => {
    expect(() => scoreMap({ rodada: 2, atletas: {} }, 1)).toThrow();
    expect(() => scoreMap({ rodada: 1, atletas: { '1': { pontuacao: NaN } } }, 1)).toThrow();
  });
  it('reabertura permite periodo historico vazio, sem permitir antecipacao durante jogos', () => {
    const cleared = new Map([...matches].map(([id, m]) => [id, { ...m, periodo_tr: '' }]));
    const frozen = team([athlete(1), reserve]);
    expect(resolveReplacements(frozen, scores(0, 0, 8, false), cleared).replacements).toEqual([]);
    expect(resolveReplacements(frozen, scores(0, 0, 8, false), cleared, true).replacements).toHaveLength(1);
  });
  it('interpreta data sem offset em Brasilia, independente do servidor', () => {
    expect(matchStart(game(1, { timestamp: undefined, partida_data: '2026-08-29 18:30:00' }))).toBe(Date.parse('2026-08-29T21:30:00Z'));
  });
});
