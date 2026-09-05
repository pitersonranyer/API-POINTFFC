import { ConfigService } from '@nestjs/config';
import { Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { CartolaService } from '../src/cartola/cartola.service';
import { CartolaMarketStatus, CartolaMatchesResponse, CartolaScoredAthletesPayload } from '../src/cartola/cartola.types';
import { PrismaService } from '../src/prisma/prisma.service';
import { RoundProcessingService } from '../src/round-processing/round-processing.service';
import { TimeSnapshotsService } from '../src/time-snapshots/time-snapshots.service';

function setup() {
  let round: any = null;
  let teams: any[] = [];
  let failCommit = false;
  let market: CartolaMarketStatus = { temporada: 2026, rodada_atual: 25, status_mercado: 1, bola_rolando: false };
  let points: CartolaScoredAthletesPayload = { rodada: 25, atletas: { '10': { pontuacao: 10, entrou_em_campo: true }, '11': { pontuacao: 4, entrou_em_campo: true } } };
  let matches: CartolaMatchesResponse = { rodada: 25, clubes: {}, partidas: [
    { partida_id: 1, clube_casa_id: 1, clube_visitante_id: 2, valida: true, periodo_tr: '2T', timestamp: 1000 },
  ] };
  const events: string[] = [];
  const failures = new Set<number>();
  const team = (id: number) => ({ id, timeId: id, temporada: 2026, rodada: 25, capitaoId: id === 3 ? 11 : 10, reservaLuxoId: null,
    escalacao: [{ atletaId: id === 3 ? 11 : 10, posicaoId: 5, clubeId: 1, titular: true, reserva: false, capitao: true }],
    pontuacao: null, substituicoes: [],
  });
  const prisma = {
    timeUsuario: { findMany: jest.fn(async () => [{ timeId: 1 }, { timeId: 2 }, { timeId: 3 }, { timeId: 1 }]) },
    timeRodada: { findMany: jest.fn(async (args: any = {}) => {
      if (args.select?._count) return teams.map((t) => ({ ...t, _count: { escalacao: t.escalacao.filter((a: any) => a.titular).length } }));
      if (args.where?.OR) {
        const clauses = args.where.OR[1].escalacao.some.OR;
        return teams.filter((t) => !t.pontuacao || t.escalacao.some((a: any) => clauses[0].atletaId.in.includes(a.atletaId) || clauses[1].clubeId.in.includes(a.clubeId)));
      }
      return teams;
    }) },
    rodadaProcessamento: {
      upsert: jest.fn(async ({ create }: any) => {
        round ??= { ...create, status: 'AGUARDANDO_ESCALACOES', pontuados: null, partidas: null, lockToken: null, lockAte: null };
        return round;
      }),
      findMany: jest.fn(async () => round && round.status !== 'CONSOLIDADA' ? [round] : []),
      findUniqueOrThrow: jest.fn(async () => ({ ...round })),
      updateMany: jest.fn(async ({ where, data }: any) => {
        if (!round || (where.status?.not === round.status) || (where.lockToken && round.lockToken !== where.lockToken)
          || (where.lockAte?.gt && round.lockAte <= where.lockAte.gt)
          || (where.OR && round.lockAte && round.lockAte >= new Date())) return { count: 0 };
        round = { ...round, ...data }; return { count: 1 };
      }),
      update: jest.fn(async ({ data }: any) => { round = { ...round, ...data }; return round; }),
    },
    substituicaoTimeRodada: { updateMany: jest.fn(async () => ({ count: 0 })) },
    $executeRaw: jest.fn(async (sql: Prisma.Sql) => {
      if (failCommit) throw new Error('Database unavailable');
      if (sql.sql.includes('INSERT INTO PONTUACAO')) {
        for (let i = 0; i < sql.values.length; i += 6) {
          const target = teams.find((t) => t.id === sql.values[i]);
          target.pontuacao = { pontuacao: new Prisma.Decimal(sql.values[i + 1] as Prisma.Decimal), status: sql.values[i + 2] };
        }
      }
      return 1;
    }),
    $transaction: jest.fn(async (callback: (tx: any) => Promise<unknown>): Promise<unknown> => {
      const oldRound = { ...round }; const oldTeams = teams.map((t) => ({ ...t }));
      try { return await callback(prisma); }
      catch (error) { round = oldRound; teams = oldTeams; throw error; }
    }),
  };
  const snapshots = { criarSnapshot: jest.fn(async ({ timeId }: { timeId: number }) => {
    events.push(`snapshot:${timeId}`);
    if (failures.has(timeId)) throw new Error('Cartola indisponivel');
    if (!teams.some((t) => t.timeId === timeId)) teams.push(team(timeId));
    return { timeRodadaId: timeId, titulares: 1 };
  }) };
  const cartola = {
    loadMarketStatusFresh: jest.fn(async () => ({ ...market })),
    loadScoredAthletesFresh: jest.fn(async () => { events.push('pontuados'); return { value: points, ttlMs: 1000 }; }),
    loadFinalScoredAthletesFresh: jest.fn(async () => { events.push('finais'); return points; }),
    loadMatchesFresh: jest.fn(async () => matches),
  };
  const create = () => new RoundProcessingService(prisma as unknown as PrismaService, cartola as unknown as CartolaService,
    snapshots as unknown as TimeSnapshotsService, { get: (_key: string, fallback: unknown) => fallback } as ConfigService);
  return { prisma, snapshots, cartola, events, failures, create, get round() { return round; }, get teams() { return teams; },
    closed: () => { market = { ...market, status_mercado: 2, bola_rolando: true }; },
    maintenance: () => { market = { ...market, status_mercado: 4, bola_rolando: false }; },
    open: () => { market = { ...market, status_mercado: 1, rodada_atual: 26, bola_rolando: false }; },
    end: () => { matches = { ...matches, partidas: matches.partidas.map((m) => ({ ...m, periodo_tr: 'F' })) }; market.bola_rolando = false; },
    points: (value: CartolaScoredAthletesPayload) => { points = value; },
    matches: (value: CartolaMatchesResponse) => { matches = value; },
    failCommit: (value: boolean) => { failCommit = value; },
  };
}

describe('Ciclo persistido de rodadas', () => {
  beforeAll(() => Logger.overrideLogger([]));
  it('aberto -> fechado captura times deduplicados antes de qualquer pontuado', async () => {
    const f = setup(); const worker = f.create();
    await worker.tick(); expect(f.snapshots.criarSnapshot).not.toHaveBeenCalled();
    f.closed(); await worker.tick();
    expect(f.events).toEqual(['snapshot:1', 'snapshot:2', 'snapshot:3', 'pontuados']);
    expect(f.round.timesPrevistos).toEqual([1, 2, 3]);
    expect(f.round.status).toBe('EM_ANDAMENTO');
    expect(f.teams.map((t) => t.pontuacao.pontuacao.toNumber())).toEqual([15, 15, 6]);
    await worker.tick(); expect(f.snapshots.criarSnapshot).toHaveBeenCalledTimes(3);
  });
  it('falha de captura nao pontua time ausente; reinicio retenta somente pendente', async () => {
    const f = setup(); f.closed(); f.failures.add(2);
    await f.create().tick();
    expect(f.round.status).toBe('AGUARDANDO_ESCALACOES');
    expect(f.round.falhasSnapshot).toEqual([{ timeId: 2, erro: 'Cartola indisponivel' }]);
    expect(f.teams.map((t) => t.timeId)).toEqual([1, 3]);
    f.failures.clear(); await f.create().tick();
    expect(f.snapshots.criarSnapshot.mock.calls.map(([arg]) => arg.timeId)).toEqual([1, 2, 3, 2]);
    expect(f.round.falhasSnapshot).toEqual([]);
    expect(f.teams).toHaveLength(3);
  });
  it('incremental recalcula apenas times que usam atleta alterado inclusive compartilhado', async () => {
    const f = setup(); f.closed(); await f.create().tick(); f.prisma.$executeRaw.mockClear();
    f.points({ rodada: 25, atletas: { '10': { pontuacao: -2, entrou_em_campo: true }, '11': { pontuacao: 4, entrou_em_campo: true } } });
    await f.create().tick();
    const sql = f.prisma.$executeRaw.mock.calls[0][0];
    expect(sql.values[0]).toBe(1); expect(sql.values[6]).toBe(2); expect(sql.values).toHaveLength(12);
    expect(f.teams[2].pontuacao.pontuacao.toNumber()).toBe(6);
    f.prisma.$executeRaw.mockClear(); await f.create().tick(); expect(f.prisma.$executeRaw).not.toHaveBeenCalled();
  });
  it.each([false, true])('fim dos jogos aguarda; reabertura consolida com manutencao=%s', async (maintenance) => {
    const f = setup(); f.closed(); await f.create().tick(); f.end(); await f.create().tick();
    expect(f.round.status).toBe('AGUARDANDO_CONSOLIDACAO');
    expect(f.teams.every((t) => t.pontuacao.status === 'PARCIAL')).toBe(true);
    if (maintenance) { f.maintenance(); await f.create().tick(); expect(f.cartola.loadFinalScoredAthletesFresh).not.toHaveBeenCalled(); }
    f.open(); f.prisma.$executeRaw.mockClear(); await f.create().tick();
    expect(f.round.status).toBe('CONSOLIDADA'); expect(f.round.consolidadoEm).toBeInstanceOf(Date);
    expect(f.snapshots.criarSnapshot).toHaveBeenCalledTimes(3);
    expect(f.prisma.$executeRaw.mock.calls[0][0].values).toHaveLength(18);
    expect(f.teams.every((t) => t.pontuacao.status === 'FINAL')).toBe(true);
    await f.create().tick(); expect(f.cartola.loadFinalScoredAthletesFresh).toHaveBeenCalledTimes(1);
  });
  it('falha atomica da conciliacao preserva pontuados, parciais e permite retry', async () => {
    const f = setup(); f.closed(); await f.create().tick(); f.open(); f.failCommit(true);
    const before = f.round.pontuados;
    f.points({ rodada: 25, atletas: { '10': { pontuacao: 99, entrou_em_campo: true }, '11': { pontuacao: 4, entrou_em_campo: true } } });
    await f.create().tick();
    expect(f.round.status).not.toBe('CONSOLIDADA'); expect(f.round.pontuados).toEqual(before);
    expect(f.teams[0].pontuacao.pontuacao.toNumber()).toBe(15);
    f.failCommit(false); await f.create().tick(); expect(f.round.status).toBe('CONSOLIDADA');
    expect(f.teams[0].pontuacao.pontuacao.toNumber()).toBe(148.5);
  });
  it('conciliacao nao baixa snapshot ausente apos reabertura', async () => {
    const f = setup(); f.closed(); f.failures.add(2); await f.create().tick(); f.open();
    await f.create().tick(); expect(f.round.status).not.toBe('CONSOLIDADA');
    expect(f.snapshots.criarSnapshot).toHaveBeenCalledTimes(3);
    expect(f.cartola.loadFinalScoredAthletesFresh).not.toHaveBeenCalled();
  });
  it('lock persistido impede dois workers e recupera lease expirada', async () => {
    const f = setup(); f.closed(); await f.create().tick();
    f.round.lockToken = 'outro'; f.round.lockAte = new Date(Date.now() + 60000);
    f.cartola.loadScoredAthletesFresh.mockClear(); await f.create().tick();
    expect(f.cartola.loadScoredAthletesFresh).not.toHaveBeenCalled();
    f.round.lockAte = new Date(0); await f.create().tick(); expect(f.cartola.loadScoredAthletesFresh).toHaveBeenCalledTimes(1);
  });
  it('nao publica com lease perdida antes do commit', async () => {
    const f = setup(); f.closed(); await f.create().tick(); f.prisma.$executeRaw.mockClear();
    f.cartola.loadScoredAthletesFresh.mockImplementationOnce(async () => {
      f.round.lockToken = 'novo-worker'; return { value: { rodada: 25, atletas: { '10': { pontuacao: 99 }, '11': { pontuacao: 4 } } }, ttlMs: 1000 };
    });
    await f.create().tick(); expect(f.prisma.$executeRaw).not.toHaveBeenCalled();
  });
  it('reconsolidacao explicita reutiliza snapshot e e idempotente', async () => {
    const f = setup(); f.closed(); await f.create().tick(); f.open(); await f.create().tick();
    const before = f.teams.map((t) => t.pontuacao.pontuacao.toString());
    await f.create().reconsolidarRodada(25, 2026); await f.create().reconsolidarRodada(25, 2026);
    expect(f.teams.map((t) => t.pontuacao.pontuacao.toString())).toEqual(before);
    expect(f.snapshots.criarSnapshot).toHaveBeenCalledTimes(3);
    await expect(f.create().reconsolidarRodada(24, 2025)).rejects.toThrow('temporada');
  });
  it('ajustes de placar e relogio nao reavaliam times sem scouts alterados', async () => {
    const f = setup(); f.closed(); await f.create().tick(); f.prisma.$executeRaw.mockClear();
    f.matches({ rodada: 25, clubes: {}, partidas: [{ partida_id: 1, clube_casa_id: 1, clube_visitante_id: 2,
      valida: true, periodo_tr: '2T', timestamp: 1000, placar_oficial_mandante: 2, inicio_cronometro_tr: '15:00' }] });
    await f.create().tick(); expect(f.prisma.$executeRaw).not.toHaveBeenCalled();
  });
  it('conciliacao reavalia luxo sobre snapshot, persiste troca e recalcula todos', async () => {
    const f = setup(); f.closed(); await f.create().tick();
    const original = f.teams[0];
    original.reservaLuxoId = 20;
    original.escalacao.push({ atletaId: 20, posicaoId: 5, clubeId: 2, titular: false, reserva: true, capitao: false });
    f.points({ rodada: 25, atletas: { '10': { pontuacao: 1, entrou_em_campo: true }, '11': { pontuacao: 4, entrou_em_campo: true }, '20': { pontuacao: 8, entrou_em_campo: true } } });
    f.open(); f.prisma.$executeRaw.mockClear(); await f.create().tick();
    expect(f.round.status).toBe('CONSOLIDADA');
    expect(f.teams[0].pontuacao.pontuacao.toNumber()).toBe(12);
    expect(f.prisma.$executeRaw.mock.calls.some(([sql]) => sql.sql.includes('INSERT INTO SUBSTITUICAO'))).toBe(true);
    expect(original.escalacao[0].titular).toBe(true);
    expect(original.escalacao[1].reserva).toBe(true);
  });
  it('participacao ausente impede consolidacao sem apagar ultima parcial', async () => {
    const f = setup(); f.closed(); await f.create().tick();
    f.teams[0].escalacao.push({ atletaId: 20, posicaoId: 5, clubeId: 2, titular: false, reserva: true, capitao: false });
    f.open(); await f.create().tick();
    expect(f.round.status).not.toBe('CONSOLIDADA');
    expect(f.round.erro).toContain('Participacao desconhecida');
    expect(f.teams[0].pontuacao.status).toBe('PARCIAL');
  });
  it('5000 times usam um envelope e persistencia de pontos em 50 lotes', async () => {
    const f = setup(); f.closed();
    f.prisma.timeUsuario.findMany.mockResolvedValue(Array.from({ length: 5000 }, (_, i) => ({ timeId: i + 1 })));
    await f.create().tick();
    expect(f.teams).toHaveLength(5000);
    expect(f.cartola.loadScoredAthletesFresh).toHaveBeenCalledTimes(1);
    expect(f.prisma.$executeRaw).toHaveBeenCalledTimes(50);
    expect(f.prisma.timeRodada.findMany).toHaveBeenCalledTimes(4);
  }, 15000);
});
