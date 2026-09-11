import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module';
import { FutebolController } from './futebol.controller';
import { FutebolQueryService } from './futebol-query.service';

@Module({ imports: [PrismaModule], controllers: [FutebolController], providers: [FutebolQueryService] })
export class FutebolQueryModule {}
