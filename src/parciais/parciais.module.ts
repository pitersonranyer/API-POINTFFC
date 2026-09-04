import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { CartolaModule } from '../cartola/cartola.module';
import { PartialScoreModule } from '../partial-score/partial-score.module';
import { ParciaisController } from './parciais.controller';
import { ParciaisService } from './parciais.service';

@Module({
  imports: [AuthModule, CartolaModule, PartialScoreModule],
  controllers: [ParciaisController],
  providers: [ParciaisService],
  exports: [ParciaisService],
})
export class ParciaisModule {}
