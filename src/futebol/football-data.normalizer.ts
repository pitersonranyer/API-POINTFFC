import * as Joi from 'joi';
import { DesafioPartidaStatus } from '@prisma/client';
import { nomesClube } from './futebol-clubes';
import { FUTEBOL_COMPETICOES, FutebolCodigo } from './futebol-competicoes';

export type FootballDataErrorCode = 'INVALID_RESPONSE' | 'INVALID_QUERY' | 'NOT_CONFIGURED' | 'ACCESS_DENIED'
  | 'NOT_FOUND' | 'RATE_LIMIT' | 'UNAVAILABLE' | 'TIMEOUT' | 'NETWORK';
export class FootballDataError extends Error {
  constructor(message: string, readonly code: FootballDataErrorCode = 'INVALID_RESPONSE') { super(message); }
}
const id = Joi.number().integer().positive().max(4294967295).required();
const str = (max = 255) => Joi.string().max(max).required();
const optional = (max = 255) => Joi.string().max(max).allow(null).required();
const date = Joi.string().isoDate().pattern(/Z$/).required();
const season = Joi.object({ startDate: Joi.string().pattern(/^\d{4}-\d{2}-\d{2}$/).isoDate().required() }).unknown(true).required();
const competition = Joi.object({ id, code: Joi.valid(...FUTEBOL_COMPETICOES).required() }).unknown(true).required();
const score = Joi.number().integer().min(0).max(65535).allow(null).required();
const pair = Joi.object({ home: score, away: score }).unknown(true).required();
function parse<T>(schema: Joi.Schema, input: unknown): T {
  const result = schema.validate(input, { convert: false });
  if (result.error) throw new FootballDataError('football-data: resposta inválida.');
  return result.value as T;
}
export function mapCompetition(input: unknown) {
  const value = parse<{ id: number; code: string; name: string; area: { name: string }; type: string; emblem: string | null; currentSeason: { startDate: string } }>(
    competition.keys({ name: str(), area: Joi.object({ name: str(100) }).unknown(true).required(), type: str(50), emblem: optional(65535), currentSeason: season }), input);
  return { externalId: value.id, codigo: value.code, nome: value.name, pais: value.area.name, tipo: value.type, emblemaUrl: value.emblem, temporadaAtual: Number(value.currentSeason.startDate.slice(0, 4)), ativa: true };
}
// The competition argument is retained for callers; aliases belong only to team IDs.
export function mapTeam(input: unknown, _code: FutebolCodigo = 'BSA') {
  const value = parse<{ id: number; name: string; shortName: string | null; tla: string | null; crest: string | null; area: { name: string } }>(
    Joi.object({ id, name: str(), shortName: optional(), tla: optional(10), crest: optional(65535), area: Joi.object({ name: str(100) }).unknown(true).required() }).unknown(true), input);
  return { externalId: value.id, ...nomesClube(value.id, value.name, value.shortName), sigla: value.tla, escudoUrl: value.crest, pais: value.area.name };
}
export function mapMatch(input: unknown, competitionId: number, year: number) {
  const value = parse<{ id: number; competition: { id: number }; season: { startDate: string }; matchday: number | null; stage: string | null; group: string | null; homeTeam: { id: number }; awayTeam: { id: number }; utcDate: string; status: string; lastUpdated: string; score: { winner: string | null; fullTime: { home: number | null; away: number | null }; halfTime: { home: number | null; away: number | null } } }>(
    Joi.object({ id, competition, season, matchday: score, stage: optional(100), group: optional(100), homeTeam: Joi.object({ id }).unknown(true).required(), awayTeam: Joi.object({ id }).unknown(true).required(), utcDate: date, status: str(50), lastUpdated: date,
      score: Joi.object({ winner: Joi.valid(null, 'HOME_TEAM', 'AWAY_TEAM', 'DRAW').required(), fullTime: pair, halfTime: pair }).unknown(true).required(),
    }).unknown(true), input);
  if (value.competition.id !== competitionId || Number(value.season.startDate.slice(0, 4)) !== year || value.homeTeam.id === value.awayTeam.id) throw new FootballDataError('football-data: competição, temporada ou clubes divergentes.');
  return { externalId: value.id, temporada: year, rodada: value.matchday, fase: value.stage, grupo: value.group,
    mandanteExternalId: value.homeTeam.id, visitanteExternalId: value.awayTeam.id,
    dataHoraUtc: new Date(value.utcDate), status: value.status, vencedor: value.score.winner,
    placarMandante: value.score.fullTime.home, placarVisitante: value.score.fullTime.away,
    placarIntervaloMandante: value.score.halfTime.home, placarIntervaloVisitante: value.score.halfTime.away,
    ultimaAtualizacaoApi: new Date(value.lastUpdated) };
}
export function parseList(input: unknown, key: 'teams' | 'matches', competitionId: number, year: number): unknown[] {
  const value = parse<{ competition: { id: number }; season?: { startDate: string }; teams?: unknown[]; matches?: unknown[] }>(
    Joi.object({ competition, [key]: Joi.array().items(Joi.object().unknown(true)).required(), ...(key === 'teams' ? { season } : {}) }).unknown(true), input);
  if (value.competition.id !== competitionId || (value.season && Number(value.season.startDate.slice(0, 4)) !== year)) throw new FootballDataError('football-data: competição ou temporada divergente.');
  return value[key]!;
}

