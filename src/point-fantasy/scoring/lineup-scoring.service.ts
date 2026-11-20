import { Prisma } from '@prisma/client';
import { HttpException, Injectable, Logger, NotFoundException, ServiceUnavailableException } from '@nestjs/common';
import { CartolaService } from '../../cartola/cartola.service';
import { CartolaMatch } from '../../cartola/cartola.types';
import { PrismaService } from '../../prisma/prisma.service';
import { ScoredAthletesCacheService } from '../../scored-athletes-cache/scored-athletes-cache.service';
import { validateSelection } from '../lineups/lineup.rules';
import { rankScores, scoreLineup } from './scoring-engine';
import { resolveScoringSource } from './source-completeness';
import { loadCartolaEvidence } from './cartola-evidence';
import { stableJson } from '../observation/current-scoring-plan';
import { athleteParticipation, matchEnded, matchStart, matchesByClub, scoreMap } from '../../round-processing/round-calculator';

export const SCORING_ENGINE_VERSION = '3F-1';
const include = { catalogo: true, partidas: true } as const;
type Competition = Prisma.FantasyCompeticaoGetPayload<{ include: typeof include }>;

function matchStartState(match: CartolaMatch, now: number): 'NAO_INICIADA' | 'EM_ANDAMENTO' | 'INDEFINIDA' {
  const period = (match.periodo_tr ?? '').trim().toUpperCase();
  if (['1T', '2T', 'INT', 'I', 'ET', 'PEN'].includes(period)) return 'EM_ANDAMENTO';
  const start = matchStart(match);
  return Number.isFinite(start) && start > now ? 'NAO_INICIADA' : 'INDEFINIDA';
}

export function assertScoringCompetition(c: Competition, now = new Date(), requireClosure = true) {
  if (c.status !== 'PUBLICADA' || c.catalogo.status !== 'CONGELADO'
    || c.temporada !== c.catalogo.temporada || c.rodada !== c.catalogo.rodada
    || (requireClosure && (!c.fechamentoDefinitivoEm || c.fechamentoDefinitivoEm > now)) || !c.partidas.length) {
    throw Error('SCORING_COMPETITION_NOT_READY');
  }
}

/** Explicit invocation only; no collector, scheduler or financial dependencies. */
@Injectable()
export class LineupScoringService {
  private readonly logger = new Logger(LineupScoringService.name);

  constructor(private readonly db: PrismaService, private readonly cartola?: CartolaService,
    private readonly scoredAthletesCache?: ScoredAthletesCacheService) {}

  /** Batch preview using one read of each Cartola source for a whole ranking. */
  async previewCartolaCompetition(competicaoId: number) {
    const cartola = this.cartola;
    const scoredAthletesCache = this.scoredAthletesCache;
    if (!cartola || !scoredAthletesCache) {
      throw new ServiceUnavailableException('Fontes Cartola indisponíveis para o preview Fantasy');
    }
    const { competition, lineups } = await this.db.$transaction(async tx => {
      const competition = await tx.fantasyCompeticao.findFirst({
        where: { id: competicaoId, status: 'PUBLICADA' },
        include: { catalogo: true, partidas: { orderBy: { id: 'asc' } } },
      });
      if (!competition) throw new NotFoundException('Competicao Fantasy nao encontrada');
      assertScoringCompetition(competition, new Date(), false);
      const lineups = await tx.fantasyEscalacao.findMany({
        where: { competicaoId, status: 'INSCRITA', confirmadaEm: { not: null } },
        include: { usuario: { select: { fantasyBrasaoId: true } }, identidade: { select: { identificadorPublico: true, nomeBase: true } },
          atletas: { include: { atleta: true } } }, orderBy: { id: 'asc' },
      });
      return { competition, lineups };
    }, { isolationLevel: 'RepeatableRead' });

    // Ranking Live reads the official Cartola feed through the scored-athletes cache.
    // It deliberately bypasses CartolaService.getScoredAthletes(), which may require
    // rodadaProcessamento.pontuados when Prisma is available. Nothing is persisted here.
    const [scored, matches] = await Promise.all([
      this.readPreviewSource('pontuados', competition.id, competition.rodada,
        () => scoredAthletesCache.getScoredAthletes(competition.temporada, competition.rodada)),
      this.readPreviewSource('partidas', competition.id, competition.rodada,
        () => cartola.getMatchesByRound(competition.rodada, competition.temporada)),
    ]);
    const previews = lineups.map(lineup => {
      try {
        return this.scoreCartolaLineup(competition, lineup, scored, matches);
      } catch (error) {
        this.logger.error({ event: 'point_fantasy_live_preview_lineup_failed', competicaoId,
          temporada: competition.temporada, rodada: competition.rodada, escalacaoId: lineup.id,
          errorType: error instanceof Error ? error.name : 'UnknownError',
          httpStatus: error instanceof HttpException ? error.getStatus() : undefined });
        throw error;
      }
    });
    const matchStates = competition.partidas.map(fixture => {
      const match = matches.value.partidas.find(item => item.partida_id === fixture.partidaIdExterno);
      return !match ? 'INDEFINIDA' as const : matchEnded(match) ? 'ENCERRADA' as const : matchStartState(match, Date.now());
    });
    return { competicaoId, temporada: competition.temporada, rodada: competition.rodada,
      partidas: [...new Set(matchStates)], cacheDesatualizado: scored.stale || matches.stale,
      items: lineups.map((lineup, index) => ({ escalacaoId: lineup.id, versaoEscalacao: lineup.versao,
        nomePublico: lineup.nomePublico, sequencial: lineup.sequencial, identidade: lineup.identidade,
        usuarioId: lineup.usuarioId, brasaoPreferido: lineup.usuario?.fantasyBrasaoId ?? null,
        formacao: lineup.formacao, ...previews[index] })) };
  }

