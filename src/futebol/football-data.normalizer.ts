import * as Joi from 'joi';
import { nomesClube } from './futebol-clubes';

export class FootballDataError extends Error {}
const id = Joi.number().integer().positive().max(4294967295).required();
const str = (max = 255) => Joi.string().max(max).required();
const optional = (max = 255) => Joi.string().max(max).allow(null).required();
const date = Joi.string().isoDate().pattern(/Z$/).required();
const season = Joi.object({ startDate: Joi.string().pattern(/^\d{4}-\d{2}-\d{2}$/).isoDate().required() }).unknown(true).required();
const competition = Joi.object({ id, code: Joi.valid('BSA').required() }).unknown(true).required();
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
export function mapTeam(input: unknown) {
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
