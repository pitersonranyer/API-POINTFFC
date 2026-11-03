import { BadRequestException, Injectable } from '@nestjs/common';
import { ApiFutebolV2Client } from './api-futebol-v2.client';
import { consultarAgenda } from './agenda';
import { mapEstatisticas, mapFormacao, mapPreJogo, mapSumario } from './api-futebol-v2.mapper';

@Injectable()
export class FantasyService {
  constructor(private readonly client: ApiFutebolV2Client) {}
  agenda(temporada: string, rodada?: string) { return consultarAgenda(this.client, temporada, rodada); }
  async preJogo(fixtureId: string) { return mapPreJogo(await this.client.detalhe(this.id(fixtureId))); }
  async formacao(fixtureId: string) { return mapFormacao(await this.client.detalhe(this.id(fixtureId))); }
  async sumario(fixtureId: string) {
    const id = this.id(fixtureId), detalhe = await this.client.detalhe(id);
    const eventos = await this.client.eventos(id), lances = await this.client.lances(id);
    return mapSumario(detalhe, eventos, lances);
  }
  async estatisticas(fixtureId: string) {
    const id = this.id(fixtureId), detalhe = await this.client.detalhe(id);
    return mapEstatisticas(detalhe, await this.client.estatisticas(id));
  }
  private id(value: string): number {
    if (!/^\d+$/.test(value) || !Number.isSafeInteger(Number(value)) || Number(value) <= 0) throw new BadRequestException('fixtureId deve ser um ID inteiro positivo da API Futebol V2');
    return Number(value);
  }
}
