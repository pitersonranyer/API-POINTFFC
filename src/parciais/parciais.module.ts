import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { ParciaisController } from './parciais.controller';
import { ParciaisService } from './parciais.service';

@Module({
  imports: [AuthModule],
  controllers: [ParciaisController],
  providers: [ParciaisService],
  exports: [ParciaisService],
})
export class ParciaisModule {}
