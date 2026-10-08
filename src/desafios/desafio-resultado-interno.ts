import { DesafioPartida, Prisma } from '@prisma/client';
import { DesafioResultadoOficial, mapDesafioResultado } from '../futebol/football-data-desafio-resultado';

export const resultadoInternoInclude = { competicao: true, timeMandante: true, timeVisitante: true } satisfies Prisma.FutebolPartidaInclude;
export type PartidaInterna = Prisma.FutebolPartidaGetPayload<{ include: typeof resultadoInternoInclude }>;

/** lastUpdated do fornecedor, nunca atualizadoEm/ultimoSyncEm, comprova recencia.
 * Sem duration/regularTime persistidos, FINISHED sempre exige confirmacao externa.
 */
export function resultadoInterno(partida: PartidaInterna, snapshots: DesafioPartida[], now: number): DesafioResultadoOficial | null {
  if (!snapshots.length || snapshots.some(p => p.fixtureIdApiFootball !== partida.externalId
    || p.leagueIdApiFootball !== partida.competicao.externalId
    || p.mandanteIdApiFootball !== partida.timeMandante.externalId
    || p.visitanteIdApiFootball !== partida.timeVisitante.externalId)) return null;
  const live = ['IN_PLAY', 'PAUSED'].includes(partida.status);
  if (!live && !['SCHEDULED', 'TIMED', 'CANCELLED', 'POSTPONED', 'SUSPENDED', 'AWARDED'].includes(partida.status)) return null;
  const age = now - partida.ultimaAtualizacaoApi.getTime();
  if (!Number.isFinite(age) || age < 0 || age > (live ? 10 : 15) * 60_000) return null;
  // Persistencia local nao prova observacao do fornecedor. Serve apenas como
  // limite conservador para nao regredir uma parcial ja aplicada mais tarde.
  if (snapshots.some(p => p.status === 'EM_ANDAMENTO'
    && p.atualizadoEm > partida.ultimaAtualizacaoApi)) return null;
  const gol = (value: number | null): value is number => value !== null && Number.isInteger(value) && value >= 0 && value <= 65535;
  if (live && (!gol(partida.placarMandante) || !gol(partida.placarVisitante))) return null;
  // Reutiliza identidade e traducao de status; nao inventa score.duration.
  // fullTime interno em jogo e apenas parcial, nunca resultado regulamentar final.
  try {
    const resultado = mapDesafioResultado({ id: partida.externalId, status: partida.status, utcDate: partida.dataHoraUtc.toISOString(),
      competition: { id: partida.competicao.externalId, name: partida.competicao.nome },
      homeTeam: { id: partida.timeMandante.externalId, name: partida.timeMandante.nome },
      awayTeam: { id: partida.timeVisitante.externalId, name: partida.timeVisitante.nome } });
    return live ? { ...resultado, golsMandante: partida.placarMandante, golsVisitante: partida.placarVisitante } : resultado;
  } catch { return null; }
}
