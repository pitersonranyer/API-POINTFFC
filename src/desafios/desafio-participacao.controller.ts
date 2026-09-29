import { Body, Controller, HttpCode, Param, Post, UseGuards } from '@nestjs/common';
import { ApiBadRequestResponse, ApiBearerAuth, ApiConflictResponse, ApiForbiddenResponse, ApiNotFoundResponse, ApiOkResponse, ApiOperation, ApiTags, ApiUnauthorizedResponse } from '@nestjs/swagger';
import { Usuario } from '@prisma/client';
import { AuthenticatedUser } from '../auth/authenticated-user.decorator';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { DesafioParticipacaoService } from './desafio-participacao.service';
import { DesafioIdParamsDto } from './dto/desafios.dto';
import { DesafioParticipacaoDto, DesafioSaldoInsuficienteDto, ParticiparDesafioDto } from './dto/desafio-participacao.dto';

@ApiTags('desafios')
@ApiBearerAuth('jwt')
@UseGuards(JwtAuthGuard)
@Controller('desafios')
export class DesafioParticipacaoController {
  constructor(private readonly participacao: DesafioParticipacaoService) {}

  @Post(':id/participar')
  @HttpCode(200)
  @ApiOperation({ summary: 'Confirma participacao com os palpites existentes; repeticao nao cobra novamente' })
  @ApiOkResponse({ type: DesafioParticipacaoDto })
  @ApiBadRequestResponse({ description: 'ID ou body invalido; aceita body ausente ou {}' })
  @ApiUnauthorizedResponse({ description: 'JWT ausente ou invalido' })
  @ApiForbiddenResponse({ description: 'Usuario nao ativo' })
  @ApiNotFoundResponse({ description: 'Desafio ou usuario inexistente' })
  @ApiConflictResponse({ description: 'Saldo insuficiente (code SALDO_INSUFICIENTE) ou impedimento de participacao; demais conflitos tambem possuem code', type: DesafioSaldoInsuficienteDto })
  participar(@Param() params: DesafioIdParamsDto, @AuthenticatedUser() usuario: Usuario, @Body() dto: ParticiparDesafioDto) {
    void dto;
    return this.participacao.participar(params.id, usuario.idUsuario);
  }
}
