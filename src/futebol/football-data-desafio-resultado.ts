import { DesafioPartidaStatus, DesafioResultado } from '@prisma/client';
import { DesafioFixture, mapDesafioMatch, parseDesafioMatches } from './football-data.normalizer';

export interface DesafioResultadoOficial extends DesafioFixture {
  statusApuracao: DesafioPartidaStatus;
  resultado: DesafioResultado | null;
  golsMandante: number | null;
  golsVisitante: number | null;
  pendencia: string | null;
}

function objeto(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function placar(value: unknown): { home: number; away: number } | null {
  const row = objeto(value);
  const gol = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v) && v >= 0 && v <= 65535;
  return gol(row.home) && gol(row.away) ? { home: row.home, away: row.away } : null;
}

export function mapDesafioResultado(input: unknown): DesafioResultadoOficial {
  const fixture = mapDesafioMatch(input);
  const vazio = { ...fixture, resultado: null, golsMandante: null, golsVisitante: null, pendencia: null };
  if (fixture.statusInterno !== 'FINALIZADA') {
    return { ...vazio, statusApuracao: fixture.statusInterno ?? 'EM_ANDAMENTO',
      pendencia: fixture.statusInterno === null ? 'STATUS_NAO_SUPORTADO' : null };
  }
  const score = objeto(objeto(input).score);
  const regular = placar(score.regularTime);
  const full = placar(score.fullTime);
  // v4: fullTime e cumulativo; nunca subtrair extraTime/penalties nem usar winner.
  // https://docs.football-data.org/general/v4/overtime.html
  const seguro = score.duration === 'REGULAR'
    ? full && (score.regularTime === undefined || score.regularTime === null
      || (regular && regular.home === full.home && regular.away === full.away)) ? full : null
    : ['EXTRA_TIME', 'PENALTY_SHOOTOUT'].includes(String(score.duration)) ? regular : null;
  if (!seguro) return { ...vazio, statusApuracao: 'EM_ANDAMENTO', pendencia: 'PLACAR_90_MINUTOS_INDISPONIVEL' };
  return { ...fixture, statusApuracao: 'FINALIZADA', golsMandante: seguro.home, golsVisitante: seguro.away,
    resultado: seguro.home > seguro.away ? 'CASA' : seguro.home < seguro.away ? 'FORA' : 'EMPATE', pendencia: null };
}

export function parseDesafioResultados(input: unknown): DesafioResultadoOficial[] {
  // Reutiliza a validacao do envelope, identidade e duplicatas do cliente atual.
  parseDesafioMatches(input);
  return (objeto(input).matches as unknown[]).map(mapDesafioResultado);
}
