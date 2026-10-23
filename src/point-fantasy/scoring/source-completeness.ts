import { FantasyApuracaoRodada, FantasyPontuacaoAtleta, FantasyPontuacaoColeta } from '@prisma/client';
import { sha256 } from '../observation/official-normalizer';
import { stableJson } from '../observation/current-scoring-plan';

import type { PreservedParticipation, CatalogIdentity } from './cartola-evidence';
export interface CompletenessAssessment {
  eligible: boolean;
  reasons: string[];
  collectionId: number | null;
  revision: string;
  sourceHash: string | null;
  historical?: { collectionId: number; snapshotId: number; scorePayloadHash: string; matchPayloadHash: string; matchIds: number[] };
}

/** Integrity of current points, independent of preserved participation evidence. */
export function assessCompleteness(round: FantasyApuracaoRodada, collection: FantasyPontuacaoColeta | null,
  points: FantasyPontuacaoAtleta[]): CompletenessAssessment {
  const reasons: string[] = [];
  if (!collection || collection.id !== round.ultimaColetaAplicadaId || collection.rodadaId !== round.id
    || collection.estado !== 'SUCESSO' || collection.modeloPersistencia !== 'ATUAL'
    || collection.revisaoResultante !== round.revisaoAtual || collection.hashConteudo !== round.hashConteudoAtual
    || !collection.hashPayload || !/^[a-f0-9]{64}$/.test(collection.hashPayload)
    || round.revisaoAtual <= 0n) reasons.push('SOURCE_REVISION_NOT_ANCHORED');
  const hash = sha256(stableJson({ schema: 'current-scoring-v1', temporada: round.temporada, rodada: round.rodada,
    atletas: [...points].sort((a,b) => a.atletaIdCartola - b.atletaIdCartola)
      .map(a => [a.atletaIdCartola, a.hashConteudo, a.presenteNaUltimaLista, a.versaoNormalizador]) }));
  if (!points.length || hash !== round.hashConteudoAtual || collection?.qtdRecebidos !== points.filter(p => p.presenteNaUltimaLista).length
    || new Set(points.map(p => p.atletaIdCartola)).size !== points.length
    || points.some(p => p.temporada !== round.temporada || p.rodada !== round.rodada || p.apuracaoId !== round.id
      || p.revisaoAlteracao > round.revisaoAtual)) reasons.push('SOURCE_SET_INTEGRITY_UNPROVEN');
  return { eligible: reasons.length === 0, reasons: [...new Set(reasons)], collectionId: collection?.id ?? null,
    revision: round.revisaoAtual.toString(), sourceHash: round.hashConteudoAtual };
}

export function resolveScoringSource(official: FantasyPontuacaoAtleta | undefined,
  athlete: CatalogIdentity, revision: bigint, evidence: PreservedParticipation) {
  if (!official || official.presenteNaUltimaLista === false) {
    return evidence.participation(athlete) === false
      ? { points: '0', played: false, origin: 'NAO_PARTICIPACAO_INFERIDA_CARTOLA' as const }
      : { points: null, played: null, origin: 'INFORMACAO_AUSENTE' as const };
  }
  const valid = official.estadoClube === 'VALOR' && official.estadoPosicao === 'VALOR'
    && official.clubeIdCartola === athlete.clubeIdExterno && official.posicaoId === athlete.posicaoId
    && official.revisaoAlteracao <= revision;
  return { points: valid && official.estadoPontuacao === 'VALOR' ? official.pontuacao?.toFixed() ?? null : null,
    played: valid && official.estadoParticipacao === 'VALOR' ? official.entrouEmCampo : null,
    origin: valid ? 'REGISTRO_OFICIAL' as const : 'IDENTIDADE_INCOMPATIVEL' as const };
}
