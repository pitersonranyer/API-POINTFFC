import { Module } from '@nestjs/common';
import { CartolaModule } from '../cartola/cartola.module';
import { ScoredAthletesCacheModule } from '../scored-athletes-cache/scored-athletes-cache.module';
import { SubstitutionService } from './substitution.service';

@Module({
  imports: [CartolaModule, ScoredAthletesCacheModule],
  providers: [SubstitutionService],
  exports: [SubstitutionService],
})
export class SubstitutionModule {}