  private async readPreviewSource<T>(source: 'pontuados' | 'partidas', competicaoId: number, rodada: number,
    read: () => Promise<T>): Promise<T> {
    try {
      return await read();
    } catch (error) {
      // Do not log provider payloads, URLs, headers, or credentials.
      this.logger.error({ event: 'point_fantasy_live_preview_source_failed', source, competicaoId, rodada,
        errorType: error instanceof Error ? error.name : 'UnknownError' });
      throw error;
    }
  }

  /** Read-only single-lineup adapter retained for local tools and focused callers. */
  async previewCartolaLineup(competicaoId: number, escalacaoId: number) {
    const result = await this.previewCartolaCompetition(competicaoId);
    const item = result.items.find(lineup => lineup.escalacaoId === escalacaoId);
    if (!item) throw new NotFoundException('Escalacao inscrita nao encontrada');
    return item;
  }

  private scoreCartolaLineup(competition: Competition,
    lineup: Prisma.FantasyEscalacaoGetPayload<{ include: { usuario: { select: { fantasyBrasaoId: true } };
      identidade: { select: { identificadorPublico: true; nomeBase: true } }; atletas: { include: { atleta: true } } } }>,
    scored: Awaited<ReturnType<CartolaService['getScoredAthletes']>>,
    matches: Awaited<ReturnType<CartolaService['getMatchesByRound']>>) {
    const payload = scored.value;
    if (payload.rodada !== competition.rodada) throw new ServiceUnavailableException('Rodada dos pontos Cartola divergente');
    // The Cartola envelope may be partial while games are live. Validate every
    // included athlete with the shared parser, while retaining the original
    // completeness signal so an omitted athlete is never treated as a DNP.
    const scores = scoreMap({ ...payload, total_atletas: Object.keys(payload.atletas ?? {}).length }, competition.rodada);
    const providerMatches = matchesByClub(matches.value, competition.rodada);
    const providerMatchesById = new Map(matches.value.partidas.map(match => [match.partida_id, match]));
    const completeEnvelope = payload.total_atletas === scores.size && scores.size > 0;
    const participation = athleteParticipation(scores, providerMatches, completeEnvelope);
    const selectedClubs = new Set(competition.partidas.flatMap(match => [match.clubeMandanteId, match.clubeVisitanteId]));
    const selection = {
      formacao: lineup.formacao,
      titulares: lineup.atletas.filter(a => a.papel === 'TITULAR').map(a => a.catalogoAtletaId),
      reservas: lineup.atletas.filter(a => a.papel === 'RESERVA').map(a => a.catalogoAtletaId),
      tecnico: lineup.atletas.find(a => a.papel === 'TECNICO')?.catalogoAtletaId ?? null,
      capitaoAtletaId: lineup.capitaoAtletaId,
      reservaMagoAtletaId: lineup.reservaMagoAtletaId,
    };
    if (lineup.atletas.some(a => a.atleta.catalogoId !== competition.catalogoId
      || !selectedClubs.has(a.atleta.clubeIdExterno))
      || !validateSelection(selection, lineup.atletas.map(a => a.atleta)).completa) {
      throw new ServiceUnavailableException('Escalacao Fantasy incompleta ou incompativel com a competicao');
    }
    const individual = lineup.atletas.map(({ atleta, papel, catalogoAtletaId }) => {
      const supplied = scores.get(atleta.atletaIdExterno);
      if (supplied && ((supplied.clube_id !== undefined && supplied.clube_id !== atleta.clubeIdExterno)
        || (supplied.posicao_id !== undefined && supplied.posicao_id !== atleta.posicaoId))) {
        throw new ServiceUnavailableException(`Identidade Cartola divergente para o atleta ${atleta.atletaIdExterno}`);
      }
      const match = providerMatchesById.get(competition.partidas.find(item => item.clubeMandanteId === atleta.clubeIdExterno
        || item.clubeVisitanteId === atleta.clubeIdExterno)?.partidaIdExterno ?? -1)
        ?? providerMatches.get(atleta.clubeIdExterno);
      const ended = !!match && matchEnded(match);
      const rawParticipation = supplied && typeof supplied.entrou_em_campo === 'boolean' ? supplied.entrou_em_campo : undefined;
      // A false flag before full time means “not yet observed”, not “did not play”.
      const played = rawParticipation === true ? true : ended ? participation({ atletaId: atleta.atletaIdExterno,
        clubeId: atleta.clubeIdExterno, posicaoId: atleta.posicaoId, titular: false, reserva: papel === 'RESERVA', capitao: lineup.capitaoAtletaId === catalogoAtletaId }) : null;
      return { catalogoAtletaId, atletaIdCartola: atleta.atletaIdExterno, papel,
        pontuacaoCartola: typeof supplied?.pontuacao === 'number' ? String(supplied.pontuacao) : null,
        entrouEmCampo: played ?? null, partida: !match ? 'INDEFINIDA' as const : ended ? 'ENCERRADA' as const
          : matchStartState(match, Date.now()), stale: scored.stale || matches.stale };
    });
    const players = individual.map(row => ({ id: row.catalogoAtletaId,
      position: lineup.atletas.find(a => a.catalogoAtletaId === row.catalogoAtletaId)!.atleta.posicaoId,
      role: row.papel, points: row.pontuacaoCartola, played: row.entrouEmCampo ?? null,
      matchEnded: row.partida === 'ENCERRADA' }));
    const result = scoreLineup(players, lineup.capitaoAtletaId!, lineup.reservaMagoAtletaId!, { partial: true });
    return { temporada: competition.temporada,
      rodada: competition.rodada, estado: result.total === null || result.missing.length ? 'PENDENTE' as const : 'PROVISORIO' as const,
      pontuacoesEnvelopeCompleto: completeEnvelope,
      cacheDesatualizado: scored.stale || matches.stale, partidas: [...new Set(individual.map(a => a.partida))],
      atletas: individual, ...result, persistido: false };
  }

