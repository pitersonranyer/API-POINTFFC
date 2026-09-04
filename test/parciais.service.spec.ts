import { Prisma } from '@prisma/client';
import { performance } from 'perf_hooks';
import { ParciaisService } from '../src/parciais/parciais.service';
import { PrismaService } from '../src/prisma/prisma.service';
import { CartolaService } from '../src/cartola/cartola.service';
import { PartialScoreService } from '../src/partial-score/partial-score.service';

const persisted = (timeId: number, score: number | null = timeId / 100) => ({
  timeId,
  nomeTime: `Time ${timeId}`,
  nomeCartoleiro: `Cartoleiro ${timeId}`,
  escudoUrl: `https://example.com/${timeId}.png`,
  rodadas: score === null ? [{ pontuacao: null }] : [{
    pontuacao: {
      pontuacao: new Prisma.Decimal(score),
      status: 'PARCIAL' as const,
      atualizadoEm: new Date('2026-08-31T12:00:00.000Z'),
    },
  }],
});

describe('ParciaisService', () => {
  const prisma = {
    timeCartola: { findMany: jest.fn() },
    timeUsuario: { findMany: jest.fn() },
    timeRodada: { findMany: jest.fn() },
    pontuacaoTimeRodada: { findMany: jest.fn() },
  };
  const cartola = { getMarketStatus: jest.fn() };
  const partialScore = { calcular: jest.fn() };
  const service = new ParciaisService(
    prisma as unknown as PrismaService,
    cartola as unknown as CartolaService,
    partialScore as unknown as PartialScoreService,
  );

  beforeEach(() => jest.clearAllMocks());

  it('retorna um time com a parcial persistida', async () => {
    prisma.timeCartola.findMany.mockResolvedValue([persisted(30157355, 75.2)]);

    const result = await service.listar({ temporada: 2026, rodada: 25, timeIds: [30157355] });

    expect(result).toEqual({
      temporada: 2026,
      rodada: 25,
      parciais: [{
        timeId: 30157355,
        nomeTime: 'Time 30157355',
        nomeCartoleiro: 'Cartoleiro 30157355',
        escudoUrl: 'https://example.com/30157355.png',
        pontuacao: 75.2,
        status: 'PARCIAL',
        atualizadoEm: new Date('2026-08-31T12:00:00.000Z'),
      }],
    });
  });

  it('retorna vários times preservando a ordem solicitada', async () => {
    prisma.timeCartola.findMany.mockResolvedValue([persisted(2, 20), persisted(1, 10), persisted(3, 30)]);

    const result = await service.listar({ temporada: 2026, rodada: 25, timeIds: [3, 1, 2] });

    expect(result.parciais.map(({ timeId }) => timeId)).toEqual([3, 1, 2]);
    expect(result.parciais.map(({ pontuacao }) => pontuacao)).toEqual([30, 10, 20]);
  });

  it('retorna AGUARDANDO para time local sem pontuação', async () => {
    prisma.timeCartola.findMany.mockResolvedValue([persisted(1, null)]);

    await expect(service.listar({ temporada: 2026, rodada: 25, timeIds: [1] })).resolves.toMatchObject({
      parciais: [{ timeId: 1, pontuacao: null, status: 'AGUARDANDO', atualizadoEm: null }],
    });
  });

  it('retorna NAO_ENCONTRADO para ID que não existe localmente sem falhar a lista', async () => {
    prisma.timeCartola.findMany.mockResolvedValue([]);

    await expect(service.listar({ temporada: 2026, rodada: 25, timeIds: [999] })).resolves.toMatchObject({
      parciais: [{
        timeId: 999,
        nomeTime: null,
        nomeCartoleiro: null,
        escudoUrl: null,
        pontuacao: null,
        status: 'NAO_ENCONTRADO',
        atualizadoEm: null,
      }],
    });
  });

  it('filtra exatamente pela temporada e rodada solicitadas', async () => {
    prisma.timeCartola.findMany.mockResolvedValue([persisted(1, null)]);

    await service.listar({ temporada: 2025, rodada: 24, timeIds: [1] });

    expect(prisma.timeCartola.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: { timeId: { in: [1] } },
      select: expect.objectContaining({
        rodadas: expect.objectContaining({ where: { temporada: 2025, rodada: 24 } }),
      }),
    }));
  });

  it('faz uma única operação Prisma em lote, inclusive para 1000 IDs', async () => {
    const timeIds = Array.from({ length: 1000 }, (_, index) => index + 1);
    prisma.timeCartola.findMany.mockResolvedValue(timeIds.map((timeId) => persisted(timeId, 1)));

    const result = await service.listar({ temporada: 2026, rodada: 25, timeIds });

    expect(result.parciais).toHaveLength(1000);
    expect(prisma.timeCartola.findMany).toHaveBeenCalledTimes(1);
    expect(prisma.timeCartola.findMany.mock.calls[0][0].where.timeId.in).toHaveLength(1000);
  });

  it('mede serialização controlada para 1, 100 e 1000 times', async () => {
    const metrics = [];
    for (const size of [1, 100, 1000]) {
      const timeIds = Array.from({ length: size }, (_, index) => index + 1);
      prisma.timeCartola.findMany.mockResolvedValueOnce(timeIds.map((timeId) => persisted(timeId, 75.2)));
      const started = performance.now();
      const response = await service.listar({ temporada: 2026, rodada: 25, timeIds });
      const body = JSON.stringify(response);
      metrics.push({
        times: size,
        prismaOperations: 1,
        totalMs: Number((performance.now() - started).toFixed(3)),
        responseBytes: Buffer.byteLength(body),
      });
    }
    console.log(`PARCIAIS_READ_BENCHMARK ${JSON.stringify(metrics)}`);
    expect(metrics.map(({ times }) => times)).toEqual([1, 100, 1000]);
    expect(prisma.timeCartola.findMany).toHaveBeenCalledTimes(3);
  });
  it('processa todos os snapshots pendentes na primeira execucao', async () => {
    cartola.getMarketStatus.mockResolvedValue({ value: { rodada_atual: 26, temporada: 2026 } });
    prisma.timeUsuario.findMany.mockResolvedValue([{ timeId: 1 }, { timeId: 2 }, { timeId: 3 }]);
    prisma.timeRodada.findMany.mockResolvedValue([
      { id: 101, timeId: 1 }, { id: 102, timeId: 2 }, { id: 103, timeId: 3 },
    ]);
    prisma.pontuacaoTimeRodada.findMany.mockResolvedValue([]);
    partialScore.calcular.mockResolvedValue({});

    await expect(service.atualizarRodadaAnterior()).resolves.toEqual({
      temporada: 2026, rodada: 25, timesCadastrados: 3, atualizados: 3,
      jaProcessados: 0, semSnapshot: 0, timeIdsSemSnapshot: [], falhas: 0, detalhesFalhas: [],
    });
    expect(partialScore.calcular).toHaveBeenCalledTimes(3);
  });

  it('nao recalcula snapshots que ja possuem pontuacao', async () => {
    cartola.getMarketStatus.mockResolvedValue({ value: { rodada_atual: 26, temporada: 2026 } });
    prisma.timeUsuario.findMany.mockResolvedValue([{ timeId: 1 }, { timeId: 2 }, { timeId: 3 }]);
    prisma.timeRodada.findMany.mockResolvedValue([
      { id: 101, timeId: 1 }, { id: 102, timeId: 2 }, { id: 103, timeId: 3 },
    ]);
    prisma.pontuacaoTimeRodada.findMany.mockResolvedValue([
      { timeRodadaId: 101 }, { timeRodadaId: 102 }, { timeRodadaId: 103 },
    ]);

    await expect(service.atualizarRodadaAnterior()).resolves.toMatchObject({
      atualizados: 0, jaProcessados: 3, semSnapshot: 0, falhas: 0,
    });
    expect(partialScore.calcular).not.toHaveBeenCalled();
  });

  it('processa somente o novo time quando os demais ja possuem pontuacao', async () => {
    cartola.getMarketStatus.mockResolvedValue({ value: { rodada_atual: 26, temporada: 2026 } });
    prisma.timeUsuario.findMany.mockResolvedValue([{ timeId: 1 }, { timeId: 2 }, { timeId: 3 }, { timeId: 4 }]);
    prisma.timeRodada.findMany.mockResolvedValue([
      { id: 101, timeId: 1 }, { id: 102, timeId: 2 }, { id: 103, timeId: 3 }, { id: 104, timeId: 4 },
    ]);
    prisma.pontuacaoTimeRodada.findMany.mockResolvedValue([
      { timeRodadaId: 101 }, { timeRodadaId: 102 }, { timeRodadaId: 103 },
    ]);
    partialScore.calcular.mockResolvedValue({});

    await expect(service.atualizarRodadaAnterior()).resolves.toMatchObject({
      timesCadastrados: 4, atualizados: 1, jaProcessados: 3, semSnapshot: 0, falhas: 0,
    });
    expect(partialScore.calcular).toHaveBeenCalledTimes(1);
    expect(partialScore.calcular).toHaveBeenCalledWith({ timeId: 4, temporada: 2026, rodada: 25 });
  });

  it('classifica novo time sem snapshot sem recalcular os existentes', async () => {
    cartola.getMarketStatus.mockResolvedValue({ value: { rodada_atual: 26, temporada: 2026 } });
    prisma.timeUsuario.findMany.mockResolvedValue([{ timeId: 1 }, { timeId: 2 }, { timeId: 3 }, { timeId: 4 }]);
    prisma.timeRodada.findMany.mockResolvedValue([
      { id: 101, timeId: 1 }, { id: 102, timeId: 2 }, { id: 103, timeId: 3 },
    ]);
    prisma.pontuacaoTimeRodada.findMany.mockResolvedValue([
      { timeRodadaId: 101 }, { timeRodadaId: 102 }, { timeRodadaId: 103 },
    ]);

    await expect(service.atualizarRodadaAnterior()).resolves.toMatchObject({
      timesCadastrados: 4, atualizados: 0, jaProcessados: 3,
      semSnapshot: 1, timeIdsSemSnapshot: [4], falhas: 0,
    });
    expect(partialScore.calcular).not.toHaveBeenCalled();
  });

  it('isola a falha de um time pendente e preserva a contagem do resumo', async () => {
    cartola.getMarketStatus.mockResolvedValue({ value: { rodada_atual: 26, temporada: 2026 } });
    prisma.timeUsuario.findMany.mockResolvedValue([{ timeId: 1 }, { timeId: 2 }, { timeId: 3 }, { timeId: 4 }]);
    prisma.timeRodada.findMany.mockResolvedValue([
      { id: 101, timeId: 1 }, { id: 102, timeId: 2 }, { id: 103, timeId: 3 }, { id: 104, timeId: 4 },
    ]);
    prisma.pontuacaoTimeRodada.findMany.mockResolvedValue([
      { timeRodadaId: 101 }, { timeRodadaId: 102 }, { timeRodadaId: 103 },
    ]);
    partialScore.calcular.mockRejectedValue(new Error('snapshot inconsistente'));

    const result = await service.atualizarRodadaAnterior();
    expect(result).toMatchObject({
      timesCadastrados: 4, atualizados: 0, jaProcessados: 3, semSnapshot: 0, falhas: 1,
      detalhesFalhas: [{ timeId: 4, motivo: 'snapshot inconsistente' }],
    });
    expect(result.timesCadastrados).toBe(
      result.jaProcessados + result.atualizados + result.semSnapshot + result.falhas,
    );
  });

  it('consulta pontuacoes existentes uma unica vez em lote', async () => {
    cartola.getMarketStatus.mockResolvedValue({ value: { rodada_atual: 26, temporada: 2026 } });
    prisma.timeUsuario.findMany.mockResolvedValue([{ timeId: 1 }, { timeId: 2 }]);
    prisma.timeRodada.findMany.mockResolvedValue([{ id: 101, timeId: 1 }, { id: 102, timeId: 2 }]);
    prisma.pontuacaoTimeRodada.findMany.mockResolvedValue([{ timeRodadaId: 101 }]);
    partialScore.calcular.mockResolvedValue({});

    await service.atualizarRodadaAnterior();

    expect(prisma.pontuacaoTimeRodada.findMany).toHaveBeenCalledTimes(1);
    expect(prisma.pontuacaoTimeRodada.findMany).toHaveBeenCalledWith({
      where: { timeRodadaId: { in: [101, 102] } },
      select: { timeRodadaId: true },
    });
  });
});
