import 'reflect-metadata';
import { BadRequestException, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { RankingCompeticaoService } from '../src/ligas-competicoes/ranking-competicao.service';
import { PrismaService } from '../src/prisma/prisma.service';

type StateRow = { id: number; competicaoLigaId: number; statusInscricao: 'ATIVA' | 'CANCELADA';
  pontuacao: Prisma.Decimal | null; posicao: number | null; posicaoAnterior: number | null; dataInscricao: Date;
  premioApurado: Prisma.Decimal | null };
const makeRow = (id: number, date: string, score: string | null, posicao: number | null,
  statusInscricao: StateRow['statusInscricao'] = 'ATIVA'): StateRow => ({
  id, competicaoLigaId: 1, statusInscricao, pontuacao: score === null ? null : new Prisma.Decimal(score),
  posicao, posicaoAnterior: null, dataInscricao: new Date(date), premioApurado: null,
});

describe('RankingCompeticaoService', () => {
  let state: StateRow[];
  let failAt: number | null;
  const tx = {
    $queryRaw: jest.fn(),
    inscricaoTimeCompeticao: { findMany: jest.fn(), updateMany: jest.fn() },
  };
  const prisma = {
    competicaoLiga: { findFirst: jest.fn() },
    inscricaoTimeCompeticao: { findMany: jest.fn() },
    timeRodada: { findMany: jest.fn() },
    escalacaoTimeRodada: { findMany: jest.fn() },
    $transaction: jest.fn(),
  };
  const service = new RankingCompeticaoService(prisma as unknown as PrismaService);
  beforeEach(() => {
    jest.clearAllMocks();
    state = [makeRow(1, '2026-09-01T00:00:00Z', '10.00', 2),
      makeRow(2, '2026-09-02T00:00:00Z', '20.00', 1),
      makeRow(3, '2026-09-03T00:00:00Z', null, null),
      makeRow(4, '2026-09-01T00:00:00Z', '99.00', 1, 'CANCELADA')];
    failAt = null;
    prisma.competicaoLiga.findFirst.mockResolvedValue({ id: 1, nome: 'POINT FFC - Rodada 27',
      rodadaInicio: null, rodadaFim: null, dataInicio: null });
    prisma.inscricaoTimeCompeticao.findMany.mockResolvedValue([]);
    prisma.timeRodada.findMany.mockResolvedValue([]);
    prisma.escalacaoTimeRodada.findMany.mockResolvedValue([]);
    prisma.$transaction.mockImplementation(async (callback: (client: typeof tx) => Promise<unknown>) => {
      const working = state.map(row => ({ ...row }));
      tx.$queryRaw.mockResolvedValue([{ ID: 1 }]);
      tx.inscricaoTimeCompeticao.findMany.mockImplementation(async () => working.filter(row => row.competicaoLigaId === 1 && row.statusInscricao === 'ATIVA')
        .map(({ id, pontuacao, posicao, dataInscricao }) => ({ id, pontuacao, posicao, dataInscricao })));
      tx.inscricaoTimeCompeticao.updateMany.mockImplementation(async ({ where, data }) => {
        if (failAt !== null && tx.inscricaoTimeCompeticao.updateMany.mock.calls.length === failAt) throw new Error('Falha de escrita');
        const row = working.find(item => item.id === where.id && item.competicaoLigaId === where.competicaoLigaId && item.statusInscricao === 'ATIVA');
        if (!row) return { count: 0 };
        row.pontuacao = data.pontuacao;
        row.posicaoAnterior = data.posicaoAnterior;
        row.posicao = data.posicao;
        return { count: 1 };
      });
      const result = await callback(tx);
      state = working;
      return result;
    });
  });

  it('retorna ranking vazio com quantidade zero', async () => {
    expect(await service.consultar(1)).toEqual({ competicaoId: 1, nomeCompeticao: 'POINT FFC - Rodada 27',
      quantidadeParticipantes: 0, ranking: [] });
  });

  it('consulta apenas ATIVA em ordem de posicao, pontuacao, data e ID', async () => {
    await service.consultar(1);
    expect(prisma.inscricaoTimeCompeticao.findMany.mock.calls[0][0]).toMatchObject({
      where: { competicaoLigaId: 1, statusInscricao: 'ATIVA' },
      orderBy: [{ posicao: { sort: 'asc', nulls: 'last' } },
        { pontuacao: { sort: 'desc', nulls: 'last' } }, { dataInscricao: 'asc' }, { id: 'asc' }],
    });
  });

  it('usa snapshot da inscricao e conta participantes retornados', async () => {
    prisma.inscricaoTimeCompeticao.findMany.mockResolvedValue([
      { id: 2, timeIdCartola: 200, nomeTime: 'Snapshot B', nomeCartoleiro: 'B', escudoUrl: null,
        pontuacao: new Prisma.Decimal('20.25'), posicao: 1, posicaoAnterior: 3, premioApurado: null },
      { id: 1, timeIdCartola: 100, nomeTime: 'Snapshot A', nomeCartoleiro: null, escudoUrl: 'escudo',
        pontuacao: null, posicao: null, posicaoAnterior: null, premioApurado: null },
    ]);
    expect(await service.consultar(1)).toEqual({ competicaoId: 1, nomeCompeticao: 'POINT FFC - Rodada 27', quantidadeParticipantes: 2,
      ranking: [
        { inscricaoId: 2, timeIdCartola: 200, nomeTime: 'Snapshot B', nomeCartoleiro: 'B', escudoUrl: null,
          pontuacao: 20.25, posicao: 1, posicaoAnterior: 3, premioApurado: null, capitao: null },
        { inscricaoId: 1, timeIdCartola: 100, nomeTime: 'Snapshot A', nomeCartoleiro: null, escudoUrl: 'escudo',
          pontuacao: null, posicao: null, posicaoAnterior: null, premioApurado: null, capitao: null },
      ] });
    expect(prisma.inscricaoTimeCompeticao.findMany.mock.calls[0][0].select).not.toHaveProperty('timeUsuario');
  });

  it('associa capitoes pelos snapshots da rodada em consultas de lote e preserva a ordem', async () => {
    prisma.competicaoLiga.findFirst.mockResolvedValue({ id: 1, nome: 'Rodada 27', rodadaInicio: 27,
      rodadaFim: 27, dataInicio: new Date('2026-09-01T00:00:00Z') });
    prisma.inscricaoTimeCompeticao.findMany.mockResolvedValue([200, 100, 300].map((timeIdCartola, index) => ({
      id: index + 1, timeIdCartola, nomeTime: `Time ${timeIdCartola}`, nomeCartoleiro: null,
      escudoUrl: null, pontuacao: null, posicao: null, posicaoAnterior: null, premioApurado: null,
    })));
    prisma.timeRodada.findMany.mockResolvedValue([
      { id: 10, timeId: 100, capitaoId: 91 }, { id: 20, timeId: 200, capitaoId: 92 },
    ]);
    prisma.escalacaoTimeRodada.findMany.mockResolvedValue([
      { timeRodadaId: 10, atletaId: 91, nome: 'Capitao A' },
      { timeRodadaId: 20, atletaId: 92, nome: 'Capitao B' },
    ]);
    const result = await service.consultar(1);
    expect(result.ranking.map(item => [item.timeIdCartola, item.capitao?.apelido ?? null])).toEqual([
      [200, 'Capitao B'], [100, 'Capitao A'], [300, null],
    ]);
    expect(prisma.timeRodada.findMany).toHaveBeenCalledTimes(1);
    expect(prisma.escalacaoTimeRodada.findMany).toHaveBeenCalledTimes(1);
    expect(prisma.timeRodada.findMany.mock.calls[0][0].where).toEqual({ temporada: 2026, rodada: 27,
      timeId: { in: [200, 100, 300] } });
  });

  it('retorna capitao nulo quando nao ha contexto de rodada unica', async () => {
    prisma.inscricaoTimeCompeticao.findMany.mockResolvedValue([{ id: 1, timeIdCartola: 100, nomeTime: 'A',
      nomeCartoleiro: null, escudoUrl: null, pontuacao: null, posicao: null, posicaoAnterior: null, premioApurado: null }]);
    const result = await service.consultar(1);
    expect(result.ranking[0].capitao).toBeNull();
    expect(prisma.timeRodada.findMany).not.toHaveBeenCalled();
  });

  it('retorna capitao nulo se escalacao nao confirma o atleta do snapshot', async () => {
    prisma.competicaoLiga.findFirst.mockResolvedValue({ id: 1, nome: 'Rodada 27', rodadaInicio: 27,
      rodadaFim: 27, dataInicio: new Date('2026-09-01T00:00:00Z') });
    prisma.inscricaoTimeCompeticao.findMany.mockResolvedValue([{ id: 1, timeIdCartola: 100, nomeTime: 'A',
      nomeCartoleiro: null, escudoUrl: null, pontuacao: null, posicao: null, posicaoAnterior: null, premioApurado: null }]);
    prisma.timeRodada.findMany.mockResolvedValue([{ id: 10, timeId: 100, capitaoId: 91 }]);
    prisma.escalacaoTimeRodada.findMany.mockResolvedValue([{ timeRodadaId: 10, atletaId: 92, nome: 'Outro' }]);
    expect((await service.consultar(1)).ranking[0].capitao).toBeNull();
  });

  it('nao revela competicao invisivel ou com vinculos inativos', async () => {
    expect(prisma.competicaoLiga.findFirst.mock.calls).toHaveLength(0);
    prisma.competicaoLiga.findFirst.mockResolvedValue(null);
    await expect(service.consultar(1)).rejects.toBeInstanceOf(NotFoundException);
    expect(prisma.competicaoLiga.findFirst.mock.calls[0][0].where).toMatchObject({ id: 1, visivelApp: true,
      ligaModalidade: { ativa: true, liga: { status: 'ATIVA', visivelApp: true }, modalidade: { ativa: true } } });
  });

  it('atualiza pontuacao e recalcula todas as posicoes sequenciais', async () => {
    await service.atualizarPontuacoes(1, [{ inscricaoId: 1, pontuacao: '25.50' }]);
    expect(state.map(row => [row.id, row.pontuacao?.toString() ?? null, row.posicao])).toEqual([
      [1, '25.5', 1], [2, '20', 2], [3, null, 3], [4, '99', 1],
    ]);
    expect(prisma.$transaction).toHaveBeenCalledWith(expect.any(Function), { isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted });
    expect(tx.$queryRaw.mock.invocationCallOrder[0]).toBeLessThan(tx.inscricaoTimeCompeticao.findMany.mock.invocationCallOrder[0]);
  });

  it('copia a posicao anterior antes de sobrescrever e nao altera premio', async () => {
    await service.atualizarPontuacoes(1, [{ inscricaoId: 1, pontuacao: 25 }]);
    expect(state.map(row => [row.id, row.posicaoAnterior])).toEqual([[1, 2], [2, 1], [3, null], [4, null]]);
    expect(tx.inscricaoTimeCompeticao.updateMany.mock.calls[0][0].data).not.toHaveProperty('premioApurado');
    expect(state.every(row => row.premioApurado === null)).toBe(true);
  });

  it('desempata pontuacao por data de inscricao e depois ID', async () => {
    state = [makeRow(3, '2026-09-02T00:00:00Z', null, null), makeRow(2, '2026-09-01T00:00:00Z', null, null),
      makeRow(1, '2026-09-01T00:00:00Z', null, null)];
    await service.atualizarPontuacoes(1, [
      { inscricaoId: 1, pontuacao: '15.00' }, { inscricaoId: 2, pontuacao: '15.00' },
      { inscricaoId: 3, pontuacao: '15.00' },
    ]);
    expect(state.map(row => [row.id, row.posicao])).toEqual([[3, 3], [2, 2], [1, 1]]);
  });

  it('ignora inscricoes CANCELADA no recalculo', async () => {
    await service.atualizarPontuacoes(1, []);
    expect(tx.inscricaoTimeCompeticao.updateMany).toHaveBeenCalledTimes(3);
    expect(state[3]).toMatchObject({ id: 4, statusInscricao: 'CANCELADA', posicao: 1, posicaoAnterior: null });
  });

  it('rejeita inscricao de outra competicao, cancelada ou inexistente antes de escrever', async () => {
    await expect(service.atualizarPontuacoes(1, [{ inscricaoId: 4, pontuacao: 10 }])).rejects.toBeInstanceOf(BadRequestException);
    expect(tx.inscricaoTimeCompeticao.updateMany).not.toHaveBeenCalled();
    expect(state[0].pontuacao?.toString()).toBe('10');
  });

  it('rollback preserva todas as posicoes se uma escrita falha', async () => {
    failAt = 2;
    const before = state.map(row => ({ ...row }));
    await expect(service.atualizarPontuacoes(1, [{ inscricaoId: 1, pontuacao: '25.00' }])).rejects.toThrow('Falha de escrita');
    expect(state).toEqual(before);
    expect(tx.inscricaoTimeCompeticao.updateMany).toHaveBeenCalledTimes(2);
  });

  it.each([
    [[{ inscricaoId: 1, pontuacao: '1.234' }], 'decimal'],
    [[{ inscricaoId: 1, pontuacao: '10000000000' }], 'faixa'],
    [[{ inscricaoId: 1, pontuacao: 1 }, { inscricaoId: 1, pontuacao: 2 }], 'duplicado'],
  ])('rejeita entrada invalida: %s (%s)', async (updates, _label) => {
    await expect(service.atualizarPontuacoes(1, updates)).rejects.toBeInstanceOf(BadRequestException);
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });
});
