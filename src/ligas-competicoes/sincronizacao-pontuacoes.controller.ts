import { Controller, HttpCode, Param, Post, UseGuards } from '@nestjs/common';
import { ApiBadRequestResponse, ApiBearerAuth, ApiForbiddenResponse, ApiNotFoundResponse, ApiOkResponse, ApiOperation, ApiTags, ApiUnauthorizedResponse } from '@nestjs/swagger';
import { AdminGuard } from '../auth/admin.guard';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { CompeticaoIdParamsDto } from './dto/ligas-competicoes-query.dto';
import { SincronizacaoPontuacoesResponseDto } from './dto/sincronizacao-pontuacoes.dto';
import { SincronizacaoPontuacoesService } from './sincronizacao-pontuacoes.service';

@ApiTags('competicoes')
@ApiBearerAuth('jwt')
@UseGuards(JwtAuthGuard, AdminGuard)
@Controller('competicoes')
export class SincronizacaoPontuacoesController {
  constructor(private readonly sincronizacao: SincronizacaoPontuacoesService) {}

  @Post(':id/sincronizar-pontuacoes')
  @HttpCode(200)
  @ApiOperation({ summary: 'Sincroniza pontuacoes persistidas dos times da rodada com o ranking da competicao' })
  @ApiOkResponse({ type: SincronizacaoPontuacoesResponseDto })
  @ApiBadRequestResponse({ description: 'Competicao sem rodada unica ou temporada identificavel' })
  @ApiNotFoundResponse({ description: 'Competicao nao encontrada' })
  @ApiUnauthorizedResponse({ description: 'JWT ausente ou invalido' })
  @ApiForbiddenResponse({ description: 'Acesso exclusivo para administrador da plataforma' })
  sincronizar(@Param() params: CompeticaoIdParamsDto) {
    return this.sincronizacao.sincronizarPontuacoesCompeticao(params.id);
  }
}
