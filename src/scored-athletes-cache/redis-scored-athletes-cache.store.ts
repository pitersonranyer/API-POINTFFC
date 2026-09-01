import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import Redis from 'ioredis';
import { ScoredAthletesCacheStore } from './scored-athletes-cache.store';

@Injectable()
export class RedisScoredAthletesCacheStore extends ScoredAthletesCacheStore implements OnModuleInit, OnModuleDestroy {
  readonly kind = 'redis' as const;
  private readonly logger = new Logger(RedisScoredAthletesCacheStore.name);
  private readonly redis: Redis;

  constructor(url: string) {
    super();
    this.redis = new Redis(url, {
      lazyConnect: true,
      enableReadyCheck: true,
      maxRetriesPerRequest: 2,
    });
    this.redis.on('error', (error) => this.logger.error({ event: 'redis_error', reason: error.message }));
  }

  async onModuleInit(): Promise<void> {
    try {
      await this.redis.connect();
    } catch (error) {
      throw new Error(`Não foi possível conectar ao Redis configurado: ${error instanceof Error ? error.message : 'erro desconhecido'}`);
    }
  }

  async onModuleDestroy(): Promise<void> {
    if (this.redis.status !== 'end') await this.redis.quit();
  }

  get(key: string): Promise<string | null> {
    return this.redis.get(key);
  }

  async set(key: string, value: string, ttlMs: number): Promise<void> {
    await this.redis.set(key, value, 'PX', ttlMs);
  }

  async setIfAbsent(key: string, value: string, ttlMs: number): Promise<boolean> {
    return (await this.redis.set(key, value, 'PX', ttlMs, 'NX')) === 'OK';
  }

  async delete(key: string): Promise<void> {
    await this.redis.del(key);
  }

  async releaseLock(key: string, token: string): Promise<void> {
    await this.redis.eval(
      "if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('del', KEYS[1]) else return 0 end",
      1,
      key,
      token,
    );
  }
}
