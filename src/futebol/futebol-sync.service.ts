import { Injectable, Logger } from '@nestjs/common';
import { randomUUID } from 'crypto';
import { PrismaService } from '../prisma/prisma.service';
import { FootballDataClient } from './football-data.client';
import { vinculoCartola } from './futebol-cartola';
import { FootballDataError, mapCompetition, mapMatch, mapTeam, parseList } from './football-data.normalizer';

@Injectable()
export class FutebolSyncService {
  private readonly logger = new Logger(FutebolSyncService.name);
  private running?: Promise<unknown>;
  constructor(private readonly prisma: PrismaService, private readonly client: FootballDataClient) {}
  syncBrasileirao() {
    if (!this.running) this.running = this.sync().finally(() => { this.running = undefined; });
    return this.running;
  }
  private async sync() {
    // Persisted only if the entire transaction commits. Start time is conservative
    // when a scheduling boundary is crossed while fetching the provider.
    const ultimoSyncEm = new Date();
    const syncId = randomUUID();
    this.logger.log(JSON.stringify({ event: 'futebol.sync.start', syncId, at: ultimoSyncEm.toISOString() }));
    const competition = mapCompetition(await this.client.getCompetition('BSA'));
    const year = competition.temporadaAtual;
    const teams = parseList(await this.client.getTeams('BSA', year), 'teams', competition.externalId, year).map(mapTeam);
    const matches = parseList(await this.client.getMatches('BSA', year), 'matches', competition.externalId, year).map(value => mapMatch(value, competition.externalId, year));
    this.logger.log(JSON.stringify({ event: 'futebol.provider.received', syncId, at: new Date().toISOString(), partidas: matches.length }));
    const teamIds = new Set(teams.map(team => team.externalId));
    if (matches.some(match => !teamIds.has(match.mandanteExternalId) || !teamIds.has(match.visitanteExternalId))) throw new FootballDataError('football-data: partida com clube ausente na temporada.');
    const changes: unknown[] = [];
    let ignored = 0;
    const result = await this.prisma.$transaction(async tx => {
      const dataCompeticao = { ...competition, ultimoSyncEm };
      const saved = await tx.futebolCompeticao.upsert({ where: { externalId: competition.externalId }, create: dataCompeticao, update: dataCompeticao });
      const localIds = new Map<number, number>();
      for (const team of teams) {
        const vinculo = vinculoCartola(competition.codigo, team.externalId);
        const row = await tx.futebolTime.upsert({ where: { externalId: team.externalId },
          create: { ...team, cartolaClubeId: vinculo.cartolaClubeId ?? null },
          update: { ...team, ...vinculo } });
        localIds.set(team.externalId, row.id);
      }
      for (const match of matches) {
        const { mandanteExternalId, visitanteExternalId, ...fields } = match;
        const data = { ...fields, competicaoId: saved.id, timeMandanteId: localIds.get(mandanteExternalId)!, timeVisitanteId: localIds.get(visitanteExternalId)! };
        const existing = await tx.futebolPartida.findUnique({ where: { externalId: data.externalId } });
        const changed = !existing || existing.status !== data.status || existing.placarMandante !== data.placarMandante || existing.placarVisitante !== data.placarVisitante;
        const stale = existing && existing.ultimaAtualizacaoApi > data.ultimaAtualizacaoApi;
        if (changed || stale || ['IN_PLAY', 'PAUSED'].includes(data.status)) {
          const observation = { externalId: data.externalId, status: data.status, placarMandante: data.placarMandante,
            placarVisitante: data.placarVisitante, ultimaAtualizacaoApi: data.ultimaAtualizacaoApi,
            anterior: existing ? { status: existing.status, placarMandante: existing.placarMandante, placarVisitante: existing.placarVisitante } : null,
            ignored: Boolean(stale) };
          this.logger.log(JSON.stringify({ event: 'futebol.provider.match', syncId, at: new Date().toISOString(), ...observation }));
          if (!stale) changes.push(observation);
        }
        if (stale) { ignored++; continue; }
        await tx.futebolPartida.upsert({ where: { externalId: data.externalId }, create: data, update: data });
      }
      const where = { competicaoId: saved.id, temporada: year };
      return { competicao: 'BSA', temporada: year, clubesProcessados: teamIds.size, partidasRecebidas: new Set(matches.map(match => match.externalId)).size,
        partidasPersistidas: await tx.futebolPartida.count({ where }),
        exemplos: await tx.futebolPartida.findMany({ where, take: 3, orderBy: { dataHoraUtc: 'asc' }, include: { timeMandante: true, timeVisitante: true } }) };
    }, { timeout: 120000, isolationLevel: 'Serializable' });
    this.logger.log(JSON.stringify({ event: 'futebol.sync.committed', syncId, at: new Date().toISOString(),
      ultimoSyncEm, durationMs: Date.now() - ultimoSyncEm.getTime(), ignored, partidas: changes }));
    return result;
  }
}
