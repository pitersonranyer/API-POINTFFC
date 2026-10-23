import { FantasyApuracaoRodada, FantasyCatalogoAtleta, FantasyCompeticaoPartida, FantasyPontuacaoAtleta, Prisma } from '@prisma/client';
import { CartolaMarketStatus, CartolaMatchesResponse, CartolaScoredAthletesPayload } from '../../cartola/cartola.types';
import { athleteParticipation, matchEnded, matchesByClub, matchStart, scoreMap } from '../../round-processing/round-calculator';
import { sha256 } from '../observation/official-normalizer';
import { assessCompleteness, CompletenessAssessment } from './source-completeness';

export type CatalogIdentity = Pick<FantasyCatalogoAtleta, 'atletaIdExterno' | 'clubeIdExterno' | 'posicaoId'>;
type Preserved = Prisma.FantasyPontuacaoColetaGetPayload<{ include: { snapshot: true } }>;
const object = (v: unknown): Record<string, unknown> => v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : {};
export interface PreservedParticipation {
  assessment: CompletenessAssessment;
  participation(athlete: CatalogIdentity): boolean | undefined;
}

/** Reads preserved responses only. Cartola decides participation; CURRENT Decimal
 * points remain authoritative. Only selected competition fixtures must be final. */
export function preservedParticipation(round: FantasyApuracaoRodada, current: CompletenessAssessment,
  candidates: Preserved[], selected: FantasyCompeticaoPartida[]): PreservedParticipation {
  const errors: string[] = [];
  for (const row of [...candidates].sort((a,b) => b.id - a.id)) {
    try {
      const snapshot = row.snapshot, response = object(row.evidenciasPartidas);
      if (row.estado !== 'SUCESSO' || row.rodadaId !== round.id || !snapshot || row.snapshotId !== snapshot.id
        || snapshot.rodadaId !== round.id || row.httpStatus !== 200 || response.status !== 200
        || response.error !== null || response.endpoint !== `/partidas/${round.rodada}` || typeof response.text !== 'string') throw Error('PRESERVED_RESPONSE_INVALID');
      const hash = sha256(snapshot.payloadOriginal);
      if (hash !== snapshot.hashPayload || hash !== row.hashPayload || row.payloadRecebido !== snapshot.payloadOriginal) throw Error('PRESERVED_PAYLOAD_HASH_MISMATCH');
      const before = JSON.parse(String(object(row.statusAntes).text)) as CartolaMarketStatus;
      const after = JSON.parse(String(object(row.statusDepois).text)) as CartolaMarketStatus;
      if (before.temporada !== round.temporada || after.temporada !== round.temporada
        || !Number.isInteger(before.rodada_atual) || before.rodada_atual < round.rodada
        || before.rodada_atual !== after.rodada_atual || before.status_mercado !== after.status_mercado) throw Error('PRESERVED_SEASON_CONTEXT_INVALID');
      const payload = JSON.parse(snapshot.payloadOriginal) as CartolaScoredAthletesPayload;
      const matches = JSON.parse(response.text) as CartolaMatchesResponse;
      if ((payload.temporada !== undefined && payload.temporada !== round.temporada)
        || (matches.temporada !== undefined && matches.temporada !== round.temporada)) throw Error('PRESERVED_SEASON_MISMATCH');
      const scores = scoreMap(payload, round.rodada), clubs = matchesByClub(matches, round.rodada);
      if (payload.total_atletas !== scores.size || scores.size === 0) throw Error('PRESERVED_ENVELOPE_INCOMPLETE');
      if (new Set(matches.partidas.map(m => m.partida_id)).size !== matches.partidas.length) throw Error('PRESERVED_MATCH_ID_DUPLICATED');
      if (!selected.length || new Set(selected.map(m => m.partidaIdExterno)).size !== selected.length
        || selected.some(m => {
          const official = clubs.get(m.clubeMandanteId);
          return !official || official !== clubs.get(m.clubeVisitanteId) || official.partida_id !== m.partidaIdExterno
            || official.clube_casa_id !== m.clubeMandanteId || official.clube_visitante_id !== m.clubeVisitanteId
            || !matchEnded(official) || !Number.isFinite(matchStart(official)) || matchStart(official) > Date.now()
            || new Date(matchStart(official)).getUTCFullYear() !== round.temporada;
        })) throw Error('SELECTED_MATCHES_NOT_FINAL_OR_INCOMPATIBLE');
      const participation = athleteParticipation(scores, clubs, true);
      const selectedClubs = new Set(selected.flatMap(m => [m.clubeMandanteId, m.clubeVisitanteId]));
      const assessment: CompletenessAssessment = { ...current, historical: { collectionId: row.id, snapshotId: snapshot.id,
        scorePayloadHash: hash, matchPayloadHash: sha256(response.text), matchIds: selected.map(m => m.partidaIdExterno).sort((a,b) => a-b) } };
      return { assessment, participation: (a: CatalogIdentity): boolean | undefined => {
        if (!assessment.eligible || !selectedClubs.has(a.clubeIdExterno)) return undefined;
        const entry = scores.get(a.atletaIdExterno);
        if (entry && (entry.clube_id !== a.clubeIdExterno || entry.posicao_id !== a.posicaoId)) return undefined;
        return participation({ atletaId: a.atletaIdExterno, clubeId: a.clubeIdExterno, posicaoId: a.posicaoId,
          titular: false, reserva: false, capitao: false });
      } };
    } catch (error) { errors.push(error instanceof Error ? error.message : 'PRESERVED_EVIDENCE_INVALID'); }
  }
  return { assessment: { ...current, eligible: false,
    reasons: [...new Set([...current.reasons, ...(errors.length ? errors : ['PRESERVED_EVIDENCE_UNAVAILABLE'])])] },
    participation: () => undefined };
}

export async function loadCartolaEvidence(tx: Prisma.TransactionClient, round: FantasyApuracaoRodada,
  points: FantasyPontuacaoAtleta[], selected: FantasyCompeticaoPartida[]): Promise<PreservedParticipation> {
  const collection = round.ultimaColetaAplicadaId ? await tx.fantasyPontuacaoColeta.findUnique({ where: { id: round.ultimaColetaAplicadaId } }) : null;
  const candidates = await tx.fantasyPontuacaoColeta.findMany({ where: { rodadaId: round.id, estado: 'SUCESSO', snapshotId: { not: null } },
    include: { snapshot: true }, orderBy: { id: 'desc' } });
  return preservedParticipation(round, assessCompleteness(round, collection, points), candidates, selected);
}
