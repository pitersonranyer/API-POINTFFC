import { Controller, Get, Param, UseGuards } from '@nestjs/common';
import { ApiBadRequestResponse, ApiBearerAuth, ApiForbiddenResponse, ApiNotFoundResponse, ApiOkResponse, ApiOperation, ApiTags, ApiUnauthorizedResponse } from '@nestjs/swagger';
import { AdminGuard } from '../auth/admin.guard';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { CompeticaoIdParamsDto } from './dto/ligas-competicoes-query.dto';
import { DiagnosticoEscalacoesResponseDto } from './dto/diagnostico-escalacoes.dto';
import { DiagnosticoEscalacoesService } from './diagnostico-escalacoes.service';

@ApiTags('competicoes')
@ApiBearerAuth('jwt')
@UseGuards(JwtAuthGuard, AdminGuard)
@Controller('competicoes')
export class DiagnosticoEscalacoesController {
  constructor(private readonly diagnostico: DiagnosticoEscalacoesService) {}

  @Get(':id/diagnostico-escalacoes')
  @ApiOperation({ summary: 'Diagnostica snapshots persistidos dos times inscritos na rodada' })
  @ApiOkResponse({ type: DiagnosticoEscalacoesResponseDto })
  @ApiBadRequestResponse({ description: 'Competicao sem rodada unica ou temporada identificavel' })
  @ApiNotFoundResponse({ description: 'Competicao nao encontrada' })
  @ApiUnauthorizedResponse({ description: 'JWT ausente ou invalido' })
  @ApiForbiddenResponse({ description: 'Acesso exclusivo para administrador da plataforma' })
  consultar(@Param() params: CompeticaoIdParamsDto) { return this.diagnostico.diagnosticar(params.id); }
}
