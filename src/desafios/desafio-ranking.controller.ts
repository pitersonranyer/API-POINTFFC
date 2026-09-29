import { Controller, Get, Param, Query } from '@nestjs/common';
import { ApiBadRequestResponse, ApiNotFoundResponse, ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import { DesafioIdParamsDto } from './dto/desafios.dto';
import { DesafioRankingDto, DesafioRankingQueryDto } from './dto/desafio-ranking.dto';
import { DesafioRankingService } from './desafio-ranking.service';

@ApiTags('desafios')
@Controller('desafios')
export class DesafioRankingController {
  constructor(private readonly ranking: DesafioRankingService) {}

  @Get(':id/ranking')
  @ApiOperation({ summary: 'Ranking publico dos inscritos ativos, com posicoes empatadas' })
  @ApiOkResponse({ type: DesafioRankingDto })
  @ApiNotFoundResponse({ description: 'Desafio inexistente ou nao publico' })
  @ApiBadRequestResponse({ description: 'ID ou paginacao invalida' })
  consultar(@Param() params: DesafioIdParamsDto, @Query() query: DesafioRankingQueryDto) {
    return this.ranking.consultar(params.id, query);
  }
}
