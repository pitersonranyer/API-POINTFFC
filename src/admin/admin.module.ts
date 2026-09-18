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

@Module({
  imports: [AuthModule, PrismaModule],
  controllers: [AdminLigasController, AdminCompeticoesController, AdminPremiacoesController],
  providers: [AdminGuard, AdminLigasService, AdminCompeticoesService, AdminPremiacoesService],
})
export class AdminModule {}
