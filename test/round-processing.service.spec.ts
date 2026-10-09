import { ConfigService } from '@nestjs/config';
import { Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { CartolaService } from '../src/cartola/cartola.service';
import { CartolaMarketStatus, CartolaMatchesResponse, CartolaScoredAthletesPayload } from '../src/cartola/cartola.types';
import { PrismaService } from '../src/prisma/prisma.service';
import { RoundProcessingService } from '../src/round-processing/round-processing.service';
import { TimeSnapshotsService } from '../src/time-snapshots/time-snapshots.service';
import { SincronizacaoPontuacoesService } from '../src/ligas-competicoes/sincronizacao-pontuacoes.service';
import { effectiveLineup } from '../src/round-processing/round-calculator';

function setup() {
  let round: any = null;
  let teams: any[] = [];
  let failCommit = false;
  let market: CartolaMarketStatus = { temporada: 2026, rodada_atual: 25, status_mercado: 1, bola_rolando: false };
  let points: CartolaScoredAthletesPayload = { rodada: 25, atletas: { '10': { pontuacao: 10, entrou_em_campo: true }, '11': { pontuacao: 4, entrou_em_campo: true } } };
  let matches: CartolaMatchesResponse = { rodada: 25, clubes: {}, partidas: [
    { partida_id: 1, clube_casa_id: 1, clube_visitante_id: 2, valida: true, periodo_tr: '2T', timestamp: 1767225600 },
  ] };
  const events: string[] = [];
  const failures = new Set<number>();
  const team = (id: number) => ({ id, timeId: id, temporada: 2026, rodada: 25, capitaoId: id === 3 ? 11 : 10, reservaLuxoId: null,
    escalacao: [{ atletaId: id === 3 ? 11 : 10, posicaoId: 5, clubeId: 1, titular: true, reserva: false, capitao: true }],
    pontuacao: null, substituicoes: [],
  });
  const prisma = {
    timeUsuario: { findMany: jest.fn(async () => [{ timeId: 1 }, { timeId: 2 }, { timeId: 3 }, { timeId: 1 }]) },
    inscricaoTimeCompeticao: { findMany: jest.fn(async () => [] as Array<{ timeIdCartola: number }>) },
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
      findUnique: jest.fn(async () => round ? { ...round } : null),
      updateMany: jest.fn(async ({ where, data }: any) => {
        if (!round || (where.status?.not === round.status) || (where.lockToken && round.lockToken !== where.lockToken)
          || (where.lockAte?.gt && round.lockAte <= where.lockAte.gt)
          || (where.OR && round.lockAte && round.lockAte >= new Date())) return { count: 0 };
        round = { ...round, ...data }; return { count: 1 };
      }),
      update: jest.fn(async ({ data }: any) => { round = { ...round, ...data }; return round; }),
    },
    substituicaoTimeRodada: { updateMany: jest.fn(async ({ where }: any) => {
      for (const target of teams.filter((t) => where.timeRodadaId.in.includes(t.id))) target.substituicoes = [];
      return { count: 0 };
    }) },
    $executeRaw: jest.fn(async (sql: Prisma.Sql) => {
      if (failCommit) throw new Error('Database unavailable');
      if (sql.sql.includes('INSERT INTO PONTUACAO')) {
        for (let i = 0; i < sql.values.length; i += 6) {
          const target = teams.find((t) => t.id === sql.values[i]);
          target.pontuacao = { pontuacao: new Prisma.Decimal(sql.values[i + 1] as Prisma.Decimal), status: sql.values[i + 2], consolidadoEm: sql.values[i + 5] };
        }
      }
      if (sql.sql.includes('INSERT INTO SUBSTITUICAO')) {
        for (let i = 0; i < sql.values.length; i += 6) {
          teams.find((t) => t.id === sql.values[i]).substituicoes.push({
            atletaSaiuId: sql.values[i + 1], atletaEntrouId: sql.values[i + 2], posicaoId: sql.values[i + 3],
          });
        }
      }
      return 1;
    }),
    $queryRaw: jest.fn(async () => []),
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
    getTeamById: jest.fn(),
    loadMarketStatusFresh: jest.fn(async () => ({ ...market })),
    loadScoredAthletesFresh: jest.fn(async () => { events.push('pontuados'); return { value: points, ttlMs: 1000 }; }),
    loadFinalScoredAthletesFresh: jest.fn(async () => { events.push('finais'); return points; }),
    loadAdministrativeScoredAthletesFresh: jest.fn(async () => ({ ...points, total_atletas: points.total_atletas ?? Object.keys(points.atletas!).length })),
    loadMatchesFresh: jest.fn(async () => matches),
  };
  const sincronizacao = { sincronizarRodada: jest.fn(async () => { events.push('sincronizacao'); }) };
  const create = () => new RoundProcessingService(prisma as unknown as PrismaService, cartola as unknown as CartolaService,
    snapshots as unknown as TimeSnapshotsService, { get: (_key: string, fallback: unknown) => fallback } as ConfigService,
    sincronizacao as unknown as SincronizacaoPontuacoesService);
  return { prisma, snapshots, cartola, sincronizacao, events, failures, create, get round() { return round; }, get teams() { return teams; },
    closed: () => { market = { ...market, status_mercado: 2, bola_rolando: true }; },
    maintenance: () => { market = { ...market, status_mercado: 4, bola_rolando: false }; },
    open: () => { market = { ...market, status_mercado: 1, rodada_atual: 26, bola_rolando: false }; },
    end: () => { matches = { ...matches, partidas: matches.partidas.map((m) => ({ ...m, periodo_tr: 'F' })) }; market.bola_rolando = false; },
    points: (value: CartolaScoredAthletesPayload) => { points = value; },
    matches: (value: CartolaMatchesResponse) => { matches = value; },
    failCommit: (value: boolean) => { failCommit = value; },
  };
}

