import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { ParciaisController } from './parciais.controller';
import { ParciaisService } from './parciais.service';
import { RoundProcessingModule } from '../round-processing/round-processing.module';

@Module({
  imports: [AuthModule, RoundProcessingModule],
  controllers: [ParciaisController],
  providers: [ParciaisService],
  exports: [ParciaisService],
})
export class ParciaisModule {}