  private async calculate(tx: Prisma.TransactionClient, competicaoId: number, preview = false) {
    const competition = await tx.fantasyCompeticao.findUniqueOrThrow({ where: { id: competicaoId }, include });
    assertScoringCompetition(competition, new Date(), !preview);
    const round = await tx.fantasyApuracaoRodada.findUniqueOrThrow({ where: {
      temporada_rodada: { temporada: competition.temporada, rodada: competition.rodada },
    } });
    if (round.revisaoAtual === 0n || !round.hashConteudoAtual) throw Error('SCORING_REVISION_UNAVAILABLE');
    const lineups = await tx.fantasyEscalacao.findMany({ where: {
      competicaoId, status: 'INSCRITA', confirmadaEm: { not: null,
        ...(competition.fechamentoDefinitivoEm ? { lte: competition.fechamentoDefinitivoEm } : {}) },
    }, include: { atletas: { include: { atleta: true } } }, orderBy: { id: 'asc' } });
    const clubs = new Set(competition.partidas.flatMap(m => [m.clubeMandanteId, m.clubeVisitanteId]));
    const points = await tx.fantasyPontuacaoAtleta.findMany({ where: {
      temporada: competition.temporada, rodada: competition.rodada, apuracaoId: round.id,
    } });
    const evidence = await loadCartolaEvidence(tx, round, points, competition.partidas);
    const completeness = evidence.assessment;
    const byExternalId = new Map(points.map(p => [p.atletaIdCartola, p]));
    const results = lineups.map(lineup => {
      const selection = { formacao: lineup.formacao,
        titulares: lineup.atletas.filter(p => p.papel === 'TITULAR').map(p => p.catalogoAtletaId),
        reservas: lineup.atletas.filter(p => p.papel === 'RESERVA').map(p => p.catalogoAtletaId),
        tecnico: lineup.atletas.find(p => p.papel === 'TECNICO')?.catalogoAtletaId ?? null,
        capitaoAtletaId: lineup.capitaoAtletaId, reservaMagoAtletaId: lineup.reservaMagoAtletaId };
      if (!lineup.confirmadaEm || lineup.atletas.some(p => p.atleta.catalogoId !== competition.catalogoId
        || !clubs.has(p.atleta.clubeIdExterno))
        || !validateSelection(selection, lineup.atletas.map(p => p.atleta)).completa) throw Error('INELIGIBLE_SCORING_LINEUP');
      const sources = lineup.atletas.map(p => {
        const official = byExternalId.get(p.atleta.atletaIdExterno);
        return { id: p.catalogoAtletaId, position: p.atleta.posicaoId, role: p.papel,
          ...resolveScoringSource(official, p.atleta, round.revisaoAtual, evidence) };
      });
      const result = scoreLineup(sources, selection.capitaoAtletaId!, selection.reservaMagoAtletaId!);
      return { escalacaoId: lineup.id, versaoEscalacao: lineup.versao, ...result,
        fontes: sources.map(p => ({ catalogoAtletaId: p.id, origem: p.origin })).sort((a,b) => a.catalogoAtletaId - b.catalogoAtletaId),
        evidenciaAusencias: completeness };
    });
    return { competition, round, completeness, fechamentoEfetivado: !!competition.fechamentoDefinitivoEm
      && competition.fechamentoDefinitivoEm <= new Date(), results: rankScores(results) };
  }

