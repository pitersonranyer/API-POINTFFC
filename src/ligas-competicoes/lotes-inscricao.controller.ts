import { Body, Controller, Headers, Param, Post, UseGuards } from '@nestjs/common';
import { ApiBadRequestResponse, ApiBearerAuth, ApiConflictResponse, ApiCreatedResponse, ApiHeader, ApiNotFoundResponse, ApiOperation, ApiTags, ApiUnauthorizedResponse } from '@nestjs/swagger';
import { Usuario } from '@prisma/client';
import { AuthenticatedUser } from '../auth/authenticated-user.decorator';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { CompeticaoIdParamsDto } from './dto/ligas-competicoes-query.dto';
import { CriarLoteInscricaoDto, LoteInscricaoResponseDto } from './dto/lotes-inscricao.dto';
import { LotesInscricaoService } from './lotes-inscricao.service';

@ApiTags('competicoes')
@ApiBearerAuth('jwt')
@UseGuards(JwtAuthGuard)
@Controller('competicoes')
export class LotesInscricaoController {
  constructor(private readonly lotes: LotesInscricaoService) {}

  @Post(':id/inscricoes/lote')
  @ApiOperation({ summary: 'Inscreve lote FREE/PAGO atomicamente; repeticoes retornam a resposta original' })
  @ApiHeader({ name: 'Idempotency-Key', required: true, description: '16 a 128 caracteres alfanumericos, hifen ou underscore. Escopada por usuario.' })
  @ApiCreatedResponse({ type: LoteInscricaoResponseDto })
  @ApiBadRequestResponse({ description: 'DTO, ID ou Idempotency-Key invalido' })
  @ApiUnauthorizedResponse({ description: 'JWT ausente ou invalido' })
  @ApiNotFoundResponse({ description: 'Competicao ou time do usuario inexistente' })
  @ApiConflictResponse({ description: 'SALDO_INSUFICIENTE (saldoDisponivel, valorNecessario, valorFaltante, moeda); PRECO_INSCRICAO_ALTERADO (valorEsperado, valorAtual, quantidade, valorTotalAtual); IDEMPOTENCY_KEY_REUTILIZADA; limites, carteira bloqueada ou inscricao indisponivel' })
  criar(@AuthenticatedUser() usuario: Usuario, @Param() params: CompeticaoIdParamsDto,
    @Body() body: CriarLoteInscricaoDto, @Headers('idempotency-key') chave: string | undefined) {
    return this.lotes.criar(params.id, usuario.idUsuario, body, chave);
  }
}
