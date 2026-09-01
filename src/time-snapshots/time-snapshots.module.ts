import { Module } from '@nestjs/common';
import { CartolaModule } from '../cartola/cartola.module';
import { TimeSnapshotsService } from './time-snapshots.service';

@Module({
  imports: [CartolaModule],
  providers: [TimeSnapshotsService],
  exports: [TimeSnapshotsService],
})
export class TimeSnapshotsModule {}
