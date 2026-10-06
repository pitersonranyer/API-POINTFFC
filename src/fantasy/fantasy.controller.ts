import { Controller, Get, Param } from '@nestjs/common';
import { FantasyService } from './fantasy.service';

@Controller('fantasy')
export class FantasyController {
  constructor(private readonly service: FantasyService) {}
  @Get('partidas/:fixtureId/sumario')
  sumario(@Param('fixtureId') fixtureId: string) { return this.service.sumario(fixtureId); }

  @Get('partidas/:fixtureId/estatisticas')
  estatisticas(@Param('fixtureId') fixtureId: string) { return this.service.estatisticas(fixtureId); }

  @Get('partidas/:fixtureId/formacao')
  formacao(@Param('fixtureId') fixtureId: string) { return this.service.formacao(fixtureId); }
}
