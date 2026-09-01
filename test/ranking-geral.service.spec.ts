import 'reflect-metadata';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../src/prisma/prisma.service';
import { RankingGeralService } from '../src/ranking-geral/ranking-geral.service';

describe('RankingGeralService', () => {
  const prisma = {
    $queryRaw: jest.fn(),
    $transaction: jest.fn(async (queries: Array<Promise<unknown>>) => Promise.all(queries)),
  };
  const service = new RankingGeralService(prisma as unknown as PrismaService);
  const row = (timeId: number, pontuacao: number, status: 'PARCIAL' | 'FINAL' = 'PARCIAL') => ({
    timeId,
    nomeTime: `Time ${timeId}`,
    nomeCartoleiro: `Cartoleiro ${timeId}`,
    escudoUrl: `https://example.com/${timeId}.png`,
    pontuacao: new Prisma.Decimal(pontuacao),
    status,
  });

  beforeEach(() => {
    jest.clearAllMocks();
    prisma.$queryRaw.mockResolvedValueOnce([{ total: BigInt(3) }]);
  });

  it('retorna ranking ordenado e numera as posições', async () => {
    prisma.$queryRaw.mockResolvedValueOnce([row(3, 90), row(1, 80), row(2, 70, 'FINAL')]);

    const result = await service.consultar({ temporada: 2026, rodada: 25, limit: 15 });

    expect(result).toEqual({
      temporada: 2026,
      rodada: 25,
      total: 3,
      ranking: [
        { posicao: 1, timeId: 3, nomeTime: 'Time 3', nomeCartoleiro: 'Cartoleiro 3', escudoUrl: 'https://example.com/3.png', pontuacao: 90, status: 'PARCIAL' },
        { posicao: 2, timeId: 1, nomeTime: 'Time 1', nomeCartoleiro: 'Cartoleiro 1', escudoUrl: 'https://example.com/1.png', pontuacao: 80, status: 'PARCIAL' },
        { posicao: 3, timeId: 2, nomeTime: 'Time 2', nomeCartoleiro: 'Cartoleiro 2', escudoUrl: 'https://example.com/2.png', pontuacao: 70, status: 'FINAL' },
      ],
    });
  });

  it('define desempate por timeId ASC diretamente no SQL', async () => {
    prisma.$queryRaw.mockResolvedValueOnce([row(10, 50), row(20, 50)]);

    const result = await service.consultar({ temporada: 2026, rodada: 25, limit: 15 });
    const rankingSql = (prisma.$queryRaw.mock.calls[1][0] as TemplateStringsArray).join(' ');

    expect(result.ranking.map(({ timeId }) => timeId)).toEqual([10, 20]);
    expect(rankingSql).toMatch(/ORDER BY p\.PONTUACAO DESC, tr\.TIME_ID ASC/);
  });

  it('filtra temporada e rodada e aplica o limit parametrizado', async () => {
    prisma.$queryRaw.mockResolvedValueOnce([]);

    await service.consultar({ temporada: 2025, rodada: 24, limit: 100 });

    expect(prisma.$queryRaw.mock.calls[0].slice(1)).toEqual([2025, 24]);
    expect(prisma.$queryRaw.mock.calls[1].slice(1)).toEqual([2025, 24, 100]);
  });

  it('retorna lista vazia e total zero', async () => {
    prisma.$queryRaw.mockReset()
      .mockResolvedValueOnce([{ total: BigInt(0) }])
      .mockResolvedValueOnce([]);

    await expect(service.consultar({ temporada: 2026, rodada: 1, limit: 15 })).resolves.toEqual({
      temporada: 2026, rodada: 1, total: 0, ranking: [],
    });
  });

  it('usa INNER JOIN para excluir times sem pontuação e não seleciona dados privados', async () => {
    prisma.$queryRaw.mockResolvedValueOnce([]);

    await service.consultar({ temporada: 2026, rodada: 25, limit: 15 });
    const rankingSql = (prisma.$queryRaw.mock.calls[1][0] as TemplateStringsArray).join(' ');

    expect(rankingSql).toContain('INNER JOIN PONTUACAO_TIME_RODADA');
    expect(rankingSql).toContain('INNER JOIN TIME_CARTOLA');
    expect(rankingSql).not.toMatch(/EMAIL|USUARIO_ID|TIME_USUARIO/i);
  });

  it('executa duas queries fixas em uma transação, sem N+1', async () => {
    prisma.$queryRaw.mockResolvedValueOnce(Array.from({ length: 100 }, (_, index) => row(index + 1, 100 - index)));

    const result = await service.consultar({ temporada: 2026, rodada: 25, limit: 100 });

    expect(result.ranking).toHaveLength(100);
    expect(prisma.$queryRaw).toHaveBeenCalledTimes(2);
    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
    expect(prisma.$transaction.mock.calls[0][0]).toHaveLength(2);
  });
});