describe('Consolidacao de titulares omitidos', () => {
  beforeAll(() => Logger.overrideLogger([]));
  async function fixture(capitao = false, reservePoints = 7.2, complete = true) {
    const f = setup(); f.closed(); await f.create().tick();
    const target = f.teams[0];
    target.capitaoId = capitao ? 10 : 11;
    target.escalacao = [
      { atletaId: 10, nome: 'Britez (simulado)', posicaoId: 5, clubeId: 1, titular: true, reserva: false, capitao },
      ...Array.from({ length: 11 }, (_, i) => ({ atletaId: 11 + i, posicaoId: i === 10 ? 6 : 4,
        clubeId: 1, titular: true, reserva: false, capitao: !capitao && i === 0 })),
      { atletaId: 30, nome: 'Millan (simulado)', posicaoId: 5, clubeId: 2, titular: false, reserva: true, capitao: false },
    ];
    // Fixture sintetica: os 11 participantes somam 133,07 antes da troca.
    const atletas: CartolaScoredAthletesPayload['atletas'] = {
      '11': { pontuacao: capitao ? 123.07 : 82.04666666666667, entrou_em_campo: true, clube_id: 1 },
      '30': { pontuacao: reservePoints, entrou_em_campo: true, clube_id: 2 },
    };
    for (let id = 12; id <= 21; id++) atletas[id] = { pontuacao: 1, entrou_em_campo: true, clube_id: 1 };
    const envelope = { rodada: 25, total_atletas: Object.keys(atletas).length, atletas };
    f.points(complete ? envelope : { rodada: envelope.rodada, atletas }); f.end(); await f.create().tick();
    return { f, envelope };
  }

  it('reavalia sem diff, persiste Britez/Millan simulado, soma 7,20 e repete sem duplicar', async () => {
    const { f } = await fixture();
    const frozen = JSON.stringify(f.teams.map((t) => t.escalacao));
    expect(f.teams[0].pontuacao.pontuacao.toNumber()).toBe(140.27);
    // Simula a ultima parcial ainda sem troca, embora o envelope ja esteja persistido.
    f.teams[0].substituicoes = [];
    f.teams[0].pontuacao.pontuacao = new Prisma.Decimal(133.07);
    f.prisma.timeRodada.findMany.mockClear(); f.prisma.$executeRaw.mockClear();
    f.open(); await f.create().tick();
    expect(f.round.status).toBe('CONSOLIDADA');
    expect(f.teams.every((t) => t.pontuacao.status === 'FINAL')).toBe(true);
    const target = f.teams[0];
    expect(target.pontuacao.pontuacao.minus(133.07).toNumber()).toBe(7.2);
    expect(target.substituicoes).toEqual([{ atletaSaiuId: 10, atletaEntrouId: 30, posicaoId: 5 }]);
    const lineup = effectiveLineup(target, target.substituicoes);
    expect(lineup).toHaveLength(12);
    expect(lineup.filter((a) => f.round.pontuados.atletas[a.atletaId]?.entrou_em_campo)).toHaveLength(12);
    expect(f.prisma.timeRodada.findMany.mock.calls.every(([args]) => !args.where.OR)).toBe(true);
    expect(f.prisma.$executeRaw.mock.calls.some(([sql]) => sql.sql.includes('INSERT INTO SUBSTITUICAO'))).toBe(true);
    const totals = f.teams.map((t) => t.pontuacao.pontuacao.toString());
    await f.create().reconsolidarRodada(25, 2026);
    await f.create().reconsolidarRodada(25, 2026);
    expect(f.teams.map((t) => t.pontuacao.pontuacao.toString())).toEqual(totals);
    expect(target.substituicoes).toHaveLength(1);
    expect(JSON.stringify(f.teams.map((t) => t.escalacao))).toBe(frozen);
    expect(f.snapshots.criarSnapshot).toHaveBeenCalledTimes(3);
    expect(f.cartola.getTeamById).not.toHaveBeenCalled();
  });

  it.each(['sem-total', 'total-inconsistente', 'em-jogo', 'status-desconhecido', 'sem-cobertura', 'sem-reserva'])('preserva parcial e permite retry com %s', async (condition) => {
    const { f, envelope } = await fixture();
    const before = f.teams.map((t) => t.pontuacao.pontuacao.toString());
    const substitutions = JSON.stringify(f.teams.map((t) => t.substituicoes));
    const invalid = JSON.parse(JSON.stringify(envelope)) as CartolaScoredAthletesPayload;
    if (condition === 'sem-total') delete invalid.total_atletas;
    if (condition === 'total-inconsistente') invalid.total_atletas!++;
    if (condition === 'sem-cobertura') Object.values(invalid.atletas!).forEach((a) => { a.clube_id = 2; });
    if (condition === 'sem-reserva') { f.teams[0].escalacao.pop(); delete invalid.total_atletas; }
    if (condition === 'em-jogo' || condition === 'status-desconhecido') {
      const partidas = [{ partida_id: 1, clube_casa_id: 1, clube_visitante_id: 2, valida: true,
        periodo_tr: condition === 'em-jogo' ? '2T' : '', timestamp: 1767225600 }];
      // Retira tambem a confirmacao anterior para testar status realmente desconhecido.
      f.round.partidas = { rodada: 25, clubes: {}, partidas };
      f.matches({ rodada: 25, clubes: {}, partidas });
    }
    f.points(invalid); f.open(); f.prisma.$executeRaw.mockClear();
    await f.create().tick();
    expect(f.round.status).not.toBe('CONSOLIDADA');
    expect(f.round.erro).toBeTruthy();
    expect(f.round.lockToken).toBeNull();
    expect(f.prisma.$executeRaw).not.toHaveBeenCalled();
    expect(f.teams.map((t) => t.pontuacao.pontuacao.toString())).toEqual(before);
    expect(JSON.stringify(f.teams.map((t) => t.substituicoes))).toBe(substitutions);
    // Sem reserva, a ausencia ainda precisa de prova; com prova aceita zero.
    f.points(envelope); f.end(); await f.create().tick();
    expect(f.round.status).toBe('CONSOLIDADA');
  });

  it.each([0, -2])('nao usa reserva normal com %s mesmo com ausencia comprovada', async (points) => {
    const { f } = await fixture(false, points);
    f.open(); await f.create().tick();
    expect(f.round.status).toBe('CONSOLIDADA');
    expect(f.teams[0].substituicoes).toEqual([]);
    expect(f.teams[0].pontuacao.pontuacao.toNumber()).toBe(133.07);
  });

  it('transfere capitao omitido e multiplica reserva por 1,5', async () => {
    const { f } = await fixture(true);
    f.open(); await f.create().tick();
    const target = f.teams[0];
    expect(f.round.status).toBe('CONSOLIDADA');
    expect(target.pontuacao.pontuacao.toNumber()).toBe(143.87);
    expect(effectiveLineup(target, target.substituicoes).find((a) => a.capitao)?.atletaId).toBe(30);
  });

  it('reavalia participacao pendente quando apenas a completude do envelope muda', async () => {
    const { f, envelope } = await fixture(false, 7.2, false);
    expect(f.teams[0].substituicoes).toEqual([]);
    expect(f.teams[0].pontuacao.pontuacao.toNumber()).toBe(133.07);
    f.points(envelope); f.open(); await f.create().tick();
    expect(f.round.status).toBe('CONSOLIDADA');
    expect(f.teams[0].pontuacao.pontuacao.toNumber()).toBe(140.27);
    expect(f.teams[0].substituicoes).toHaveLength(1);
  });

  it.each([false, true])('luxo com titular ausente segue regra normal, positivo=%s', async (positive) => {
    const { f } = await fixture(false, positive ? 7.2 : -1);
    f.teams[0].reservaLuxoId = 30;
    f.open(); await f.create().tick();
    expect(f.round.status).toBe('CONSOLIDADA');
    expect(f.teams[0].substituicoes).toHaveLength(positive ? 1 : 0);
  });

  it('consolida luxo negativo superior e transfere capitao sem reutilizar reserva', async () => {
    const f = setup(); f.closed(); await f.create().tick();
    const target = f.teams[0]; target.reservaLuxoId = 30;
    target.escalacao.push({ atletaId: 30, posicaoId: 5, clubeId: 2, titular: false, reserva: true, capitao: false });
    f.points({ rodada: 25, atletas: {
      '10': { pontuacao: -2, entrou_em_campo: true },
      '11': { pontuacao: 4, entrou_em_campo: true },
      '30': { pontuacao: -1, entrou_em_campo: true },
    } });
    f.end(); f.open(); await f.create().tick();
    expect(f.round.status).toBe('CONSOLIDADA');
    expect(target.pontuacao.pontuacao.toNumber()).toBe(-1.5);
    await f.create().reconsolidarRodada(25, 2026);
    expect(target.substituicoes).toEqual([{ atletaSaiuId: 10, atletaEntrouId: 30, posicaoId: 5 }]);
  });
});

