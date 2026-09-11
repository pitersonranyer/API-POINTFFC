import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { FootballDataClient } from './football-data.client';
import { FootballDataError, mapCompetition, mapMatch, mapTeam, parseList } from './football-data.normalizer';

@Injectable()
export class FutebolSyncService {
  private running?: Promise<unknown>;
  constructor(private readonly prisma: PrismaService, private readonly client: FootballDataClient) {}
  syncBrasileirao() {
    if (!this.running) this.running = this.sync().finally(() => { this.running = undefined; });
    return this.running;
  }
  private async sync() {
    const competition = mapCompetition(await this.client.getCompetition('BSA'));
    const year = competition.temporadaAtual;
    const teams = parseList(await this.client.getTeams('BSA', year), 'teams', competition.externalId, year).map(mapTeam);
    const matches = parseList(await this.client.getMatches('BSA', year), 'matches', competition.externalId, year).map(value => mapMatch(value, competition.externalId, year));
    const teamIds = new Set(teams.map(team => team.externalId));
    if (matches.some(match => !teamIds.has(match.mandanteExternalId) || !teamIds.has(match.visitanteExternalId))) throw new FootballDataError('football-data: partida com clube ausente na temporada.');
    return this.prisma.$transaction(async tx => {
      const saved = await tx.futebolCompeticao.upsert({ where: { externalId: competition.externalId }, create: competition, update: competition });
      const localIds = new Map<number, number>();
      for (const team of teams) {
        const row = await tx.futebolTime.upsert({ where: { externalId: team.externalId }, create: team, update: team });
        localIds.set(team.externalId, row.id);
      }
      for (const match of matches) {
        const { mandanteExternalId, visitanteExternalId, ...fields } = match;
        const data = { ...fields, competicaoId: saved.id, timeMandanteId: localIds.get(mandanteExternalId)!, timeVisitanteId: localIds.get(visitanteExternalId)! };
        const existing = await tx.futebolPartida.findUnique({ where: { externalId: data.externalId } });
        if (existing && existing.ultimaAtualizacaoApi > data.ultimaAtualizacaoApi) continue;
        await tx.futebolPartida.upsert({ where: { externalId: data.externalId }, create: data, update: data });
      }
      const where = { competicaoId: saved.id, temporada: year };
      return { competicao: 'BSA', temporada: year, clubesProcessados: teamIds.size, partidasRecebidas: new Set(matches.map(match => match.externalId)).size,
        partidasPersistidas: await tx.futebolPartida.count({ where }),
        exemplos: await tx.futebolPartida.findMany({ where, take: 3, orderBy: { dataHoraUtc: 'asc' }, include: { timeMandante: true, timeVisitante: true } }) };
    }, { timeout: 120000, isolationLevel: 'Serializable' });
  }
}
