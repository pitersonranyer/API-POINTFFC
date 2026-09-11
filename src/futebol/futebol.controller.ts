import { Controller, Get, Param, Query } from '@nestjs/common';
import { ApiBadRequestResponse, ApiNotFoundResponse, ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import { FutebolCodigoParamsDto, FutebolJogosQueryDto, FutebolRodadaParamsDto } from './dto/futebol-query.dto';
import { FutebolCompeticaoResponseDto, FutebolJogosResponseDto } from './dto/futebol-response.dto';
import { FutebolQueryService } from './futebol-query.service';

@ApiTags('futebol')
@ApiBadRequestResponse({ description: 'Parâmetros ou filtros inválidos' })
@ApiNotFoundResponse({ description: 'Competição não encontrada no banco local' })
@Controller('futebol/competicoes')
export class FutebolController {
  constructor(private readonly futebol: FutebolQueryService) {}

  @Get()
  @ApiOperation({ summary: 'Lista competições ativas persistidas localmente' })
  @ApiOkResponse({ type: [FutebolCompeticaoResponseDto] })
  listarCompeticoes() { return this.futebol.listarCompeticoes(); }

  @Get(':codigo/jogos')
  @ApiOperation({ summary: 'Consulta jogos exclusivamente no banco local' })
  @ApiOkResponse({ type: FutebolJogosResponseDto })
  listarJogos(@Param() params: FutebolCodigoParamsDto, @Query() query: FutebolJogosQueryDto) {
    return this.futebol.listarJogos(params.codigo, query);
  }

  @Get(':codigo/rodadas/:rodada')
  @ApiOperation({ summary: 'Consulta rodada da temporada atual da competição' })
  @ApiOkResponse({ type: FutebolJogosResponseDto })
  consultarRodada(@Param() params: FutebolRodadaParamsDto) { return this.futebol.consultarRodada(params.codigo, params.rodada); }

  @Get(':codigo/rodada-atual')
  @ApiOperation({ summary: 'Seleciona rodada pelos status persistidos, sem consultar o provedor' })
  @ApiOkResponse({ type: FutebolJogosResponseDto })
  consultarRodadaAtual(@Param() params: FutebolCodigoParamsDto) { return this.futebol.consultarRodadaAtual(params.codigo); }
}
