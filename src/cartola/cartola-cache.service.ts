import { Injectable, Logger } from '@nestjs/common';
import { CachedResult } from './cartola.types';

interface CacheEntry<T> { value: T; expiresAt: number }
type Ttl<T> = number | ((value: T) => number);

@Injectable()
export class CartolaCacheService {
  private readonly logger = new Logger(CartolaCacheService.name);
  private readonly entries = new Map<string, CacheEntry<unknown>>();
  private readonly inFlight = new Map<string, Promise<CachedResult<unknown>>>();

  async getOrLoad<T>(key: string, ttlMs: Ttl<T>, loader: () => Promise<T>): Promise<CachedResult<T>> {
    const cached = this.entries.get(key) as CacheEntry<T> | undefined;
    if (cached && cached.expiresAt > Date.now()) return { value: cached.value, cache: 'hit', stale: false };
    const currentLoad = this.inFlight.get(key) as Promise<CachedResult<T>> | undefined;
    if (currentLoad) return currentLoad;
    const load = this.load(key, cached, ttlMs, loader);
    this.inFlight.set(key, load as Promise<CachedResult<unknown>>);
    try { return await load; } finally { this.inFlight.delete(key); }
  }

  clear(): void { this.entries.clear(); this.inFlight.clear(); }

  private async load<T>(key: string, stale: CacheEntry<T> | undefined, ttlMs: Ttl<T>, loader: () => Promise<T>): Promise<CachedResult<T>> {
    try {
      const value = await loader();
      const duration = typeof ttlMs === 'function' ? ttlMs(value) : ttlMs;
      this.entries.set(key, { value, expiresAt: Date.now() + duration });
      return { value, cache: 'miss', stale: false };
    } catch (error) {
      if (stale) {
        this.logger.warn(`API Cartola indisponível; usando fallback stale para ${key}`);
        return { value: stale.value, cache: 'stale', stale: true };
      }
      throw error;
    }
  }
}
