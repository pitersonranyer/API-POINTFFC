import { LineupScoringService } from '../src/point-fantasy/scoring/lineup-scoring.service';
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
    const cartola: any = { getScoredAthletes: jest.fn(async () => ({ value: payload, cache: 'hit', stale: false })),
      getMatchesByRound: jest.fn(async () => ({ value: { rodada: 31, partidas: [providerMatch] }, cache: 'hit', stale: false })) };
    return { service: new LineupScoringService(db, cartola), db, cartola, lineup, payload, athletes, selection, providerMatch };
  };

  it('uses Cartola individual values for 11 starters, five reserves and coach, then applies Fantasy rules', async () => {
    const f = setup();
    const result = await f.service.previewCartolaLineup(8, 71);
    expect(f.cartola.getScoredAthletes).toHaveBeenCalledWith(31, 2026);
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
    expect(result.total).toBeNull();
    expect(result.atletas.find((a: any) => a.atletaIdCartola === 1017)).toMatchObject({ pontuacaoCartola: null, entrouEmCampo: null });
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
    expect(f.cartola.getScoredAthletes).toHaveBeenCalledTimes(1);
    expect(f.cartola.getMatchesByRound).toHaveBeenCalledTimes(1);
  });
});
