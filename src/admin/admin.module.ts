import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { AdminGuard } from '../auth/admin.guard';
import { PrismaModule } from '../prisma/prisma.module';
import { AdminCompeticoesController } from './admin-competicoes.controller';
import { AdminCompeticoesService } from './admin-competicoes.service';
import { AdminLigasController } from './admin-ligas.controller';
import { AdminLigasService } from './admin-ligas.service';
import { AdminPremiacoesController } from './admin-premiacoes.controller';
import { AdminPremiacoesService } from './admin-premiacoes.service';
import { AdminDashboardFinanceiroController } from './admin-dashboard-financeiro.controller';
import { AdminDashboardFinanceiroService } from './admin-dashboard-financeiro.service';
import { AdminDesafiosController } from './admin-desafios.controller';
import { AdminDesafiosService } from './admin-desafios.service';
import { FutebolModule } from '../futebol/futebol.module';
import { AdminDesafioPartidasService } from './admin-desafio-partidas.service';
import { AdminDesafioApuracaoService } from './admin-desafio-apuracao.service';
import { AdminDesafioApuracaoController } from './admin-desafio-apuracao.controller';
import { DesafioSyncService } from '../desafios/desafio-sync.service';

@Module({
  imports: [AuthModule, PrismaModule, FutebolModule],
  controllers: [AdminLigasController, AdminCompeticoesController, AdminPremiacoesController, AdminDashboardFinanceiroController, AdminDesafiosController, AdminDesafioApuracaoController],
  providers: [DesafioSyncService, AdminGuard, AdminLigasService, AdminCompeticoesService, AdminPremiacoesService, AdminDashboardFinanceiroService, AdminDesafiosService, AdminDesafioPartidasService, AdminDesafioApuracaoService],
})
export class AdminModule {}
