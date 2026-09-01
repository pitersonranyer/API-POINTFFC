import { Controller, Get, Query } from '@nestjs/common';
import { ApiBadRequestResponse, ApiOkResponse, ApiOperation, ApiQuery, ApiTags } from '@nestjs/swagger';
import { RankingGeralQueryDto } from './dto/ranking-geral-query.dto';
import { RankingGeralResponseDto } from './dto/ranking-geral-response.dto';
import { RankingGeralService } from './ranking-geral.service';

@ApiTags('ranking-geral')
@Controller('ranking-geral')
export class RankingGeralController {
  constructor(private readonly rankingGeral: RankingGeralService) {}

  @Get()
  @ApiOperation({ summary: 'Ranking público dos times com pontuação persistida na rodada' })
  @ApiQuery({ name: 'temporada', type: Number, example: 2026 })
  @ApiQuery({ name: 'rodada', schema: { type: 'integer', minimum: 1, maximum: 38, example: 25 } })
  @ApiQuery({ name: 'limit', required: false, schema: { type: 'integer', minimum: 1, maximum: 100, default: 15 } })
  @ApiOkResponse({ type: RankingGeralResponseDto, description: 'Empates são ordenados pelo menor timeId' })
  @ApiBadRequestResponse({ description: 'Temporada, rodada ou limit inválido' })
  consultar(@Query() query: RankingGeralQueryDto): Promise<RankingGeralResponseDto> {
    return this.rankingGeral.consultar(query);
  }
}
