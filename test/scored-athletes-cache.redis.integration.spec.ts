import { RedisScoredAthletesCacheStore } from '../src/scored-athletes-cache/redis-scored-athletes-cache.store';

const enabled = process.env.RUN_REDIS_INTEGRATION_TESTS === 'true' && Boolean(process.env.REDIS_URL);
const describeRedis = enabled ? describe : describe.skip;

describeRedis('RedisScoredAthletesCacheStore (integração opt-in)', () => {
  let store: RedisScoredAthletesCacheStore;
  const prefix = `test:scored-athletes:${process.pid}`;

  beforeAll(async () => {
    store = new RedisScoredAthletesCacheStore(process.env.REDIS_URL!);
    await store.onModuleInit();
  });

  afterAll(async () => {
    await Promise.all([store.delete(`${prefix}:value`), store.delete(`${prefix}:lock`)]);
    await store.onModuleDestroy();
  });

  it('grava com TTL e expira', async () => {
    await store.set(`${prefix}:value`, 'ok', 50);
    await expect(store.get(`${prefix}:value`)).resolves.toBe('ok');
    await new Promise((resolve) => setTimeout(resolve, 70));
    await expect(store.get(`${prefix}:value`)).resolves.toBeNull();
  });

  it('implementa lock NX e liberação protegida por token', async () => {
    await expect(store.setIfAbsent(`${prefix}:lock`, 'token-a', 1_000)).resolves.toBe(true);
    await expect(store.setIfAbsent(`${prefix}:lock`, 'token-b', 1_000)).resolves.toBe(false);
    await store.releaseLock(`${prefix}:lock`, 'token-b');
    await expect(store.get(`${prefix}:lock`)).resolves.toBe('token-a');
    await store.releaseLock(`${prefix}:lock`, 'token-a');
    await expect(store.get(`${prefix}:lock`)).resolves.toBeNull();
  });
});
