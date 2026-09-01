import { Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { performance } from 'perf_hooks';
import { CartolaService } from '../src/cartola/cartola.service';
import { PartialScoreService } from '../src/partial-score/partial-score.service';
import { PrismaService } from '../src/prisma/prisma.service';
import { MemoryScoredAthletesCacheStore } from '../src/scored-athletes-cache/memory-scored-athletes-cache.store';
import { ScoredAthletesCacheService } from '../src/scored-athletes-cache/scored-athletes-cache.service';

interface Metric { calculations: number; cartolaCalls: number; hits: number; misses: number; totalMs: number; averageMs: number }

describe('PartialScore + cache (benchmark local controlado)', () => {
  beforeAll(() => Logger.overrideLogger([]));

  const run = async (calculations: number, concurrent: boolean): Promise<Metric> => {
    const cartola = {
      loadScoredAthletesFresh: jest.fn(async () => {
        await new Promise((resolve) => setTimeout(resolve, 5));
        return { value: { rodada: 25, atletas: { '10': { pontuacao: 10 }, '11': { pontuacao: 4 }, '12': { pontuacao: 2.5 } } }, ttlMs: 60_000 };
      }),
    };
    const cache = new ScoredAthletesCacheService(
      new MemoryScoredAthletesCacheStore(),
      cartola as unknown as CartolaService,
      { get: (_key: string, fallback: number) => fallback } as ConfigService,
    );
    let hits = 0;
    let misses = 0;
    const originalGet = cache.getScoredAthletes.bind(cache);
    jest.spyOn(cache, 'getScoredAthletes').mockImplementation(async (...args) => {
      const result = await originalGet(...args);
      if (result.cache === 'hit') hits += 1;
      else if (result.cache === 'miss') misses += 1;
      return result;
    });
    const prisma = {
      timeRodada: { findUnique: jest.fn(async () => ({
        id: 'rodada-1', capitaoId: 11, escalacao: [
          { atletaId: 10, posicaoId: 5, clubeId: 1, titular: true, capitao: false },
          { atletaId: 11, posicaoId: 4, clubeId: 2, titular: true, capitao: true },
          { atletaId: 12, posicaoId: 6, clubeId: 3, titular: true, capitao: false },
        ],
      })) },
      pontuacaoTimeRodada: { upsert: jest.fn(async () => ({})), update: jest.fn(async () => ({})) },
    };
    const partial = new PartialScoreService(prisma as unknown as PrismaService, cache);
    const task = () => partial.calcular({ timeId: 123, temporada: 2026, rodada: 25 });
    const started = performance.now();
    if (concurrent) await Promise.all(Array.from({ length: calculations }, task));
    else for (let index = 0; index < calculations; index += 1) await task();
    const totalMs = performance.now() - started;
    return {
      calculations,
      cartolaCalls: cartola.loadScoredAthletesFresh.mock.calls.length,
      hits,
      misses,
      totalMs: Number(totalMs.toFixed(2)),
      averageMs: Number((totalMs / calculations).toFixed(3)),
    };
  };

  it('mede 1, 100 sequenciais e 50 concorrentes', async () => {
    const metrics = {
      one: await run(1, false),
      sequential100: await run(100, false),
      concurrent50: await run(50, true),
      redisConnections: 0,
      redisErrors: 0,
      store: 'memory',
    };
    console.log(`PARTIAL_CACHE_BENCHMARK ${JSON.stringify(metrics)}`);
    expect(metrics.one).toMatchObject({ cartolaCalls: 1, hits: 0, misses: 1 });
    expect(metrics.sequential100).toMatchObject({ cartolaCalls: 1, hits: 99, misses: 1 });
    expect(metrics.concurrent50).toMatchObject({ cartolaCalls: 1, hits: 49, misses: 1 });
  });
});
