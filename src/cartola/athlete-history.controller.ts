import { Controller, Get, Param, Query } from '@nestjs/common';
import { ApiBadRequestResponse, ApiNotFoundResponse, ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import { AthleteHistoryService } from './athlete-history.service';
import { AthleteHistoryParamsDto, AthleteHistoryQueryDto } from './dto/athlete-history-query.dto';
import { AthleteHistoryResponseDto } from './dto/athlete-history-response.dto';

@ApiTags('cartola')
@Controller('cartola/atletas')
export class AthleteHistoryController {
  constructor(private readonly history: AthleteHistoryService) {}

  @Get(':atletaId/historico')
  @ApiOperation({ summary: 'Histórico individual exclusivamente dos snapshots persistidos',
    description: 'Sem consultas externas ou gravações. CONSOLIDADA é o estado global da rodada. Pontuações oficiais são preservadas; ausência não equivale a zero. Participação só usa evidência explícita do snapshot. Empates nos extremos usam a primeira rodada. Cobertura é avaliada de 1 até a referência, independentemente do limite exibido.' })
  @ApiOkResponse({ type: AthleteHistoryResponseDto })
  @ApiBadRequestResponse({ description: 'Parâmetros inválidos' })
  @ApiNotFoundResponse({ description: 'Sem referência explícita e sem rodada consolidada na temporada' })
  getHistory(@Param() params: AthleteHistoryParamsDto, @Query() query: AthleteHistoryQueryDto) {
    return this.history.getHistory(params.atletaId, query);
  }
}
