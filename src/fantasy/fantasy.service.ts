import { BadRequestException, Injectable } from '@nestjs/common';
import { ApiFootballClient } from './api-football.client';
import { mapSumario } from './api-football.mapper';
import { SumarioPartida } from './fantasy.types';

@Injectable()
export class FantasyService {
  constructor(private readonly client: ApiFootballClient) {}
  async sumario(fixtureId: string): Promise<SumarioPartida> {
    if (!/^\d+$/.test(fixtureId) || !Number.isSafeInteger(Number(fixtureId)) || Number(fixtureId) <= 0) {
      throw new BadRequestException('fixtureId deve ser um inteiro positivo');
    }
    const id = Number(fixtureId);
    const fixture = await this.client.fixture(id);
    const events = await this.client.events(id);
    return mapSumario(fixture, events);
  }
}
