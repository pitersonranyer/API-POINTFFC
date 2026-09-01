import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import { ApiBadRequestResponse, ApiBearerAuth, ApiOkResponse, ApiOperation, ApiQuery, ApiTags, ApiUnauthorizedResponse } from '@nestjs/swagger';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { ListarParciaisQueryDto, MAX_PARTIAL_TEAM_IDS } from './dto/listar-parciais-query.dto';
import { ListaParciaisResponseDto } from './dto/parcial-time-response.dto';
import { ParciaisService } from './parciais.service';

@ApiTags('parciais')
@ApiBearerAuth('jwt')
@ApiUnauthorizedResponse({ description: 'JWT ausente, inválido ou expirado' })
@UseGuards(JwtAuthGuard)
@Controller('parciais')
export class ParciaisController {
  constructor(private readonly parciais: ParciaisService) {}

  @Get()
  @ApiOperation({ summary: 'Consulta parciais já persistidas sem executar cálculos' })
  @ApiQuery({ name: 'temporada', type: Number, example: 2026 })
  @ApiQuery({ name: 'rodada', schema: { type: 'integer', minimum: 1, maximum: 38, example: 25 } })
  @ApiQuery({
    name: 'timeIds',
    type: String,
    example: '30157355,12345678',
    description: `De 1 a ${MAX_PARTIAL_TEAM_IDS} IDs positivos, sem duplicação`,
  })
  @ApiOkResponse({ type: ListaParciaisResponseDto })
  @ApiBadRequestResponse({ description: 'Temporada, rodada ou lista de IDs inválida' })
  listar(@Query() query: ListarParciaisQueryDto): Promise<ListaParciaisResponseDto> {
    return this.parciais.listar(query);
  }
}
