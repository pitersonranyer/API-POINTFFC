import { LineupScoringService } from '../src/point-fantasy/scoring/lineup-scoring.service';
import { ScoredAthletesCacheService } from '../src/scored-athletes-cache/scored-athletes-cache.service';
import { MemoryScoredAthletesCacheStore } from '../src/scored-athletes-cache/memory-scored-athletes-cache.store';
import { completeLineup } from './point-fantasy-lineup.fixture';

describe('POINT Fantasy Cartola scoring preview', () => {
  const setup = (missingExternalId?: number) => {
    const { athletes, selection } = completeLineup();
    const lineup: any = { id: 71, competicaoId: 8, versao: 3, status: 'INSCRITA', confirmadaEm: new Date(),
      formacao: selection.formacao, capitaoAtletaId: selection.capitaoAtletaId, reservaMagoAtletaId: selection.reservaMagoAtletaId,
      atletas: athletes.map(atleta => ({ catalogoAtletaId: atleta.id, atleta,
        papel: selection.titulares.includes(atleta.id) ? 'TITULAR' : atleta.id === selection.tecnico ? 'TECNICO' : 'RESERVA' })) };
    const competition: any = { id: 8, catalogoId: 3, status: 'PUBLICADA', temporada: 2026, rodada: 31,
      fechamentoDefinitivoEm: null, catalogo: { status: 'CONGELADO', temporada: 2026, rodada: 31 },
      partidas: [{ id: 2, partidaIdExterno: 9001, clubeMandanteId: 263, clubeVisitanteId: 264,
        inicioPrevisto: new Date(Date.now() - 60_000), inicioReal: new Date(Date.now() - 60_000), status: 'EM_ANDAMENTO' }] };
    const db: any = { fantasyCompeticao: { findFirst: jest.fn(async () => competition) },
      fantasyEscalacao: { findFirst: jest.fn(async () => lineup), findMany: jest.fn(async () => [lineup]) },
      $transaction: jest.fn(async (action: any) => action(db)) };
    const payload: any = { rodada: 31, total_atletas: athletes.length, atletas: {} };
    for (const athlete of athletes) {
      if (athlete.atletaIdExterno === missingExternalId) continue;
      payload.atletas[String(athlete.atletaIdExterno)] = { pontuacao: athlete.id === selection.capitaoAtletaId ? -1.25 : athlete.id,
        entrou_em_campo: true, clube_id: athlete.clubeIdExterno, posicao_id: athlete.posicaoId, scout: { G: 1 } };
    }
    const providerMatch: any = { partida_id: 9001, clube_casa_id: 263,
        clube_visitante_id: 264, partida_data: new Date(Date.now() - 60_000).toISOString(), timestamp: Math.floor((Date.now() - 60_000) / 1000),
        valida: true, periodo_tr: 'F' };
    const cartola: any = {
      // The general Cartola read would require rodadaProcessamento.pontuados in
      // production; the live preview must use the current official feed instead.
      getScoredAthletes: jest.fn(async () => { throw new Error('persisted snapshot missing'); }),
      loadScoredAthletesFresh: jest.fn(async () => ({ value: payload, ttlMs: 15_000 })),
      getMatchesByRound: jest.fn(async () => ({ value: { rodada: 31, partidas: [providerMatch] }, cache: 'hit', stale: false })) };
    const scoredCache = new ScoredAthletesCacheService(new MemoryScoredAthletesCacheStore(), cartola,
      { get: (_key: string, fallback: number) => fallback } as any);
    return { service: new LineupScoringService(db, cartola, scoredCache), db, cartola, scoredCache,
      lineup, payload, athletes, selection, providerMatch };
  };

  it('reads current Cartola points without a persisted snapshot and applies Fantasy rules', async () => {
    const f = setup();
    const result = await f.service.previewCartolaLineup(8, 71);
    expect(result.atletas.find((athlete: any) => athlete.pontuacaoCartola !== null)).toEqual(
      expect.objectContaining({ scouts: expect.any(Object) }));
    expect(f.cartola.getScoredAthletes).not.toHaveBeenCalled();
    expect(f.cartola.loadScoredAthletesFresh).toHaveBeenCalledWith(31, 2026);
    expect(f.cartola.getMatchesByRound).toHaveBeenCalledWith(31, 2026);
    expect(result.atletas).toHaveLength(17);
    expect(result.atletas.map((a: any) => a.pontuacaoCartola)).toEqual(f.athletes.map(a => String(a.id === f.selection.capitaoAtletaId ? -1.25 : a.id)));
    expect(result.atletas.filter((a: any) => a.papel === 'TITULAR')).toHaveLength(11);
    expect(result.atletas.filter((a: any) => a.papel === 'RESERVA')).toHaveLength(5);
    expect(result.atletas.filter((a: any) => a.papel === 'TECNICO')).toHaveLength(1);
    expect(result.atletas.find((a: any) => a.catalogoAtletaId === f.selection.capitaoAtletaId)).toMatchObject({ pontuacaoCartola: '-1.25' });
    expect(result.total).toBe('103');
    expect(result.contributions.find((row: any) => row.starter === f.selection.capitaoAtletaId)).toMatchObject({ multiplier: 2 });
    expect(result.substitutions).toContainEqual(expect.objectContaining({ kind: 'MAGO', out: f.selection.capitaoAtletaId, multiplier: 2 }));
    expect(result.atletas.some((a: any) => Number(a.pontuacaoCartola) > 0)).toBe(true);
    expect(result.persistido).toBe(false);
    expect(f.db.fantasyEscalacaoResultado).toBeUndefined();
    expect(result.partidas).toContain('ENCERRADA');
  });

  it('leaves the scaleup pending when one individual point is unavailable', async () => {
    const f = setup(1017);
    const result = await f.service.previewCartolaLineup(8, 71);
    expect(result.estado).toBe('PENDENTE');
    expect(result.total).toBe('103');
    expect(result.missing).toContain(17);
    expect(result.atletas.find((a: any) => a.atletaIdCartola === 1017)).toMatchObject({ pontuacaoCartola: null, entrouEmCampo: null });
  });

  it('returns a live partial total when one athlete in an in-progress match has no score', async () => {
    const f = setup();
    const missing = f.lineup.atletas.find((row: any) => row.papel === 'TITULAR' && row.catalogoAtletaId !== f.selection.capitaoAtletaId)!;
    delete f.payload.atletas[String(missing.atleta.atletaIdExterno)];
    f.providerMatch.periodo_tr = '2T';

    const result = await f.service.previewCartolaLineup(8, 71);
    const expected = f.lineup.atletas.filter((row: any) => row.papel !== 'RESERVA'
      && row.catalogoAtletaId !== missing.catalogoAtletaId).reduce((sum: number, row: any) => {
        const points = row.atleta.id === f.selection.capitaoAtletaId ? -1.25 : row.atleta.id;
        return sum + points * (row.atleta.id === f.selection.capitaoAtletaId ? 2 : 1);
      }, 0);

    expect(result.partidas).toContain('EM_ANDAMENTO');
    expect(result.total).toBe(String(expected));
    expect(result.missing).toContain(missing.catalogoAtletaId);
    expect(result.substitutions).toEqual([]);
  });

  it('confirms a nonparticipant and permits the common reserve only after the match ends', async () => {
    const f = setup();
    const absent = f.lineup.atletas.find((row: any) => row.papel === 'TITULAR' && row.catalogoAtletaId !== f.selection.capitaoAtletaId)!;
    delete f.payload.atletas[String(absent.atleta.atletaIdExterno)];
    f.payload.total_atletas = Object.keys(f.payload.atletas).length;
    f.providerMatch.periodo_tr = 'F';

    const result = await f.service.previewCartolaLineup(8, 71);

    expect(result.missing).not.toContain(absent.catalogoAtletaId);
    expect(result.substitutions).toContainEqual(expect.objectContaining({ kind: 'COMUM', out: absent.catalogoAtletaId }));
  });

  it('distinguishes an evidenced live match from a scheduled match with unknown status', async () => {
    const f = setup();
    f.providerMatch.periodo_tr = '2T';
    let result = await f.service.previewCartolaLineup(8, 71);
    expect(result.partidas).toContain('EM_ANDAMENTO');
    f.providerMatch.periodo_tr = '';
    f.providerMatch.timestamp = Math.floor((Date.now() - 60_000) / 1000);
    result = await f.service.previewCartolaLineup(8, 71);
    expect(result.partidas).toContain('INDEFINIDA');
    f.providerMatch.timestamp = Math.floor((Date.now() + 60 * 60_000) / 1000);
    result = await f.service.previewCartolaLineup(8, 71);
    expect(result.partidas).toContain('NAO_INICIADA');
  });

  it('loads both Cartola datasets once for several enrolled lineups', async () => {
    const f = setup();
    f.db.fantasyEscalacao.findMany.mockResolvedValue([f.lineup, { ...f.lineup, id: 72 }]);
    const result = await f.service.previewCartolaCompetition(8);
    expect(result.items).toHaveLength(2);
    expect(f.cartola.getScoredAthletes).not.toHaveBeenCalled();
    expect(f.cartola.loadScoredAthletesFresh).toHaveBeenCalledTimes(1);
    expect(f.cartola.getMatchesByRound).toHaveBeenCalledTimes(1);
  });

  it('logs the failing lineup without athlete payload details when preview validation rejects it', async () => {
    const f = setup();
    const operationalLog = jest.spyOn((f.service as any).logger, 'error').mockImplementation();
    f.lineup.atletas[0].atleta.clubeIdExterno = 999;

    await expect(f.service.previewCartolaCompetition(8)).rejects.toThrow();

    expect(operationalLog).toHaveBeenCalledWith(expect.objectContaining({
      event: 'point_fantasy_live_preview_lineup_failed', competicaoId: 8,
      temporada: 2026, rodada: 31, escalacaoId: 71, errorType: 'ServiceUnavailableException', httpStatus: 503,
    }));
    expect(JSON.stringify(operationalLog.mock.calls)).not.toContain('Atleta 1');
  });

  it('uses the fresh feed instead of an older current-round snapshot', async () => {
    const f = setup();
    const freshPoints = { ...f.payload, atletas: { ...f.payload.atletas,
      [String(f.athletes[0].atletaIdExterno)]: { ...f.payload.atletas[String(f.athletes[0].atletaIdExterno)], pontuacao: 99 } } };
    f.cartola.loadScoredAthletesFresh.mockResolvedValueOnce({ value: freshPoints, ttlMs: 15_000 });

    const result = await f.service.previewCartolaLineup(8, 71);

    expect(result.atletas.find((a: any) => a.atletaIdCartola === f.athletes[0].atletaIdExterno)?.pontuacaoCartola).toBe('99');
    expect(f.cartola.getScoredAthletes).not.toHaveBeenCalled();
  });

  it('preserves Cartola official points and does not recalculate scouts such as SG', async () => {
    const f = setup();
    const athlete = f.athletes[0];
    f.payload.atletas[String(athlete.atletaIdExterno)] = { pontuacao: 5, entrou_em_campo: true,
      clube_id: athlete.clubeIdExterno, posicao_id: athlete.posicaoId, scout: { SG: 1 } };

    const result = await f.service.previewCartolaLineup(8, 71);

    expect(result.atletas.find((row: any) => row.atletaIdCartola === athlete.atletaIdExterno)?.pontuacaoCartola).toBe('5');
  });
});
