import { ScoredAthletesCacheStore } from './scored-athletes-cache.store';

interface MemoryEntry {
  value: string;
  expiresAt: number;
}

export class MemoryScoredAthletesCacheStore extends ScoredAthletesCacheStore {
  readonly kind = 'memory' as const;
  private readonly entries = new Map<string, MemoryEntry>();

  async get(key: string): Promise<string | null> {
    const entry = this.entries.get(key);
    if (!entry) return null;
    if (entry.expiresAt <= Date.now()) {
      this.entries.delete(key);
      return null;
    }
    return entry.value;
  }

  async set(key: string, value: string, ttlMs: number): Promise<void> {
    this.entries.set(key, { value, expiresAt: Date.now() + ttlMs });
  }

  async setIfAbsent(key: string, value: string, ttlMs: number): Promise<boolean> {
    const entry = this.entries.get(key);
    if (entry && entry.expiresAt > Date.now()) return false;
    this.entries.set(key, { value, expiresAt: Date.now() + ttlMs });
    return true;
  }

  async delete(key: string): Promise<void> {
    this.entries.delete(key);
  }

  async releaseLock(key: string, token: string): Promise<void> {
    if (await this.get(key) === token) this.entries.delete(key);
  }
}
