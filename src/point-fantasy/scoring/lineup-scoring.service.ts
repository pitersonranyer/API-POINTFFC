import { Prisma } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { validateSelection } from '../lineups/lineup.rules';
import { rankScores, scoreLineup } from './scoring-engine';
import { resolveScoringSource } from './source-completeness';
import { loadCartolaEvidence } from './cartola-evidence';
import { stableJson } from '../observation/current-scoring-plan';

export const SCORING_ENGINE_VERSION = '3F-1';
const include = { catalogo: true, partidas: true } as const;
type Competition = Prisma.FantasyCompeticaoGetPayload<{ include: typeof include }>;

export function assertScoringCompetition(c: Competition, now = new Date(), requireClosure = true) {
  if (c.status !== 'PUBLICADA' || c.catalogo.status !== 'CONGELADO'
    || c.temporada !== c.catalogo.temporada || c.rodada !== c.catalogo.rodada
    || (requireClosure && (!c.fechamentoDefinitivoEm || c.fechamentoDefinitivoEm > now)) || !c.partidas.length) {
    throw Error('SCORING_COMPETITION_NOT_READY');
  }
}

/** Explicit invocation only; no collector, scheduler or financial dependencies. */
export class LineupScoringService {
  constructor(private readonly db: PrismaService) {}

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
