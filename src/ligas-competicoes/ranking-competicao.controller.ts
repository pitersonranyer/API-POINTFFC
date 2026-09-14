import { Controller, Get, Param } from '@nestjs/common';
import { ApiBadRequestResponse, ApiNotFoundResponse, ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import { CompeticaoIdParamsDto } from './dto/ligas-competicoes-query.dto';
import { RankingCompeticaoResponseDto } from './dto/ranking-competicao.dto';
import { RankingCompeticaoService } from './ranking-competicao.service';

@ApiTags('competicoes')
@Controller('competicoes')
export class RankingCompeticaoController {
  constructor(private readonly ranking: RankingCompeticaoService) {}

  @Get(':id/ranking')
  @ApiOperation({ summary: 'Consulta ranking publico das inscricoes ativas' })
  @ApiOkResponse({ type: RankingCompeticaoResponseDto })
  @ApiBadRequestResponse({ description: 'ID invalido' })
  @ApiNotFoundResponse({ description: 'Competicao publica nao encontrada' })
  consultar(@Param() params: CompeticaoIdParamsDto) {
    return this.ranking.consultar(params.id);
  }
}
