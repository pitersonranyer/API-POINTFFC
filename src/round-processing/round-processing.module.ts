import { Module } from '@nestjs/common';
import { CartolaModule } from '../cartola/cartola.module';
import { TimeSnapshotsModule } from '../time-snapshots/time-snapshots.module';
import { RoundProcessingService } from './round-processing.service';
import { AuthModule } from '../auth/auth.module';
import { AdminGuard } from '../auth/admin.guard';
import { AdminRoundsController } from './admin-rounds.controller';
import { LigasCompeticoesModule } from '../ligas-competicoes/ligas-competicoes.module';

@Module({ imports: [AuthModule, CartolaModule, TimeSnapshotsModule, LigasCompeticoesModule], controllers: [AdminRoundsController], providers: [RoundProcessingService, AdminGuard], exports: [RoundProcessingService] })
export class RoundProcessingModule {}