  preview(competicaoId: number) {
    return this.db.$transaction(tx => this.calculate(tx, competicaoId, true), { isolationLevel: 'RepeatableRead' });
  }

  async persist(competicaoId: number, authorization: { competicaoId: number; temporada: number; rodada: number; revisao: string }) {
    if (authorization.competicaoId !== competicaoId) throw Error('SCORING_AUTHORIZATION_SCOPE');
    return this.db.$transaction(async tx => {
      // Same competition lock as confirmations; round lock serializes with collection.
      await tx.$queryRaw`SELECT ID FROM FANTASY_COMPETICAO WHERE ID=${competicaoId} FOR UPDATE`;
      await tx.$queryRaw`SELECT ID FROM FANTASY_APURACAO_RODADA WHERE TEMPORADA=${authorization.temporada} AND RODADA=${authorization.rodada} FOR UPDATE`;
      const plan = await this.calculate(tx, competicaoId);
      if (plan.competition.temporada !== authorization.temporada || plan.competition.rodada !== authorization.rodada
        || plan.round.revisaoAtual.toString() !== authorization.revisao) throw Error('SCORING_AUTHORIZATION_SCOPE');
      for (const result of plan.results) {
        const current = await tx.fantasyEscalacaoResultado.findUnique({ where: { escalacaoId: result.escalacaoId } });
        if (current?.revisao === plan.round.revisaoAtual && current.versaoEscalacao === result.versaoEscalacao
          && current.versaoMotor === SCORING_ENGINE_VERSION && current.hashFonte === plan.round.hashConteudoAtual
          && stableJson((current.auditoria as Prisma.JsonObject)?.evidenciaAusencias ?? null) === stableJson(result.evidenciaAusencias)) continue;
        const data = { competicaoId, temporada: plan.competition.temporada, rodada: plan.competition.rodada,
          revisao: plan.round.revisaoAtual, hashFonte: plan.round.hashConteudoAtual!,
          versaoEscalacao: result.versaoEscalacao, versaoMotor: SCORING_ENGINE_VERSION,
          total: result.total, auditoria: JSON.parse(JSON.stringify(result)) as Prisma.InputJsonValue };
        await tx.fantasyEscalacaoResultado.upsert({ where: { escalacaoId: result.escalacaoId },
          create: { escalacaoId: result.escalacaoId, ...data }, update: data });
      }
      return plan;
    }, { isolationLevel: 'Serializable', timeout: 30000 });
  }
}
