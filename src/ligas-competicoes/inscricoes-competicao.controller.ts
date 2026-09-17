import { Body, Controller, Get, Param, Post, UseGuards } from '@nestjs/common';
import { ApiBadRequestResponse, ApiBearerAuth, ApiConflictResponse, ApiCreatedResponse, ApiNotFoundResponse, ApiOkResponse, ApiOperation, ApiTags, ApiUnauthorizedResponse } from '@nestjs/swagger';
import { Usuario } from '@prisma/client';
import { AuthenticatedUser } from '../auth/authenticated-user.decorator';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { CompeticaoIdParamsDto } from './dto/ligas-competicoes-query.dto';
import { CriarInscricaoDto, CriarInscricoesResponseDto, MinhaInscricaoDto, ParticipanteCompeticaoDto } from './dto/inscricoes-competicao.dto';
import { InscricoesCompeticaoService } from './inscricoes-competicao.service';

@ApiTags('competicoes')
@Controller('competicoes')
export class InscricoesCompeticaoController {
  constructor(private readonly inscricoes: InscricoesCompeticaoService) {}

  @Post(':id/inscricoes')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth('jwt')
  @ApiOperation({ summary: 'Inscreve um ou mais times proprios em competicao FREE' })
  @ApiCreatedResponse({ type: CriarInscricoesResponseDto })
  @ApiBadRequestResponse({ description: 'ID ou timesCartolaIds invalido' })
  @ApiUnauthorizedResponse({ description: 'JWT ausente ou invalido' })
  @ApiNotFoundResponse({ description: 'Competicao ou time do usuario nao encontrado' })
  @ApiConflictResponse({ description: 'Inscricoes indisponiveis, limite atingido ou time ja inscrito' })
  criar(@AuthenticatedUser() usuario: Usuario, @Param() params: CompeticaoIdParamsDto, @Body() body: CriarInscricaoDto) {
    return this.inscricoes.criar(params.id, usuario.idUsuario, body.timesCartolaIds);
  }

  @Get(':id/inscricoes/minhas')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth('jwt')
  @ApiOperation({ summary: 'Lista minhas inscricoes na competicao' })
  @ApiOkResponse({ type: [MinhaInscricaoDto] })
  @ApiUnauthorizedResponse({ description: 'JWT ausente ou invalido' })
  @ApiNotFoundResponse({ description: 'Competicao nao encontrada' })
  minhas(@AuthenticatedUser() usuario: Usuario, @Param() params: CompeticaoIdParamsDto) {
    return this.inscricoes.minhas(params.id, usuario.idUsuario);
  }

  @Get(':id/participantes')
  @ApiOperation({ summary: 'Lista participantes ativos a partir do snapshot da inscricao' })
  @ApiOkResponse({ type: [ParticipanteCompeticaoDto] })
  @ApiNotFoundResponse({ description: 'Competicao publica nao encontrada' })
  participantes(@Param() params: CompeticaoIdParamsDto) {
    return this.inscricoes.participantes(params.id);
  }
}
