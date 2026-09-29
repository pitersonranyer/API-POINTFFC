import { Body, Controller, Get, Header, Param, Put, Query, UseGuards } from '@nestjs/common';
import { ApiBadRequestResponse, ApiBearerAuth, ApiConflictResponse, ApiForbiddenResponse, ApiNotFoundResponse, ApiOkResponse, ApiOperation, ApiTags, ApiUnauthorizedResponse } from '@nestjs/swagger';
import { Usuario } from '@prisma/client';
import { AuthenticatedUser } from '../auth/authenticated-user.decorator';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { OptionalJwtAuthGuard } from '../auth/optional-jwt-auth.guard';
import { DesafiosService } from './desafios.service';
import { DesafioIdParamsDto, DesafioPartidaParamsDto, ListarDesafiosQueryDto, SalvarDesafioPalpiteDto } from './dto/desafios.dto';
import { DesafioDetalheDto, DesafioPalpiteSalvoDto, DesafiosPaginaDto } from './dto/desafios-response.dto';

@ApiTags('desafios')
@ApiBadRequestResponse({ description: 'Parametros ou payload invalidos' })
@ApiNotFoundResponse({ description: 'Desafio indisponivel ou partida inexistente neste Desafio' })
@Controller('desafios')
export class DesafiosController {
  constructor(private readonly desafios: DesafiosService) {}

  @Get()
  @ApiOperation({ summary: 'Lista Desafios publicos no periodo de disponibilizacao' })
  @ApiOkResponse({ type: DesafiosPaginaDto })
  listar(@Query() query: ListarDesafiosQueryDto) {
    return this.desafios.listar(query);
  }

  @Get(':id')
  @UseGuards(OptionalJwtAuthGuard)
  @Header('Cache-Control', 'private, no-store')
  @ApiBearerAuth('jwt')
  @ApiOperation({ summary: 'Detalhe publico; JWT opcional inclui somente os palpites do usuario' })
  @ApiOkResponse({ type: DesafioDetalheDto })
  @ApiUnauthorizedResponse({ description: 'Token informado invalido ou expirado' })
  @ApiForbiddenResponse({ description: 'Usuario bloqueado' })
  buscar(@Param() params: DesafioIdParamsDto, @AuthenticatedUser() usuario?: Usuario) {
    return this.desafios.buscar(params.id, usuario?.idUsuario);
  }

  @Put(':id/partidas/:partidaId/palpite')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth('jwt')
  @ApiOperation({ summary: 'Cria ou altera meu palpite, sem exigir inscricao' })
  @ApiOkResponse({ type: DesafioPalpiteSalvoDto })
  @ApiUnauthorizedResponse({ description: 'JWT ausente, invalido ou expirado' })
  @ApiForbiddenResponse({ description: 'Usuario bloqueado' })
  @ApiConflictResponse({ description: 'Desafio indisponivel para participacao ou partida fechada/inelegivel' })
  salvarPalpite(@Param() params: DesafioPartidaParamsDto, @AuthenticatedUser() usuario: Usuario,
    @Body() dto: SalvarDesafioPalpiteDto) {
    return this.desafios.salvarPalpite(params.id, params.partidaId, usuario.idUsuario, dto);
  }
}
