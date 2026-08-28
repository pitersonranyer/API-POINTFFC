import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { MeusTimesController } from './meus-times.controller';
import { MeusTimesService } from './meus-times.service';

@Module({
  imports: [AuthModule],
  controllers: [MeusTimesController],
  providers: [MeusTimesService],
  exports: [MeusTimesService],
})
export class MeusTimesModule {}
