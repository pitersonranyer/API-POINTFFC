import { Module } from '@nestjs/common';
import { CartolaModule } from '../cartola/cartola.module';
import { TimeSnapshotsModule } from '../time-snapshots/time-snapshots.module';
import { RoundProcessingService } from './round-processing.service';
import { AuthModule } from '../auth/auth.module';
import { AdminGuard } from '../auth/admin.guard';
import { AdminRoundsController } from './admin-rounds.controller';

@Module({ imports: [AuthModule, CartolaModule, TimeSnapshotsModule], controllers: [AdminRoundsController], providers: [RoundProcessingService, AdminGuard], exports: [RoundProcessingService] })
export class RoundProcessingModule {}
