import { Prisma } from '@prisma/client';
import { LineupScoringService } from '../src/point-fantasy/scoring/lineup-scoring.service';
import { completeLineup } from './point-fantasy-lineup.fixture';

describe('POINT FFC 3C persistence (mock transaction, no database)', () => {
  let db: any, c: any, round: any, lineups: any[], points: any[], stored: Map<number, any>;
  let service: LineupScoringService;
  const authorization = { competicaoId: 8, temporada: 2026, rodada: 31, revisao: '1' };
  beforeEach(() => {
    const { athletes, selection } = completeLineup();
    c = { id: 8, catalogoId: 3, status: 'PUBLICADA', temporada: 2026, rodada: 31,
      fechamentoDefinitivoEm: new Date(1000), catalogo: { status: 'CONGELADO', temporada: 2026, rodada: 31 },
      partidas: [{ clubeMandanteId: 263, clubeVisitanteId: 264 }] };
    round = { id: 2, revisaoAtual: 1n, hashConteudoAtual: 'a'.repeat(64) };
    lineups = [1, 2].map(id => ({ id, competicaoId: 8, versao: 1, status: 'INSCRITA', confirmadaEm: new Date(500),
      formacao: selection.formacao, capitaoAtletaId: selection.capitaoAtletaId, reservaMagoAtletaId: selection.reservaMagoAtletaId,
      atletas: athletes.map(atleta => ({ catalogoAtletaId: atleta.id, atleta,
        papel: selection.titulares.includes(atleta.id) ? 'TITULAR' : atleta.posicaoId === 6 ? 'TECNICO' : 'RESERVA' })) }));
    points = athletes.map(a => ({ atletaIdCartola: a.atletaIdExterno, clubeIdCartola: a.clubeIdExterno,
      posicaoId: a.posicaoId, estadoClube: 'VALOR', estadoPosicao: 'VALOR', estadoPontuacao: 'VALOR',
      estadoParticipacao: 'VALOR', entrouEmCampo: true, pontuacao: new Prisma.Decimal(1), revisaoAlteracao: 1n }));
    stored = new Map();
    db = { $queryRaw: jest.fn(async () => []),
      fantasyCompeticao: { findUniqueOrThrow: jest.fn(async () => c) },
      fantasyApuracaoRodada: { findUniqueOrThrow: jest.fn(async () => round) },
      fantasyEscalacao: { findMany: jest.fn(async () => lineups) },
      fantasyPontuacaoAtleta: { findMany: jest.fn(async () => points) },
      fantasyPontuacaoColeta: { findMany: jest.fn(async () => []) },
      fantasyEscalacaoResultado: {
        findUnique: jest.fn(async ({ where }) => stored.get(where.escalacaoId) ?? null),
        upsert: jest.fn(async ({ where, create, update }) => {
          stored.set(where.escalacaoId, stored.has(where.escalacaoId) ? { ...stored.get(where.escalacaoId), ...update } : create);
        }),
      },
    };
    db.$transaction = jest.fn(async action => {
      const before = new Map(stored);
      try { return await action(db); } catch (error) { stored = before; throw error; }
    });
    service = new LineupScoringService(db);
  });
  it('same revision is idempotent; new revision updates current rows', async () => {
    await service.persist(8, authorization); await service.persist(8, authorization);
    expect(stored.size).toBe(2); expect(db.fantasyEscalacaoResultado.upsert).toHaveBeenCalledTimes(2);
    round.revisaoAtual = 2n; round.hashConteudoAtual = 'b'.repeat(64);
    points[0].pontuacao = new Prisma.Decimal(5); points[0].revisaoAlteracao = 2n;
    await service.persist(8, { ...authorization, revisao: '2' });
    expect(stored.get(1)).toMatchObject({ revisao: 2n, total: '21' });
    expect(stored.size).toBe(2);
  });
  it('preview reads without results writes and preserves ties', async () => {
    const result = await service.preview(8);
    expect(result.results.map(r => r.posicao)).toEqual([1, 1]);
    expect(db.fantasyEscalacaoResultado.upsert).not.toHaveBeenCalled();
  });
  it('idempotency ignores JSON key ordering as returned by MySQL', async () => {
    await service.persist(8, authorization);
    for (const result of stored.values()) {
      result.auditoria.evidenciaAusencias = Object.fromEntries(Object.entries(result.auditoria.evidenciaAusencias).reverse());
    }
    await service.persist(8, authorization);
    expect(db.fantasyEscalacaoResultado.upsert).toHaveBeenCalledTimes(2);
  });
  it('scopes lineups, official points and writes to the correct competition and round', async () => {
    await service.persist(8, authorization);
    expect(db.fantasyEscalacao.findMany).toHaveBeenCalledWith(expect.objectContaining({ where: expect.objectContaining({ competicaoId: 8, status: 'INSCRITA' }) }));
    expect(db.fantasyPontuacaoAtleta.findMany).toHaveBeenCalledWith({ where: {
      temporada: 2026, rodada: 31, apuracaoId: 2,
    } });
    c.id = 9; lineups = lineups.map(l => ({ ...l, id: l.id + 10, competicaoId: 9 }));
    await service.persist(9, { ...authorization, competicaoId: 9 });
    expect(stored.get(11).competicaoId).toBe(9); expect(stored.get(1).competicaoId).toBe(8);
  });
  it('rejects clubs outside the competition instead of mixing scores', async () => {
    lineups[0].atletas[0].atleta.clubeIdExterno = 999;
    await expect(service.persist(8, authorization)).rejects.toThrow('INELIGIBLE_SCORING_LINEUP');
    expect(stored.size).toBe(0);
  });
  it('official identity mismatch is pending information, not zero', async () => {
    points[0].clubeIdCartola = 999;
    const plan = await service.preview(8);
    expect(plan.results[0]).toMatchObject({ total: null, missing: [1], posicao: null });
  });
  it('records pending athletes and replacement audit as JSON', async () => {
    points.splice(0, 1); await service.persist(8, authorization);
    expect(stored.get(1)).toMatchObject({ total: null, auditoria: { missing: [1] } });
  });
  it('requires definitive closure and exact approved revision', async () => {
    c.fechamentoDefinitivoEm = null;
    await expect(service.persist(8, authorization)).rejects.toThrow('SCORING_COMPETITION_NOT_READY');
    c.fechamentoDefinitivoEm = new Date(1000); round.revisaoAtual = 2n;
    await expect(service.persist(8, authorization)).rejects.toThrow('SCORING_AUTHORIZATION_SCOPE');
    expect(stored.size).toBe(0);
  });
  it('rolls back the competition batch when any result write fails', async () => {
    db.fantasyEscalacaoResultado.upsert.mockImplementationOnce(async ({ create }: any) => stored.set(create.escalacaoId, create))
      .mockRejectedValueOnce(Error('write failed'));
    await expect(service.persist(8, authorization)).rejects.toThrow('write failed');
    expect(stored.size).toBe(0);
    expect(db.$transaction).toHaveBeenCalledWith(expect.any(Function), { isolationLevel: 'Serializable', timeout: 30000 });
  });
});
