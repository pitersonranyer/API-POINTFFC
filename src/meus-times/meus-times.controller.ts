import { Body, Controller, Delete, Get, HttpCode, Param, Post, UseGuards } from '@nestjs/common';
import { ApiBadRequestResponse, ApiBearerAuth, ApiBody, ApiCreatedResponse, ApiNotFoundResponse, ApiOkResponse, ApiOperation, ApiParam, ApiTags, ApiUnauthorizedResponse } from '@nestjs/swagger';
import { Usuario } from '@prisma/client';
import { AuthenticatedUser } from '../auth/authenticated-user.decorator';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { AdicionarTimeDto } from './dto/adicionar-time.dto';
import { ImportarTimesDto } from './dto/importar-times.dto';
import { TimeIdParamDto } from './dto/time-id-param.dto';
import { TimeUsuarioResponseDto } from './dto/time-usuario-response.dto';
import { MeusTimesService } from './meus-times.service';

@ApiTags('meus-times')
@ApiBearerAuth('jwt')
@ApiUnauthorizedResponse({ description: 'JWT ausente, invalido ou expirado' })
@UseGuards(JwtAuthGuard)
@Controller('meus-times')
export class MeusTimesController {
  constructor(private readonly meusTimes: MeusTimesService) {}

  @Get()
  @ApiOperation({ summary: 'Lista os times do usuario autenticado' })
  @ApiOkResponse({ description: 'Times ordenados do mais recente para o mais antigo', type: [TimeUsuarioResponseDto] })
  listar(@AuthenticatedUser() usuario: Usuario) {
    return this.meusTimes.listarTimesDoUsuario(usuario.idUsuario);
  }

  @Post()
  @ApiOperation({ summary: 'Adiciona um time ao usuario autenticado' })
  @ApiCreatedResponse({ description: 'Retorna adicionado ou ja_existente', schema: { example: { status: 'adicionado', timeId: 44566162 } } })
  @ApiBadRequestResponse({ description: 'Dados do time invalidos' })
  adicionar(@AuthenticatedUser() usuario: Usuario, @Body() body: AdicionarTimeDto) {
    return this.meusTimes.adicionarTime(usuario.idUsuario, body);
  }

  @Post('importar')
  @HttpCode(200)
  @ApiOperation({ summary: 'Importa times de forma idempotente e com resultados parciais' })
  @ApiBody({ type: ImportarTimesDto })
  @ApiOkResponse({ description: 'Totais, IDs adicionados, existentes e falhas por item' })
  importar(@AuthenticatedUser() usuario: Usuario, @Body() body: ImportarTimesDto) {
    return this.meusTimes.adicionarTimesEmLote(usuario.idUsuario, body.times);
  }

  @Delete(':timeId')
  @HttpCode(204)
  @ApiOperation({ summary: 'Remove um time do usuario autenticado' })
  @ApiParam({ name: 'timeId', schema: { type: 'integer', minimum: 1 } })
  @ApiNotFoundResponse({ description: 'Vinculo nao encontrado para o usuario autenticado' })
  async remover(@AuthenticatedUser() usuario: Usuario, @Param() params: TimeIdParamDto): Promise<void> {
    await this.meusTimes.removerTime(usuario.idUsuario, params.timeId);
  }
}
