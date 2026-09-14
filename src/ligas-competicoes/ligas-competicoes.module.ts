import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module';
import { LigasController, CompeticoesController } from './ligas-competicoes.controller';
import { LigasCompeticoesService } from './ligas-competicoes.service';
import { AuthModule } from '../auth/auth.module';
import { InscricoesCompeticaoController } from './inscricoes-competicao.controller';
import { InscricoesCompeticaoService } from './inscricoes-competicao.service';
import { ResumoCompeticaoController } from './resumo-competicao.controller';
import { ResumoCompeticaoService } from './resumo-competicao.service';
import { RankingCompeticaoController } from './ranking-competicao.controller';
import { RankingCompeticaoService } from './ranking-competicao.service';
import { AdminGuard } from '../auth/admin.guard';
import { DiagnosticoEscalacoesController } from './diagnostico-escalacoes.controller';
import { DiagnosticoEscalacoesService } from './diagnostico-escalacoes.service';
import { SincronizacaoPontuacoesController } from './sincronizacao-pontuacoes.controller';
import { SincronizacaoPontuacoesService } from './sincronizacao-pontuacoes.service';

@Module({ imports: [PrismaModule, AuthModule], controllers: [LigasController, CompeticoesController, InscricoesCompeticaoController, ResumoCompeticaoController, RankingCompeticaoController, DiagnosticoEscalacoesController, SincronizacaoPontuacoesController], providers: [LigasCompeticoesService, InscricoesCompeticaoService, ResumoCompeticaoService, RankingCompeticaoService, DiagnosticoEscalacoesService, SincronizacaoPontuacoesService, AdminGuard], exports: [SincronizacaoPontuacoesService] })
export class LigasCompeticoesModule {}
