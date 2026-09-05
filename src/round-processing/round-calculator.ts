import { BadGatewayException, UnprocessableEntityException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { CartolaMatch, CartolaMatchesResponse, CartolaScoredAthlete, CartolaScoredAthletesPayload } from '../cartola/cartola.types';

export interface FrozenAthlete {
  atletaId: number; posicaoId: number; clubeId: number | null;
  titular: boolean; reserva: boolean; capitao: boolean;
  preco?: Prisma.Decimal | null; nome?: string | null;
}
export interface Replacement { atletaSaiuId: number; atletaEntrouId: number; posicaoId: number }
export interface FrozenTeam {
  id: number; capitaoId: number | null; reservaLuxoId: number | null;
  escalacao: FrozenAthlete[];
}

// Unknown match states are deliberately not interpreted as full time.
export function matchEnded(match: CartolaMatch): boolean {
  return match.valida === true && match.periodo_tr === 'F';
}

export function matchStart(match: CartolaMatch): number {
  if (typeof match.timestamp === 'number' && Number.isFinite(match.timestamp)) return match.timestamp * 1000;
  const raw = match.partida_data ?? '';
  // Cartola's offset-free game dates use Brasilia time, independent of host TZ.
  const date = /^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}$/.test(raw) ? `${raw.replace(' ', 'T')}-03:00` : raw;
  return Date.parse(date);
}

export function scoreMap(payload: CartolaScoredAthletesPayload, round: number): Map<number, CartolaScoredAthlete> {
  if (payload.rodada !== round || !payload.atletas || Array.isArray(payload.atletas)
    || typeof payload.atletas !== 'object') throw new BadGatewayException('Pontuados de rodada invalida');
  const result = new Map<number, CartolaScoredAthlete>();
  if (payload.total_atletas !== undefined && (!Number.isInteger(payload.total_atletas)
    || payload.total_atletas !== Object.keys(payload.atletas).length)) throw new BadGatewayException('Envelope de pontuados incompleto');
  for (const [key, athlete] of Object.entries(payload.atletas)) {
    if (!Number.isInteger(Number(key)) || Number(key) < 1 || !athlete
      || typeof athlete.pontuacao !== 'number' || !Number.isFinite(athlete.pontuacao)
      || (athlete.entrou_em_campo !== undefined && typeof athlete.entrou_em_campo !== 'boolean')) {
      throw new BadGatewayException(`Pontuado invalido: ${key}`);
    }
    if (athlete.scout !== undefined && athlete.scout !== null
      && (typeof athlete.scout !== 'object' || Array.isArray(athlete.scout)
        || Object.values(athlete.scout).some((n) => typeof n !== 'number' || !Number.isFinite(n)))) {
      throw new BadGatewayException(`Scouts invalidos: ${key}`);
    }
    result.set(Number(key), athlete);
  }
  return result;
}

export function matchesByClub(payload: CartolaMatchesResponse, round: number): Map<number, CartolaMatch> {
  if (payload.rodada !== round || !Array.isArray(payload.partidas)) throw new BadGatewayException('Partidas de rodada invalida');
  const result = new Map<number, CartolaMatch>();
  for (const match of payload.partidas.filter((m) => m.valida === true)) {
    for (const club of [match.clube_casa_id, match.clube_visitante_id]) {
      if (!Number.isInteger(club) || result.has(club)) throw new BadGatewayException('Partidas ambiguas por clube');
      result.set(club, match);
    }
  }
  return result;
}

export function effectiveLineup(team: FrozenTeam, replacements: Replacement[]): FrozenAthlete[] {
  const effective = new Map(team.escalacao.filter((a) => a.titular).map((a) => [a.atletaId, { ...a }]));
  const used = new Set<number>();
  for (const replacement of replacements) {
    const outgoing = effective.get(replacement.atletaSaiuId);
    const incoming = team.escalacao.find((a) => a.reserva && a.atletaId === replacement.atletaEntrouId);
    if (!outgoing || !incoming || used.has(incoming.atletaId) || outgoing.posicaoId === 6
      || outgoing.posicaoId !== incoming.posicaoId || incoming.posicaoId !== replacement.posicaoId) {
      throw new UnprocessableEntityException('Substituicao inconsistente com snapshot');
    }
    used.add(incoming.atletaId);
    effective.delete(outgoing.atletaId);
    effective.set(incoming.atletaId, { ...incoming, titular: true, reserva: false, capitao: outgoing.capitao });
  }
  return [...effective.values()];
}

