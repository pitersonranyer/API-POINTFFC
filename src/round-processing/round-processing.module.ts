import { Module } from '@nestjs/common';
import { CartolaModule } from '../cartola/cartola.module';
import { TimeSnapshotsModule } from '../time-snapshots/time-snapshots.module';
import { RoundProcessingService } from './round-processing.service';

@Module({ imports: [CartolaModule, TimeSnapshotsModule], providers: [RoundProcessingService], exports: [RoundProcessingService] })
export class RoundProcessingModule {}
