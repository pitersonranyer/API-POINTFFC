import { BadRequestException, ConflictException, Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Prisma, RodadaProcessamento } from '@prisma/client';
import { randomUUID } from 'crypto';
import { CartolaService } from '../cartola/cartola.service';
import { CartolaMarketStatus, CartolaMatchesResponse, CartolaScoredAthletesPayload } from '../cartola/cartola.types';
import { PrismaService } from '../prisma/prisma.service';
import { TimeSnapshotsService } from '../time-snapshots/time-snapshots.service';
import { effectiveLineup, matchEnded, matchStart, matchesByClub, Replacement, resolveReplacements, scoreMap, totalScore } from './round-calculator';

type RoundKey = { temporada: number; rodada: number };
const json = (value: unknown): Prisma.InputJsonValue => JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue;
const keyOf = (round: RoundKey): RoundKey => ({ temporada: round.temporada, rodada: round.rodada });
const LEASE_MS = 120_000;
const BATCH = 100;

@Injectable()
export class RoundProcessingService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(RoundProcessingService.name);
  private timer?: NodeJS.Timeout;
  private stopped = false;
  private running = false;

  constructor(private readonly prisma: PrismaService, private readonly cartola: CartolaService,
    private readonly snapshots: TimeSnapshotsService, private readonly config: ConfigService) {}

  onModuleInit(): void {
    if (this.config.get<string>('NODE_ENV') !== 'test' && this.config.get<boolean>('ROUND_PROCESSING_ENABLED', true)) this.schedule(0);
  }
  onModuleDestroy(): void { this.stopped = true; if (this.timer) clearTimeout(this.timer); }
  private schedule(delay: number): void {
    if (this.stopped) return;
    this.timer = setTimeout(() => { void this.tick().then((next) => this.schedule(next)); }, delay);
    this.timer.unref();
  }

  async tick(): Promise<number> {
    if (this.running) return 20_000;
    this.running = true;
    try {
      const market = await this.cartola.loadMarketStatusFresh();
      this.validateMarket(market);
      if (market.status_mercado === 2) {
        const key = { temporada: market.temporada!, rodada: market.rodada_atual };
        await this.ensureRound(key);
        await this.process(key, market, false);
      } else if (market.status_mercado === 1) {
        const pending = await this.prisma.rodadaProcessamento.findMany({
          where: { status: { not: 'CONSOLIDADA' } }, orderBy: [{ temporada: 'asc' }, { rodada: 'asc' }],
        });
        for (const round of pending) {
          // Never silently select N-1, a different season, or an older unverified API window.
          if (round.temporada === market.temporada && (round.rodada === market.rodada_atual - 1
            || (market.game_over === true && round.rodada === market.rodada_atual))) {
            await this.process(keyOf(round), market, true);
          } else {
            await this.prisma.rodadaProcessamento.update({ where: { temporada_rodada: keyOf(round) },
              data: { erro: 'Rodada pendente fora da janela oficial atual; exige reconciliacao administrativa com fonte da temporada validada' } });
          }
        }
      }
      return market.status_mercado === 2 && market.bola_rolando ? 20_000 : 60_000;
    } catch (error) {
      this.logger.error({ etapa: 'RODADA', resultado: 'ERRO', erro: this.message(error) });
      return 60_000;
    } finally { this.running = false; }
  }

  async reconcilePending(temporada?: number): Promise<RoundKey[]> {
    const market = await this.cartola.loadMarketStatusFresh();
    this.validateMarket(market);
    if (market.status_mercado !== 1 || (temporada !== undefined && temporada !== market.temporada)) {
      throw new BadRequestException('Conciliacao exige mercado aberto na temporada atual');
    }
    const rounds = await this.prisma.rodadaProcessamento.findMany({
      where: { temporada: market.temporada, status: { not: 'CONSOLIDADA' } },
    });
    const processed: RoundKey[] = [];
    for (const round of rounds) {
      if (round.rodada !== market.rodada_atual - 1 && !(market.game_over && round.rodada === market.rodada_atual)) {
        throw new BadRequestException('Rodada pendente fora da janela oficial atual');
      }
      if (!await this.process(keyOf(round), market, true)) throw new ConflictException('Rodada ja esta em processamento');
      processed.push(keyOf(round));
    }
    return processed;
  }

  // Explicit administrative service entry point; no new public endpoint.
  async reconsolidarRodada(rodada: number, temporada: number): Promise<void> {
    const market = await this.cartola.loadMarketStatusFresh();
    this.validateMarket(market);
    if (market.status_mercado !== 1 || temporada !== market.temporada
      || (rodada !== market.rodada_atual - 1 && !(market.game_over && rodada === market.rodada_atual))) {
      throw new BadRequestException('Fonte externa nao comprova a temporada de rodadas fora da janela atual');
    }
    if (!await this.process({ temporada, rodada }, market, true, true)) {
      throw new ConflictException('Rodada inexistente ou ja em processamento');
    }
  }

  private validateMarket(market: CartolaMarketStatus): void {
    if (!Number.isInteger(market.temporada) || market.temporada! < 1
      || !Number.isInteger(market.rodada_atual) || market.rodada_atual < 1 || market.rodada_atual > 38
      || !Number.isInteger(market.status_mercado) || typeof market.bola_rolando !== 'boolean') {
      throw new BadRequestException('Status do mercado sem temporada/rodada/estado validos');
    }
  }

  private async ensureRound(key: RoundKey): Promise<void> {
    const [linked, existing] = await Promise.all([
      this.prisma.timeUsuario.findMany({ select: { timeId: true }, distinct: ['timeId'] }),
      this.prisma.timeRodada.findMany({ where: key, select: { timeId: true } }),
    ]);
    const ids = [...new Set([...linked, ...existing].map((t) => t.timeId))].sort((a, b) => a - b);
    await this.prisma.rodadaProcessamento.upsert({ where: { temporada_rodada: key },
      create: { ...key, timesPrevistos: ids, falhasSnapshot: [] }, update: {} });
  }

  private async lease(key: RoundKey, token: string): Promise<void> {
    const updated = await this.prisma.rodadaProcessamento.updateMany({
      where: { ...key, lockToken: token, lockAte: { gt: new Date() } },
      data: { lockAte: new Date(Date.now() + LEASE_MS) },
    });
    if (updated.count !== 1) throw new Error('Lock da rodada expirou');
  }

  private async process(key: RoundKey, market: CartolaMarketStatus, final: boolean, force = false): Promise<boolean> {
    const token = randomUUID();
    const acquired = await this.prisma.rodadaProcessamento.updateMany({
      where: { ...key, ...(force ? {} : { status: { not: 'CONSOLIDADA' as const } }),
        OR: [{ lockAte: null }, { lockAte: { lt: new Date() } }] },
      data: { lockToken: token, lockAte: new Date(Date.now() + LEASE_MS) },
    });
    if (!acquired.count) return false;
    const started = Date.now();
    try {
      const round = await this.prisma.rodadaProcessamento.findUniqueOrThrow({ where: { temporada_rodada: key } });
      if (!final) await this.capture(round, token);
      await this.calculate(round, market, token, final);
      this.logger.log({ ...key, etapa: final ? 'CONSOLIDACAO' : 'PARCIAL', duracaoMs: Date.now() - started, resultado: 'OK' });
      return true;
    } catch (error) {
      await this.prisma.rodadaProcessamento.updateMany({ where: { ...key, lockToken: token }, data: { erro: this.message(error) } });
      this.logger.error({ ...key, etapa: final ? 'CONSOLIDACAO' : 'PARCIAL', duracaoMs: Date.now() - started, resultado: 'ERRO', erro: this.message(error) });
      throw error;
    } finally {
      await this.prisma.rodadaProcessamento.updateMany({ where: { ...key, lockToken: token }, data: { lockToken: null, lockAte: null } });
    }
  }

  private async capture(round: RodadaProcessamento, token: string): Promise<void> {
    const started = Date.now();
    const key = keyOf(round);
    const ids = round.timesPrevistos as number[];
    const existing = await this.prisma.timeRodada.findMany({ where: key, select: { timeId: true, escalacao: { select: { titular: true } } } });
    const valid = new Set(existing.filter((t) => t.escalacao.some((a) => a.titular)).map((t) => t.timeId));
    const missing = ids.filter((id) => !valid.has(id));
    const failures: Array<{ timeId: number; erro: string }> = [];
    for (let index = 0; index < missing.length; index += 5) {
      await this.lease(key, token);
      const results = await Promise.allSettled(missing.slice(index, index + 5).map((timeId) => this.snapshots.criarSnapshot({ ...key, timeId })));
      results.forEach((result, offset) => {
        if (result.status === 'rejected' || result.value.titulares === 0) failures.push({ timeId: missing[index + offset],
          erro: result.status === 'rejected' ? this.message(result.reason) : 'Snapshot existente sem titulares' });
      });
      await this.prisma.rodadaProcessamento.updateMany({ where: { ...key, lockToken: token }, data: { falhasSnapshot: json(failures) } });
    }
    await this.prisma.rodadaProcessamento.updateMany({ where: { ...key, lockToken: token }, data: {
      status: failures.length ? 'AGUARDANDO_ESCALACOES' : 'ESCALACOES_CARREGADAS',
      falhasSnapshot: json(failures),
    } });
    this.logger.log({ ...key, etapa: 'SNAPSHOT', timesPrevistos: ids.length, timesCarregados: ids.length - failures.length,
      falhasSnapshot: failures.length, duracaoMs: Date.now() - started, resultado: failures.length ? 'PENDENTE' : 'OK' });
  }

  private async calculate(round: RodadaProcessamento, market: CartolaMarketStatus, token: string, final: boolean): Promise<void> {
    const key = keyOf(round);
    const all = await this.prisma.timeRodada.findMany({ where: key, select: { id: true, timeId: true,
      _count: { select: { escalacao: { where: { titular: true } } } },
    } });
    const teams = all.filter((t) => t._count.escalacao > 0);
    const ids = new Set(teams.map((t) => t.timeId));
    const missing = (round.timesPrevistos as number[]).filter((id) => !ids.has(id));
    if (final && (missing.length || all.length !== teams.length)) throw new Error(`Snapshot incompleto: ${missing.length || all.length - teams.length} times`);
    if (!teams.length && (round.timesPrevistos as number[]).length) return;
    // Capture finishes before the first request for scores; one envelope serves every team.
    const scored = final ? await this.cartola.loadFinalScoredAthletesFresh(key.temporada, key.rodada)
      : (await this.cartola.loadScoredAthletesFresh()).value;
    const receivedMatches = await this.cartola.loadMatchesFresh(key.rodada);
    const oldMatches = round.partidas as unknown as CartolaMatchesResponse | null;
    const priorMatches = new Map(oldMatches?.partidas.map((m) => [m.partida_id, m]) ?? []);
    // Retain a confirmed full-time signal if the provider clears live metadata.
    const matches = { ...receivedMatches, partidas: receivedMatches.partidas.map((m) =>
      !m.periodo_tr && priorMatches.get(m.partida_id)?.periodo_tr === 'F' ? { ...m, periodo_tr: 'F' } : m) };
    const scores = scoreMap(scored, key.rodada);
    const clubs = matchesByClub(matches, key.rodada);
    if (final && teams.length && (clubs.size === 0 || [...clubs.values()].some((m) => !(matchStart(m) <= Date.now())))) {
      throw new Error('Partidas finais ausentes, futuras ou com horario desconhecido');
    }
    if (final && scores.size === 0 && teams.length) throw new Error('Pontuados finais vazios');
    const previous = round.pontuados as CartolaScoredAthletesPayload | null;
    const oldScores = previous?.atletas ?? {};
    if (scores.size === 0 && Object.keys(oldScores).length > 0) throw new Error('Envelope vazio apos pontuados validos; preservar ultima parcial');
    const changed = new Set([...Object.keys(oldScores), ...scores.keys()].map(Number).filter((id) =>
      JSON.stringify(oldScores[id]) !== JSON.stringify(scores.get(id))));
    const oldClubs = oldMatches ? matchesByClub(oldMatches, key.rodada) : new Map();
    const signature = (match: CartolaMatchesResponse['partidas'][number] | undefined) => match
      ? JSON.stringify([match.partida_id, match.valida, matchEnded(match), matchStart(match)]) : '';
    const changedClubs = new Set([...clubs.keys(), ...oldClubs.keys()].filter((id) =>
      signature(oldClubs.get(id)) !== signature(clubs.get(id))));
    const affected = await this.prisma.timeRodada.findMany({
      where: { ...key, escalacao: { some: { titular: true } }, ...(final || !previous ? {} : {
        OR: [{ pontuacao: { is: null } }, { escalacao: { some: { OR: [
          { atletaId: { in: [...changed] } }, { clubeId: { in: [...changedClubs] } },
        ] } } }],
      }) },
      include: { escalacao: true, pontuacao: true, substituicoes: { where: { ativa: true } } },
    });
    const totals: Array<{ id: number; total: Prisma.Decimal; replacements: Replacement[] }> = [];
    let substitutionCount = 0;
    for (const team of affected) {
      // Reevaluate only on relevant match changes, first calculation, or final reconciliation.
      const relevantMatchChange = team.escalacao.some((a) => a.clubeId !== null && changedClubs.has(a.clubeId));
      const participationChanged = team.escalacao.some((a) => changed.has(a.atletaId)
        && oldScores[a.atletaId]?.entrou_em_campo !== scores.get(a.atletaId)?.entrou_em_campo);
      const resolution = final || !team.pontuacao || relevantMatchChange || participationChanged
        ? resolveReplacements(team, scores, clubs, final) : { replacements: team.substituicoes, pending: [] };
      if (final && resolution.pending.length) throw new Error(`Time ${team.timeId}: ${resolution.pending.join('; ')}`);
      if (final && team.escalacao.some((a) => a.titular && !scores.has(a.atletaId))) {
        throw new Error(`Time ${team.timeId}: atleta titular sem dados finais oficiais`);
      }
      totals.push({ id: team.id, total: totalScore(effectiveLineup(team, resolution.replacements), scores), replacements: resolution.replacements });
      substitutionCount += resolution.replacements.length;
    }
    await this.lease(key, token);
    const latest = await this.cartola.loadMarketStatusFresh();
    this.validateMarket(latest);
    if (latest.temporada !== market.temporada || latest.rodada_atual !== market.rodada_atual
      || latest.status_mercado !== market.status_mercado) throw new Error('Mercado mudou durante processamento; tentar novamente');
    const ended = matches.partidas.filter((m) => m.valida === true);
    const waiting = !market.bola_rolando && ended.length > 0 && ended.every((m) => matchStart(m) <= Date.now());
    await this.prisma.$transaction(async (tx) => {
      // Fencing plus row lock: another worker cannot publish after lease takeover.
      const fenced = await tx.rodadaProcessamento.updateMany({ where: { ...key, lockToken: token, lockAte: { gt: new Date() } },
        data: { lockAte: new Date(Date.now() + LEASE_MS) } });
      if (fenced.count !== 1) throw new Error('Lock perdido antes da persistencia');
      for (let index = 0; index < totals.length; index += BATCH) {
        const batch = totals.slice(index, index + BATCH);
        const now = new Date();
        const status = final ? 'FINAL' : 'PARCIAL';
        await tx.$executeRaw(Prisma.sql`
          INSERT INTO PONTUACAO_TIME_RODADA (TIME_RODADA_ID, PONTUACAO, STATUS, CRIADO_EM, ATUALIZADO_EM, CONSOLIDADO_EM)
          VALUES ${Prisma.join(batch.map((t) => Prisma.sql`(${t.id}, ${t.total}, ${status}, ${now}, ${now}, ${final ? now : null})`))}
          ON DUPLICATE KEY UPDATE PONTUACAO=VALUES(PONTUACAO), STATUS=VALUES(STATUS), ATUALIZADO_EM=VALUES(ATUALIZADO_EM), CONSOLIDADO_EM=VALUES(CONSOLIDADO_EM)`);
        await tx.substituicaoTimeRodada.updateMany({ where: { timeRodadaId: { in: batch.map((t) => t.id) } }, data: { ativa: false } });
        const replacements = batch.flatMap((t) => t.replacements.map((r) => ({ ...r, timeRodadaId: t.id })));
        if (replacements.length) await tx.$executeRaw(Prisma.sql`
          INSERT INTO SUBSTITUICAO_TIME_RODADA (TIME_RODADA_ID, ATLETA_SAIU_ID, ATLETA_ENTROU_ID, POSICAO_ID, ATIVA, CRIADO_EM, ATUALIZADO_EM)
          VALUES ${Prisma.join(replacements.map((r) => Prisma.sql`(${r.timeRodadaId}, ${r.atletaSaiuId}, ${r.atletaEntrouId}, ${r.posicaoId}, true, ${now}, ${now})`))}
          ON DUPLICATE KEY UPDATE ATIVA=true, ATUALIZADO_EM=VALUES(ATUALIZADO_EM)`);
      }
      await tx.rodadaProcessamento.update({ where: { temporada_rodada: key }, data: {
        status: final ? 'CONSOLIDADA' : missing.length ? 'AGUARDANDO_ESCALACOES' : waiting ? 'AGUARDANDO_CONSOLIDACAO' : 'EM_ANDAMENTO',
        pontuados: json(scored), partidas: json(matches), erro: null, ...(final ? { consolidadoEm: new Date() } : {}),
      } });
    }, { timeout: 120_000, maxWait: 10_000 });
    this.logger.log({ ...key, etapa: final ? 'CONSOLIDACAO' : 'PARCIAL', atletasRecebidos: scores.size,
      atletasAlterados: changed.size, timesAfetados: totals.length, substituicoes: substitutionCount });
  }
  private message(error: unknown): string { return (error instanceof Error ? error.message : String(error)).slice(0, 2000); }
}
