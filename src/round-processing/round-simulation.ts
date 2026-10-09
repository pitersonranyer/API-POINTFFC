import { BadGatewayException, UnprocessableEntityException } from '@nestjs/common';
import { Prisma, RodadaProcessamento } from '@prisma/client';
import { CartolaMatchesResponse, CartolaScoredAthletesPayload } from '../cartola/cartola.types';
import { athleteParticipation, effectiveLineup, matchEnded, matchesByClub, Replacement, resolveReplacements,
  scoreMap, totalScore, validateFinalData, validateFinalTeam } from './round-calculator';

type Team = Prisma.TimeRodadaGetPayload<{ include: {
  time: { select: { nomeTime: true } }; escalacao: true; pontuacao: true; substituicoes: true;
} }>;
type Classification = 'CONSISTENTE' | 'DIVERGENTE' | 'PENDENTE_DE_DADOS' | 'NÃO_VERIFICÁVEL';
export interface TeamDiagnostic {
  timeId: number; nomeTime: string | null; classificacao: Classification;
  pontuacaoPersistida: number | null; pontuacaoRecalculada: number | null; diferenca: number | null;
  jogadoresParticiparam: number | null; capitaoEfetivoId: number | null;
  substituicoesPersistidas: Array<Replacement & { reservaLuxo: boolean; herdouCapitao: boolean }>;
  substituicoesEsperadas: TeamDiagnostic['substituicoesPersistidas'] | null;
  motivo: string | null;
}

export function simulateRound(round: RodadaProcessamento, teams: Team[]) {
  let scores: ReturnType<typeof scoreMap> | undefined;
  let clubs: ReturnType<typeof matchesByClub> | undefined;
  let dataError: string | undefined;
  let dataClassification: Classification = 'PENDENTE_DE_DADOS';
  const envelope = round.pontuados as CartolaScoredAthletesPayload | null;
  try {
    if (!envelope || !round.partidas) throw new Error('Envelope de pontuados ou partidas ausente');
    scores = scoreMap(envelope, round.rodada);
    clubs = matchesByClub(round.partidas as unknown as CartolaMatchesResponse, round.rodada);
    validateFinalData(scores, clubs);
  } catch (error) {
    dataError = error instanceof Error ? error.message : 'Dados persistidos invalidos';
    if (error instanceof TypeError || (error instanceof BadGatewayException && !dataError.includes('incompleto'))) {
      dataClassification = 'NÃO_VERIFICÁVEL';
    }
  }
  const expectedIds = Array.isArray(round.timesPrevistos) ? round.timesPrevistos : [];
  if (!Array.isArray(round.timesPrevistos) || expectedIds.some((id) => typeof id !== 'number' || !Number.isInteger(id) || id < 1)) {
    dataError = 'Lista de times previstos invalida'; dataClassification = 'NÃO_VERIFICÁVEL';
  }
  const concurrent = round.lockToken !== null && round.lockAte !== null && round.lockAte.getTime() > Date.now();
  const times = teams.map((team): TeamDiagnostic => {
    const describe = (replacements: Replacement[]) => replacements.map((r) => ({
      atletaSaiuId: r.atletaSaiuId, atletaEntrouId: r.atletaEntrouId, posicaoId: r.posicaoId,
      reservaLuxo: team.reservaLuxoId === r.atletaEntrouId,
      herdouCapitao: team.escalacao.some((a) => a.atletaId === r.atletaSaiuId && a.capitao),
    })).sort((a, b) => a.atletaSaiuId - b.atletaSaiuId || a.atletaEntrouId - b.atletaEntrouId);
    const result: TeamDiagnostic = {
      timeId: team.timeId, nomeTime: team.time?.nomeTime ?? null, classificacao: 'PENDENTE_DE_DADOS',
      pontuacaoPersistida: team.pontuacao?.pontuacao.toNumber() ?? null,
      pontuacaoRecalculada: null, diferenca: null, jogadoresParticiparam: null, capitaoEfetivoId: null,
      substituicoesPersistidas: describe(team.substituicoes), substituicoesEsperadas: null, motivo: null,
    };
    try {
      if (concurrent) throw new Error('Processamento em andamento; repetir diagnostico apos liberacao');
      if (dataError || !scores || !clubs) throw new Error(dataError ?? 'Dados indisponiveis');
      const complete = envelope?.total_atletas === scores.size && scores.size > 0;
      const participation = athleteParticipation(scores, clubs, complete);
      // The historical diagnostic requires persisted full-time evidence, without a live-market fallback.
      const resolution = resolveReplacements(team, scores, clubs, false, complete);
      effectiveLineup(team, team.substituicoes);
      validateFinalTeam(team, resolution, scores, participation);
      const lineup = effectiveLineup(team, resolution.replacements);
      if (lineup.some((a) => participation(a) === undefined)) throw new Error('Participacao desconhecida na escalacao efetiva');
      if (team.escalacao.some((a) => (a.titular || a.reserva)
        && (a.clubeId === null || !clubs!.has(a.clubeId) || !matchEnded(clubs!.get(a.clubeId)!)))) {
        throw new Error('Fim de partida nao comprovado no snapshot');
      }
      const total = totalScore(lineup, scores);
      result.pontuacaoRecalculada = total.toNumber();
      result.jogadoresParticiparam = lineup.filter((a) => participation(a) === true).length;
      result.capitaoEfetivoId = lineup.find((a) => a.capitao)?.atletaId ?? null;
      result.substituicoesEsperadas = describe(resolution.replacements);
      if (!team.pontuacao) throw new Error('Pontuacao persistida ausente; comparacao indisponivel');
      result.diferenca = total.minus(team.pontuacao.pontuacao).toNumber();
      const changedScore = !total.equals(team.pontuacao.pontuacao);
      const changedReplacements = JSON.stringify(result.substituicoesEsperadas) !== JSON.stringify(result.substituicoesPersistidas);
      result.classificacao = changedScore || changedReplacements ? 'DIVERGENTE' : 'CONSISTENTE';
      result.motivo = [changedScore ? 'Pontuacao divergente' : '', changedReplacements ? 'Substituicoes divergentes' : ''].filter(Boolean).join('; ') || null;
    } catch (error) {
      result.classificacao = error instanceof UnprocessableEntityException ? 'NÃO_VERIFICÁVEL'
        : dataError && !concurrent ? dataClassification : 'PENDENTE_DE_DADOS';
      result.motivo = error instanceof Error ? error.message : 'Registro nao verificavel';
    }
    return result;
  });
  const availableIds = new Set(teams.filter((t) => t.escalacao.some((a) => a.titular)).map((t) => t.timeId));
  const timesSemSnapshot = expectedIds.filter((id) => typeof id === 'number' && !availableIds.has(id)).length;
  return {
    temporada: round.temporada, rodada: round.rodada, statusRodada: round.status, totalTimes: times.length,
    processamentoEmAndamento: concurrent, timesSemSnapshot,
    diagnosticoDefinitivo: !concurrent && !timesSemSnapshot && !dataError
      && times.every((t) => t.classificacao === 'CONSISTENTE' || t.classificacao === 'DIVERGENTE'),
    consistentes: times.filter((t) => t.classificacao === 'CONSISTENTE').length,
    divergentes: times.filter((t) => t.classificacao === 'DIVERGENTE').length,
    pendentesDeDados: times.filter((t) => t.classificacao === 'PENDENTE_DE_DADOS').length,
    naoVerificaveis: times.filter((t) => t.classificacao === 'NÃO_VERIFICÁVEL').length,
    times,
  };
}
