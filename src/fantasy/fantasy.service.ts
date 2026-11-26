import { BadRequestException, Injectable } from '@nestjs/common';
import { ApiFutebolV2Client } from './api-futebol-v2.client';
import { consultarAgenda } from './agenda';
import { mapEventos, mapEstatisticas, mapFormacao, mapPreJogo, mapSumario } from './api-futebol-v2.mapper';

import { simular } from './international-scoring';

@Injectable()
export class FantasyService {
  constructor(private readonly client: ApiFutebolV2Client) {}
  agenda(temporada?: string, rodada?: string, campeonato?: string, fase?: string) {
    return consultarAgenda(this.client, temporada, rodada, campeonato, fase);
  }
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
  async fantasy(fixtureId: string) {
    const id = this.id(fixtureId);
    const detalhe = await this.client.detalhe(id);
    const pre = mapPreJogo(detalhe);
    if (pre.partida.campeonatoId !== 15) throw new BadRequestException('Simulação disponível apenas na Champions League');
    const ativa = ['EM_ANDAMENTO', 'INTERVALO', 'ENCERRADA'].includes(pre.partida.status);
    const stats = ativa ? await this.client.estatisticas(id) : {};
    const eventos = ativa ? await this.client.eventos(id) : {};
    return simular(pre, mapEstatisticas(detalhe, stats), mapEventos(detalhe, eventos), new Date().toISOString());
  }
  private id(value: string): number {
    if (!/^\d+$/.test(value) || !Number.isSafeInteger(Number(value)) || Number(value) <= 0) throw new BadRequestException('fixtureId deve ser um ID inteiro positivo da API Futebol V2');
    return Number(value);
  }
}
