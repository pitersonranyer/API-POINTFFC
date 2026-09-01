import { Global, Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { CartolaModule } from '../cartola/cartola.module';
import { MemoryScoredAthletesCacheStore } from './memory-scored-athletes-cache.store';
import { RedisScoredAthletesCacheStore } from './redis-scored-athletes-cache.store';
import { ScoredAthletesCacheService } from './scored-athletes-cache.service';
import { ScoredAthletesCacheStore } from './scored-athletes-cache.store';

@Global()
@Module({
  imports: [CartolaModule],
  providers: [
    {
      provide: ScoredAthletesCacheStore,
      inject: [ConfigService],
      useFactory: (config: ConfigService): ScoredAthletesCacheStore => {
        const redisUrl = config.get<string>('REDIS_URL')?.trim();
        return redisUrl ? new RedisScoredAthletesCacheStore(redisUrl) : new MemoryScoredAthletesCacheStore();
      },
    },
    ScoredAthletesCacheService,
  ],
  exports: [ScoredAthletesCacheService],
})
export class ScoredAthletesCacheModule {}
