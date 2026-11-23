import { ServiceUnavailableException } from '@nestjs/common';
import { PointFantasyService } from '../src/point-fantasy/point-fantasy.service';
import { LineupScoringService } from '../src/point-fantasy/scoring/lineup-scoring.service';

describe('POINT Fantasy live ranking', () => {
  let db: any, competition: any, entries: any[], scoring: any, service: PointFantasyService;
  const preview = (points: Array<string | null>, partidas = ['EM_ANDAMENTO']) => ({
    partidas, cacheDesatualizado: false,
    items: entries.map((entry, index) => ({ escalacaoId: entry.id, versaoEscalacao: entry.versao,
      total: points[index], missing: points[index] === null ? [999] : [],
      estado: points[index] === null ? 'PENDENTE' : 'PROVISORIO' })),
  });

  beforeEach(() => {
    competition = { id: 8, temporada: 2026, rodada: 31, status: 'PUBLICADA', fimInscricao: new Date(0),
      fechamentoDefinitivoEm: null, partidas: [{ status: 'EM_ANDAMENTO', inicioReal: new Date(1000), inicioPrevisto: new Date(0) }] };
    entries = [1, 2, 3].map(id => ({ id, competicaoId: 8, usuarioId: id, versao: 2, nomePublico: `Time ${id}`,
      sequencial: id, formacao: '4-3-3', identidade: { identificadorPublico: `ID${id}`, nomeBase: `Time ${id}` },
      usuario: { fantasyBrasaoId: null }, resultado: null,
      capitao: id === 1 ? { apelido: 'Pedro' } : id === 2 ? { apelido: 'Vitor Roque' } : null }));
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
    expect(result).toMatchObject({ estadoPontuacao: 'NAO_INICIADA', detalhesPublicosLiberados: false });
    expect(result.items.map(item => item.formacao)).toEqual([null, '4-3-3', null]);
    expect(result.items.every(item => item.pontuacao === null && item.posicao === null)).toBe(true);
    expect(scoring.previewCartolaCompetition).not.toHaveBeenCalled();
    expect(result.items.every(item => !('capitaoNome' in item))).toBe(true);
    expect(db.fantasyEscalacao.findMany.mock.calls[0][0].select).not.toHaveProperty('capitao');
  });

  it('keeps captains and details private when a match starts before the registration deadline', async () => {
    competition.fimInscricao = new Date(Date.now() + 60_000);
    const result = await service.ranking(8, { page: 1, limit: 50 });
    expect(result).toMatchObject({ detalhesPublicosLiberados: false });
    expect(result.items.every(item => !('capitaoNome' in item) && item.formacao === null)).toBe(true);
    expect(scoring.previewCartolaCompetition).not.toHaveBeenCalled();
  });

  it('ranks all entries globally, preserves ties, and returns AO_VIVO after lock', async () => {
    scoring.previewCartolaCompetition.mockImplementation(async () => preview(['5', '10', '10'], ['EM_ANDAMENTO']));
    const result = await service.ranking(8, { page: 1, limit: 50 }, 2);
    expect(result).toMatchObject({ estadoPontuacao: 'AO_VIVO', detalhesPublicosLiberados: true });
    expect(result.items.map(item => [item.escalacaoId, item.posicao, item.pontuacao])).toEqual([[2, 1, '10'], [3, 1, '10'], [1, 3, '5']]);
    expect(result.items.every(item => item.formacao === '4-3-3')).toBe(true);
    expect(result.items.map(item => 'capitaoNome' in item ? item.capitaoNome : undefined)).toEqual(['Vitor Roque', null, 'Pedro']);
    expect(db.fantasyEscalacao.findMany).toHaveBeenCalledTimes(1);
    expect(db.fantasyEscalacao.findMany.mock.calls[0][0].include.capitao).toEqual({ select: { apelido: true } });
    expect(JSON.stringify(result)).not.toMatch(/atletas|capitaoAtletaId|usuarioId/);
    expect(scoring.previewCartolaCompetition).toHaveBeenCalledTimes(1);
  });

  it('returns all own teams across public pages without changing tied positions or totals', async () => {
    const template = entries[0];
    entries = Array.from({ length: 105 }, (_, i) => ({
      ...template, id: i + 1, sequencial: i + 1, usuarioId: i % 3 === 0 ? 42 : 8,
    }));
    scoring.previewCartolaCompetition.mockImplementation(async () => preview(entries.map((_, i) => String(6 - Math.floor(i / 2)))));
    const first = await service.ranking(8, { page: 1, limit: 50 }, 42);
    const second = await service.ranking(8, { page: 2, limit: 50 }, 42);
    const last = await service.ranking(8, { page: 3, limit: 50 }, 42);
    const own = await service.myRanking(8, 42);
    expect(own).toMatchObject({ total: 35, limit: 35, page: 1, estadoPontuacao: 'AO_VIVO' });
    expect(own.items).toEqual([...first.items, ...second.items, ...last.items].filter(item => item.meuTime));
    expect(own.items.some(item => item.posicao! > 100)).toBe(true);
    expect(own.items.map(item => item.pontuacao)).toEqual(expect.arrayContaining(['0', '-1']));
    expect(await service.myRanking(8, 99)).toMatchObject({ total: 0, items: [] });
  });

  it('returns known partial totals as AO_VIVO when some athletes await future matches', async () => {
    scoring.previewCartolaCompetition.mockResolvedValue({ partidas: ['EM_ANDAMENTO', 'NAO_INICIADA'],
      cacheDesatualizado: false, items: entries.map((entry, index) => ({
        escalacaoId: entry.id, versaoEscalacao: entry.versao, total: String(4 + index), missing: [900 + index],
      })) });

    const result = await service.ranking(8, { page: 1, limit: 50 });

    expect(result.estadoPontuacao).toBe('AO_VIVO');
    expect(result.items.map(item => item.pontuacao)).toEqual(['6', '5', '4']);
    expect(result.items.every(item => item.posicao !== null)).toBe(true);
  });

  it('returns PENDENTE when Cartola has not supplied scores before kickoff', async () => {
    scoring.previewCartolaCompetition.mockImplementation(async () => preview([null, null, null], ['NAO_INICIADA']));
    const result = await service.ranking(8, { page: 1, limit: 50 });
    expect(result.estadoPontuacao).toBe('PENDENTE');
    expect(result.items.every(item => item.pontuacao === null && item.posicao === null)).toBe(true);
  });

  const partialPreview = () => {
    const result = preview(['0', '10', '99'], ['INDEFINIDA']);
    return { ...result, temporada: 2026, rodada: 31, items: result.items.map((item, index) => ({
      ...item, missing: [999], versaoEscalacao: index === 2 ? item.versaoEscalacao - 1 : item.versaoEscalacao,
      atletas: [{ catalogoAtletaId: 1, pontuacaoCartola: item.total }, { catalogoAtletaId: 999, pontuacaoCartola: null }],
      contributions: [{ athlete: 1, points: item.total }],
    })) };
  };

  it('publishes official compatible totals even with unknown matches and pending athletes', async () => {
    scoring.previewCartolaCompetition.mockResolvedValue(partialPreview());
    const page = await service.ranking(8, { page: 1, limit: 50 });
    expect(page).toMatchObject({ estadoPontuacao: 'PENDENTE', parciaisDisponiveis: true });
    expect(page.items.map(item => [item.escalacaoId, item.posicao, item.pontuacao]))
      .toEqual([[2, 1, '10'], [1, 2, '0'], [3, null, null]]);
    expect(await service.ranking(8, { page: 3, limit: 1 })).toMatchObject({ parciaisDisponiveis: true,
      items: [expect.objectContaining({ pontuacao: null, posicao: null })] });
  });

  it.each(['season', 'round', 'no official scores', 'bench-only scores'])('does not publish partials with %s', async issue => {
    const data = partialPreview();
    if (issue === 'season') data.temporada--;
    if (issue === 'round') data.rodada--;
    if (issue === 'no official scores') data.items.forEach(item => { item.atletas[0].pontuacaoCartola = null; });
    if (issue === 'bench-only scores') data.items.forEach(item => { item.contributions[0].athlete = 999; });
    scoring.previewCartolaCompetition.mockResolvedValue(data);
    const result = await service.ranking(8, { page: 1, limit: 50 });
    expect(result.estadoPontuacao).toBe('PENDENTE');
    expect(result).not.toHaveProperty('parciaisDisponiveis');
    expect(result.items.every(item => item.pontuacao === null && item.posicao === null)).toBe(true);
  });

  it('keeps the ranking pending when matches are live but no lineups have a total', async () => {
    scoring.previewCartolaCompetition.mockResolvedValue(preview([null, null, null]));
    const result = await service.ranking(8, { page: 1, limit: 50 });
    expect(result.estadoPontuacao).toBe('PENDENTE');
    expect(result.items.every(item => item.pontuacao === null && item.posicao === null)).toBe(true);
  });

  it('keeps the published totals as the match moves from unknown to live and then provisional', async () => {
    const data = partialPreview();
    scoring.previewCartolaCompetition.mockResolvedValueOnce(data)
      .mockResolvedValueOnce({ ...data, partidas: ['EM_ANDAMENTO'] })
      .mockResolvedValueOnce(preview(['0', '10', '12'], ['ENCERRADA']));

    const request = () => service.ranking(8, { page: 1, limit: 50 });
    const partial = await request();
    const live = await request();
    const provisional = await request();
    expect(partial).toMatchObject({ estadoPontuacao: 'PENDENTE', parciaisDisponiveis: true });
    expect(live.estadoPontuacao).toBe('AO_VIVO');
    expect(live.items.map(item => item.pontuacao)).toEqual(partial.items.map(item => item.pontuacao));
    expect(provisional.estadoPontuacao).toBe('PROVISORIO');
    expect(provisional.items.map(item => item.pontuacao)).toEqual(['12', '10', '0']);
  });

  it('returns PROVISORIO once all competition matches ended and scores are available', async () => {
    scoring.previewCartolaCompetition.mockImplementation(async () => preview(['5', '10', '10'], ['ENCERRADA']));
    const result = await service.ranking(8, { page: 1, limit: 50 });
    expect(result.estadoPontuacao).toBe('PROVISORIO');
    expect(result.items[0].posicao).toBe(1);
  });

  it('does not mark ended matches PROVISORIO while any lineup still has missing athletes', async () => {
    const operationalLog = jest.spyOn((service as any).logger, 'warn').mockImplementation();
    scoring.previewCartolaCompetition.mockResolvedValue({ partidas: ['ENCERRADA'], cacheDesatualizado: false,
      items: entries.map(entry => ({ escalacaoId: entry.id, versaoEscalacao: entry.versao,
        total: '5', missing: entry.id === 2 ? [999] : [] })) });

    const result = await service.ranking(8, { page: 1, limit: 50 });

    expect(result.estadoPontuacao).toBe('PENDENTE');
    expect(result.items.every(item => item.pontuacao === null && item.posicao === null)).toBe(true);
    expect(operationalLog).toHaveBeenCalledWith(expect.objectContaining({
      event: 'point_fantasy_ranking_preview_incomplete', competicaoId: 8, partidasPreview: ['ENCERRADA'],
      escalacoes: [expect.objectContaining({ escalacaoId: 2, previewEncontrado: true,
        versaoCompativel: true, totalDisponivel: true, atletasSemPontuacao: 1 })],
    }));
    expect(JSON.stringify(operationalLog.mock.calls)).not.toContain('999');
  });

  it('does not turn source failures into zero scores', async () => {
    const operationalLog = jest.spyOn((service as any).logger, 'error').mockImplementation();
    scoring.previewCartolaCompetition.mockRejectedValue(new ServiceUnavailableException('Cartola indisponivel'));
    const result = await service.ranking(8, { page: 1, limit: 50 });
    expect(result.estadoPontuacao).toBe('PENDENTE');
    expect(result.items.every(item => item.pontuacao === null && item.posicao === null)).toBe(true);
    expect(operationalLog).toHaveBeenCalledWith(expect.objectContaining({
      event: 'point_fantasy_ranking_preview_pending', competicaoId: 8,
      errorType: 'ServiceUnavailableException', httpStatus: 503,
    }));
    expect(JSON.stringify(operationalLog.mock.calls)).not.toContain('Cartola indisponivel');
  });
});
