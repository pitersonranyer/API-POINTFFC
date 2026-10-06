import { Controller, Get, Param } from '@nestjs/common';
import { FantasyService } from './fantasy.service';

@Controller('fantasy')
export class FantasyController {
  constructor(private readonly service: FantasyService) {}
  @Get('partidas/:fixtureId/sumario')
  sumario(@Param('fixtureId') fixtureId: string) { return this.service.sumario(fixtureId); }
}
