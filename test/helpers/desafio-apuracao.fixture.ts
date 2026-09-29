import { Prisma } from '@prisma/client';
import { AdminDesafioApuracaoService } from '../../src/admin/admin-desafio-apuracao.service';
import { DesafioRankingService } from '../../src/desafios/desafio-ranking.service';
import { FootballDataClient } from '../../src/futebol/football-data.client';
import { mapDesafioResultado } from '../../src/futebol/football-data-desafio-resultado';
import { PrismaService } from '../../src/prisma/prisma.service';

export function resultadoOficial(id = 100, home = 2, away = 0, status = 'FINISHED') {
  return mapDesafioResultado({ id, status, utcDate: '2030-10-01T12:00:00Z', competition: { id: 2013, name: 'Serie A' },
    homeTeam: { id: 1, name: 'Casa' }, awayTeam: { id: 2, name: 'Fora' }, score: { duration: 'REGULAR', fullTime: { home, away } } });
}

export function desafioApuracaoFixture() {
  const data = new Date('2030-10-01T12:00:00Z');
  const state: { desafio: any; partidas: any[]; palpites: any[]; inscricoes: any[] } = {
    desafio: { id: 7, status: 'ABERTO', publicadoEm: new Date('2030-09-01T00:00:00Z'),
      inicioInscricao: new Date('2030-09-01T00:00:00Z'), dataInicio: data, dataFim: new Date('2030-10-02T00:00:00Z'), atualizadoEm: data },
    partidas: [{ id: 1, desafioId: 7, fixtureIdApiFootball: 100, leagueIdApiFootball: 2013,
      mandanteIdApiFootball: 1, visitanteIdApiFootball: 2, status: 'AGENDADA', resultado: null,
      golsMandante: null, golsVisitante: null, dataInicio: data, atualizadoEm: data }],
    palpites: ['CASA', 'EMPATE', 'FORA'].map((palpite, index) => ({ id: index + 1, desafioId: 7,
      desafioPartidaId: 1, usuarioId: index + 1, palpite, pontos: null, apurado: false })),
    inscricoes: [1, 2, 3].map(usuarioId => ({ usuarioId, desafioId: 7, status: 'ATIVA',
      usuario: { idUsuario: usuarioId, nome: `Usuario ${usuarioId}`, fotoUrl: null } })),
  };
  const proibido = jest.fn(() => { throw new Error('Apuracao/ranking nao pode movimentar dinheiro'); });
  const tx: any = {
    $queryRaw: jest.fn(async () => state.desafio ? [{ ID: 7n }] : []),
    desafio: {
      findUnique: jest.fn(async () => state.desafio ? { ...state.desafio, partidas: state.partidas.map(p => ({ ...p })) } : null),
      findFirst: jest.fn(async ({ where }) => state.desafio && where.id === state.desafio.id
        && where.status.in.includes(state.desafio.status) && state.desafio.publicadoEm
        && state.desafio.publicadoEm <= where.publicadoEm.lte && state.desafio.inicioInscricao <= where.inicioInscricao.lte
        ? { ...state.desafio } : null),
      update: jest.fn(async ({ data: fields }) => { state.desafio = { ...state.desafio, ...fields }; return state.desafio; }),
    },
    desafioPartida: {
      findMany: jest.fn(async ({ where }) => state.partidas.filter(p => p.desafioId === where.desafioId)),
      update: jest.fn(async ({ where, data: fields }) => {
        state.partidas = state.partidas.map(p => p.id === where.id ? { ...p, ...fields } : p);
        return state.partidas.find(p => p.id === where.id);
      }),
    },
    desafioPalpite: {
      updateMany: jest.fn(async ({ where, data: fields }) => {
        let count = 0;
        state.palpites = state.palpites.map(p => {
          if (p.desafioId !== where.desafioId || p.desafioPartidaId !== where.desafioPartidaId
            || (where.palpite !== undefined && p.palpite !== where.palpite)) return p;
          count++; return { ...p, ...fields };
        }); return { count };
      }),
      groupBy: jest.fn(async ({ where }) => {
        const soma = new Map<number, number>();
        state.palpites.filter(p => p.desafioId === where.desafioId && where.usuarioId.in.includes(p.usuarioId)
          && where.desafioPartidaId.in.includes(p.desafioPartidaId) && p.apurado === where.apurado
          && p.pontos !== null && where.pontos.in.includes(Number(p.pontos)))
          .forEach(p => soma.set(p.usuarioId, (soma.get(p.usuarioId) ?? 0) + Number(p.pontos)));
        return [...soma].map(([usuarioId, pontos]) => ({ usuarioId, _sum: { pontos: new Prisma.Decimal(pontos) } }));
      }),
    },
    desafioInscricao: { findMany: jest.fn(async ({ where }) => state.inscricoes.filter(i => i.desafioId === where.desafioId && i.status === where.status)) },
    carteira: { update: proibido }, movimentacaoCarteira: { create: proibido },
  };
  let queue = Promise.resolve();
  const prisma: any = { ...tx, $transaction: jest.fn(async callback => {
    const previous = queue; let release!: () => void;
    queue = new Promise<void>(resolve => { release = resolve; }); await previous;
    const backup = { desafio: state.desafio && { ...state.desafio }, partidas: state.partidas.map(p => ({ ...p })),
      palpites: state.palpites.map(p => ({ ...p })), inscricoes: state.inscricoes.map(i => ({ ...i })) };
    try { return await callback(tx); } catch (error) { Object.assign(state, backup); throw error; } finally { release(); }
  }) };
  const api = { buscarResultadosPorIds: jest.fn(async (_ids: number[]) => [resultadoOficial()]) };
  const service = new AdminDesafioApuracaoService(prisma as PrismaService, api as unknown as FootballDataClient);
  const ranking = new DesafioRankingService(prisma as PrismaService);
  return { state, tx, prisma, api, service, ranking, proibido };
}
