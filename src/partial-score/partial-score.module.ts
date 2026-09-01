import { Module } from '@nestjs/common';
import { ScoredAthletesCacheModule } from '../scored-athletes-cache/scored-athletes-cache.module';
import { PartialScoreService } from './partial-score.service';

@Module({
  imports: [ScoredAthletesCacheModule],
  providers: [PartialScoreService],
  exports: [PartialScoreService],
})
export class PartialScoreModule {}