export function totalScore(athletes: FrozenAthlete[], scores: Map<number, CartolaScoredAthlete>): Prisma.Decimal {
  return athletes.reduce((sum, a) => {
    const value = new Prisma.Decimal(scores.get(a.atletaId)?.pontuacao ?? 0);
    return sum.plus(a.capitao ? value.mul('1.5') : value);
  }, new Prisma.Decimal(0)).toDecimalPlaces(2, Prisma.Decimal.ROUND_HALF_UP);
}

export function resolveReplacements(team: FrozenTeam, scores: Map<number, CartolaScoredAthlete>, matches: Map<number, CartolaMatch>, reopened = false) {
  const replacements: Replacement[] = [];
  const pending: string[] = [];
  const starters = team.escalacao.filter((a) => a.titular);
  if (!starters.length || new Set(team.escalacao.map((a) => a.atletaId)).size !== team.escalacao.length
    || starters.filter((a) => a.capitao).length !== (team.capitaoId === null ? 0 : 1)
    || starters.some((a) => a.capitao && a.atletaId !== team.capitaoId)) {
    throw new UnprocessableEntityException('Snapshot invalido');
  }
  const played = (a: FrozenAthlete) => scores.get(a.atletaId)?.entrou_em_campo;
  const game = (a: FrozenAthlete) => a.clubeId === null ? undefined : matches.get(a.clubeId);
  const finished = (a: FrozenAthlete) => {
    const m = game(a);
    return m !== undefined && (matchEnded(m) || (reopened && m.valida === true && matchStart(m) <= Date.now()));
  };
  const points = (a: FrozenAthlete) => scores.get(a.atletaId)?.pontuacao ?? 0;
  const kickoff = (a: FrozenAthlete) => {
    const m = game(a);
    return m ? matchStart(m) : NaN;
  };
  const tieBreak = (a: FrozenAthlete, b: FrozenAthlete): number => {
    if (a.capitao !== b.capitao) return a.capitao ? -1 : 1;
    if (a.preco == null || b.preco == null) throw new Error('Preco ausente no desempate');
    const price = b.preco.comparedTo(a.preco);
    if (price) return price;
    if (!a.nome || !b.nome) throw new Error('Nome ausente no desempate');
    const name = a.nome.localeCompare(b.nome, 'pt-BR');
    if (!name) throw new Error('Desempate ambiguo');
    return name;
  };
  for (const reserve of team.escalacao.filter((a) => a.reserva)) {
    if (reserve.posicaoId === 6) throw new UnprocessableEntityException('Tecnico nao tem reserva');
    if (team.escalacao.filter((a) => a.reserva && a.posicaoId === reserve.posicaoId).length !== 1) {
      throw new UnprocessableEntityException('Multiplos reservas na mesma posicao');
    }
    const position = starters.filter((a) => a.posicaoId === reserve.posicaoId);
    if (!position.length) throw new UnprocessableEntityException('Reserva sem titular da posicao');
    if (!finished(reserve) || position.some((a) => !finished(a))) {
      pending.push(`Partidas pendentes na posicao ${reserve.posicaoId}`); continue;
    }
    if (played(reserve) === false) continue;
    if (played(reserve) === undefined || position.some((a) => played(a) === undefined)) {
      pending.push(`Participacao desconhecida na posicao ${reserve.posicaoId}`); continue;
    }
    try {
      const absent = position.filter((a) => played(a) === false);
      let outgoing: FrozenAthlete | undefined;
      if (absent.length && points(reserve) > 0) {
        outgoing = absent.sort((a, b) => {
          const first = kickoff(a); const second = kickoff(b);
          if (!Number.isFinite(first) || !Number.isFinite(second)) throw new Error('Horario ausente no desempate');
          return first - second || tieBreak(a, b);
        })[0];
      } else if (!absent.length && team.reservaLuxoId === reserve.atletaId) {
        const candidates = position.filter((a) => points(a) < points(reserve));
        outgoing = candidates.sort((a, b) => points(a) - points(b) || tieBreak(a, b))[0];
      }
      if (outgoing) replacements.push({ atletaSaiuId: outgoing.atletaId, atletaEntrouId: reserve.atletaId, posicaoId: reserve.posicaoId });
    } catch (error) { pending.push(error instanceof Error ? error.message : 'Desempate desconhecido'); }
  }
  return { replacements, pending };
}
