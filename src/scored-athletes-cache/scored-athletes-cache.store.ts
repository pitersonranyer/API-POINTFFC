export abstract class ScoredAthletesCacheStore {
  abstract readonly kind: 'redis' | 'memory';
  abstract get(key: string): Promise<string | null>;
  abstract set(key: string, value: string, ttlMs: number): Promise<void>;
  abstract setIfAbsent(key: string, value: string, ttlMs: number): Promise<boolean>;
  abstract delete(key: string): Promise<void>;
  abstract releaseLock(key: string, token: string): Promise<void>;
}
