import { Module } from '@nestjs/common';
import { RankingGeralController } from './ranking-geral.controller';
import { RankingGeralService } from './ranking-geral.service';

@Module({
  controllers: [RankingGeralController],
  providers: [RankingGeralService],
  exports: [RankingGeralService],
})
export class RankingGeralModule {}
