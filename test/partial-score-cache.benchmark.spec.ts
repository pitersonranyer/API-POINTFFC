import { Prisma } from '@prisma/client';
import { performance } from 'perf_hooks';
import { scoreMap, totalScore } from '../src/round-processing/round-calculator';

describe('Pontuacao em lote com mapa global', () => {
  it('calcula 5000 times com um unico mapa de pontuados', () => {
    const scores = scoreMap({ rodada: 25, atletas: { '10': { pontuacao: 10 }, '11': { pontuacao: -2 } } }, 25);
    const lineup = [
      { atletaId: 10, posicaoId: 5, clubeId: 1, titular: true, reserva: false, capitao: true },
      { atletaId: 11, posicaoId: 6, clubeId: 2, titular: true, reserva: false, capitao: false },
    ];
    const started = performance.now();
    const totals: Prisma.Decimal[] = Array.from({ length: 5000 }, () => totalScore(lineup, scores));
    expect(totals.every((total) => total.equals(13))).toBe(true);
    console.log(JSON.stringify({ benchmark: 'round_score_5000', times: totals.length, mapas: 1, duracaoMs: performance.now() - started }));
  });
});
