import { Controller, Get, Param, UseGuards } from '@nestjs/common';
import { ApiBadRequestResponse, ApiBearerAuth, ApiNotFoundResponse, ApiOkResponse, ApiOperation, ApiTags, ApiUnauthorizedResponse } from '@nestjs/swagger';
import { Usuario } from '@prisma/client';
import { AuthenticatedUser } from '../auth/authenticated-user.decorator';
import { OptionalJwtAuthGuard } from '../auth/optional-jwt-auth.guard';
import { CompeticaoIdParamsDto } from './dto/ligas-competicoes-query.dto';
import { ResumoCompeticaoResponseDto } from './dto/resumo-competicao.dto';
import { ResumoCompeticaoService } from './resumo-competicao.service';

@ApiTags('competicoes')
@Controller('competicoes')
export class ResumoCompeticaoController {
  constructor(private readonly resumo: ResumoCompeticaoService) {}

  @Get(':id/resumo')
  @UseGuards(OptionalJwtAuthGuard)
  @ApiBearerAuth('jwt')
  @ApiOperation({ summary: 'Resumo publico da competicao com dados pessoais quando autenticado' })
  @ApiOkResponse({ type: ResumoCompeticaoResponseDto })
  @ApiBadRequestResponse({ description: 'ID invalido' })
  @ApiUnauthorizedResponse({ description: 'Token informado invalido ou expirado' })
  @ApiNotFoundResponse({ description: 'Competicao nao encontrada ou invisivel' })
  consultar(@Param() params: CompeticaoIdParamsDto, @AuthenticatedUser() usuario?: Usuario) {
    return this.resumo.consultar(params.id, usuario?.idUsuario);
  }
}
