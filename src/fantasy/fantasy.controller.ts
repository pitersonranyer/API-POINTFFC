import { Controller, Get, Param, Query } from '@nestjs/common';
import { FantasyService } from './fantasy.service';

@Controller('fantasy')
export class FantasyController {
  constructor(private readonly service: FantasyService) {}
  @Get('agenda')
  agenda(
    @Query('temporada') temporada?: string,
    @Query('rodada') rodada?: string,
    @Query('campeonato') campeonato?: string,
    @Query('fase') fase?: string,
  ) {
    return this.service.agenda(temporada, rodada, campeonato, fase);
  }

  @Get('partidas/:fixtureId/pre-jogo')
  preJogo(@Param('fixtureId') fixtureId: string) { return this.service.preJogo(fixtureId); }

  @Get('partidas/:fixtureId/sumario')
  sumario(@Param('fixtureId') fixtureId: string) { return this.service.sumario(fixtureId); }

  @Get('partidas/:fixtureId/estatisticas')
  estatisticas(@Param('fixtureId') fixtureId: string) { return this.service.estatisticas(fixtureId); }

  @Get('partidas/:fixtureId/fantasy')
  fantasy(@Param('fixtureId') fixtureId: string) { return this.service.fantasy(fixtureId); }

  @Get('partidas/:fixtureId/formacao')
  formacao(@Param('fixtureId') fixtureId: string) { return this.service.formacao(fixtureId); }
}