// Contrato usado pelo Desafio: nenhum codigo de status do fornecedor sai desta fronteira.
export interface DesafioFixture {
  fixtureId: number;
  leagueId: number;
  leagueNome: string;
  dataHoraInicio: string;
  mandanteId: number;
  mandanteNome: string;
  mandanteLogo: string | null;
  visitanteId: number;
  visitanteNome: string;
  visitanteLogo: string | null;
  statusInterno: DesafioPartidaStatus | null;
  horarioConfirmado: boolean;
}

export function traduzirStatusDesafio(status: string): DesafioPartidaStatus | null {
  if (status === 'SCHEDULED' || status === 'TIMED') return DesafioPartidaStatus.AGENDADA;
  if (['IN_PLAY', 'PAUSED', 'EXTRA_TIME', 'PENALTY_SHOOTOUT'].includes(status)) return DesafioPartidaStatus.EM_ANDAMENTO;
  if (status === 'FINISHED') return DesafioPartidaStatus.FINALIZADA;
  if (['SUSPENDED', 'POSTPONED', 'CANCELLED', 'AWARDED'].includes(status)) return DesafioPartidaStatus.ANULADA;
  return null;
}

function crestOpcional(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  try {
    const url = new URL(value);
    if (url.protocol === 'https:' || url.protocol === 'http:') return value;
  } catch { /* Escudo opcional: ausencia/URL invalida nao bloqueia a partida. */ }
  return null;
}

export function mapDesafioMatch(input: unknown): DesafioFixture {
  const team = Joi.object({ id, name: str(), crest: Joi.any().optional() }).unknown(true).required();
  const value = parse<{ id: number; competition: { id: number; name: string }; utcDate: string; status: string;
    homeTeam: { id: number; name: string; crest?: unknown }; awayTeam: { id: number; name: string; crest?: unknown } }>(
    Joi.object({ id, competition: Joi.object({ id, name: str() }).unknown(true).required(), utcDate: date,
      status: str(50), homeTeam: team, awayTeam: team }).unknown(true).required(), input);
  if (value.homeTeam.id === value.awayTeam.id || !value.homeTeam.name.trim() || !value.awayTeam.name.trim()
    || !value.competition.name.trim()) throw new FootballDataError('football-data: resposta inválida.');
  return {
    fixtureId: value.id, leagueId: value.competition.id, leagueNome: value.competition.name,
    dataHoraInicio: new Date(value.utcDate).toISOString(),
    mandanteId: value.homeTeam.id, mandanteNome: value.homeTeam.name, mandanteLogo: crestOpcional(value.homeTeam.crest),
    visitanteId: value.awayTeam.id, visitanteNome: value.awayTeam.name, visitanteLogo: crestOpcional(value.awayTeam.crest),
    statusInterno: traduzirStatusDesafio(value.status),
    // SCHEDULED tem apenas data aproximada; TIMED confirma data e horario no fornecedor.
    horarioConfirmado: value.status === 'TIMED',
  };
}

export function parseDesafioMatches(input: unknown): DesafioFixture[] {
  const value = parse<{ matches: unknown[]; resultSet?: { count: number }; count?: number }>(
    Joi.object({ matches: Joi.array().items(Joi.object().unknown(true)).required(),
      resultSet: Joi.object({ count: Joi.number().integer().min(0).required() }).unknown(true).optional(),
      count: Joi.number().integer().min(0).optional(),
    }).unknown(true).required(), input);
  if ((value.resultSet && value.resultSet.count !== value.matches.length)
    || (value.count !== undefined && value.count !== value.matches.length)) throw new FootballDataError('football-data: lista incompleta.');
  const matches = value.matches.map(mapDesafioMatch);
  if (new Set(matches.map(match => match.fixtureId)).size !== matches.length) throw new FootballDataError('football-data: partidas duplicadas na resposta.');
  return matches;
}
