import { Prisma } from '@prisma/client';
import { CartolaScoredAthletesPayload } from './cartola.types';
import { effectiveLineup, scoreMap, totalScore } from '../round-processing/round-calculator';

type PersistedTeam = Prisma.TimeRodadaGetPayload<{
  include: { time: true; escalacao: true; pontuacao: true; substituicoes: true };
}>;

/** Projects persisted replacements; never selects or recalculates replacements. */
export function teamDetailResponse(team: PersistedTeam, payload: CartolaScoredAthletesPayload) {
  const active = team.substituicoes.filter((replacement) => replacement.ativa);
  const effective = new Map(effectiveLineup(team, active).map((athlete) => [athlete.atletaId, athlete]));
  const scores = scoreMap(payload, team.rodada);
  const athletes = team.escalacao.map((athlete) => {
    const counted = effective.get(athlete.atletaId);
    const score = scores.get(athlete.atletaId);
    return {
      atleta_id: athlete.atletaId,
      posicao_id: athlete.posicaoId,
      clube_id: athlete.clubeId,
      nome: athlete.nome,
      apelido: typeof score?.apelido === 'string' ? score.apelido : athlete.nome,
      ...(typeof score?.foto === 'string' ? { foto: score.foto } : {}),
      preco_num: athlete.preco?.toNumber() ?? null,
      pontos_num: score?.pontuacao ?? 0,
      scout: score?.scout ?? null,
      entrou_em_campo: score?.entrou_em_campo ?? null,
      titularEfetivo: counted !== undefined,
      capitaoOriginal: athlete.capitao,
      capitaoEfetivo: counted?.capitao ?? false,
      reservaLuxo: athlete.atletaId === team.reservaLuxoId,
      reservaLuxoUtilizado: athlete.atletaId === team.reservaLuxoId
        && active.some((replacement) => replacement.atletaEntrouId === athlete.atletaId),
      pontuacaoContabilizada: counted ? totalScore([counted], scores).toNumber() : 0,
    };
  });
  const originals = new Set(team.escalacao.filter((a) => a.titular).map((a) => a.atletaId));
  return {
    time: { time_id: team.timeId, nome: team.time.nomeTime, nome_cartola: team.time.nomeCartoleiro,
      slug: team.time.slug, url_escudo_png: team.time.escudoUrl, foto_perfil: team.time.fotoPerfilUrl,
      assinante: team.time.assinante, rodada_time_id: team.rodada },
    timeRodadaId: team.id,
    temporada: team.temporada,
    rodada_atual: team.rodada,
    esquema_id: team.esquemaTatico,
    patrimonio: team.patrimonio?.toNumber() ?? null,
    capitao_id: team.capitaoId,
    reserva_luxo_id: team.reservaLuxoId,
    pontos: team.pontuacao!.pontuacao.toNumber(),
    status: team.pontuacao!.status,
    jogadores_jogaram: athletes.filter((a) => a.titularEfetivo && a.entrou_em_campo === true).length,
    atletas: athletes.filter((a) => originals.has(a.atleta_id)),
    reservas: athletes.filter((a) => !originals.has(a.atleta_id)),
    substituicoes: active.map((replacement) => ({
      ativa: true as const,
      titularSaiuId: replacement.atletaSaiuId,
      reservaEntrouId: replacement.atletaEntrouId,
      reservaLuxo: replacement.atletaEntrouId === team.reservaLuxoId,
      herdouCapitao: effective.get(replacement.atletaEntrouId)?.capitao ?? false,
    })),
  };
}

export type TeamDetailResponse = ReturnType<typeof teamDetailResponse>;
