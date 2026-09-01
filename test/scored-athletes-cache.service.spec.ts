import { BadGatewayException, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { CartolaService } from '../src/cartola/cartola.service';
import { CartolaScoredAthletesPayload } from '../src/cartola/cartola.types';
import { MemoryScoredAthletesCacheStore } from '../src/scored-athletes-cache/memory-scored-athletes-cache.store';
import { ScoredAthletesCacheService } from '../src/scored-athletes-cache/scored-athletes-cache.service';

const payload = (rodada = 25, pontos = 7.5): CartolaScoredAthletesPayload => ({
  rodada,
  total_atletas: 1,
  atletas: {
    '123': { atleta_id: 123, pontuacao: pontos, entrou_em_campo: true },
  },
});

const config = (overrides: Record<string, number> = {}) =>
  ({
    get: jest.fn((key: string, fallback: number) => overrides[key] ?? fallback),
  }) as unknown as ConfigService;

const setup = (overrides: Record<string, number> = {}) => {
  const store = new MemoryScoredAthletesCacheStore();
  const cartola = { loadScoredAthletesFresh: jest.fn() };
  const service = new ScoredAthletesCacheService(
    store,
    cartola as unknown as CartolaService,
    config(overrides),
  );
  return { service, store, cartola };
};

describe('ScoredAthletesCacheService', () => {
  beforeAll(() => Logger.overrideLogger([]));

  it('faz miss, grava o envelope e depois atende por hit', async () => {
    const { service, store, cartola } = setup();
    cartola.loadScoredAthletesFresh.mockResolvedValue({ value: payload(), ttlMs: 60_000 });

    await expect(service.getScoredAthletes(2026, 25)).resolves.toMatchObject({ cache: 'miss', stale: false });
    await expect(service.getScoredAthletes(2026, 25)).resolves.toMatchObject({ cache: 'hit', stale: false });

    expect(cartola.loadScoredAthletesFresh).toHaveBeenCalledTimes(1);
    expect(await store.get('cartola:pontuados:2026:25')).not.toBeNull();
    expect(await store.get('cartola:pontuados:2026:25:stale')).not.toBeNull();
  });

  it('isola as chaves por temporada e rodada', async () => {
    const { service, store, cartola } = setup();
    cartola.loadScoredAthletesFresh
      .mockResolvedValueOnce({ value: payload(25), ttlMs: 60_000 })
      .mockResolvedValueOnce({ value: payload(24), ttlMs: 60_000 });

    await service.getScoredAthletes(2026, 25);
    await service.getScoredAthletes(2025, 24);

    expect(await store.get('cartola:pontuados:2026:25')).not.toBeNull();
    expect(await store.get('cartola:pontuados:2025:24')).not.toBeNull();
  });

  it('respeita o TTL do dado fresco', async () => {
    jest.useFakeTimers();
    const { service, cartola } = setup();
    cartola.loadScoredAthletesFresh.mockResolvedValue({ value: payload(), ttlMs: 100 });

    await service.getScoredAthletes(2026, 25);
    jest.advanceTimersByTime(101);
    await service.getScoredAthletes(2026, 25);

    expect(cartola.loadScoredAthletesFresh).toHaveBeenCalledTimes(2);
    jest.useRealTimers();
  });

  it('coordena 50 misses concorrentes com uma única chamada ao Cartola', async () => {
    const { service, cartola } = setup({ REDIS_LOCK_WAIT_MS: 2_000 });
    cartola.loadScoredAthletesFresh.mockImplementation(
      () => new Promise((resolve) => setTimeout(() => resolve({ value: payload(), ttlMs: 60_000 }), 30)),
    );

    const results = await Promise.all(Array.from({ length: 50 }, () => service.getScoredAthletes(2026, 25)));

    expect(cartola.loadScoredAthletesFresh).toHaveBeenCalledTimes(1);
    expect(results.filter((result) => result.cache === 'miss')).toHaveLength(1);
    expect(results.filter((result) => result.cache === 'hit')).toHaveLength(49);
  });

  it('adquire o lock depois que um lock abandonado expira', async () => {
    const { service, store, cartola } = setup({ REDIS_LOCK_WAIT_MS: 500, REDIS_LOCK_TTL_MS: 100 });
    await store.set('cartola:pontuados:2026:25:lock', 'abandonado', 60);
    cartola.loadScoredAthletesFresh.mockResolvedValue({ value: payload(), ttlMs: 60_000 });

    await expect(service.getScoredAthletes(2026, 25)).resolves.toMatchObject({ cache: 'miss' });
    expect(cartola.loadScoredAthletesFresh).toHaveBeenCalledTimes(1);
  });

  it('usa stale se a atualização falhar, sem sobrescrever o último valor válido', async () => {
    jest.useFakeTimers();
    const { service, cartola } = setup({ REDIS_SCORED_STALE_TTL_SECONDS: 60 });
    cartola.loadScoredAthletesFresh.mockResolvedValueOnce({ value: payload(25, 8.25), ttlMs: 100 });
    await service.getScoredAthletes(2026, 25);
    jest.advanceTimersByTime(101);
    cartola.loadScoredAthletesFresh.mockRejectedValueOnce(new Error('Cartola indisponível'));

    const result = await service.getScoredAthletes(2026, 25);

    expect(result).toMatchObject({ cache: 'stale', stale: true });
    expect(result.value.atletas?.['123'].pontuacao).toBe(8.25);
    jest.useRealTimers();
  });

  it('rejeita payload inválido e não o grava quando não há stale', async () => {
    const { service, store, cartola } = setup();
    cartola.loadScoredAthletesFresh.mockResolvedValue({ value: { rodada: 24, atletas: {} }, ttlMs: 60_000 });

    await expect(service.getScoredAthletes(2026, 25)).rejects.toBeInstanceOf(BadGatewayException);
    expect(await store.get('cartola:pontuados:2026:25')).toBeNull();
    expect(await store.get('cartola:pontuados:2026:25:stale')).toBeNull();
  });

  it('propaga a falha do Cartola quando não existe stale', async () => {
    const { service, cartola } = setup();
    cartola.loadScoredAthletesFresh.mockRejectedValue(new Error('Cartola indisponível'));

    await expect(service.getScoredAthletes(2026, 25)).rejects.toThrow('Cartola indisponível');
  });

  it('mantém e devolve stale válido quando o refresh produz payload inválido', async () => {
    jest.useFakeTimers();
    const { service, store, cartola } = setup({ REDIS_SCORED_STALE_TTL_SECONDS: 60 });
    cartola.loadScoredAthletesFresh.mockResolvedValueOnce({ value: payload(25, 4.75), ttlMs: 100 });
    await service.getScoredAthletes(2026, 25);
    jest.advanceTimersByTime(101);
    cartola.loadScoredAthletesFresh.mockResolvedValueOnce({ value: { rodada: 24, atletas: {} }, ttlMs: 60_000 });

    const result = await service.getScoredAthletes(2026, 25);

    expect(result.value.atletas?.['123'].pontuacao).toBe(4.75);
    expect(await store.get('cartola:pontuados:2026:25')).toBeNull();
    expect(await store.get('cartola:pontuados:2026:25:stale')).not.toBeNull();
    jest.useRealTimers();
  });

  it('não chama o Cartola novamente em 100 leituras sequenciais', async () => {
    const { service, cartola } = setup();
    cartola.loadScoredAthletesFresh.mockResolvedValue({ value: payload(), ttlMs: 60_000 });

    const results = [];
    for (let index = 0; index < 100; index += 1) results.push(await service.getScoredAthletes(2026, 25));

    expect(cartola.loadScoredAthletesFresh).toHaveBeenCalledTimes(1);
    expect(results.filter((result) => result.cache === 'hit')).toHaveLength(99);
  });
});
