import { BadGatewayException } from '@nestjs/common';
import { ApiEvent, ApiFixture, ApiTeamStatistics, Equipe, EstatisticasEquipe, EstatisticasPartida, EventoSumario, Participante, SumarioPartida } from './fantasy.types';

function participante(value: ApiEvent['player']): Participante | null {
  return value && (value.id !== null || value.name !== null) ? { idExterno: value.id, nome: value.name } : null;
}
function equipe(value: ApiEvent['team']): Equipe {
  return { idExterno: value.id, nome: value.name, logo: value.logo ?? null };
}
function tipo(event: ApiEvent): EventoSumario['tipo'] {
  if (event.type === 'Goal' && event.detail === 'Normal Goal') return 'GOL';
  if (event.type === 'Card' && event.detail === 'Yellow Card') return 'CARTAO_AMARELO';
  if (event.type === 'subst') return 'SUBSTITUICAO';
  if (event.type === 'Var' && event.detail === 'Goal cancelled') return 'VAR_GOL_ANULADO';
  return 'DESCONHECIDO';
}

export function mapSumario(fixture: ApiFixture, events: ApiEvent[]): SumarioPartida {
  const rodada = fixture.league.round?.match(/(?:^| - )(\d+)$/);
  const placar = { mandante: 0, visitante: 0 };
  const eventos = events.map((event, index) => ({ event, index })).sort((a, b) =>
    (a.event.time.elapsed ?? 0) - (b.event.time.elapsed ?? 0)
    || (a.event.time.extra ?? 0) - (b.event.time.extra ?? 0) || a.index - b.index
  ).map(({ event }): EventoSumario => {
    const normalized: EventoSumario = {
      tipo: tipo(event),
      tempo: { minuto: event.time.elapsed, acrescimo: event.time.extra,
        exibicao: event.time.elapsed === null ? null : `${event.time.elapsed}${event.time.extra ? '+' + event.time.extra : ''}'` },
      equipe: equipe(event.team), comentarios: event.comments ?? null,
      origem: { tipo: event.type, detalhe: event.detail },
    };
    if (normalized.tipo === 'SUBSTITUICAO') {
      normalized.jogadorSai = participante(event.player);
      normalized.jogadorEntra = participante(event.assist);
    } else {
      normalized.jogador = participante(event.player);
      if (normalized.tipo === 'GOL') {
        normalized.assistencia = participante(event.assist);
        if (event.team.id === fixture.teams.home.id) placar.mandante++;
        else if (event.team.id === fixture.teams.away.id) placar.visitante++;
        normalized.placarAposEvento = { ...placar };
      }
    }
    return normalized;
  });
  return { partida: { idExterno: fixture.fixture.id, campeonato: fixture.league.name,
    rodada: rodada ? Number(rodada[1]) : null, fase: fixture.league.round,
    status: statusPartida(fixture.fixture.status.short), data: fixture.fixture.date, estadio: fixture.fixture.venue.name,
    mandante: equipe(fixture.teams.home), visitante: equipe(fixture.teams.away),
    placar: { mandante: fixture.goals.home, visitante: fixture.goals.away } }, eventos };
}

function statusPartida(status: string): string {
  if (['FT', 'AET', 'PEN'].includes(status)) return 'ENCERRADA';
  if (['1H', '2H', 'ET', 'BT', 'P', 'LIVE'].includes(status)) return 'EM_ANDAMENTO';
  if (status === 'HT') return 'INTERVALO';
  if (status === 'NS') return 'AGENDADA';
  if (status === 'TBD') return 'A_DEFINIR';
  if (status === 'PST') return 'ADIADA';
  if (status === 'CANC') return 'CANCELADA';
  if (['SUSP', 'INT'].includes(status)) return 'INTERROMPIDA';
  if (status === 'ABD') return 'ABANDONADA';
  if (['AWD', 'WO'].includes(status)) return 'RESULTADO_ADMINISTRATIVO';
  return 'DESCONHECIDO';
}

