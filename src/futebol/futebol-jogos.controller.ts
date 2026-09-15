import { Controller, Get } from '@nestjs/common';
import { ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import { FutebolJogosHojeResponseDto } from './dto/futebol-response.dto';
import { FutebolQueryService } from './futebol-query.service';

@ApiTags('futebol')
@Controller('futebol/jogos')
export class FutebolJogosController {
  constructor(private readonly futebol: FutebolQueryService) {}

  @Get('hoje')
  @ApiOperation({ summary: 'Jogos do dia em America/Sao_Paulo, exclusivamente do banco local e de competições ativas' })
  @ApiOkResponse({ type: FutebolJogosHojeResponseDto })
  listarHoje() { return this.futebol.listarJogosHoje(); }
}
