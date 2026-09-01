import { Prisma } from '@prisma/client';
import { performance } from 'perf_hooks';
import { ParciaisService } from '../src/parciais/parciais.service';
import { PrismaService } from '../src/prisma/prisma.service';

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
  const prisma = { timeCartola: { findMany: jest.fn() } };
  const service = new ParciaisService(prisma as unknown as PrismaService);

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
});
