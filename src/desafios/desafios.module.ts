import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { PrismaModule } from '../prisma/prisma.module';
import { DesafiosController } from './desafios.controller';
import { DesafiosService } from './desafios.service';
import { CarteiraModule } from '../carteira/carteira.module';
import { DesafioParticipacaoController } from './desafio-participacao.controller';
import { DesafioParticipacaoService } from './desafio-participacao.service';
import { DesafioRankingController } from './desafio-ranking.controller';
import { DesafioRankingService } from './desafio-ranking.service';

@Module({ imports: [AuthModule, PrismaModule, CarteiraModule],
  controllers: [DesafiosController, DesafioParticipacaoController, DesafioRankingController],
  providers: [DesafiosService, DesafioParticipacaoService, DesafioRankingService] })
export class DesafiosModule {}