describe('Reprocessamento manual', () => {
  beforeAll(() => Logger.overrideLogger([]));
  async function historical(periodo = 'F', consolidated = false) {
    const f = setup(); f.closed(); await f.create().tick();
    const target = f.teams[0];
    f.teams.splice(1);
    Object.assign(f.round, { rodada: 29, timesPrevistos: [30157355], status: consolidated ? 'CONSOLIDADA' : 'EM_ANDAMENTO' });
    Object.assign(target, { timeId: 30157355, rodada: 29, capitaoId: 11 });
    target.escalacao = [
      { atletaId: 10, nome: 'Britez (sintetico)', posicaoId: 3, clubeId: 1, titular: true, reserva: false, capitao: false },
      ...Array.from({ length: 11 }, (_, i) => ({ atletaId: 11 + i, posicaoId: 4, clubeId: 1,
        titular: true, reserva: false, capitao: i === 0 })),
      { atletaId: 124219, nome: 'Millan (sintetico)', posicaoId: 3, clubeId: 266, titular: false, reserva: true, capitao: false },
    ];
    target.pontuacao = { pontuacao: new Prisma.Decimal(133.07), status: consolidated ? 'FINAL' : 'PARCIAL' };
    const atletas: CartolaScoredAthletesPayload['atletas'] = {
      '11': { pontuacao: 0, entrou_em_campo: true, clube_id: 1 },
      '12': { pontuacao: 124.07, entrou_em_campo: true, clube_id: 1 },
      '124219': { pontuacao: 7.2, entrou_em_campo: true, clube_id: 266 },
    };
    for (let id = 13; id <= 21; id++) atletas[id] = { pontuacao: 1, entrou_em_campo: true, clube_id: 1 };
    const source = { rodada: 29, total_atletas: 12, atletas };
    const matches = { rodada: 29, clubes: {}, partidas: [{ partida_id: 346575, clube_casa_id: 1,
      clube_visitante_id: 266, valida: true, periodo_tr: periodo, timestamp: 1767225600 }] };
    f.round.partidas = { ...matches, partidas: matches.partidas.map(m => ({ ...m, periodo_tr: 'SEGUNDO_TEMPO' })) };
    f.round.pontuados = { ...source };
    f.cartola.loadMarketStatusFresh.mockResolvedValue({ temporada: 2026, rodada_atual: 30, status_mercado: 1, bola_rolando: false });
    f.cartola.loadAdministrativeScoredAthletesFresh.mockResolvedValue(source);
    f.cartola.loadMatchesFresh.mockResolvedValue(matches);
    jest.clearAllMocks();
    return { f, target, source, matches };
  }
  function addUnfinishedMatch(matches: CartolaMatchesResponse) {
    matches.partidas.push({ partida_id: 2, clube_casa_id: 777, clube_visitante_id: 778,
      valida: true, periodo_tr: '', timestamp: 1767225600 });
  }
  it('partida irrelevante nao bloqueia C01 comprovado, mas impede consolidacao global', async () => {
    const { f, target, matches, source } = await historical();
    addUnfinishedMatch(matches);
    const result = await f.create().reprocessarParciais(29, 2026);
    expect(result).toMatchObject({ status: 'PARCIAL', resultado: 'COM_PENDENCIAS', totalTimes: 1,
      atualizados: 1, inalterados: 0, pendentes: 0, naoVerificaveis: 0, rodadaConsolidada: false });
    expect(f.round.status).toBe('EM_ANDAMENTO');
    expect(target.pontuacao.status).toBe('FINAL');
    expect(target.pontuacao.consolidadoEm).toBeInstanceOf(Date);
    expect(target.pontuacao.pontuacao.toNumber()).toBe(140.27);
    expect(effectiveLineup(target, target.substituicoes).filter(a => source.atletas[a.atletaId]?.entrou_em_campo)).toHaveLength(12);
    expect(result.motivosPendencia).toContainEqual({ timeId: null, tipo: 'RODADA', motivo: 'Encerramento global não comprovado' });
    expect(f.sincronizacao.sincronizarRodada).toHaveBeenCalledTimes(1);
    f.prisma.$executeRaw.mockClear(); f.sincronizacao.sincronizarRodada.mockClear();
    expect(await f.create().reprocessarParciais(29, 2026)).toMatchObject({ atualizados: 0, inalterados: 1, rodadaConsolidada: false });
    expect(f.prisma.$executeRaw).not.toHaveBeenCalled();
    expect(f.sincronizacao.sincronizarRodada).not.toHaveBeenCalled();
  });
  it('persiste apenas comprovados, preserva FINAL pendente e inclui snapshots ausentes', async () => {
    const { f, target, matches } = await historical();
    addUnfinishedMatch(matches);
    const pending = { ...target, id: 2, timeId: 2, pontuacao: { pontuacao: new Prisma.Decimal(88), status: 'FINAL', consolidadoEm: new Date(0) },
      escalacao: target.escalacao.map((a: any) => ({ ...a, clubeId: a.reserva ? 778 : 777 })),
      substituicoes: [{ atletaSaiuId: 10, atletaEntrouId: 124219, posicaoId: 3 }] };
    f.teams.push(pending);
    f.round.timesPrevistos = [30157355, 2, 99];
    const frozen = JSON.stringify(pending);
    f.sincronizacao.sincronizarRodada.mockImplementation(async () => {
      expect(f.round.lockToken).toBeNull();
      expect(target.pontuacao.pontuacao.toNumber()).toBe(140.27);
      expect(JSON.stringify(pending)).toBe(frozen);
    });
    expect(await f.create().reprocessarParciais(29, 2026)).toMatchObject({ totalTimes: 3,
      atualizados: 1, pendentes: 1, naoVerificaveis: 1, timesComErro: 2, rodadaConsolidada: false });
    expect(JSON.stringify(pending)).toBe(frozen);
    const sql = f.prisma.$executeRaw.mock.calls.find(([statement]) => statement.sql.includes('INSERT INTO PONTUACAO'))![0];
    expect(sql.values).toHaveLength(6);
    expect(sql.values[0]).toBe(target.id);
    expect(f.snapshots.criarSnapshot).not.toHaveBeenCalled();
    expect(f.sincronizacao.sincronizarRodada).toHaveBeenCalledTimes(1);
  });
  it('coincidencia da pontuacao sem prova terminal continua pendente', async () => {
    const { f, target } = await historical('');
    target.pontuacao.pontuacao = new Prisma.Decimal(140.27);
    expect(await f.create().reprocessarParciais(29, 2026)).toMatchObject({ pendentes: 1, inalterados: 0, atualizados: 0 });
    expect(f.prisma.$executeRaw).not.toHaveBeenCalled();
  });
  it('marca antiga CONSOLIDADA sem prova atual fica preservada e nao confirma encerramento', async () => {
    const { f, target } = await historical('', true);
    const timestamp = new Date(1234);
    f.round.consolidadoEm = timestamp;
    const before = JSON.stringify(target);
    expect(await f.create().reprocessarParciais(29, 2026)).toMatchObject({ status: 'PARCIAL', statusRodada: 'CONSOLIDADA',
      resultado: 'COM_PENDENCIAS', pendentes: 1, rodadaConsolidada: false });
    expect(f.round.status).toBe('CONSOLIDADA');
    expect(f.round.consolidadoEm).toEqual(timestamp);
    expect(JSON.stringify(target)).toBe(before);
    expect(f.sincronizacao.sincronizarRodada).not.toHaveBeenCalled();
  });
  it('ausencia omitida exige cobertura do clube mesmo com partidas encerradas', async () => {
    const { f, source, target } = await historical();
    Object.values(source.atletas).forEach(a => { a.clube_id = 266; });
    expect(await f.create().reprocessarParciais(29, 2026)).toMatchObject({ pendentes: 1, atualizados: 0, rodadaConsolidada: false });
    expect(target.pontuacao.pontuacao.toNumber()).toBe(133.07);
    expect(target.substituicoes).toEqual([]);
  });
  it('snapshot invalido e snapshot sem titulares sao nao verificaveis', async () => {
    const { f, target } = await historical();
    target.capitaoId = 999;
    f.teams.push({ ...target, id: 2, timeId: 2, escalacao: [] });
    f.round.timesPrevistos = [30157355, 2];
    expect(await f.create().reprocessarParciais(29, 2026)).toMatchObject({ totalTimes: 2, naoVerificaveis: 2, atualizados: 0, rodadaConsolidada: false });
    expect(f.prisma.$executeRaw).not.toHaveBeenCalled();
  });
  it('historico sem nenhum snapshot informa motivos sem recapturar', async () => {
    const { f } = await historical();
    f.teams.splice(0);
    expect(await f.create().reprocessarParciais(29, 2026)).toMatchObject({ totalTimes: 1, naoVerificaveis: 1, atualizados: 0, rodadaConsolidada: false });
    expect(f.prisma.$executeRaw).not.toHaveBeenCalled();
    expect(f.snapshots.criarSnapshot).not.toHaveBeenCalled();
  });
  it('todos comprovados consolidam uma vez; repeticao nao escreve nem sincroniza', async () => {
    const { f, target } = await historical();
    // Capitao com zero e participacao true nao e tratado como ausente.
    expect(await f.create().reprocessarParciais(29, 2026)).toMatchObject({ atualizados: 1, rodadaConsolidada: true, resultado: 'ATUALIZADO' });
    expect(target.substituicoes.some((r: any) => r.atletaSaiuId === 11)).toBe(false);
    const date = f.round.consolidadoEm;
    f.prisma.$executeRaw.mockClear(); f.sincronizacao.sincronizarRodada.mockClear();
    expect(await f.create().reprocessarParciais(29, 2026)).toMatchObject({ status: 'FINAL', atualizados: 0,
      inalterados: 1, rodadaConsolidada: true, resultado: 'SEM_ALTERACOES' });
    expect(f.round.consolidadoEm).toEqual(date);
    expect(f.prisma.$executeRaw).not.toHaveBeenCalled();
    expect(f.sincronizacao.sincronizarRodada).not.toHaveBeenCalled();
  });
  it('completa consolidacao global depois sem regravar time ja comprovado', async () => {
    const { f, matches } = await historical();
    addUnfinishedMatch(matches);
    await f.create().reprocessarParciais(29, 2026);
    matches.partidas[1].periodo_tr = 'F';
    f.prisma.$executeRaw.mockClear();
    expect(await f.create().reprocessarParciais(29, 2026)).toMatchObject({ rodadaConsolidada: true, atualizados: 0, inalterados: 1 });
    expect(f.round.status).toBe('CONSOLIDADA');
    expect(f.prisma.$executeRaw).not.toHaveBeenCalled();
  });
  it('historico reavalia Reserva de Luxo com todas as participacoes comprovadas', async () => {
    const { f, target, source } = await historical();
    target.reservaLuxoId = 124219;
    source.atletas['10'] = { pontuacao: 1, entrou_em_campo: true, clube_id: 1 };
    source.total_atletas++;
    expect(await f.create().reprocessarParciais(29, 2026)).toMatchObject({ atualizados: 1, pendentes: 0, rodadaConsolidada: true });
    expect(target.substituicoes).toEqual([{ atletaSaiuId: 10, atletaEntrouId: 124219, posicaoId: 3 }]);
    expect(target.pontuacao.pontuacao.toNumber()).toBe(140.27);
  });
  it('lock historico impede duas avaliacaoes simultaneas', async () => {
    const { f } = await historical('');
    const results = await Promise.allSettled([f.create().reprocessarParciais(29, 2026), f.create().reprocessarParciais(29, 2026)]);
    expect(results.filter(r => r.status === 'fulfilled')).toHaveLength(1);
    expect(results.find(r => r.status === 'rejected')).toMatchObject({ reason: { status: 409 } });
    expect(f.round.lockToken).toBeNull();
  });
  it('mudanca dos times previstos antes do commit bloqueia consolidacao e gravacao', async () => {
    const { f } = await historical();
    f.cartola.loadMarketStatusFresh.mockImplementation(async () => {
      // A leitura final ocorre depois que os snapshots foram avaliados.
      if (f.prisma.timeRodada.findMany.mock.calls.length >= 2) f.round.timesPrevistos = [30157355, 999];
      return { temporada: 2026, rodada_atual: 30, status_mercado: 1, bola_rolando: false };
    });
    await expect(f.create().reprocessarParciais(29, 2026)).rejects.toMatchObject({ status: 409 });
    expect(f.prisma.$executeRaw).not.toHaveBeenCalled();
    expect(f.sincronizacao.sincronizarRodada).not.toHaveBeenCalled();
  });
  it.each([false, true])('reconsolida historica, inclusive consolidada=%s, com prova final e sincroniza apos commit', async (consolidated) => {
    const { f, target, source } = await historical('F', consolidated);
    const frozen = JSON.stringify(target.escalacao);
    f.sincronizacao.sincronizarRodada.mockImplementation(async () => {
      expect(target.pontuacao.status).toBe('FINAL');
      expect(f.round.lockToken).toBeNull();
    });
    expect(await f.create().reprocessarParciais(29, 2026)).toMatchObject({ status: 'FINAL', timesProcessados: 1 });
    expect(target.pontuacao.pontuacao.toNumber()).toBe(140.27);
    expect(target.substituicoes).toEqual([{ atletaSaiuId: 10, atletaEntrouId: 124219, posicaoId: 3 }]);
    expect(effectiveLineup(target, target.substituicoes).filter(a => source.atletas[a.atletaId]?.entrou_em_campo)).toHaveLength(12);
    expect(await f.create().reprocessarParciais(29, 2026)).toMatchObject({ substituicoesAlteradas: 0 });
    expect(target.substituicoes).toHaveLength(1);
    expect(JSON.stringify(target.escalacao)).toBe(frozen);
    expect(f.snapshots.criarSnapshot).not.toHaveBeenCalled();
    expect(f.sincronizacao.sincronizarRodada).toHaveBeenCalledWith(2026, 29);
  });
  it.each(['', 'SEGUNDO_TEMPO'])('preserva historica sem prova final: %s', async (periodo) => {
    const { f, target } = await historical(periodo);
    const previous = JSON.stringify(f.round.pontuados);
    expect(await f.create().reprocessarParciais(29, 2026)).toMatchObject({
      status: 'PARCIAL', resultado: 'COM_PENDENCIAS', atualizados: 0, pendentes: 1, rodadaConsolidada: false,
    });
    expect(target.pontuacao.pontuacao.toNumber()).toBe(133.07);
    expect(target.substituicoes).toEqual([]);
    expect(JSON.stringify(f.round.pontuados)).toBe(previous);
    expect(f.prisma.$executeRaw).not.toHaveBeenCalled();
    expect(f.sincronizacao.sincronizarRodada).not.toHaveBeenCalled();
    expect(f.round.lockToken).toBeNull();
  });
  it.each(['', 'SEGUNDO_TEMPO'])('preserva confirmacao final anterior quando periodo oficial retorna %s', async (periodo) => {
    const { f } = await historical(periodo);
    f.round.partidas.partidas[0].periodo_tr = 'POS_JOGO';
    expect(await f.create().reprocessarParciais(29, 2026)).toMatchObject({ status: 'FINAL' });
  });
  it.each(['incompleto', 'participacao', 'clube', 'identidade', 'temporada'])('preserva resultado com fonte %s', async (condition) => {
    const { f, source, matches, target } = await historical('F', true);
    if (condition === 'incompleto') source.total_atletas++;
    if (condition === 'participacao') delete source.atletas['124219'].entrou_em_campo;
    if (condition === 'clube') target.escalacao[0].clubeId = 999;
    if (condition === 'identidade') { f.round.partidas.partidas[0].periodo_tr = 'F'; matches.partidas[0].clube_visitante_id = 777; }
    if (condition === 'temporada') matches.partidas[0].timestamp = 1000;
    if (condition === 'identidade' || condition === 'temporada') {
      await expect(f.create().reprocessarParciais(29, 2026)).rejects.toMatchObject({ status: 409 });
    } else {
      expect(await f.create().reprocessarParciais(29, 2026)).toMatchObject({ pendentes: 1, atualizados: 0, rodadaConsolidada: false });
    }
    expect(target.pontuacao.status).toBe('FINAL');
    expect(target.pontuacao.pontuacao.toNumber()).toBe(133.07);
    expect(f.prisma.$executeRaw).not.toHaveBeenCalled();
  });
  it('falha da API libera lease e preserva resultados', async () => {
    const { f, target } = await historical();
    f.cartola.loadAdministrativeScoredAthletesFresh.mockRejectedValue(new Error('API indisponivel'));
    await expect(f.create().reprocessarParciais(29, 2026)).rejects.toThrow('API indisponivel');
    expect(f.round.lockToken).toBeNull();
    expect(target.pontuacao.pontuacao.toNumber()).toBe(133.07);
    expect(f.prisma.$executeRaw).not.toHaveBeenCalled();
  });
  it('falha transacional da reconsolidacao preserva evidencias novas sem publicar resultados', async () => {
    const { f } = await historical();
    f.failCommit(true);
    await expect(f.create().reprocessarParciais(29, 2026)).rejects.toThrow('Database unavailable');
    expect(f.round.partidas.partidas[0].periodo_tr).toBe('F');
    expect(f.teams[0].pontuacao.pontuacao.toNumber()).toBe(133.07);
    expect(f.round.status).toBe('EM_ANDAMENTO');
    expect(f.round.lockToken).toBeNull();
    expect(f.sincronizacao.sincronizarRodada).not.toHaveBeenCalled();
  });
  it('sem total declarado nao presume completude para consolidar', async () => {
    const { f, source } = await historical();
    const incomplete: CartolaScoredAthletesPayload = { rodada: source.rodada, atletas: source.atletas };
    f.cartola.loadAdministrativeScoredAthletesFresh.mockResolvedValue(incomplete as typeof source);
    expect(await f.create().reprocessarParciais(29, 2026)).toMatchObject({ pendentes: 1, atualizados: 0, rodadaConsolidada: false });
    expect(f.prisma.$executeRaw).not.toHaveBeenCalled();
  });
  it('mudanca de temporada antes do commit impede gravacao', async () => {
    const { f } = await historical();
    f.cartola.loadMarketStatusFresh.mockResolvedValueOnce({ temporada: 2026, rodada_atual: 30, status_mercado: 1, bola_rolando: false })
      .mockResolvedValueOnce({ temporada: 2027, rodada_atual: 1, status_mercado: 1, bola_rolando: false });
    await expect(f.create().reprocessarParciais(29, 2026)).rejects.toMatchObject({ status: 409 });
    expect(f.prisma.$executeRaw).not.toHaveBeenCalled();
  });
  it('nao rebaixa pontuacao final individual durante parcial atual', async () => {
    const f = setup(); f.closed(); await f.create().tick();
    f.teams[0].pontuacao.status = 'FINAL';
    f.teams[0].pontuacao.pontuacao = new Prisma.Decimal(999);
    expect(await f.create().reprocessarParciais(25, 2026)).toMatchObject({ status: 'PARCIAL', timesProcessados: 2, timesComErro: 1 });
    expect(f.teams[0].pontuacao.status).toBe('FINAL');
    expect(f.teams[0].pontuacao.pontuacao.toNumber()).toBe(999);
  });
  it('rejeita outra temporada e rodada futura antes de consultar pontuados', async () => {
    const { f } = await historical();
    await expect(f.create().reprocessarParciais(29, 2025)).rejects.toMatchObject({ status: 400 });
    await expect(f.create().reprocessarParciais(31, 2026)).rejects.toMatchObject({ status: 400 });
    expect(f.cartola.loadAdministrativeScoredAthletesFresh).not.toHaveBeenCalled();
  });
  it('recalcula todos sem diff, corrige substituicoes e repete sem duplicar nem alterar snapshots', async () => {
    const f = setup(); f.closed(); await f.create().tick();
    const frozen = JSON.stringify(f.teams.map((t) => t.escalacao));
    f.teams[0].substituicoes = [{ atletaSaiuId: 10, atletaEntrouId: 99, posicaoId: 5 }];
    f.teams.forEach((t) => { t.pontuacao.pontuacao = new Prisma.Decimal(999); });
    jest.clearAllMocks();
    const result = await f.create().reprocessarParciais(25, 2026);
    expect(result).toMatchObject({ temporada: 2026, rodada: 25, status: 'PARCIAL', timesProcessados: 3, timesComErro: 0, substituicoesAlteradas: 1 });
    expect(f.teams.map((t) => t.pontuacao.pontuacao.toNumber())).toEqual([15, 15, 6]);
    expect(f.teams[0].substituicoes).toEqual([]);
    expect(await f.create().reprocessarParciais(25, 2026)).toMatchObject({ timesProcessados: 3, substituicoesAlteradas: 0 });
    expect(f.teams).toHaveLength(3);
    expect(JSON.stringify(f.teams.map((t) => t.escalacao))).toBe(frozen);
    expect(f.teams.every((t) => t.pontuacao.status === 'PARCIAL' && t.pontuacao.consolidadoEm === null)).toBe(true);
    expect(f.round).toMatchObject({ status: 'EM_ANDAMENTO', consolidadoEm: null, lockToken: null, lockAte: null });
    expect(f.snapshots.criarSnapshot).not.toHaveBeenCalled();
    expect(f.cartola.loadAdministrativeScoredAthletesFresh).toHaveBeenCalledTimes(2);
    expect(f.cartola.loadMatchesFresh).toHaveBeenCalledTimes(2);
    expect(f.cartola.getTeamById).not.toHaveBeenCalled();
    expect(f.cartola.loadFinalScoredAthletesFresh).not.toHaveBeenCalled();
    expect(f.prisma.timeRodada.findMany.mock.calls.every(([args]) => !args.where.OR)).toBe(true);
  });
  it('reavalia reserva de luxo e aplica capitao 1,5, mantendo uma unica substituicao', async () => {
    const f = setup(); f.closed(); await f.create().tick();
    f.teams[0].reservaLuxoId = 12;
    f.teams[0].escalacao.push({ atletaId: 12, posicaoId: 5, clubeId: 2, titular: false, reserva: true, capitao: false });
    f.points({ rodada: 25, atletas: { ...f.round.pontuados.atletas, '12': { pontuacao: 20, entrou_em_campo: true } } });
    f.end();
    expect(await f.create().reprocessarParciais(25, 2026)).toMatchObject({ substituicoesAlteradas: 1 });
    expect(f.teams[0].pontuacao.pontuacao.toNumber()).toBe(30);
    expect(await f.create().reprocessarParciais(25, 2026)).toMatchObject({ substituicoesAlteradas: 0 });
    expect(f.teams[0].substituicoes).toEqual([{ atletaSaiuId: 10, atletaEntrouId: 12, posicaoId: 5 }]);
    expect(f.prisma.$executeRaw.mock.calls.some(([sql]) => sql.sql.includes('ON DUPLICATE KEY UPDATE ATIVA=true'))).toBe(true);
  });
  it('404 para rodada inexistente e 400 para parametros invalidos', async () => {
    const f = setup();
    await expect(f.create().reprocessarParciais(25, 2026)).rejects.toMatchObject({ status: 404 });
    await expect(f.create().reprocessarParciais(39, 2026)).rejects.toMatchObject({ status: 400 });
    await expect(f.create().reprocessarParciais(25, 0)).rejects.toMatchObject({ status: 400 });
  });
  it.each(['lock', 'snapshot'])('409 para %s', async (condition) => {
    const f = setup(); f.closed(); await f.create().tick();
    if (condition === 'lock') { f.round.lockToken = 'outro'; f.round.lockAte = new Date(Date.now() + 120000); }
    if (condition === 'snapshot') f.teams.pop();
    f.prisma.$executeRaw.mockClear();
    await expect(f.create().reprocessarParciais(25, 2026)).rejects.toMatchObject({ status: 409 });
    expect(f.prisma.$executeRaw).not.toHaveBeenCalled();
    expect(f.round.lockToken).toBe(condition === 'lock' ? 'outro' : null);
  });
  it('lease impede dois workers simultaneos', async () => {
    const f = setup(); f.closed(); await f.create().tick();
    const results = await Promise.allSettled([f.create().reprocessarParciais(25, 2026), f.create().reprocessarParciais(25, 2026)]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(results.find((r) => r.status === 'rejected')).toMatchObject({ reason: { status: 409 } });
    expect(f.round.lockToken).toBeNull();
  });
  it('contabiliza erro de time e libera lease apos falha de persistencia', async () => {
    const f = setup(); f.closed(); await f.create().tick();
    f.teams[0].capitaoId = 999;
    expect(await f.create().reprocessarParciais(25, 2026)).toMatchObject({ timesProcessados: 2, timesComErro: 1 });
    f.failCommit(true);
    await expect(f.create().reprocessarParciais(25, 2026)).rejects.toThrow('Database unavailable');
    expect(f.round.lockToken).toBeNull();
  });
});

describe('Ciclo persistido de rodadas', () => {
  beforeAll(() => Logger.overrideLogger([]));
  it('aberto -> fechado captura times deduplicados antes de qualquer pontuado', async () => {
    const f = setup(); const worker = f.create();
    await worker.tick(); expect(f.snapshots.criarSnapshot).not.toHaveBeenCalled();
    f.closed(); await worker.tick();
    expect(f.events).toEqual(['snapshot:1', 'snapshot:2', 'snapshot:3', 'pontuados', 'sincronizacao']);
    expect(f.round.timesPrevistos).toEqual([1, 2, 3]);
    expect(f.round.status).toBe('EM_ANDAMENTO');
    expect(f.teams.map((t) => t.pontuacao.pontuacao.toNumber())).toEqual([15, 15, 6]);
    await worker.tick(); expect(f.snapshots.criarSnapshot).toHaveBeenCalledTimes(3);
  });
  it('sincroniza apos persistir PARCIAL, uma vez por lote alterado', async () => {
    const f = setup(); f.closed();
    f.sincronizacao.sincronizarRodada.mockImplementation(async () => {
      expect(f.teams.every(team => team.pontuacao?.status === 'PARCIAL')).toBe(true);
      expect(f.round.lockToken).toBeNull();
    });
    await f.create().tick();
    expect(f.sincronizacao.sincronizarRodada).toHaveBeenCalledWith(2026, 25);
    expect(f.sincronizacao.sincronizarRodada).toHaveBeenCalledTimes(1);
    await f.create().tick();
    expect(f.sincronizacao.sincronizarRodada).toHaveBeenCalledTimes(1);
  });
  it('sincroniza novamente apos consolidar FINAL', async () => {
    const f = setup(); f.closed(); await f.create().tick();
    f.sincronizacao.sincronizarRodada.mockClear();
    f.sincronizacao.sincronizarRodada.mockImplementation(async () => {
      expect(f.teams.every(team => team.pontuacao?.status === 'FINAL')).toBe(true);
      expect(f.round.lockToken).toBeNull();
    });
    f.end(); f.open(); await f.create().tick();
    expect(f.round.status).toBe('CONSOLIDADA');
    expect(f.sincronizacao.sincronizarRodada).toHaveBeenCalledTimes(1);
  });
  it('falha da sincronizacao nao desfaz pontuacao nem estado da rodada', async () => {
    const f = setup(); f.closed();
    f.sincronizacao.sincronizarRodada.mockRejectedValueOnce(new Error('Falha da competicao'));
    await f.create().tick();
    expect(f.round.status).toBe('EM_ANDAMENTO');
    expect(f.teams.every(team => team.pontuacao?.status === 'PARCIAL')).toBe(true);
    expect(f.sincronizacao.sincronizarRodada).toHaveBeenCalledTimes(1);
  });
  it('inclui times com inscricao ativa mesmo sem vinculo em TIME_USUARIO', async () => {
    const f = setup();
    f.prisma.inscricaoTimeCompeticao.findMany.mockResolvedValue([{ timeIdCartola: 4 }]);
    f.closed();
    await f.create().tick();
    expect(f.round.timesPrevistos).toEqual([1, 2, 3, 4]);
    expect(f.snapshots.criarSnapshot).toHaveBeenCalledWith(expect.objectContaining({ timeId: 4, rodada: 25, temporada: 2026 }));
    expect(f.prisma.inscricaoTimeCompeticao.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ statusInscricao: 'ATIVA' }),
    }));
  });
  it('incorpora inscricao nova quando a rodada ja existe', async () => {
    const f = setup(); f.closed();
    await f.create().tick();
    f.prisma.inscricaoTimeCompeticao.findMany.mockResolvedValue([{ timeIdCartola: 4 }]);
    await f.create().tick();
    expect(f.round.timesPrevistos).toEqual([1, 2, 3, 4]);
    expect(f.snapshots.criarSnapshot.mock.calls.map(([arg]) => arg.timeId)).toEqual([1, 2, 3, 4]);
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
  it.each([false, true])('corrigir apenas pontos aplica e reverte substituicao com luxo=%s', async (luxury) => {
    const f = setup(); f.closed(); const worker = f.create(); await worker.tick();
    const target = f.teams[0];
    target.reservaLuxoId = luxury ? 20 : null;
    target.escalacao.push({ atletaId: 20, posicaoId: 5, clubeId: 2, titular: false, reserva: true, capitao: false });
    const update = (reservePoints: number) => f.points({ rodada: 25, atletas: {
      '10': { pontuacao: luxury ? 10 : 0, entrou_em_campo: luxury },
      '11': { pontuacao: 4, entrou_em_campo: true },
      '20': { pontuacao: reservePoints, entrou_em_campo: true },
    } });
    f.end(); update(0); await worker.tick();
    expect(target.substituicoes).toEqual([]);
    update(12); await worker.tick();
    expect(f.round.erro).toBeNull();
    expect(target.substituicoes).toEqual([{ atletaSaiuId: 10, atletaEntrouId: 20, posicaoId: 5 }]);
    expect(target.pontuacao.pontuacao.toNumber()).toBe(18);
    expect(target.pontuacao.status).toBe('PARCIAL');
    update(0); await worker.tick();
    expect(target.substituicoes).toEqual([]);
    expect(target.pontuacao.pontuacao.toNumber()).toBe(luxury ? 15 : 0);
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
    const f = setup(); f.closed(); await f.create().tick(); f.end(); f.open(); f.failCommit(true);
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
    expect(f.round.partidas.partidas[0].periodo_tr).toBe('2T');
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
    const f = setup(); f.closed(); await f.create().tick(); f.end(); f.open(); await f.create().tick();
    const before = f.teams.map((t) => t.pontuacao.pontuacao.toString());
    await f.create().reconsolidarRodada(25, 2026); await f.create().reconsolidarRodada(25, 2026);
    expect(f.teams.map((t) => t.pontuacao.pontuacao.toString())).toEqual(before);
    expect(f.snapshots.criarSnapshot).toHaveBeenCalledTimes(3);
    await expect(f.create().reconsolidarRodada(24, 2025)).rejects.toThrow('temporada');
  });
  it('ajustes de placar e relogio nao reavaliam times sem scouts alterados', async () => {
    const f = setup(); f.closed(); await f.create().tick(); f.prisma.$executeRaw.mockClear();
    f.matches({ rodada: 25, clubes: {}, partidas: [{ partida_id: 1, clube_casa_id: 1, clube_visitante_id: 2,
      valida: true, periodo_tr: '2T', timestamp: 1767225600, placar_oficial_mandante: 2, inicio_cronometro_tr: '15:00' }] });
    await f.create().tick(); expect(f.prisma.$executeRaw).not.toHaveBeenCalled();
  });
  it('conciliacao reavalia luxo sobre snapshot, persiste troca e recalcula todos', async () => {
    const f = setup(); f.closed(); await f.create().tick();
    const original = f.teams[0];
    original.reservaLuxoId = 20;
    original.escalacao.push({ atletaId: 20, posicaoId: 5, clubeId: 2, titular: false, reserva: true, capitao: false });
    f.points({ rodada: 25, atletas: { '10': { pontuacao: 1, entrou_em_campo: true }, '11': { pontuacao: 4, entrou_em_campo: true }, '20': { pontuacao: 8, entrou_em_campo: true } } });
    f.end(); f.open(); f.prisma.$executeRaw.mockClear(); await f.create().tick();
    expect(f.round.status).toBe('CONSOLIDADA');
    expect(f.teams[0].pontuacao.pontuacao.toNumber()).toBe(12);
    expect(f.prisma.$executeRaw.mock.calls.some(([sql]) => sql.sql.includes('INSERT INTO SUBSTITUICAO'))).toBe(true);
    expect(original.escalacao[0].titular).toBe(true);
    expect(original.escalacao[1].reserva).toBe(true);
  });
  it('participacao ausente impede consolidacao sem apagar ultima parcial', async () => {
    const f = setup(); f.closed(); await f.create().tick();
    f.teams[0].escalacao.push({ atletaId: 20, posicaoId: 5, clubeId: 2, titular: false, reserva: true, capitao: false });
    f.end(); f.open(); await f.create().tick();
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

  it.each(['', 'SEGUNDO_TEMPO'])('automatico preserva termino e substituicao com regressao %s', async (periodo) => {
    const f = setup(); f.closed(); await f.create().tick();
    f.teams[0].escalacao.push({ atletaId: 20, posicaoId: 5, clubeId: 2, titular: false, reserva: true, capitao: false });
    f.points({ rodada: 25, total_atletas: 3, atletas: {
      '10': { pontuacao: 0, entrou_em_campo: false, clube_id: 1 },
      '11': { pontuacao: 4, entrou_em_campo: true, clube_id: 1 },
      '20': { pontuacao: 8, entrou_em_campo: true, clube_id: 2 },
    } });
    f.end(); await f.create().tick();
    expect(f.teams[0].pontuacao.pontuacao.toNumber()).toBe(12);
    f.matches({ rodada: 25, clubes: {}, partidas: [{ partida_id: 1, clube_casa_id: 1, clube_visitante_id: 2,
      valida: true, periodo_tr: periodo, timestamp: 1767225600 }] });
    await f.create().tick();
    expect(f.round.partidas.partidas[0].periodo_tr).toBe('F');
    expect(f.teams[0].substituicoes).toHaveLength(1);
    expect(f.teams[0].pontuacao.pontuacao.toNumber()).toBe(12);
  });
  it('guarda partidas e envelope completos apos erro de calculo; retenta sem diff', async () => {
    const f = setup(); f.closed(); await f.create().tick();
    f.teams[0].capitaoId = 999;
    f.points({ rodada: 25, total_atletas: 2, atletas: {
      '10': { pontuacao: 20, entrou_em_campo: true }, '11': { pontuacao: 4, entrou_em_campo: true },
    } });
    f.end(); await f.create().tick();
    expect(f.round.partidas.partidas[0].periodo_tr).toBe('F');
    expect(f.round.pontuados.atletas['10'].pontuacao).toBe(20);
    expect(f.teams[0].pontuacao.pontuacao.toNumber()).toBe(15);
    expect(f.round.erro).toBeTruthy();
    f.teams[0].capitaoId = 10;
    await f.create().tick();
    expect(f.teams[0].pontuacao.pontuacao.toNumber()).toBe(30);
    expect(f.round.erro).toBeNull();
  });
  it('nao sobrescreve evidencia completa nem resultados com pontuados incompletos', async () => {
    const f = setup(); f.closed(); await f.create().tick();
    f.points({ rodada: 25, total_atletas: 2, atletas: {
      '10': { pontuacao: 20, entrou_em_campo: true }, '11': { pontuacao: 4, entrou_em_campo: true },
    } });
    await f.create().tick();
    f.points({ rodada: 25, atletas: { '10': { pontuacao: 0, entrou_em_campo: false } } });
    await f.create().tick();
    expect(f.round.pontuados.total_atletas).toBe(2);
    expect(f.teams[0].pontuacao.pontuacao.toNumber()).toBe(30);
    expect(f.round.erro).toContain('Envelope incompleto');
  });
  it('campo de participacao omitido nao apaga participacao explicita anterior', async () => {
    const f = setup(); f.closed(); await f.create().tick();
    f.points({ rodada: 25, total_atletas: 2, atletas: {
      '10': { pontuacao: 0 }, '11': { pontuacao: 4, entrou_em_campo: true },
    } });
    await f.create().tick();
    expect(f.round.pontuados.atletas['10'].entrou_em_campo).toBe(true);
    expect(f.teams[0].pontuacao.pontuacao.toNumber()).toBe(15);
    expect(f.round.erro).toContain('Participacao oficial incompleta');
  });
  it.each(['identidade', 'validade', 'ausente', 'temporada', 'rodada'])('automatico bloqueia correcao conflitante %s', async (condition) => {
    const f = setup(); f.closed(); await f.create().tick(); f.end(); await f.create().tick();
    const before = JSON.stringify(f.round.partidas);
    const incoming = JSON.parse(before) as CartolaMatchesResponse;
    if (condition === 'identidade') incoming.partidas[0].clube_casa_id = 777;
    if (condition === 'validade') incoming.partidas[0].valida = false;
    if (condition === 'ausente') incoming.partidas = [];
    if (condition === 'temporada') incoming.temporada = 2025;
    if (condition === 'rodada') incoming.rodada = 24;
    f.matches(incoming); f.prisma.$executeRaw.mockClear();
    await f.create().tick();
    expect(JSON.stringify(f.round.partidas)).toBe(before);
    expect(f.round.erro).toBeTruthy();
    expect(f.prisma.$executeRaw).not.toHaveBeenCalled();
  });
  it.each(['antes', 'andamento'])('nao antecipa substituicao com participacao false e jogo %s', async (condition) => {
    const f = setup(); f.closed(); await f.create().tick();
    f.teams[0].escalacao.push({ atletaId: 20, posicaoId: 5, clubeId: 2, titular: false, reserva: true, capitao: false });
    f.points({ rodada: 25, total_atletas: 3, atletas: {
      '10': { pontuacao: 0, entrou_em_campo: false }, '11': { pontuacao: 4, entrou_em_campo: true },
      '20': { pontuacao: 8, entrou_em_campo: true },
    } });
    f.matches({ rodada: 25, clubes: {}, partidas: [{ partida_id: 1, clube_casa_id: 1, clube_visitante_id: 2,
      valida: true, periodo_tr: condition === 'antes' ? '' : '2T',
      timestamp: condition === 'antes' ? Date.now() / 1000 + 3600 : 1767225600 }] });
    await f.create().tick();
    expect(f.teams[0].substituicoes).toEqual([]);
    expect(f.round.erro).toBeTruthy();
  });
  it('aplica troca progressiva antes do fim de partida de outra posicao', async () => {
    const f = setup(); f.closed(); await f.create().tick();
    f.teams[0].escalacao.push(
      { atletaId: 20, posicaoId: 5, clubeId: 2, titular: false, reserva: true, capitao: false },
      { atletaId: 21, posicaoId: 4, clubeId: 3, titular: true, reserva: false, capitao: false },
    );
    f.points({ rodada: 25, total_atletas: 4, atletas: {
      '10': { pontuacao: 0, entrou_em_campo: false }, '11': { pontuacao: 4, entrou_em_campo: true },
      '20': { pontuacao: 8, entrou_em_campo: true }, '21': { pontuacao: 2, entrou_em_campo: true },
    } });
    f.matches({ rodada: 25, clubes: {}, partidas: [
      { partida_id: 1, clube_casa_id: 1, clube_visitante_id: 2, valida: true, periodo_tr: 'F', timestamp: 1767225600 },
      { partida_id: 2, clube_casa_id: 3, clube_visitante_id: 4, valida: true, periodo_tr: '2T', timestamp: 1767225600 },
    ] });
    await f.create().tick();
    expect(f.teams[0].substituicoes).toEqual([{ atletaSaiuId: 10, atletaEntrouId: 20, posicaoId: 5 }]);
    expect(f.teams[0].pontuacao.pontuacao.toNumber()).toBe(14);
    expect(f.teams[0].pontuacao.status).toBe('PARCIAL');
    expect(f.round.status).not.toBe('CONSOLIDADA');
    expect(effectiveLineup(f.teams[0], f.teams[0].substituicoes).find(a => a.capitao)?.atletaId).toBe(20);
    f.teams[0].escalacao.push({ atletaId: 22, posicaoId: 4, clubeId: 4, titular: false, reserva: true, capitao: false });
    f.teams[0].reservaLuxoId = 22;
    f.points({ ...f.round.pontuados, total_atletas: 5, atletas: {
      ...f.round.pontuados.atletas, '22': { pontuacao: 3, entrou_em_campo: true },
    } });
    await f.create().tick();
    expect(f.teams[0].substituicoes).toHaveLength(1);
    expect(f.teams[0].pontuacao.pontuacao.toNumber()).toBe(14);
    expect(f.round.erro).toBeTruthy();
    f.matches({ ...f.round.partidas, partidas: f.round.partidas.partidas.map((m: any) => ({ ...m, periodo_tr: 'F' })) });
    await f.create().tick();
    expect(f.round.erro).toBeNull();
    expect(f.teams[0].substituicoes).toHaveLength(2);
    expect(f.teams[0].pontuacao.pontuacao.toNumber()).toBe(15);
  });
});
