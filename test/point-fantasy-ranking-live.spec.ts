import { ServiceUnavailableException } from '@nestjs/common';
import { PointFantasyService } from '../src/point-fantasy/point-fantasy.service';
import { LineupScoringService } from '../src/point-fantasy/scoring/lineup-scoring.service';

describe('POINT Fantasy live ranking', () => {
  let db: any, competition: any, entries: any[], scoring: any, service: PointFantasyService;
  const preview = (points: Array<string | null>, partidas = ['EM_ANDAMENTO']) => ({
    partidas, cacheDesatualizado: false,
    items: entries.map((entry, index) => ({ escalacaoId: entry.id, versaoEscalacao: entry.versao,
      total: points[index], estado: points[index] === null ? 'PENDENTE' : 'PROVISORIO' })),
  });

  beforeEach(() => {
    competition = { id: 8, temporada: 2026, rodada: 31, status: 'PUBLICADA', fimInscricao: new Date(0),
      fechamentoDefinitivoEm: null, partidas: [{ status: 'EM_ANDAMENTO', inicioReal: new Date(1000), inicioPrevisto: new Date(0) }] };
    entries = [1, 2, 3].map(id => ({ id, competicaoId: 8, usuarioId: id, versao: 2, nomePublico: `Time ${id}`,
      sequencial: id, formacao: '4-3-3', identidade: { identificadorPublico: `ID${id}`, nomeBase: `Time ${id}` },
      usuario: { fantasyBrasaoId: null }, resultado: null }));
    db = {
      fantasyCompeticao: { findFirst: jest.fn(async () => competition) },
      fantasyEscalacao: { findMany: jest.fn(async () => entries), count: jest.fn(async () => entries.length) },
      fantasyApuracaoRodada: { findUnique: jest.fn(async () => null) },
      $transaction: jest.fn(async (action: any) => action(db)),
    };
    scoring = { previewCartolaCompetition: jest.fn(async () => preview(['5', '10', '10'])) };
    service = new PointFantasyService(db, {} as any, scoring as unknown as LineupScoringService);
  });

  it('does not fetch or expose scores or rival formations before market closure', async () => {
    competition.fimInscricao = new Date(Date.now() + 60_000);
    competition.partidas = [{ status: 'AGENDADA', inicioReal: null, inicioPrevisto: new Date(Date.now() + 120_000) }];
    const result = await service.ranking(8, { page: 1, limit: 50 }, 2);
    expect(result.estadoPontuacao).toBe('NAO_INICIADA');
    expect(result.items.map(item => item.formacao)).toEqual([null, '4-3-3', null]);
    expect(result.items.every(item => item.pontuacao === null && item.posicao === null)).toBe(true);
    expect(scoring.previewCartolaCompetition).not.toHaveBeenCalled();
  });

  it('ranks all entries globally, preserves ties, and returns AO_VIVO after lock', async () => {
    scoring.previewCartolaCompetition.mockImplementation(async () => preview(['5', '10', '10'], ['EM_ANDAMENTO']));
    const result = await service.ranking(8, { page: 1, limit: 50 }, 2);
    expect(result.estadoPontuacao).toBe('AO_VIVO');
    expect(result.items.map(item => [item.escalacaoId, item.posicao, item.pontuacao])).toEqual([[2, 1, '10'], [3, 1, '10'], [1, 3, '5']]);
    expect(result.items.every(item => item.formacao === '4-3-3')).toBe(true);
    expect(JSON.stringify(result)).not.toMatch(/atletas|capitaoAtletaId|usuarioId/);
    expect(scoring.previewCartolaCompetition).toHaveBeenCalledTimes(1);
  });

  it('returns PENDENTE when Cartola has not supplied scores before kickoff', async () => {
    scoring.previewCartolaCompetition.mockImplementation(async () => preview([null, null, null], ['NAO_INICIADA']));
    const result = await service.ranking(8, { page: 1, limit: 50 });
    expect(result.estadoPontuacao).toBe('PENDENTE');
    expect(result.items.every(item => item.pontuacao === null && item.posicao === null)).toBe(true);
  });

  it('returns PROVISORIO once all competition matches ended and scores are available', async () => {
    scoring.previewCartolaCompetition.mockImplementation(async () => preview(['5', '10', '10'], ['ENCERRADA']));
    const result = await service.ranking(8, { page: 1, limit: 50 });
    expect(result.estadoPontuacao).toBe('PROVISORIO');
    expect(result.items[0].posicao).toBe(1);
  });

  it('does not turn source failures into zero scores', async () => {
    scoring.previewCartolaCompetition.mockRejectedValue(new ServiceUnavailableException('Cartola indisponivel'));
    const result = await service.ranking(8, { page: 1, limit: 50 });
    expect(result.estadoPontuacao).toBe('PENDENTE');
    expect(result.items.every(item => item.pontuacao === null && item.posicao === null)).toBe(true);
  });
});
