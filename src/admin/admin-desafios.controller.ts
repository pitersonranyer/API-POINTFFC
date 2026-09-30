import { Body, Controller, Delete, Get, Param, Patch, Post, Query, UseGuards } from '@nestjs/common';
import { ApiBadRequestResponse, ApiBearerAuth, ApiConflictResponse, ApiCreatedResponse, ApiForbiddenResponse, ApiNotFoundResponse, ApiOkResponse, ApiTags, ApiUnauthorizedResponse } from '@nestjs/swagger';
import { Usuario } from '@prisma/client';
import { AdminGuard } from '../auth/admin.guard';
import { AuthenticatedUser } from '../auth/authenticated-user.decorator';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { AdminDesafiosService } from './admin-desafios.service';
import { AdminDesafioPartidasService } from './admin-desafio-partidas.service';
import { AdicionarAdminDesafioPartidaDto, AdminDesafioPartidaParamsDto, PesquisarAdminFixturesDto, ReordenarAdminDesafioPartidasDto } from './dto/admin-desafio-partidas.dto';
import { AdminIdParamsDto } from './dto/admin-common.dto';
import { AcaoAdminDesafioDto, AtualizarAdminDesafioDto, CriarAdminDesafioDto, ListarAdminDesafiosQueryDto } from './dto/admin-desafios.dto';

@ApiTags('admin')
@ApiBearerAuth('jwt')
@ApiUnauthorizedResponse({ description: 'JWT ausente ou invalido' })
@ApiForbiddenResponse({ description: 'Acesso exclusivo para PLATFORM_ADMIN ativo' })
@ApiBadRequestResponse({ description: 'Configuracao ou parametros invalidos' })
@ApiNotFoundResponse({ description: 'Desafio nao encontrado' })
@ApiConflictResponse({ description: 'Operacao nao permitida no status atual' })
@UseGuards(JwtAuthGuard, AdminGuard)
@Controller('admin/desafios')
export class AdminDesafiosController {
  constructor(private readonly desafios: AdminDesafiosService, private readonly partidas: AdminDesafioPartidasService) {}

  @Post()
  @ApiCreatedResponse({ description: 'Desafio criado como RASCUNHO' })
  criar(@AuthenticatedUser() usuario: Usuario, @Body() dto: CriarAdminDesafioDto): Promise<Record<string, unknown>> {
    return this.desafios.criar(usuario.idUsuario, dto);
  }

  @Get()
  @ApiOkResponse({ description: 'Pagina de desafios administrativos' })
  listar(@Query() query: ListarAdminDesafiosQueryDto): Promise<Record<string, unknown>> {
    return this.desafios.listar(query);
  }

  // Rota estatica deve preceder :id para nao ser interpretada como identificador.
  @Get('fixtures')
  @ApiOkResponse({ description: 'Partidas oficiais football-data.org das competicoes suportadas, por periodo inclusivo de ate 7 dias UTC, sem persistencia' })
  pesquisarFixtures(@Query() query: PesquisarAdminFixturesDto) {
    return this.partidas.pesquisar(query);
  }

  @Post(':id/partidas')
  @ApiCreatedResponse({ description: 'Snapshot oficial adicionado ao rascunho' })
  adicionarPartida(@Param() params: AdminIdParamsDto, @Body() dto: AdicionarAdminDesafioPartidaDto) {
    return this.partidas.adicionar(params.id, dto.fixtureId);
  }

  @Get(':id/partidas')
  @ApiOkResponse({ description: 'Partidas ordenadas do Desafio' })
  listarPartidas(@Param() params: AdminIdParamsDto) {
    return this.partidas.listar(params.id);
  }

  @Patch(':id/partidas/ordem')
  @ApiOkResponse({ description: 'Lista completa com ordens sequenciais' })
  reordenarPartidas(@Param() params: AdminIdParamsDto, @Body() dto: ReordenarAdminDesafioPartidasDto) {
    return this.partidas.reordenar(params.id, dto.partidaIds);
  }

  @Delete(':id/partidas/:partidaId')
  @ApiOkResponse({ description: 'Partidas restantes com ordem normalizada' })
  removerPartida(@Param() params: AdminDesafioPartidaParamsDto) {
    return this.partidas.remover(params.id, params.partidaId);
  }

  @Get(':id')
  @ApiOkResponse({ description: 'Configuracao completa do desafio' })
  buscar(@Param() params: AdminIdParamsDto): Promise<Record<string, unknown>> {
    return this.desafios.buscar(params.id);
  }

  @Patch(':id')
  @ApiOkResponse({ description: 'Rascunho atualizado' })
  atualizar(@Param() params: AdminIdParamsDto, @Body() dto: AtualizarAdminDesafioDto): Promise<Record<string, unknown>> {
    return this.desafios.atualizar(params.id, dto);
  }

  @Post(':id/publicar')
  @ApiCreatedResponse({ description: 'Desafio publicado como ABERTO' })
  publicar(@Param() params: AdminIdParamsDto, @Body() dto: AcaoAdminDesafioDto): Promise<Record<string, unknown>> {
    void dto;
    return this.desafios.publicar(params.id);
  }

  @Post(':id/cancelar')
  @ApiCreatedResponse({ description: 'Desafio cancelado' })
  cancelar(@Param() params: AdminIdParamsDto, @Body() dto: AcaoAdminDesafioDto): Promise<Record<string, unknown>> {
    void dto;
    return this.desafios.cancelar(params.id);
  }
}