const CAMPOS_ESTATISTICAS: ReadonlyArray<{
  origem: string; campo: keyof EstatisticasEquipe; formato: 'inteiro' | 'percentual' | 'decimal' | 'decimalAssinado';
}> = [
  { origem: 'Shots on Goal', campo: 'finalizacoesNoGol', formato: 'inteiro' },
  { origem: 'Shots off Goal', campo: 'finalizacoesFora', formato: 'inteiro' },
  { origem: 'Total Shots', campo: 'finalizacoes', formato: 'inteiro' },
  { origem: 'Blocked Shots', campo: 'finalizacoesBloqueadas', formato: 'inteiro' },
  { origem: 'Shots insidebox', campo: 'finalizacoesDentroArea', formato: 'inteiro' },
  { origem: 'Shots outsidebox', campo: 'finalizacoesForaArea', formato: 'inteiro' },
  { origem: 'Fouls', campo: 'faltas', formato: 'inteiro' },
  { origem: 'Corner Kicks', campo: 'escanteios', formato: 'inteiro' },
  { origem: 'Offsides', campo: 'impedimentos', formato: 'inteiro' },
  { origem: 'Ball Possession', campo: 'posseBola', formato: 'percentual' },
  { origem: 'Yellow Cards', campo: 'cartoesAmarelos', formato: 'inteiro' },
  { origem: 'Red Cards', campo: 'cartoesVermelhos', formato: 'inteiro' },
  { origem: 'Goalkeeper Saves', campo: 'defesasGoleiro', formato: 'inteiro' },
  { origem: 'Total passes', campo: 'passes', formato: 'inteiro' },
  { origem: 'Passes accurate', campo: 'passesCertos', formato: 'inteiro' },
  { origem: 'Passes %', campo: 'precisaoPasses', formato: 'percentual' },
  { origem: 'expected_goals', campo: 'golsEsperados', formato: 'decimal' },
  { origem: 'goals_prevented', campo: 'golsEvitados', formato: 'decimalAssinado' },
];

function valorEstatistica(value: number | string | null, formato: typeof CAMPOS_ESTATISTICAS[number]['formato']): number | null {
  if (value === null) return null;
  let normalized: number;
  if (typeof value === 'number') normalized = value;
  else {
    const text = value.trim();
    const pattern = formato === 'percentual' ? /^\d+(?:\.\d+)?%?$/ : /^-?\d+(?:\.\d+)?$/;
    if (!pattern.test(text)) throw new BadGatewayException('Resposta inválida do serviço de partidas');
    normalized = Number(text.replace(/%$/, ''));
  }
  if (!Number.isFinite(normalized) || (formato !== 'decimalAssinado' && normalized < 0)
    || (formato === 'inteiro' && !Number.isSafeInteger(normalized))
    || (formato === 'percentual' && normalized > 100)) {
    throw new BadGatewayException('Resposta inválida do serviço de partidas');
  }
  return normalized;
}

function estatisticasEquipe(row?: ApiTeamStatistics): EstatisticasEquipe {
  const result = {} as EstatisticasEquipe;
  for (const definition of CAMPOS_ESTATISTICAS) {
    const matches = row?.statistics.filter(stat => stat.type === definition.origem) ?? [];
    if (matches.length > 1) throw new BadGatewayException('Resposta inválida do serviço de partidas');
    result[definition.campo] = matches.length ? valorEstatistica(matches[0].value, definition.formato) : null;
  }
  return result;
}

export function mapEstatisticas(fixture: ApiFixture, rows: ApiTeamStatistics[]): EstatisticasPartida {
  const homeId = fixture.teams.home.id;
  const awayId = fixture.teams.away.id;
  const ids = rows.map(row => row.team.id);
  if (homeId === awayId || new Set(ids).size !== ids.length || ids.some(id => id !== homeId && id !== awayId)) {
    throw new BadGatewayException('Resposta inválida do serviço de partidas');
  }
  return {
    partida: { idExterno: fixture.fixture.id },
    mandante: { ...equipe(fixture.teams.home), estatisticas: estatisticasEquipe(rows.find(row => row.team.id === homeId)) },
    visitante: { ...equipe(fixture.teams.away), estatisticas: estatisticasEquipe(rows.find(row => row.team.id === awayId)) },
  };
}
