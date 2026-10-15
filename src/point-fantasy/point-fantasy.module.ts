import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { AdminGuard } from '../auth/admin.guard';
import { CartolaModule } from '../cartola/cartola.module';
import { PrismaModule } from '../prisma/prisma.module';
import { AdminPointFantasyController, PointFantasyController } from './point-fantasy.controller';
import { PointFantasyService } from './point-fantasy.service';
import { LineupController } from './lineups/lineup.controller';
import { LineupService } from './lineups/lineup.service';

@Module({ imports: [PrismaModule, CartolaModule, AuthModule], controllers: [PointFantasyController, AdminPointFantasyController, LineupController],
  providers: [PointFantasyService, AdminGuard, LineupService] })
export class PointFantasyModule {}
