import { ParticipantCrestController } from './participant-crest.controller';
import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { AdminGuard } from '../auth/admin.guard';
import { CartolaModule } from '../cartola/cartola.module';
import { PrismaModule } from '../prisma/prisma.module';
import { ScoredAthletesCacheModule } from '../scored-athletes-cache/scored-athletes-cache.module';
import { AdminPointFantasyController, PointFantasyController } from './point-fantasy.controller';
import { PointFantasyService } from './point-fantasy.service';
import { LineupController } from './lineups/lineup.controller';
import { LineupService } from './lineups/lineup.service';
import { LineupScoringService } from './scoring/lineup-scoring.service';

@Module({ imports: [PrismaModule, CartolaModule, ScoredAthletesCacheModule, AuthModule], controllers: [ParticipantCrestController, PointFantasyController, AdminPointFantasyController, LineupController],
  providers: [PointFantasyService, AdminGuard, LineupService, LineupScoringService] })
export class PointFantasyModule {}
