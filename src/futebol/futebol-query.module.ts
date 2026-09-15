import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module';
import { FutebolController } from './futebol.controller';
import { FutebolQueryService } from './futebol-query.service';
import { FutebolJogosController } from './futebol-jogos.controller';

@Module({ imports: [PrismaModule], controllers: [FutebolController, FutebolJogosController], providers: [FutebolQueryService] })
export class FutebolQueryModule {}
