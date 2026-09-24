import { Controller, Get, Param, Query } from '@nestjs/common';
import { ApiBadRequestResponse, ApiNotFoundResponse, ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import { CompeticaoIdParamsDto, LigaSlugParamsDto, ListarCompeticoesQueryDto } from './dto/ligas-competicoes-query.dto';
import { CompeticaoCardDto, CompeticaoDetalheDto, LigaResponseDto } from './dto/ligas-competicoes-response.dto';
import { LigasCompeticoesService } from './ligas-competicoes.service';

@ApiTags('ligas')
@ApiBadRequestResponse({ description: 'Parametros ou filtros invalidos' })
@ApiNotFoundResponse({ description: 'Liga nao encontrada ou indisponivel' })
@Controller('ligas')
export class LigasController {
  constructor(private readonly service: LigasCompeticoesService) {}

  @Get(':slug')
  @ApiOperation({ summary: 'Consulta uma liga publica e suas modalidades ativas' })
  @ApiOkResponse({ type: LigaResponseDto })
  buscar(@Param() params: LigaSlugParamsDto) { return this.service.buscarLiga(params.slug); }

  @Get(':slug/competicoes')
  @ApiOperation({ summary: 'Lista competicoes publicas de uma liga' })
  @ApiOkResponse({ type: [CompeticaoCardDto] })
  listar(@Param() params: LigaSlugParamsDto, @Query() query: ListarCompeticoesQueryDto) {
    return this.service.listarCompeticoes(params.slug, query);
  }
}

@ApiTags('competicoes')
@ApiBadRequestResponse({ description: 'ID invalido' })
@ApiNotFoundResponse({ description: 'Competicao nao encontrada ou indisponivel' })
@Controller('competicoes')
export class CompeticoesController {
  constructor(private readonly service: LigasCompeticoesService) {}

  @Get(':id')
  @ApiOperation({ summary: 'Consulta detalhe publico de uma competicao' })
  @ApiOkResponse({ type: CompeticaoDetalheDto })
  buscar(@Param() params: CompeticaoIdParamsDto) { return this.service.buscarCompeticao(params.id); }
}
