import { ApiEvent, ApiFixture, Equipe, EventoSumario, Participante, SumarioPartida } from './fantasy.types';

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
