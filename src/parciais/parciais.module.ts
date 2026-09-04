import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { CartolaModule } from '../cartola/cartola.module';
import { PartialScoreModule } from '../partial-score/partial-score.module';
import { TimeSnapshotsModule } from '../time-snapshots/time-snapshots.module';
import { ParciaisController } from './parciais.controller';
import { ParciaisService } from './parciais.service';

@Module({
  imports: [AuthModule, CartolaModule, PartialScoreModule, TimeSnapshotsModule],
  controllers: [ParciaisController],
  providers: [ParciaisService],
  exports: [ParciaisService],
})
export class ParciaisModule {}
