import { BadRequestException, ConflictException, Injectable, Logger, NotFoundException, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Prisma, RodadaProcessamento } from '@prisma/client';
import { randomUUID } from 'crypto';
import { CartolaService } from '../cartola/cartola.service';
import { CartolaMarketStatus, CartolaMatchesResponse, CartolaScoredAthletesPayload } from '../cartola/cartola.types';
import { PrismaService } from '../prisma/prisma.service';
import { TimeSnapshotsService } from '../time-snapshots/time-snapshots.service';
import { SincronizacaoPontuacoesService } from '../ligas-competicoes/sincronizacao-pontuacoes.service';
import { athleteParticipation, effectiveLineup, matchEnded, matchStart, matchesByClub, Replacement, resolveReplacements, scoreMap, totalScore, validateFinalData, validateFinalTeam } from './round-calculator';
import { simulateRound } from './round-simulation';

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
    private readonly snapshots: TimeSnapshotsService, private readonly config: ConfigService,
    private readonly sincronizacao: SincronizacaoPontuacoesService) {}

  onModuleInit(): void {
    if (this.config.get<string>('NODE_ENV') !== 'test' && this.config.get<boolean>('ROUND_PROCESSING_ENABLED', true)) this.schedule(0);
  }
  onModuleDestroy(): void { this.stopped = true; if (this.timer) clearTimeout(this.timer); }

  async simularReconsolidacao(rodada: number, temporada: number) {
    if (!Number.isInteger(temporada) || temporada < 1 || temporada > 65535
      || !Number.isInteger(rodada) || rodada < 1 || rodada > 38) throw new BadRequestException('Temporada/rodada invalidas');
    const key = { temporada, rodada };
    return this.prisma.$transaction(async (tx) => {
      const round = await tx.rodadaProcessamento.findUnique({ where: { temporada_rodada: key } });
      if (!round) throw new NotFoundException('Rodada nao encontrada');
      const teams = await tx.timeRodada.findMany({ where: key, orderBy: { timeId: 'asc' },
        include: { time: { select: { nomeTime: true } }, escalacao: true, pontuacao: true,
          substituicoes: { where: { ativa: true } } } });
      return simulateRound(round, teams);
    }, { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead });
  }
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
    const inicioTemporada = new Date(Date.UTC(key.temporada, 0, 1));
    const fimTemporada = new Date(Date.UTC(key.temporada + 1, 0, 1));
    const [linked, inscritos, existing] = await Promise.all([
      this.prisma.timeUsuario.findMany({ select: { timeId: true }, distinct: ['timeId'] }),
      this.prisma.inscricaoTimeCompeticao.findMany({
        where: { statusInscricao: 'ATIVA', competicaoLiga: {
          rodadaInicio: { lte: key.rodada }, rodadaFim: { gte: key.rodada },
          OR: [{ dataInicio: null }, { dataInicio: { gte: inicioTemporada, lt: fimTemporada } }],
        } },
        select: { timeIdCartola: true }, distinct: ['timeIdCartola'],
      }),
      this.prisma.timeRodada.findMany({ where: key, select: { timeId: true } }),
    ]);
    const ids = [...new Set([...linked, ...existing].map((t) => t.timeId).concat(inscritos.map((t) => t.timeIdCartola)))].sort((a, b) => a - b);
    await this.prisma.$transaction(async (tx) => {
      await tx.rodadaProcessamento.upsert({ where: { temporada_rodada: key },
        create: { ...key, timesPrevistos: ids, falhasSnapshot: [] }, update: {} });
      await tx.$queryRaw`SELECT temporada FROM RODADA_PROCESSAMENTO WHERE temporada = ${key.temporada} AND rodada = ${key.rodada} FOR UPDATE`;
      const round = await tx.rodadaProcessamento.findUniqueOrThrow({ where: { temporada_rodada: key }, select: { timesPrevistos: true } });
      const anteriores = round.timesPrevistos as number[];
      const merged = [...new Set([...anteriores, ...ids])].sort((a, b) => a - b);
      if (merged.length !== anteriores.length) await tx.rodadaProcessamento.update({
        where: { temporada_rodada: key }, data: { timesPrevistos: merged },
      });
    });
  }

  private async lease(key: RoundKey, token: string): Promise<void> {
    const updated = await this.prisma.rodadaProcessamento.updateMany({
      where: { ...key, lockToken: token, lockAte: { gt: new Date() } },
      data: { lockAte: new Date(Date.now() + LEASE_MS) },
    });
    if (updated.count !== 1) throw new ConflictException('Lock da rodada expirou');
  }

  private async preserveMatches(round: RodadaProcessamento, market: CartolaMarketStatus, token: string,
    received: CartolaMatchesResponse): Promise<CartolaMatchesResponse> {
    const key = keyOf(round);
    matchesByClub(received, key.rodada);
    if (market.temporada !== key.temporada || !received.partidas.length
      || new Set(received.partidas.map(m => m.partida_id)).size !== received.partidas.length
      || (received.temporada !== undefined && received.temporada !== key.temporada)
      || received.partidas.some(m => !Number.isInteger(m.partida_id)
        || m.partida_id < 1 || !Number.isInteger(m.clube_casa_id) || m.clube_casa_id < 1
        || !Number.isInteger(m.clube_visitante_id) || m.clube_visitante_id < 1
        || new Date(matchStart(m)).getUTCFullYear() !== key.temporada
        || (matchEnded(m) && matchStart(m) > Date.now()))) {
      throw new ConflictException('Partidas sem identidade, temporada ou horario oficial valido');
    }
    const previous = round.partidas as unknown as CartolaMatchesResponse | null;
    if (previous) matchesByClub(previous, key.rodada);
    const identity = (a: CartolaMatchesResponse['partidas'][number], b: CartolaMatchesResponse['partidas'][number]) =>
      a.partida_id === b.partida_id && a.clube_casa_id === b.clube_casa_id
      && a.clube_visitante_id === b.clube_visitante_id && matchStart(a) === matchStart(b);
    if (previous?.partidas.some(p => !received.partidas.some(m => m.partida_id === p.partida_id)
      || (matchEnded(p) && !received.partidas.some(m => identity(p, m) && m.valida === true)))) {
      throw new ConflictException('Correcao oficial conflitante ou partidas incompletas; evidencias anteriores preservadas');
    }
    const matches = { ...received, partidas: received.partidas.map(m => {
      const prior = previous?.partidas.find(p => identity(p, m));
      if (prior && matchEnded(prior) && !matchEnded(m)) {
        this.logger.warn({ ...key, etapa: 'REGRESSAO_PARTIDA', partidaId: m.partida_id,
          periodoRecebido: m.periodo_tr, periodoPreservado: prior.periodo_tr });
        return { ...m, periodo_tr: prior.periodo_tr };
      }
      return m;
    }) };
    const latest = await this.cartola.loadMarketStatusFresh();
    this.validateMarket(latest);
    if (latest.temporada !== market.temporada || latest.rodada_atual !== market.rodada_atual
      || latest.status_mercado !== market.status_mercado) throw new ConflictException('Mercado mudou durante coleta das evidencias');
    await this.prisma.$transaction(async tx => {
      const fenced = await tx.rodadaProcessamento.updateMany({ where: { ...key, lockToken: token, lockAte: { gt: new Date() } },
        data: { lockAte: new Date(Date.now() + LEASE_MS) } });
      if (fenced.count !== 1) throw new ConflictException('Lock perdido antes da preservacao das evidencias');
      await tx.rodadaProcessamento.update({ where: { temporada_rodada: key }, data: {
        partidas: json(matches), ...(JSON.stringify(previous) !== JSON.stringify(matches)
          ? { erro: 'Evidencias atualizadas; calculo pendente' } : {}),
      } });
    });
    return matches;
  }

  private async preserveScores(round: RodadaProcessamento, market: CartolaMarketStatus, token: string, scored: CartolaScoredAthletesPayload): Promise<void> {
    const key = keyOf(round);
    const scores = scoreMap(scored, key.rodada);
    if (scored.temporada !== undefined && scored.temporada !== key.temporada) throw new ConflictException('Pontuados de outra temporada');
    const previous = round.pontuados as CartolaScoredAthletesPayload | null;
    const complete = scored.total_atletas === scores.size && scores.size > 0;
    if (previous?.total_atletas !== undefined && previous.total_atletas > 0 && !complete) {
      throw new ConflictException('Envelope incompleto; preservar evidencias completas anteriores');
    }
    if (Object.entries(previous?.atletas ?? {}).some(([id, a]) => typeof a.entrou_em_campo === 'boolean'
      && scores.has(Number(id)) && scores.get(Number(id))?.entrou_em_campo === undefined)) {
      throw new ConflictException('Participacao oficial incompleta; preservar evidencias anteriores');
    }
    if (!complete) return;
    const latest = await this.cartola.loadMarketStatusFresh();
    this.validateMarket(latest);
    if (latest.temporada !== market.temporada || latest.rodada_atual !== market.rodada_atual
      || latest.status_mercado !== market.status_mercado) throw new ConflictException('Mercado mudou durante coleta dos pontuados');
    await this.prisma.$transaction(async tx => {
      const fenced = await tx.rodadaProcessamento.updateMany({ where: { ...key, lockToken: token, lockAte: { gt: new Date() } },
        data: { lockAte: new Date(Date.now() + LEASE_MS) } });
      if (fenced.count !== 1) throw new ConflictException('Lock perdido antes da preservacao dos pontuados');
      await tx.rodadaProcessamento.update({ where: { temporada_rodada: key }, data: {
        pontuados: json(scored), ...(JSON.stringify(previous) !== JSON.stringify(scored)
          ? { erro: 'Evidencias atualizadas; calculo pendente' } : {}),
      } });
    });
  }

  async reprocessarParciais(rodada: number, temporada: number) {
    if (!Number.isInteger(temporada) || temporada < 1 || temporada > 65535
      || !Number.isInteger(rodada) || rodada < 1 || rodada > 38) {
      throw new BadRequestException('Temporada/rodada invalidas');
    }
    const key = { temporada, rodada };
    const started = Date.now();
    const existing = await this.prisma.rodadaProcessamento.findUnique({ where: { temporada_rodada: key } });
    if (!existing) throw new NotFoundException('Rodada nao encontrada');
    const market = await this.cartola.loadMarketStatusFresh();
    this.validateMarket(market);
    if (market.temporada !== temporada || rodada > market.rodada_atual) {
      throw new BadRequestException('Reprocessamento exige rodada disponivel da temporada oficial atual');
    }
    const token = randomUUID();
    const acquired = await this.prisma.rodadaProcessamento.updateMany({
      where: { ...key, OR: [{ lockAte: null }, { lockAte: { lt: new Date() } }] },
      data: { lockToken: token, lockAte: new Date(Date.now() + LEASE_MS) },
    });
    if (!acquired.count) throw new ConflictException('Rodada ja em processamento');
    let result: Awaited<ReturnType<RoundProcessingService['calculate']>>;
    let final = false;
    try {
      const round = await this.prisma.rodadaProcessamento.findUniqueOrThrow({ where: { temporada_rodada: key } });
      const matches = await this.preserveMatches(round, market, token, await this.cartola.loadMatchesFresh(rodada));
      const scored = await this.cartola.loadAdministrativeScoredAthletesFresh(rodada);
      await this.preserveScores(round, market, token, scored);
      const scores = scoreMap(scored, rodada);
      if (scores.size === 0 || (scored.temporada !== undefined && scored.temporada !== temporada)) {
        throw new ConflictException('Fonte oficial sem integridade ou evidencia da temporada solicitada');
      }
      final = matches.partidas.filter((m) => m.valida === true).length > 0
        && matches.partidas.filter((m) => m.valida === true).every(matchEnded);
      if (final && scored.total_atletas !== scores.size) throw new ConflictException('Envelope final sem completude comprovada');
      if (!final && (round.status === 'CONSOLIDADA' || rodada < market.rodada_atual || market.status_mercado !== 2)) {
        throw new ConflictException('Pendencia: encerramento historico nao comprovado; resultados anteriores preservados');
      }
      result = await this.calculate(round, market, token, final, true, { scored, matches });
    } catch (error) {
      await this.prisma.rodadaProcessamento.updateMany({ where: { ...key, lockToken: token }, data: { erro: this.message(error) } });
      throw error;
    } finally {
      await this.prisma.rodadaProcessamento.updateMany({ where: { ...key, lockToken: token }, data: { lockToken: null, lockAte: null } });
    }
    if (result?.timesProcessados) await this.sincronizarCompeticoes(key);
    return { ...key, status: final ? 'FINAL' as const : 'PARCIAL' as const, ...result, duracaoMs: Date.now() - started, processadoEm: new Date().toISOString() };
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
    let timesProcessados = 0;
    try {
      const round = await this.prisma.rodadaProcessamento.findUniqueOrThrow({ where: { temporada_rodada: key } });
      if (!final) await this.capture(round, token);
      timesProcessados = (await this.calculate(round, market, token, final))?.timesProcessados ?? 0;
      this.logger.log({ ...key, etapa: final ? 'CONSOLIDACAO' : 'PARCIAL', duracaoMs: Date.now() - started, resultado: 'OK' });
    } catch (error) {
      await this.prisma.rodadaProcessamento.updateMany({ where: { ...key, lockToken: token }, data: { erro: this.message(error) } });
      this.logger.error({ ...key, etapa: final ? 'CONSOLIDACAO' : 'PARCIAL', duracaoMs: Date.now() - started, resultado: 'ERRO', erro: this.message(error) });
      throw error;
    } finally {
      await this.prisma.rodadaProcessamento.updateMany({ where: { ...key, lockToken: token }, data: { lockToken: null, lockAte: null } });
    }
    if (timesProcessados) await this.sincronizarCompeticoes(key);
    return true;
  }

  private async sincronizarCompeticoes(key: RoundKey): Promise<void> {
    try { await this.sincronizacao.sincronizarRodada(key.temporada, key.rodada); }
    catch (error) { this.logger.error({ ...key, etapa: 'SINCRONIZACAO_COMPETICOES', erro: this.message(error) }); }
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

  private async calculate(round: RodadaProcessamento, market: CartolaMarketStatus, token: string, final: boolean, manual = false,
    official?: { scored: CartolaScoredAthletesPayload; matches: CartolaMatchesResponse }) {
    const key = keyOf(round);
    const matches = official?.matches ?? await this.preserveMatches(round, market, token, await this.cartola.loadMatchesFresh(key.rodada));
    const scored = official?.scored ?? (final ? await this.cartola.loadFinalScoredAthletesFresh(key.temporada, key.rodada)
      : (await this.cartola.loadScoredAthletesFresh()).value);
    if (!official) await this.preserveScores(round, market, token, scored);
    const all = await this.prisma.timeRodada.findMany({ where: key, select: { id: true, timeId: true,
      _count: { select: { escalacao: { where: { titular: true } } } },
    } });
    const teams = all.filter((t) => t._count.escalacao > 0);
    const ids = new Set(teams.map((t) => t.timeId));
    const missing = (round.timesPrevistos as number[]).filter((id) => !ids.has(id));
    if (manual && (!teams.length || missing.length || all.length !== teams.length)) throw new ConflictException('Snapshot indisponivel ou incompleto');
    if (final && (missing.length || all.length !== teams.length)) throw new Error(`Snapshot incompleto: ${missing.length || all.length - teams.length} times`);
    if (!teams.length && (round.timesPrevistos as number[]).length) return;
    // Capture finishes before the first request for scores; one envelope serves every team.
    const oldMatches = round.partidas as unknown as CartolaMatchesResponse | null;
    const scores = scoreMap(scored, key.rodada);
    const clubs = matchesByClub(matches, key.rodada);
    const completeScoredEnvelope = scored.total_atletas === scores.size && scores.size > 0;
    const participation = athleteParticipation(scores, clubs, completeScoredEnvelope);
    if (final && teams.length) {
      try {
        if (![...clubs.values()].every(matchEnded)) throw new Error('Fim das partidas nao comprovado');
        validateFinalData(scores, clubs);
      }
      catch (error) { if (official) throw new ConflictException(this.message(error)); throw error; }
    }
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
      where: { ...key, escalacao: { some: { titular: true } }, ...(manual || final || round.erro || !previous ? {} : {
        OR: [{ pontuacao: { is: null } }, { escalacao: { some: { OR: [
          { atletaId: { in: [...changed] } }, { clubeId: { in: [...changedClubs] } },
        ] } } }],
      }) },
      include: { escalacao: true, pontuacao: true, substituicoes: { where: { ativa: true } } },
    });
    const totals: Array<{ id: number; total: Prisma.Decimal; replacements: Replacement[] }> = [];
    let substitutionCount = 0;
    let substitutionsChanged = 0;
    let errors = 0;
    for (const team of affected) {
      if (manual && (totals.length + errors) % BATCH === 0) await this.lease(key, token);
      try {
      if (final && team.escalacao.some((a) => !a.clubeId || !clubs.has(a.clubeId) || !matchEnded(clubs.get(a.clubeId)!))) {
        throw new ConflictException('Clube sem partida final confirmada no snapshot');
      }
      // A score correction can enable, reverse, or change a replacement even
      // when participation and match status are unchanged. The affected query
      // already limits this work to teams whose inputs changed.
      const resolution = resolveReplacements(team, scores, clubs, false,
        completeScoredEnvelope);
      if (final) validateFinalTeam(team, resolution, scores, participation);
      if (!final && resolution.pending.length) {
        this.logger.warn({ ...key, timeId: team.timeId, etapa: 'PARTICIPACAO_PENDENTE', pendencias: resolution.pending });
        if (team.substituicoes.some(r => resolution.pendingPositions.includes(r.posicaoId))) {
          throw new ConflictException('Substituicao anterior com dados pendentes; preservar resultado');
        }
        errors++;
      }
      if ((!final && team.pontuacao?.status === 'FINAL') || (final
        && effectiveLineup(team, resolution.replacements).some((a) => participation(a) === undefined))) {
        throw new ConflictException('Participacao ou substituicao pendente; preservar resultado anterior do time');
      }
      totals.push({ id: team.id, total: totalScore(effectiveLineup(team, resolution.replacements), scores), replacements: resolution.replacements });
      substitutionCount += resolution.replacements.length;
      const signature = (r: Replacement) => `${r.atletaSaiuId}:${r.atletaEntrouId}:${r.posicaoId}`;
      const before = new Set(team.substituicoes.map(signature));
      const after = new Set(resolution.replacements.map(signature));
      substitutionsChanged += [...before].filter((r) => !after.has(r)).length + [...after].filter((r) => !before.has(r)).length;
      } catch (error) {
        if (official && final) throw new ConflictException(this.message(error));
        if (final) throw error;
        errors++;
        this.logger.error({ ...key, timeId: team.timeId, etapa: 'REPROCESSAMENTO', erro: this.message(error) });
      }
    }
    await this.lease(key, token);
    if (!manual || official) {
    const latest = await this.cartola.loadMarketStatusFresh();
    this.validateMarket(latest);
    if (latest.temporada !== market.temporada || latest.rodada_atual !== market.rodada_atual
      || latest.status_mercado !== market.status_mercado) {
      if (official) throw new ConflictException('Mercado mudou durante reprocessamento; resultados preservados');
      throw new Error('Mercado mudou durante processamento; tentar novamente');
    }
    }
    const ended = matches.partidas.filter((m) => m.valida === true);
    const waiting = !market.bola_rolando && ended.length > 0 && ended.every((m) => matchStart(m) <= Date.now());
    await this.prisma.$transaction(async (tx) => {
      // Fencing plus row lock: another worker cannot publish after lease takeover.
      const fenced = await tx.rodadaProcessamento.updateMany({ where: { ...key, lockToken: token, lockAte: { gt: new Date() } },
        data: { lockAte: new Date(Date.now() + LEASE_MS) } });
      if (fenced.count !== 1) throw new ConflictException('Lock perdido antes da persistencia');
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
          ON DUPLICATE KEY UPDATE ATIVA=true, POSICAO_ID=VALUES(POSICAO_ID), ATUALIZADO_EM=VALUES(ATUALIZADO_EM)`);
      }
      await tx.rodadaProcessamento.update({ where: { temporada_rodada: key }, data: {
        status: final ? 'CONSOLIDADA' : missing.length ? 'AGUARDANDO_ESCALACOES' : waiting ? 'AGUARDANDO_CONSOLIDACAO' : 'EM_ANDAMENTO',
        pontuados: json(scored), partidas: json(matches), erro: errors ? `${errors} times com erro no reprocessamento` : null, ...(final ? { consolidadoEm: new Date() } : manual ? { consolidadoEm: null } : {}),
      } });
    }, { timeout: 120_000, maxWait: 10_000 });
    this.logger.log({ ...key, etapa: final ? 'CONSOLIDACAO' : 'PARCIAL', atletasRecebidos: scores.size,
      atletasAlterados: changed.size, timesAfetados: totals.length, substituicoes: substitutionCount });
    return { timesProcessados: totals.length, timesComErro: errors, substituicoesAlteradas: substitutionsChanged };
  }
  private message(error: unknown): string { return (error instanceof Error ? error.message : String(error)).slice(0, 2000); }
}
