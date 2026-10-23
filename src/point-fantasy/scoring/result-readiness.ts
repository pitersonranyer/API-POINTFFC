import { FantasyApuracaoRodada, FantasyCompeticao, FantasyEscalacaoResultado } from '@prisma/client';
import { SCORING_ENGINE_VERSION } from './lineup-scoring.service';

/** Same revision/hash/version checks for ranking and lineup read projections. */
export function isCurrentResult(result: Pick<FantasyEscalacaoResultado, 'competicaoId' | 'temporada' | 'rodada' | 'revisao' | 'hashFonte' | 'versaoEscalacao' | 'versaoMotor'> | null,
  round: Pick<FantasyApuracaoRodada, 'revisaoAtual' | 'hashConteudoAtual'> | null,
  competition: Pick<FantasyCompeticao, 'id' | 'temporada' | 'rodada'>, version: number): boolean {
  return !!result && !!round && result.competicaoId === competition.id
    && result.temporada === competition.temporada && result.rodada === competition.rodada
    && result.revisao === round.revisaoAtual && result.hashFonte === round.hashConteudoAtual
    && result.versaoEscalacao === version && result.versaoMotor === SCORING_ENGINE_VERSION;
}
