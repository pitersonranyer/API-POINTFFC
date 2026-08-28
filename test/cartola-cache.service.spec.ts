import { CartolaCacheService } from '../src/cartola/cartola-cache.service';

describe('CartolaCacheService', () => {
  let cache: CartolaCacheService;

  beforeEach(() => {
    cache = new CartolaCacheService();
    jest.useFakeTimers();
  });

  afterEach(() => jest.useRealTimers());

  it('faz cache miss e depois cache hit', async () => {
    const loader = jest.fn().mockResolvedValue({ rodada: 1 });
    expect((await cache.getOrLoad('key', 1000, loader)).cache).toBe('miss');
    expect((await cache.getOrLoad('key', 1000, loader)).cache).toBe('hit');
    expect(loader).toHaveBeenCalledTimes(1);
  });

  it('recarrega uma entrada expirada', async () => {
    const loader = jest.fn().mockResolvedValueOnce(1).mockResolvedValueOnce(2);
    await cache.getOrLoad('key', 1000, loader);
    jest.advanceTimersByTime(1001);
    const result = await cache.getOrLoad('key', 1000, loader);
    expect(result).toMatchObject({ value: 2, cache: 'miss', stale: false });
  });

  it('retorna fallback stale quando a atualização falha', async () => {
    await cache.getOrLoad('key', 1000, async () => ({ valid: true }));
    jest.advanceTimersByTime(1001);
    const result = await cache.getOrLoad('key', 1000, async () => { throw new Error('offline'); });
    expect(result).toMatchObject({ value: { valid: true }, cache: 'stale', stale: true });
  });

  it('propaga o erro quando não existe fallback', async () => {
    await expect(cache.getOrLoad('key', 1000, async () => { throw new Error('offline'); })).rejects.toThrow('offline');
  });

  it('deduplica chamadas simultâneas para a mesma chave', async () => {
    let resolve!: (value: number) => void;
    const loader = jest.fn(() => new Promise<number>((done) => { resolve = done; }));
    const requests = [cache.getOrLoad('key', 1000, loader), cache.getOrLoad('key', 1000, loader)];
    resolve(42);
    expect((await Promise.all(requests)).map((result) => result.value)).toEqual([42, 42]);
    expect(loader).toHaveBeenCalledTimes(1);
  });
});
