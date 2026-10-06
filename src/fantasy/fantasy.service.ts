import { BadRequestException, Injectable } from '@nestjs/common';
import { ApiFootballClient } from './api-football.client';
import { mapEstatisticas, mapFormacao, mapSumario } from './api-football.mapper';
import { EstatisticasPartida, FormacaoPartida, SumarioPartida } from './fantasy.types';

@Injectable()
export class FantasyService {
  constructor(private readonly client: ApiFootballClient) {}
  async sumario(fixtureId: string): Promise<SumarioPartida> {
    const id = this.validarFixtureId(fixtureId);
    const fixture = await this.client.fixture(id);
    const events = await this.client.events(id);
    return mapSumario(fixture, events);
  }

  async estatisticas(fixtureId: string): Promise<EstatisticasPartida> {
    const id = this.validarFixtureId(fixtureId);
    const fixture = await this.client.fixture(id);
    const statistics = await this.client.statistics(id);
    return mapEstatisticas(fixture, statistics);
  }

  async formacao(fixtureId: string): Promise<FormacaoPartida> {
    const id = this.validarFixtureId(fixtureId);
    const fixture = await this.client.fixture(id);
    const lineups = await this.client.lineups(id);
    return mapFormacao(fixture, lineups);
  }

  private validarFixtureId(fixtureId: string): number {
    if (!/^\d+$/.test(fixtureId) || !Number.isSafeInteger(Number(fixtureId)) || Number(fixtureId) <= 0) {
      throw new BadRequestException('fixtureId deve ser um inteiro positivo');
    }
    return Number(fixtureId);
  }
}
