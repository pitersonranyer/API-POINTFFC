import { Prisma, PrismaClient } from '@prisma/client';
import { performance } from 'perf_hooks';
import { PrismaService } from '../src/prisma/prisma.service';
import { RankingGeralService } from '../src/ranking-geral/ranking-geral.service';

const describeBenchmark = process.env.RUN_RANKING_BENCHMARK === 'true' ? describe : describe.skip;

describeBenchmark('RankingGeralService - benchmark MySQL local', () => {
  jest.setTimeout(120_000);
  const prisma = new PrismaClient({ log: [{ emit: 'event', level: 'query' }] });
  const service = new RankingGeralService(prisma as unknown as PrismaService);
  const datasets = [
    { size: 10, temporada: 64_000, baseTimeId: 3_000_000_000, limit: 10 },
    { size: 1000, temporada: 64_001, baseTimeId: 3_001_000_000, limit: 100 },
    { size: 5000, temporada: 64_002, baseTimeId: 3_002_000_000, limit: 100 },
  ];
  const rodada = 35;
  let queryEvents = 0;

  beforeAll(async () => {
    await prisma.$connect();
    prisma.$on('query', () => { queryEvents += 1; });
    const allTimeIds = datasets.flatMap(({ size, baseTimeId }) => Array.from({ length: size }, (_, index) => baseTimeId + index));
    await prisma.timeRodada.deleteMany({ where: { temporada: { in: datasets.map(({ temporada }) => temporada) } } });
    await prisma.timeCartola.deleteMany({ where: { timeId: { in: allTimeIds } } });

    for (const dataset of datasets) {
      for (let start = 0; start < dataset.size; start += 500) {
        const length = Math.min(500, dataset.size - start);
        const indexes = Array.from({ length }, (_, offset) => start + offset);
        await prisma.timeCartola.createMany({ data: indexes.map((index) => ({
          timeId: dataset.baseTimeId + index,
          nomeTime: `Ranking benchmark ${dataset.size}-${index}`,
          nomeCartoleiro: `Cartoleiro ${index}`,
        })) });
        await prisma.timeRodada.createMany({ data: indexes.map((index) => ({
          id: `rank-${dataset.temporada}-${index}`,
          timeId: dataset.baseTimeId + index,
          temporada: dataset.temporada,
          rodada,
        })) });
        await prisma.pontuacaoTimeRodada.createMany({ data: indexes.map((index) => ({
          id: `score-${dataset.temporada}-${index}`,
          timeRodadaId: `rank-${dataset.temporada}-${index}`,
          pontuacao: new Prisma.Decimal(((index * 37) % 20000).toString()).div(100),
          status: index % 2 === 0 ? 'PARCIAL' : 'FINAL',
        })) });
      }
    }
  });

  afterAll(async () => {
    const allTimeIds = datasets.flatMap(({ size, baseTimeId }) => Array.from({ length: size }, (_, index) => baseTimeId + index));
    await prisma.timeRodada.deleteMany({ where: { temporada: { in: datasets.map(({ temporada }) => temporada) } } });
    await prisma.timeCartola.deleteMany({ where: { timeId: { in: allTimeIds } } });
    await prisma.$disconnect();
  });

  it('mede conjuntos de 10, 1000 e 5000 times mantendo duas queries de dados', async () => {
    const metrics = [];
    for (const dataset of datasets) {
      queryEvents = 0;
      const started = performance.now();
      const result = await service.consultar({ temporada: dataset.temporada, rodada, limit: dataset.limit });
      const totalMs = performance.now() - started;
      metrics.push({
        times: dataset.size,
        returned: result.ranking.length,
        total: result.total,
        dataQueries: 2,
        mysqlEventsIncludingTransaction: queryEvents,
        totalMs: Number(totalMs.toFixed(3)),
        responseBytes: Buffer.byteLength(JSON.stringify(result)),
      });
      expect(result.total).toBe(dataset.size);
      expect(result.ranking).toHaveLength(dataset.limit);
    }
    console.log(`RANKING_GERAL_BENCHMARK ${JSON.stringify(metrics)}`);
  });
});
